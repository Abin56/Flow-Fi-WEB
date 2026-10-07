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

/** A non-transfer card credit (merchant refund / reversal / cashback / adjustment) — `type: "income"` on the card. */
const credit = (accountId: string, amount: number, date: Date, overrides: Partial<Transaction> = {}) => txn(accountId, amount, date, { type: "income", ...overrides });

describe("card credits reduce the statement — never raise it (canonical `cardStatementAmount`)", () => {
  // Statement Sep 17 – Oct 16 (closed, due 5 Nov); open cycle Oct 17 – Nov 16.
  const c = card("visa");
  const purchases = [txn(c.accountId, 6000, d(10, 1)), txn(c.accountId, 4000, d(10, 5))];
  const ownOf = (txns: Transaction[]) => computeCreditCardStandings({ cards: [c], sharedLimits: [], statements: [], transactions: txns, utilizationEmis: [], now: NOW })[0];

  it("1. ₹10,000 purchases + ₹2,000 same-cycle credit = ₹8,000 net charges (not ₹12,000)", () => {
    const txns = [...purchases, credit(c.accountId, 2000, d(10, 10))];
    const scope = scopeOf(c, txns);
    expect(scope.current?.totalAmount).toBe(8000);
    expect(scope).toMatchObject({ statementDue: 8000, cardOutstanding: 8000 });
    // Standings (usage / available) reconcile to the same liability.
    const s = ownOf(txns);
    expect([s.ownOutstanding, s.outstanding, s.available]).toEqual([8000, 8000, 92000]);
  });

  it("2. ₹10,000 + ₹2,000 credit + ₹3,000 payment = ₹5,000 remaining — either order, refund and payment kept apart", () => {
    const creditFirst = [...purchases, credit(c.accountId, 2000, d(10, 10)), payment(c.accountId, 3000, d(10, 20))];
    const paymentFirst = [...purchases, payment(c.accountId, 3000, d(10, 8)), credit(c.accountId, 2000, d(10, 12))];
    for (const txns of [creditFirst, paymentFirst]) {
      const scope = scopeOf(c, txns);
      expect(scope.current).toMatchObject({ totalAmount: 8000, amountPaid: 3000, remaining: 5000 }); // net charges vs payments
      expect(scope.statementDue).toBe(5000);
    }
  });

  it("3. credit AFTER the statement closed posts in the open cycle — the closed statement's total is never rewritten", () => {
    // Open cycle has ₹3,000 new spend: the ₹2,000 refund nets it to ₹1,000; the closed bill stays ₹10,000.
    const withSpend = scopeOf(c, [...purchases, txn(c.accountId, 3000, d(10, 25)), credit(c.accountId, 2000, d(10, 28))]);
    expect(withSpend).toMatchObject({ statementDue: 10000, unbilled: 1000, cardOutstanding: 11000 });
    expect(withSpend.current?.totalAmount).toBe(10000);
    // Open cycle has nothing else: its net-credit ₹2,000 settles the oldest open bill like an overpayment.
    const alone = scopeOf(c, [...purchases, credit(c.accountId, 2000, d(10, 28))]);
    expect(alone.current).toMatchObject({ totalAmount: 10000, remaining: 8000 });
    expect(alone).toMatchObject({ statementDue: 8000, unbilled: 0, cardOutstanding: 8000 });
  });

  it("4. credits larger than charges → nothing payable: no negative due, no Pay now, no minimum", () => {
    const txns = [txn(c.accountId, 1000, d(10, 1)), credit(c.accountId, 1500, d(10, 3))];
    const scope = scopeOf(c, txns);
    expect(scope).toMatchObject({ current: null, statementDue: 0, closedDue: 0, cardOutstanding: 0 });
    expect(payBillAmount(scope, "statement", 0)).toBeUndefined();
    expect(payBillAmount(scope, "full", ownOf(txns).ownOutstanding)).toBeUndefined();
    expect(ownOf(txns).ownOutstanding).toBe(0); // the ₹500 credit balance lives on the card account balance
    // The excess ₹500 settles the next bill rather than vanishing.
    expect(scopeOf(c, [...txns, txn(c.accountId, 2000, d(10, 20))]).unbilled).toBe(1500);
  });

  it("5–7. deleted credit stops counting; restored counts once; edited ₹2,000 → ₹1,500 recalculates exactly once", () => {
    const cr = credit(c.accountId, 2000, d(10, 10));
    expect(scopeOf(c, [...purchases, cr]).statementDue).toBe(8000);
    expect(scopeOf(c, [...purchases, { ...cr, deletedAt: NOW }]).statementDue).toBe(10000);
    expect(scopeOf(c, [...purchases, { ...cr, deletedAt: null }]).statementDue).toBe(8000);
    expect(scopeOf(c, [...purchases, { ...cr, amount: 1500 }]).statementDue).toBe(8500);
    expect(scopeOf(c, [...purchases, { ...cr, excludeFromCalculations: true }]).statementDue).toBe(10000);
  });

  it("8–9. single-statement Pay Now uses the NET bill; Statement B stays separate", () => {
    // Statement A Aug 17 – Sep 16 (due 5 Oct): ₹22,152.02 charges + ₹2,000 credit. Statement B Sep 17 – Oct 16: ₹27,170.
    const txns = [txn(c.accountId, 22152.02, d(9, 1)), credit(c.accountId, 2000, d(9, 10)), txn(c.accountId, 27170, d(10, 1))];
    const scope = scopeOf(c, txns);
    expect(scope.statementDue).toBe(20152.02);
    expect(scope.later.map((b) => b.remaining)).toEqual([27170]);
    expect(payBillAmount(scope, "statement", scope.cardOutstanding)).toBe(20152.02);
    const paid = scopeOf(c, [...txns, payment(c.accountId, 5000)]);
    expect(paid.statementDue).toBe(15152.02);
    expect(paid.later.map((b) => b.remaining)).toEqual([27170]);
  });

  it("10. shared limit: a credit on Visa reduces Visa's usage and the facility once; RuPay's statement untouched, no fake payment", () => {
    const sl: SharedCreditLimit = { id: "sl", name: "SBI", creditLimit: 100000, createdAt: d(1, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as SharedCreditLimit;
    const visa = card("visa", { sharedLimitId: "sl", creditLimit: 0 });
    const rupay = card("rupay", { sharedLimitId: "sl", creditLimit: 0 });
    const base = [txn(visa.accountId, 8000, d(10, 5)), txn(rupay.accountId, 4000, d(10, 1))];
    const run = (txns: Transaction[]) => computeCreditCardStandings({ cards: [visa, rupay], sharedLimits: [sl], statements: [], transactions: txns, utilizationEmis: [], now: NOW });
    const [v, r] = run([...base, credit(visa.accountId, 2000, d(10, 10))]);
    expect(v.statementPayment.statementDue).toBe(6000);
    expect(r.statementPayment).toMatchObject({ statementDue: 4000, cardOutstanding: 4000 });
    expect(r.statementPayment.current?.amountPaid).toBe(0);
    expect([v.outstanding, r.outstanding, v.available]).toEqual([10000, 10000, 90000]);
  });
});
