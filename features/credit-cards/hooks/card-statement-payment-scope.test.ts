import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { payBillAmount } from "@/lib/engines/card-cycle-bills";
import { computeCreditCardStandings } from "./use-credit-cards-data";

/**
 * Pay bill scope on the CARD's statement cycle (statementDay 16 → 17 Sep – 16 Oct, due 5 Nov), separate
 * from Settings → Month Cycle. Paying on 5 Nov settles the closed statement; spend from 17 Oct on is the
 * next statement's. Shared-limit siblings keep their own statements.
 */

const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(11, 5);
let seq = 0;

function card(id: string, overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id,
    accountId: `acc-${id}`,
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
    ...overrides,
  };
}

function txn(accountId: string, amount: number, dateTime: Date, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`,
    type: "expense",
    amount,
    dateTime,
    accountId,
    categoryId: "cat",
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

/** The card-side leg of a bill payment transfer (cash account → card). */
const payment = (accountId: string, amount: number, date = NOW) => txn(accountId, amount, date, { type: "income", transferId: `tr-${seq + 1}` });

const scopeOf = (c: CreditCardProfile, txns: Transaction[]) => cardStatementPaymentScope(cardBillsForCard(c, txns, [], NOW));

describe("card statement boundary", () => {
  it("a purchase ON 16 Oct is in the Sep–Oct statement; 17 Oct is the next statement", () => {
    const c = card("visa");
    const scope = scopeOf(c, [txn(c.accountId, 8000, d(10, 16)), txn(c.accountId, 3000, d(10, 17))]);
    expect(scope.statementDue).toBe(8000);
    expect(scope.unbilled).toBe(3000);
    expect(scope.statements[0].periodStart.getDate()).toBe(17);
    expect(scope.statements[0].periodEnd.getDate()).toBe(16);
  });

  it("statement due == total outstanding when nothing was bought after close", () => {
    const c = card("visa");
    const scope = scopeOf(c, [txn(c.accountId, 2000, d(9, 20)), txn(c.accountId, 6000, d(10, 5))]);
    expect(scope).toMatchObject({ statementDue: 8000, unbilled: 0, cardOutstanding: 8000 });
    expect(payBillAmount(scope, "statement", 8000)).toBe(8000);
  });

  it("₹5,000 then ₹3,000 (second partial) clears the statement; ₹3,000 new spend never consumed", () => {
    const c = card("visa");
    const base = [txn(c.accountId, 2000, d(9, 20)), txn(c.accountId, 6000, d(10, 5)), txn(c.accountId, 3000, d(10, 20))];
    const p1 = payment(c.accountId, 5000);
    expect(scopeOf(c, [...base, p1])).toMatchObject({ statementDue: 3000, unbilled: 3000, cardOutstanding: 6000 });
    expect(scopeOf(c, [...base, p1, payment(c.accountId, 3000)])).toMatchObject({ statementDue: 0, unbilled: 3000, cardOutstanding: 3000 });
  });

  it("edit ₹5,000 → ₹6,000 then revert (delete) restores ₹8,000 exactly", () => {
    const c = card("visa");
    const base = [txn(c.accountId, 8000, d(10, 5)), txn(c.accountId, 3000, d(10, 20))];
    expect(scopeOf(c, [...base, payment(c.accountId, 6000)]).statementDue).toBe(2000);
    expect(scopeOf(c, [...base, { ...payment(c.accountId, 6000), deletedAt: NOW }]).statementDue).toBe(8000);
  });
});

describe("shared-limit Visa + RuPay — standings carry each card's own statement scope", () => {
  const sl: SharedCreditLimit = { id: "sl", name: "SBI", creditLimit: 100000, createdAt: d(1, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as SharedCreditLimit;
  const visa = card("visa", { sharedLimitId: "sl", creditLimit: 0 });
  const rupay = card("rupay", { sharedLimitId: "sl", creditLimit: 0 });
  const purchases = [
    txn(visa.accountId, 8000, d(10, 5)),
    txn(visa.accountId, 3000, d(10, 20)),
    txn(rupay.accountId, 4000, d(10, 1)),
    txn(rupay.accountId, 2000, d(10, 25)),
  ];
  const standings = (txns: Transaction[]) =>
    computeCreditCardStandings({ cards: [visa, rupay], sharedLimits: [sl], statements: [], transactions: txns, utilizationEmis: [], now: NOW });

  it("before: Visa Pay bill = ₹8,000 (not facility ₹17,000); RuPay = ₹4,000", () => {
    const [v, r] = standings(purchases);
    expect(v.outstanding).toBe(17000);
    expect(v.statementPayment).toMatchObject({ statementDue: 8000, unbilled: 3000 });
    expect(r.statementPayment).toMatchObject({ statementDue: 4000, unbilled: 2000 });
    expect(payBillAmount(v.statementPayment, "statement", v.ownOutstanding)).toBe(8000);
  });

  it("after paying Visa ₹8,000 from any account: Visa ₹3,000, RuPay untouched ₹6,000, facility ₹9,000", () => {
    const [v, r] = standings([...purchases, payment(visa.accountId, 8000)]);
    expect(v.statementPayment).toMatchObject({ statementDue: 0, unbilled: 3000, cardOutstanding: 3000 });
    expect(r.statementPayment).toMatchObject({ statementDue: 4000, unbilled: 2000, cardOutstanding: 6000 });
    expect(v.outstanding).toBe(9000);
    expect(v.ownOutstanding).toBe(v.statementPayment.cardOutstanding);
  });
});
