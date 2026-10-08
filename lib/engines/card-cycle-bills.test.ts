import { describe, expect, it } from "vitest";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsDueInCycle, cardBillsForCard } from "./card-cycle-bills";
import { cycleRangeFor, isInCycle, isOwedInCycle, shiftMonthsClamped } from "./month-cycle-range";
import { liabilityTotals, loanBalanceSheet, netWorthWithLoans } from "./loan-balance-sheet";
import { calculateNetWorth } from "./net-worth";

/**
 * Reported flow: Month Cycle starts on the 18th (18 Aug → 17 Sep). A card with statementDay 15 /
 * paymentDueDay 5. Purchases on the card showed in Transactions / Accounts / Credit Cards, but the
 * Month Cycle "Credit card bills" panel only read STORED statements — and the web app never
 * materializes statements — so the bill never appeared.
 */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12);
const MONTH_CYCLE_START_DAY = 18;

function card(overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id: "card-1",
    accountId: "acc-card-1",
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
    createdAt: d(2026, 1, 1),
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
    dateTime: d(2026, 8, 16),
    accountId: "acc-card-1",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: d(2026, 8, 16),
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

/** Card-side income leg of a bank → card transfer (a bill payment). */
function billPayment(amount: number, date: Date): Transaction {
  return txn({ type: "income", amount, dateTime: date, transferId: `tr-${seq}` });
}

function statement(overrides: Partial<Statement>): Statement {
  return {
    id: "stmt-1",
    cardId: "card-1",
    periodStart: d(2026, 7, 16),
    periodEnd: d(2026, 8, 15),
    generatedDate: d(2026, 8, 15),
    dueDate: d(2026, 9, 5),
    totalAmount: 0,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: d(2026, 8, 15),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

const monthCycle = (ref: Date) => cycleRangeFor(MONTH_CYCLE_START_DAY, ref);
const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;

describe("A. Month Cycle boundary classification (startDay 18)", () => {
  const aug18Cycle = monthCycle(d(2026, 9, 1)); // 18 Aug → 17 Sep

  it("cycle containing 1 Sep is 18 Aug → 17 Sep", () => {
    expect(dayKey(aug18Cycle.start)).toBe("2026-8-18");
    expect(dayKey(aug18Cycle.end)).toBe("2026-9-17");
  });

  it.each([
    ["16 Aug (reported case)", d(2026, 8, 16), false],
    ["17 Aug (day before start)", d(2026, 8, 17), false],
    ["18 Aug (cycle start)", d(2026, 8, 18), true],
    ["17 Sep (cycle end, late evening)", new Date(2026, 8, 17, 23, 30), true],
    ["18 Sep (day after end)", d(2026, 9, 18), false],
  ])("%s → in 18 Aug–17 Sep: %s", (_label, date, expected) => {
    expect(isInCycle(date, aug18Cycle)).toBe(expected);
  });

  it("16 Aug spend belongs to the 18 Jul → 17 Aug cycle", () => {
    const owning = monthCycle(d(2026, 8, 16));
    expect(dayKey(owning.start)).toBe("2026-7-18");
    expect(dayKey(owning.end)).toBe("2026-8-17");
  });
});

describe("B/H. card transaction → statement window → Month Cycle bill", () => {
  const now = d(2026, 9, 1);

  it("derives the bill when NO statement is stored, in the cycle that owns its due date", () => {
    const bills = cardBillsForCard(card(), [txn({ amount: 1500, dateTime: d(2026, 8, 16) })], [], now);
    expect(bills).toHaveLength(1);
    // 16 Aug falls in the card's 16 Aug → 15 Sep statement, due 5 Oct.
    expect(dayKey(bills[0].periodStart)).toBe("2026-8-16");
    expect(dayKey(bills[0].periodEnd)).toBe("2026-9-15");
    expect(dayKey(bills[0].dueDate)).toBe("2026-10-5");
    expect(bills[0].remaining).toBe(1500);
    expect(bills[0].isClosed).toBe(false);

    // Spend counted in 18 Jul–17 Aug; the payment obligation in 18 Sep–17 Oct (where 5 Oct lies).
    expect(cardBillsDueInCycle(bills, monthCycle(d(2026, 8, 1)), now)).toHaveLength(0);
    expect(cardBillsDueInCycle(bills, monthCycle(d(2026, 9, 1)), now)).toHaveLength(0);
    const due = cardBillsDueInCycle(bills, monthCycle(d(2026, 10, 1)), now);
    expect(due.map((b) => b.remaining)).toEqual([1500]);
  });

  it("boundary purchases group into the card's own statement windows", () => {
    const txns = [
      txn({ amount: 10, dateTime: d(2026, 8, 17) }),
      txn({ amount: 20, dateTime: d(2026, 8, 18) }),
      txn({ amount: 40, dateTime: d(2026, 9, 17) }),
      txn({ amount: 80, dateTime: d(2026, 9, 18) }),
    ];
    const bills = cardBillsForCard(card(), txns, [], d(2026, 9, 20));
    expect(bills.map((b) => [dayKey(b.dueDate), b.totalAmount])).toEqual([
      ["2026-10-5", 30],
      ["2026-11-5", 120],
    ]);
  });

  it("a stored statement uses its LIVE total and is never double counted with derived bills", () => {
    const txns = [txn({ amount: 700, dateTime: d(2026, 8, 1) }), txn({ amount: 300, dateTime: d(2026, 8, 10) })];
    // Stale snapshot (700) — a later 300 purchase inside the period must be reflected.
    const bills = cardBillsForCard(card(), txns, [statement({ totalAmount: 700 })], now);
    expect(bills).toHaveLength(1);
    expect(bills[0].isMaterialized).toBe(true);
    expect(bills[0].totalAmount).toBe(1000);
    const due = cardBillsDueInCycle(bills, monthCycle(now), now);
    expect(due.map((b) => b.remaining)).toEqual([1000]);
  });

  it("excluded / deleted transactions and bill payments never become bill amounts; money moved out of the card does (WFI-P1-04)", () => {
    const txns = [
      txn({ amount: 500 }),
      txn({ amount: 999, excludeFromCalculations: true }),
      txn({ amount: 999, deletedAt: d(2026, 8, 20) }),
      txn({ amount: 999, type: "income", transferId: "tr-pay" }),
      txn({ amount: 250, type: "expense", transferId: "tr-out" }),
    ];
    const bills = cardBillsForCard(card(), txns, [], now);
    expect(bills.reduce((s, b) => s + b.totalAmount, 0)).toBe(750);
  });
});

describe("C/D/E. unpaid, paid and overdue bills", () => {
  const txns = [txn({ amount: 1000, dateTime: d(2026, 8, 1) })]; // statement 16 Jul–15 Aug, due 5 Sep

  it("C. unpaid bill appears only in the cycle containing its due date (18 Aug–17 Sep)", () => {
    const now = d(2026, 9, 1);
    const bills = cardBillsForCard(card(), txns, [], now);
    expect(cardBillsDueInCycle(bills, monthCycle(d(2026, 9, 1)), now).map((b) => b.remaining)).toEqual([1000]);
    expect(cardBillsDueInCycle(bills, monthCycle(d(2026, 8, 1)), now)).toHaveLength(0);
    expect(cardBillsDueInCycle(bills, monthCycle(d(2026, 10, 1)), now)).toHaveLength(0); // not yet overdue
  });

  it("D. a fully paid bill is not owed anywhere; a partial payment leaves the remainder", () => {
    const now = d(2026, 9, 1);
    const paid = cardBillsForCard(card(), [...txns, billPayment(1000, d(2026, 8, 25))], [], now);
    expect(paid[0].remaining).toBe(0);
    expect(cardBillsDueInCycle(paid, monthCycle(now), now)).toHaveLength(0);

    const partial = cardBillsForCard(card(), [...txns, billPayment(400, d(2026, 8, 25))], [], now);
    expect(cardBillsDueInCycle(partial, monthCycle(now), now).map((b) => b.remaining)).toEqual([600]);
  });

  it("E. an overdue unpaid bill carries into later cycles as overdue, once", () => {
    const now = d(2026, 9, 25);
    const bills = cardBillsForCard(card(), txns, [], now);
    const next = cardBillsDueInCycle(bills, monthCycle(now), now); // 18 Sep–17 Oct
    expect(next).toHaveLength(1);
    expect(next[0].carriedForward).toBe(true);
    expect(next[0].overdue).toBe(true);
    expect(next[0].remaining).toBe(1000);
    // Still listed (not carried) in its own cycle.
    const own = cardBillsDueInCycle(bills, monthCycle(d(2026, 9, 1)), now);
    expect(own.map((b) => b.carriedForward)).toEqual([false]);
  });

  it("isOwedInCycle (Bills/EMI) uses the same carry rule", () => {
    const now = d(2026, 9, 25);
    expect(isOwedInCycle(d(2026, 9, 5), monthCycle(now), now)).toBe(true); // carried
    expect(isOwedInCycle(d(2026, 9, 5), monthCycle(d(2026, 9, 1)), now)).toBe(true); // own cycle
    expect(isOwedInCycle(d(2026, 11, 5), monthCycle(now), now)).toBe(false); // future
    expect(isOwedInCycle(d(2026, 10, 5), monthCycle(d(2026, 11, 1)), d(2026, 9, 1))).toBe(false); // not yet overdue
  });
});

describe("F. navigating cycles", () => {
  it("previous/next stepping lands on adjacent, non-overlapping cycles and moves bills with them", () => {
    const now = d(2026, 9, 1);
    const bills = cardBillsForCard(
      card(),
      [txn({ amount: 100, dateTime: d(2026, 8, 1) }), txn({ amount: 200, dateTime: d(2026, 8, 20) })],
      [],
      now,
    );
    const prev = monthCycle(shiftMonthsClamped(now, -1));
    const cur = monthCycle(shiftMonthsClamped(now, 0));
    const next = monthCycle(shiftMonthsClamped(now, 1));
    expect(dayKey(new Date(prev.end.getTime() + 1))).toBe(dayKey(cur.start));
    expect(dayKey(new Date(cur.end.getTime() + 1))).toBe(dayKey(next.start));

    const amounts = (r: { start: Date; end: Date }) => cardBillsDueInCycle(bills, r, now).map((b) => b.remaining);
    expect(amounts(prev)).toEqual([]);
    expect(amounts(cur)).toEqual([100]);
    expect(amounts(next)).toEqual([200]);
    // Navigating back and forth is stable.
    expect(amounts(cur)).toEqual([100]);
  });
});

describe("G. reconciliation fixture: transaction → card → bill → Month Cycle → Net Worth", () => {
  it("every stage agrees; Net Worth reads the card ACCOUNT balance, not bills", () => {
    const now = d(2026, 9, 1);
    const purchase = txn({ amount: 1500, dateTime: d(2026, 8, 16) });
    // 1-2. Transaction → card account position (repository-maintained currentBalance: liability is negative).
    const bank = { id: "bank", currentBalance: 50000 };
    const cardAccount = { id: "acc-card-1", currentBalance: -1500 };
    // 3. Credit-card outstanding (liability).
    const cardOutstanding = -cardAccount.currentBalance;
    // 4. Statement (derived — none stored).
    const bills = cardBillsForCard(card(), [purchase], [], now);
    expect(bills.reduce((s, b) => s + b.remaining, 0)).toBe(cardOutstanding);
    // 5-6. Month Cycle bills / required amount (cycle owning the 5 Oct due date).
    const owed = cardBillsDueInCycle(bills, monthCycle(d(2026, 10, 1)), now);
    expect(owed.reduce((s, b) => s + b.remaining, 0)).toBe(1500);
    // 7-9. Assets / liabilities / Net Worth (Dashboard formula).
    const sheet = loanBalanceSheet([], [], 0);
    const netWorth = netWorthWithLoans(calculateNetWorth([bank, cardAccount]), sheet, 0);
    const debt = liabilityTotals(sheet, cardOutstanding);
    expect(netWorth).toBe(48500);
    expect(debt.total).toBe(1500);
    expect(netWorth + debt.total).toBe(50000); // assets

    // Paying the bill: cash and card liability fall together; Net Worth is unchanged; bill gone.
    const paidBills = cardBillsForCard(card(), [purchase, billPayment(1500, d(2026, 9, 2))], [], now);
    expect(cardBillsDueInCycle(paidBills, monthCycle(d(2026, 10, 1)), now)).toHaveLength(0);
    expect(netWorthWithLoans(calculateNetWorth([{ currentBalance: 48500 }, { currentBalance: 0 }]), sheet, 0)).toBe(48500);
  });
});
