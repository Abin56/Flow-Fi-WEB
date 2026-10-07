import { describe, expect, it } from "vitest";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope, payBillAmount } from "./card-cycle-bills";
import { buildMySpendContext, classifyForMySpend } from "./my-spend";

/**
 * Card "Pay bill" scope — the CARD's own statement cycle (statementDay 15 / paymentDueDay 5), never
 * Settings → Month Cycle, never the shared facility.
 *
 * Closed statement (16 Aug – 15 Sep, due 5 Oct): purchases ₹10,000, ₹2,000 already paid → ₹8,000 due.
 * New cycle (16 Sep – 15 Oct): purchases ₹4,000. Card outstanding ₹12,000. Today 3 Oct.
 */
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(10, 3);

function card(id: string, overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id,
    accountId: `acc-${id}`,
    sharedLimitId: null,
    statementDay: 15,
    paymentDueDay: 5,
    creditLimit: 100000,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: "4242",
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
    ...overrides,
  };
}

let seq = 0;
function txn(overrides: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `t-${seq}`,
    type: "expense",
    amount: 100,
    dateTime: d(9, 10),
    accountId: "acc-c1",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: d(9, 10),
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

/** A bill payment: one transfer — bank expense leg + card income leg, sharing a transferId. */
function billPayment(amount: number, date: Date, cardAccount = "acc-c1") {
  const transferId = `tr-${(seq += 1)}`;
  return [
    txn({ type: "expense", amount, dateTime: date, accountId: "acc-sbi", transferId }),
    txn({ type: "income", amount, dateTime: date, accountId: cardAccount, transferId }),
  ];
}

const C1 = card("c1");
const closedPurchases = [txn({ amount: 6000, dateTime: d(8, 20) }), txn({ amount: 4000, dateTime: d(9, 10) })];
const newPurchases = [txn({ amount: 4000, dateTime: d(9, 25) })];
const paid2000 = billPayment(2000, d(9, 20));

const scopeFor = (c: CreditCardProfile, all: Transaction[]) =>
  cardStatementPaymentScope(cardBillsForCard(c, all.filter((t) => t.accountId === c.accountId), [], NOW));

describe("Card Pay bill — closed statement vs new purchases", () => {
  const base = [...closedPurchases, ...newPurchases, ...paid2000];

  it("defaults to the statement remaining (₹8,000), not current outstanding (₹12,000)", () => {
    const scope = scopeFor(C1, base);
    expect(scope.statementDue).toBe(8000);
    expect(scope.unbilled).toBe(4000);
    expect(scope.cardOutstanding).toBe(12000);
    expect(scope.statements).toHaveLength(1);
    expect(payBillAmount(scope, "statement", 12000)).toBe(8000);
    // Paying everything is still available — only as the explicit choice.
    expect(payBillAmount(scope, "full", 12000)).toBe(12000);
  });

  it("paying ₹8,000 settles the statement and leaves ₹4,000 for the next statement", () => {
    const scope = scopeFor(C1, [...base, ...billPayment(8000, d(10, 2))]);
    expect(scope.statementDue).toBe(0);
    expect(scope.unbilled).toBe(4000);
    expect(scope.cardOutstanding).toBe(4000);
    expect(payBillAmount(scope, "statement", 4000)).toBeUndefined(); // never falls back to outstanding
  });

  it("partial statement payment ₹3,000 → ₹5,000 statement still due; new purchases untouched", () => {
    const scope = scopeFor(C1, [...base, ...billPayment(3000, d(10, 2))]);
    expect(scope.statementDue).toBe(5000);
    expect(scope.unbilled).toBe(4000);
  });

  it("revert (deleted payment) restores ₹8,000; retry after edit reflects the new amount", () => {
    const pay = billPayment(8000, d(10, 2));
    const reverted = pay.map((t) => ({ ...t, deletedAt: d(10, 3) }));
    expect(scopeFor(C1, [...base, ...reverted]).statementDue).toBe(8000);
    const edited = pay.map((t) => ({ ...t, amount: 5000 }));
    expect(scopeFor(C1, [...base, ...edited]).statementDue).toBe(3000);
  });

  it("shared-limit sibling cards keep their own statements", () => {
    const shared = "facility-1";
    const a = card("c1", { sharedLimitId: shared });
    const b = card("c2", { sharedLimitId: shared, lastFourDigits: "9999" });
    const sibling = [txn({ accountId: "acc-c2", amount: 7000, dateTime: d(9, 5) }), txn({ accountId: "acc-c2", amount: 1500, dateTime: d(9, 28) })];
    const all = [...base, ...sibling];
    expect(scopeFor(a, all)).toMatchObject({ statementDue: 8000, unbilled: 4000 });
    expect(scopeFor(b, all)).toMatchObject({ statementDue: 7000, unbilled: 1500 });
    // A payment into card A never reduces card B's statement.
    expect(scopeFor(b, [...all, ...billPayment(8000, d(10, 2), "acc-c1")]).statementDue).toBe(7000);
  });

  it("bill payment is a transfer: not My Spend; purchases counted once", () => {
    const ctx = buildMySpendContext({ expenses: [] });
    const [bankLeg, cardLeg] = billPayment(8000, d(10, 2));
    expect(classifyForMySpend(bankLeg, ctx).kind).toBe("transfer");
    expect(classifyForMySpend(cardLeg, ctx).kind).toBe("notExpense");
    const spend = [...closedPurchases, ...newPurchases, bankLeg, cardLeg].reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
    expect(spend).toBe(14000);
  });
});
