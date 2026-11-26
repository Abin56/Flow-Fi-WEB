import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { computeCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import {
  cardBillBreakdowns,
  cardDueStatus,
  cardOutstandingSplit,
  classifyCardTransaction,
  financedPurchasesFrom,
  financedTransferTargetsFrom,
  summarizeCardActivity,
  usageBreakdown,
} from "./card-usage-breakdown";

/** Card: statement day 16, due day 5 — cycles end on the 16th. Today 5 Nov 2026 → open cycle 17 Oct – 16 Nov. */
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(11, 5);
let seq = 0;

const CARD = {
  id: "visa",
  accountId: "acc-visa",
  sharedLimitId: null,
  statementDay: 16,
  paymentDueDay: 5,
  creditLimit: 100000,
  minimumDuePercent: null,
  autoPay: false,
  status: "active",
  cardNetwork: null,
  lastFourDigits: null,
  issuer: null,
  annualFee: 0,
  joiningFee: 0,
  interestRatePercent: null,
  rewardNotes: null,
  autoDebitAccount: null,
  cardHolderName: null,
  createdAt: d(1, 1),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
} as CreditCardProfile;

function txn(amount: number, dateTime: Date, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`,
    type: "expense",
    amount,
    dateTime,
    accountId: CARD.accountId,
    categoryId: "shopping",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: dateTime,
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}
const payment = (amount: number, date: Date) => txn(amount, date, { type: "income", transferId: `tr-${seq + 1}` });
const NONE = new Map<string, string>();

function split(transactions: Transaction[], financed: ReadonlyMap<string, string> = NONE, statements: Statement[] = []) {
  const bills = cardBillsForCard(CARD, transactions, statements, NOW);
  const scope = cardStatementPaymentScope(bills, NOW);
  return { scope, split: cardOutstandingSplit({ bills, cardTransactions: transactions, financed, ownOutstanding: scope.cardOutstanding }) };
}
const sum = (s: { loanEmiCharges: number; purchases: number; unsplit: number }) => Math.round((s.loanEmiCharges + s.purchases + s.unsplit) * 100) / 100;

describe("classifyCardTransaction — structured fields only", () => {
  it("separates purchases, Loan/EMI charges, refunds, reimbursements, bill payments and excluded rows", () => {
    expect(classifyCardTransaction(txn(500, d(10, 20)), NONE).kind).toBe("purchase");
    expect(classifyCardTransaction(txn(3000, d(10, 20), { emiId: "emi-1" }), NONE).kind).toBe("loanEmi");
    expect(classifyCardTransaction(txn(3000, d(10, 20), { loanId: "loan-1" }), NONE).kind).toBe("loanEmi");
    expect(classifyCardTransaction(txn(200, d(10, 20), { type: "income" }), NONE).kind).toBe("refund");
    expect(classifyCardTransaction(txn(200, d(10, 20), { type: "income", isPersonLedgerMovement: true }), NONE).kind).toBe("reimbursement");
    expect(classifyCardTransaction(payment(12000, d(10, 20)), NONE)).toEqual({ kind: "payment", bucket: null });
    expect(classifyCardTransaction(txn(500, d(10, 20), { excludeFromCalculations: true }), NONE).kind).toBe("excluded");
    expect(classifyCardTransaction(txn(500, d(10, 20), { deletedAt: d(10, 21) }), NONE).kind).toBe("excluded");
    // Money moved OUT of the card is a charge (same as the statement rule), not a payment.
    expect(classifyCardTransaction(txn(4000, d(10, 20), { transferId: "tr-out" }), NONE).kind).toBe("purchase");
  });

  it("a Case A financed purchase is Loan/EMI only while represented on ITS card", () => {
    const p = txn(35000, d(10, 20));
    const financed = financedPurchasesFrom([{ linkedCreditCardId: CARD.id, purchaseTransactionId: p.id }], [], [CARD]);
    expect(classifyCardTransaction(p, financed).kind).toBe("loanEmi");
    // Excluded → off the bill (the engine's Case C: the EMI lock owns it) — never counted here as well.
    expect(classifyCardTransaction({ ...p, excludeFromCalculations: true }, financed).kind).toBe("excluded");
    // Linked to another card's EMI → an ordinary purchase on this one.
    const elsewhere = financedPurchasesFrom([{ linkedCreditCardId: "other", purchaseTransactionId: p.id }], [], [CARD, { id: "other", accountId: "acc-other" }]);
    expect(classifyCardTransaction(p, elsewhere).kind).toBe("purchase");
    // Card-funded borrowed Loan purchase — same ownership rule as `cardFundedLoanCardId`.
    const loanFinanced = financedPurchasesFrom([], [{ direction: "taken", fundingSource: "creditCard", linkedCreditCardId: CARD.id, purchaseTransactionId: p.id }], [CARD]);
    expect(classifyCardTransaction(p, loanFinanced).kind).toBe("loanEmi");
    expect(financedPurchasesFrom([], [{ direction: "given", fundingSource: "creditCard", linkedCreditCardId: CARD.id, purchaseTransactionId: p.id }], [CARD]).size).toBe(0);
  });
});

describe("cardOutstandingSplit — always adds up to the card's own outstanding", () => {
  it("purchases only → all Purchases", () => {
    const { scope, split: s } = split([txn(12000, d(10, 25))]);
    expect(scope.cardOutstanding).toBe(12000);
    expect(s).toEqual({ loanEmiCharges: 0, purchases: 12000, unsplit: 0 });
  });

  it("an untouched bill with both kinds splits exactly; refunds reduce Purchases", () => {
    const rows = [txn(5000, d(10, 20)), txn(3000, d(10, 22), { emiId: "emi-1" }), txn(500, d(10, 24), { type: "income" })];
    const { scope, split: s } = split(rows);
    expect(scope.cardOutstanding).toBe(7500);
    expect(s).toEqual({ loanEmiCharges: 3000, purchases: 4500, unsplit: 0 });
  });

  it("a PARTLY paid mixed bill is shown as Not split (payments are not tagged to charges), single-kind bills stay attributed", () => {
    // Closed cycle 17 Sep – 16 Oct (due 5 Nov): ₹5,000 purchase + ₹3,000 EMI charge, ₹2,000 paid.
    // Open cycle: ₹1,000 purchase.
    const rows = [txn(5000, d(9, 20)), txn(3000, d(9, 25), { emiId: "emi-1" }), payment(2000, d(10, 1)), txn(1000, d(10, 20))];
    const { scope, split: s } = split(rows);
    expect(scope.cardOutstanding).toBe(7000);
    expect(s).toEqual({ loanEmiCharges: 0, purchases: 1000, unsplit: 6000 });
    expect(sum(s)).toBe(scope.cardOutstanding);
    const bills = cardBillsForCard(CARD, rows, [], NOW);
    expect(cardBillBreakdowns({ bills, cardTransactions: rows, financed: NONE }).get(scope.current!.id)).toEqual({
      billed: { purchases: 5000, loanEmi: 3000 }, remaining: null,
    });
  });

  it("does not claim a linked EMI transfer paid its own purchase when it was absorbed by an older bill", () => {
    const purchase = txn(3000, d(9, 25));
    const emi = { id: "phone", linkedCreditCardId: CARD.id, purchaseTransactionId: purchase.id };
    const financed = financedPurchasesFrom([emi], [], [CARD]);
    const older = txn(2000, d(8, 25));
    const mixedRetail = txn(1000, d(9, 26));
    const principal = { ...payment(1500, d(10, 3)), emiId: emi.id, installmentPaymentId: "payment-1" };
    const rows = [older, purchase, mixedRetail, principal];
    const bills = cardBillsForCard(CARD, rows, [], NOW);
    const parts = cardBillBreakdowns({ bills, cardTransactions: rows, financed, transferTargets: financedTransferTargetsFrom([emi], [], financed) });
    expect(parts.get(bills[0].id)?.remaining).toEqual({ purchases: 500, loanEmi: 0 });
    expect(parts.get(bills[1].id)?.remaining).toEqual({ purchases: 1000, loanEmi: 3000 });
  });

  it("keeps the excess over a linked purchase unattributed on a mixed bill", () => {
    const purchase = txn(1000, d(9, 25));
    const emi = { id: "phone", linkedCreditCardId: CARD.id, purchaseTransactionId: purchase.id };
    const financed = financedPurchasesFrom([emi], [], [CARD]);
    const rows = [purchase, txn(2500, d(9, 25), { emiId: "other" }), txn(1000, d(9, 26)),
      { ...payment(1600, d(10, 3)), emiId: emi.id, installmentPaymentId: "bank-payment" }];
    const bills = cardBillsForCard(CARD, rows, [], NOW);
    const parts = cardBillBreakdowns({ bills, cardTransactions: rows, financed, transferTargets: financedTransferTargetsFrom([emi], [], financed) });
    expect(bills[0].remaining).toBe(2900);
    expect(parts.get(bills[0].id)?.remaining).toBeNull();
  });

  it("a partly paid single-kind bill is still unambiguous", () => {
    const rows = [txn(3000, d(9, 25), { emiId: "emi-1" }), payment(1000, d(10, 1)), txn(800, d(10, 20))];
    const { scope, split: s } = split(rows);
    expect(s).toEqual({ loanEmiCharges: 2000, purchases: 800, unsplit: 0 });
    expect(sum(s)).toBe(scope.cardOutstanding);
  });

  it("bill payments never appear as usage; a fully paid card splits to zero", () => {
    const rows = [txn(4000, d(9, 20)), payment(4000, d(10, 2))];
    const { scope, split: s } = split(rows);
    expect(scope.cardOutstanding).toBe(0);
    expect(s).toEqual({ loanEmiCharges: 0, purchases: 0, unsplit: 0 });
  });
});

describe("usageBreakdown — Loan/EMI includes the engine lock, never twice", () => {
  it("Case B: ₹35,000 locked principal is Loan / EMI usage, purchases stay separate, parts = Credit used", () => {
    const rows = [txn(2000, d(10, 20))];
    const standing = computeCreditCardStandings({
      cards: [CARD],
      sharedLimits: [],
      statements: [],
      transactions: rows,
      utilizationEmis: [{ linkedCreditCardId: CARD.id, isClosed: false, principalAmount: 35000, principalPaid: 0, purchaseRepresented: false }],
      now: NOW,
    })[0]!;
    const own = cardOutstandingSplit({ bills: standing.bills, cardTransactions: rows, financed: NONE, ownOutstanding: standing.ownOutstanding });
    const b = usageBreakdown({ split: own, outstanding: standing.outstanding, lockedEmiPrincipal: standing.lockedEmiPrincipal, available: standing.available, creditLimit: standing.effectiveCreditLimit });
    expect(b.usedCredit).toBe(37000);
    expect(b.loanEmi).toBe(35000);
    expect(b.purchases).toBe(2000);
    expect(b.loanEmi + b.purchases + b.unsplit).toBe(b.usedCredit);
    expect(b.usedCredit + b.available).toBe(100000);
  });

  it("Case A: the financed purchase is in outstanding (Loan/EMI) and the EMI does NOT lock — counted once", () => {
    const p = txn(35000, d(10, 20));
    const rows = [p, txn(1500, d(10, 21))];
    const standing = computeCreditCardStandings({
      cards: [CARD],
      sharedLimits: [],
      statements: [],
      transactions: rows,
      utilizationEmis: [{ linkedCreditCardId: CARD.id, isClosed: false, principalAmount: 35000, principalPaid: 0, purchaseRepresented: true }],
      now: NOW,
    })[0]!;
    expect(standing.lockedEmiPrincipal).toBe(0);
    const financed = financedPurchasesFrom([{ linkedCreditCardId: CARD.id, purchaseTransactionId: p.id }], [], [CARD]);
    const own = cardOutstandingSplit({ bills: standing.bills, cardTransactions: rows, financed, ownOutstanding: standing.ownOutstanding });
    const b = usageBreakdown({ split: own, outstanding: standing.outstanding, lockedEmiPrincipal: standing.lockedEmiPrincipal, available: standing.available, creditLimit: standing.effectiveCreditLimit });
    expect(b).toMatchObject({ usedCredit: 36500, loanEmi: 35000, lockedPrincipal: 0, loanEmiCharges: 35000, purchases: 1500, unsplit: 0 });
  });
});

describe("cardDueStatus — the 'Due today' vs 'no bill due' mismatch", () => {
  it("a card whose latest closed bill is PAID reads 'No bill due' (the old fallback showed that paid bill's date as 'Due today')", () => {
    const rows = [txn(4000, d(9, 20)), payment(4000, d(10, 2)), txn(700, d(10, 20))];
    const standing = computeCreditCardStandings({ cards: [CARD], sharedLimits: [], statements: [], transactions: rows, utilizationEmis: [], now: NOW })[0]!;
    // The paid bill (due 5 Nov = today) is still in the statements list the old `dueDate` fallback read.
    expect(standing.statements.some((s) => s.dueDate.toDateString() === NOW.toDateString())).toBe(true);
    expect(standing.statementPayment.current).toBeNull();
    expect(cardDueStatus(standing.statementPayment, NOW)).toMatchObject({ tone: "clear", label: "No bill due", amount: 0 });
  });

  it("labels an unpaid bill by its own due date", () => {
    const scopeFor = (now: Date) => cardStatementPaymentScope(cardBillsForCard(CARD, [txn(4000, d(9, 20))], [], now), now);
    expect(cardDueStatus(scopeFor(d(11, 5)), d(11, 5))).toMatchObject({ tone: "soon", label: "Due today", amount: 4000 });
    expect(cardDueStatus(scopeFor(d(11, 2)), d(11, 2))).toMatchObject({ tone: "soon", label: "Due in 3 days" });
    expect(cardDueStatus(scopeFor(d(10, 20)), d(10, 20))).toMatchObject({ tone: "upcoming", label: "Due in 16 days" });
    expect(cardDueStatus(scopeFor(d(11, 8)), d(11, 8))).toMatchObject({ tone: "overdue", label: "Overdue by 3 days" });
  });
});

describe("summarizeCardActivity — spending never includes money coming in", () => {
  it("keeps charges, refunds, reimbursements and bill payments apart", () => {
    const rows = [
      txn(12000, d(10, 20), { categoryId: "travel" }),
      txn(2000, d(10, 21), { categoryId: "food" }),
      txn(3000, d(10, 22), { emiId: "emi-1" }),
      txn(400, d(10, 23), { type: "income" }),
      txn(1000, d(10, 24), { type: "income", isPersonLedgerMovement: true }),
      payment(12000, d(10, 25)),
      txn(999, d(10, 26), { excludeFromCalculations: true }),
    ];
    const s = summarizeCardActivity(rows, NONE);
    expect(s).toMatchObject({ purchases: 14000, loanEmi: 3000, refunds: 400, reimbursements: 1000, payments: 12000, counted: 6 });
    expect(s.purchasesByCategory).toEqual([
      { categoryId: "travel", amount: 12000 },
      { categoryId: "food", amount: 2000 },
    ]);
    expect(summarizeCardActivity(rows, NONE, { start: d(10, 24), end: d(10, 31) })).toMatchObject({ purchases: 0, reimbursements: 1000, payments: 12000 });
  });
});
