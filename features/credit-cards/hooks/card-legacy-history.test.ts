import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { uncoveredClosedSpendForCard } from "@/lib/repositories/credit-card-repository";
import { computeCreditCardStandings } from "./use-credit-cards-data";

/**
 * Legacy-history safety for the uncovered-closed-cycle fix. The schema has NO credit-card opening state:
 * no tracking-start date, the add-card form's "current used/outstanding" is never persisted, and card
 * accounts are always created with `openingBalance: 0`. So every live purchase on a card account is
 * debt unless a recorded payment settles it — the rule the card ACCOUNT balance and a card with no
 * saved statements already followed. These tests pin that the fix only makes cards WITH saved
 * statements agree with that rule — no transaction is counted twice and none is dropped.
 *
 * Card: statementDay 16 / paymentDueDay 5. Today 5 Nov 2026.
 */

const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day, 12);
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
    createdAt: d(6, 1),
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
const payment = (accountId: string, amount: number, date: Date) => txn(accountId, amount, date, { type: "income", transferId: `tr-${seq + 1}` });

function stored(c: CreditCardProfile, id: string, periodStart: Date, periodEnd: Date, dueDate: Date, totalAmount: number, extra: Partial<Statement> = {}): Statement {
  return {
    id,
    cardId: c.id,
    periodStart,
    periodEnd,
    generatedDate: periodEnd,
    dueDate,
    totalAmount,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: periodEnd,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...extra,
  } as Statement;
}

function standingOf(c: CreditCardProfile, statements: Statement[], transactions: Transaction[]) {
  const [s] = computeCreditCardStandings({ cards: [c], sharedLimits: [], statements, transactions, utilizationEmis: [], now: NOW });
  return s;
}
const scopeOf = (c: CreditCardProfile, statements: Statement[], transactions: Transaction[]) =>
  cardStatementPaymentScope(cardBillsForCard(c, transactions, statements, NOW));
/** The card ACCOUNT's own ledger view: every live purchase owed, every bill payment credited. */
const accountLedgerOwed = (transactions: Transaction[]) =>
  transactions.filter((t) => t.deletedAt == null).reduce((s, t) => s + (t.type === "expense" && t.transferId == null ? t.amount : t.type === "income" && t.transferId != null ? -t.amount : 0), 0);

describe("pre-tracking history — what the existing schema can and can't tell", () => {
  const c = card("visa");
  // Old Jan–Mar purchases (₹9,000) entered before reliable statements; statements saved from Sep–Oct only.
  const old = [txn(c.accountId, 4000, d(1, 10)), txn(c.accountId, 5000, d(3, 2))];
  const tracked = [txn(c.accountId, 8000, d(10, 5)), txn(c.accountId, 3000, d(10, 20))];
  const STMT = stored(c, "s-sep-oct", d(9, 17), d(10, 16), d(11, 5), 8000);

  it("UNPAID in the data (no payment recorded): counted — exactly as the card account balance and a statement-less card already count it", () => {
    const withStatement = standingOf(c, [STMT], [...old, ...tracked]);
    const noStatements = standingOf(c, [], [...old, ...tracked]);
    expect(withStatement.ownOutstanding).toBe(20000);
    expect(noStatements.ownOutstanding).toBe(20000); // pre-fix behaviour for cards without saved statements
    expect(accountLedgerOwed([...old, ...tracked])).toBe(20000);
  });

  it("settled externally AND recorded (a payment transfer exists): NOT resurrected — oldest-first settles the old cycles", () => {
    const settled = [...old, payment(c.accountId, 9000, d(4, 1)), ...tracked];
    const s = standingOf(c, [STMT], settled);
    const scope = scopeOf(c, [STMT], settled);
    expect(s.ownOutstanding).toBe(11000);
    expect(scope).toMatchObject({ statementDue: 8000, unbilled: 3000 });
    expect(scope.statements.map((b) => b.id)).toEqual(["s-sep-oct"]);
  });

  it("old purchases removed / excluded from calculations: never debt", () => {
    const cleaned = [{ ...old[0], deletedAt: NOW }, { ...old[1], excludeFromCalculations: true }, ...tracked];
    expect(standingOf(c, [STMT], cleaned).ownOutstanding).toBe(11000);
  });

  it("card creation date is NOT a safe boundary: purchases backdated before it are ordinary tracked spend", () => {
    // Added the card on 20 Oct, then entered the 5 Oct purchase with its real date — it is the Sep–Oct statement.
    const late = card("late", { createdAt: d(10, 20) });
    const t = [txn(late.accountId, 8000, d(10, 5))];
    expect(scopeOf(late, [], t).statementDue).toBe(8000);
    expect(standingOf(late, [], t).ownOutstanding).toBe(8000);
  });
});

describe("no double count between saved and unsaved statements", () => {
  const c = card("visa");
  const t = [txn(c.accountId, 2000, d(8, 12)), txn(c.accountId, 1500, d(9, 1)), txn(c.accountId, 8000, d(10, 5)), txn(c.accountId, 3000, d(10, 20))];
  const JUL = stored(c, "s-jul-aug", d(7, 17), d(8, 16), d(9, 5), 2000);
  const SEP = stored(c, "s-sep-oct", d(9, 17), d(10, 16), d(11, 5), 8000);
  const AUG = stored(c, "s-aug-sep", d(8, 17), d(9, 16), d(10, 5), 1500);

  it("before the Aug–Sep statement exists: ₹1,500 is uncovered; after it is saved: covered, uncovered ₹0, outstanding unchanged", () => {
    expect(uncoveredClosedSpendForCard(c, t, [JUL, SEP]).map((w) => w.totalAmount)).toEqual([1500]);
    const before = standingOf(c, [JUL, SEP], t).ownOutstanding;
    expect(uncoveredClosedSpendForCard(c, t, [JUL, AUG, SEP])).toEqual([]);
    const after = standingOf(c, [JUL, AUG, SEP], t).ownOutstanding;
    expect(before).toBe(14500);
    expect(after).toBe(14500); // never ₹16,000
    expect(scopeOf(c, [JUL, AUG, SEP], t).cardOutstanding).toBe(14500);
  });

  it("delete the Aug–Sep statement → its spend is uncovered again; recreate → covered again; outstanding identical throughout", () => {
    const pay = payment(c.accountId, 2500, d(10, 1));
    const all = [...t, pay];
    const saved = standingOf(c, [JUL, AUG, SEP], all).ownOutstanding;
    const deleted = standingOf(c, [JUL, { ...AUG, deletedAt: NOW }, SEP], all).ownOutstanding;
    const recreated = standingOf(c, [JUL, { ...AUG, id: "s-aug-sep-2" }, SEP], all).ownOutstanding;
    expect([saved, deleted, recreated]).toEqual([12000, 12000, 12000]);
    for (const statements of [[JUL, AUG, SEP], [JUL, { ...AUG, deletedAt: NOW }, SEP]]) {
      const scope = scopeOf(c, statements, all);
      expect(scope.cardOutstanding).toBe(12000);
      expect(scope.statements.map((b) => b.remaining)).toEqual([1000, 8000]); // ₹2,500 paid: Jul–Aug ₹2,000, then ₹500 of Aug–Sep
    }
  });

  it("a stored period that doesn't line up with today's statement day: overlapping spend is still counted once", () => {
    // Card's statement day was 10 when Jul–Aug was saved (11 Jul – 10 Aug); now 16.
    const odd = stored(c, "s-odd", d(7, 11), d(8, 10), d(8, 30), 0);
    const tt = [txn(c.accountId, 700, d(8, 5)), txn(c.accountId, 300, d(8, 14))];
    const s = standingOf(c, [odd, SEP], tt);
    expect(s.ownOutstanding).toBe(1000);
    expect(uncoveredClosedSpendForCard(c, tt, [odd, SEP]).reduce((x, w) => x + w.totalAmount, 0)).toBe(300);
  });
});

describe("payments settle the oldest real debt first — one allocator", () => {
  it("uncovered → saved → later uncovered → open: each step consumed in due order", () => {
    const c = card("visa");
    const JUL = stored(c, "s-jul-aug", d(7, 17), d(8, 16), d(9, 5), 2000);
    const SEP = stored(c, "s-sep-oct", d(9, 17), d(10, 16), d(11, 5), 8000);
    const base = [txn(c.accountId, 1000, d(7, 1)), txn(c.accountId, 2000, d(8, 12)), txn(c.accountId, 1500, d(9, 1)), txn(c.accountId, 8000, d(10, 5)), txn(c.accountId, 3000, d(10, 20))];
    const remainingAfter = (paid: number) => scopeOf(c, [JUL, SEP], [...base, payment(c.accountId, paid, NOW)]).statements.map((b) => b.remaining);
    expect(remainingAfter(500)).toEqual([500, 2000, 1500, 8000]);
    expect(remainingAfter(1000)).toEqual([2000, 1500, 8000]);
    expect(remainingAfter(3500)).toEqual([1000, 8000]);
    expect(remainingAfter(4500)).toEqual([8000]);
    for (const paid of [0, 500, 3500, 12500, 14000]) {
      const all = [...base, payment(c.accountId, paid, NOW)];
      const scope = scopeOf(c, [JUL, SEP], all);
      expect(standingOf(c, [JUL, SEP], all).ownOutstanding).toBe(scope.closedDue + scope.unbilled);
    }
  });
});

describe("shared limit — each physical card owns its own buckets; the facility sums them once", () => {
  it("Visa gap + RuPay pre-first-statement spend never migrate across cards", () => {
    const sl = { id: "sl", name: "SBI", creditLimit: 100000, createdAt: d(1, 1), deletedAt: null, lastEditedAt: null, editHistory: [] } as SharedCreditLimit;
    const visa = card("visa", { sharedLimitId: "sl", creditLimit: 0 });
    const rupay = card("rupay", { sharedLimitId: "sl", creditLimit: 0 });
    const statements = [
      stored(visa, "v-jul", d(7, 17), d(8, 16), d(9, 5), 2000),
      stored(visa, "v-sep", d(9, 17), d(10, 16), d(11, 5), 8000),
      stored(rupay, "r-sep", d(9, 17), d(10, 16), d(11, 5), 4000),
    ];
    const t = [
      txn(visa.accountId, 2000, d(8, 12)),
      txn(visa.accountId, 1500, d(9, 1)), // Visa gap
      txn(visa.accountId, 8000, d(10, 5)),
      txn(visa.accountId, 3000, d(10, 20)),
      txn(rupay.accountId, 600, d(8, 1)), // RuPay before its first saved statement
      txn(rupay.accountId, 4000, d(10, 1)),
      txn(rupay.accountId, 2000, d(10, 25)),
      payment(visa.accountId, 2000, d(9, 3)),
    ];
    const [v, r] = computeCreditCardStandings({ cards: [visa, rupay], sharedLimits: [sl], statements, transactions: t, utilizationEmis: [], now: NOW });
    expect(v.statementPayment).toMatchObject({ closedDue: 9500, unbilled: 3000 });
    expect(r.statementPayment).toMatchObject({ closedDue: 4600, unbilled: 2000 });
    // Pay Now = each card's own oldest unpaid bill, never the sibling's.
    expect(v.statementPayment.current?.cardId).toBe("visa");
    expect(r.statementPayment.current?.cardId).toBe("rupay");
    expect(v.ownOutstanding).toBe(12500);
    expect(r.ownOutstanding).toBe(6600);
    expect(v.outstanding).toBe(19100);
    expect(r.outstanding).toBe(19100);
    expect(v.available).toBe(100000 - 19100);
  });
});
