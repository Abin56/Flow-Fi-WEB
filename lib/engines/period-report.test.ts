/**
 * Reports / Analytics period engine — every expectation below is computed BY HAND from the raw records in the fixture
 * (see the comments), never by calling the engine twice. The fixture covers the rules that most often double-count:
 * transfers, card purchases vs card bill payments, card refunds, split expenses, loan disbursement / repayment, EMI
 * payments (incl. recorded-earlier), People cash legs, deleted and "don't count" rows, and a custom 18th cycle.
 */

import { describe, expect, it } from "vitest";
import { cashFlowForRange, cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { amountFor } from "@/lib/engines/dashboard-aggregation";
import { mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { accountBalancesAtCutoffs, netWorthAtCutoffs } from "@/lib/engines/net-worth-trend";
import { buildPeriodReportSources, periodDetail, periodFigures } from "@/lib/engines/period-report";
import { previousReportPeriod, resolveReportPeriod, selectionForTrendPoint, trendPeriods } from "@/lib/engines/report-period";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Expense } from "@/lib/models/expense";
import { signedAmount, type Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const NOW = new Date(2026, 10, 19, 12); // 19 Nov 2026
const START_DAY = 18; // cycles 18th → 17th
const BANK = "bank";
const CARD = "card";
const WALLET = "wallet";
const d = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour);

const tx = (p: Partial<Transaction> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({
    type: p.type ?? "expense",
    amount: p.amount ?? 0,
    dateTime: p.dateTime ?? NOW,
    accountId: p.accountId ?? BANK,
    categoryId: p.categoryId ?? "misc",
  }),
  ...p,
});

function fixture() {
  const transactions: Transaction[] = [
    tx({ id: "salary", type: "income", amount: 50_000, dateTime: d(9, 20), categoryId: "salary" }),
    tx({ id: "rent", amount: 15_000, dateTime: d(9, 25), categoryId: "rent" }),
    tx({ id: "groceries", amount: 4_000, dateTime: d(10, 2), accountId: CARD, categoryId: "food" }),
    tx({ id: "refund", type: "income", amount: 500, dateTime: d(10, 3), accountId: CARD, categoryId: "food" }),
    // Card bill payment: bank → card transfer pair.
    tx({ id: "billpay-out", amount: 3_000, dateTime: d(10, 10), transferId: "T1" }),
    tx({ id: "billpay-in", type: "income", amount: 3_000, dateTime: d(10, 10), accountId: CARD, transferId: "T1" }),
    // Bank → wallet transfer pair.
    tx({ id: "xfer-out", amount: 2_000, dateTime: d(10, 5), transferId: "T2" }),
    tx({ id: "xfer-in", type: "income", amount: 2_000, dateTime: d(10, 5), accountId: WALLET, transferId: "T2" }),
    // Split dinner: 3,000 paid, my share 1,000, friend 2,000.
    tx({ id: "dinner", amount: 3_000, dateTime: d(10, 6), categoryId: "food" }),
    // Loan I borrowed: disbursement + one repayment (linked to its schedule payment).
    tx({ id: "disburse", type: "income", amount: 20_000, dateTime: d(9, 28), loanId: "L1", paymentAllocationType: "additionalDisbursement" }),
    tx({ id: "loanpay", amount: 1_200, dateTime: d(10, 15), loanId: "L1", paymentAllocationType: "regularEmi" }),
    // EMI paid from bank (its row is replaced by the installment payment in the Month Cycle / cash figures).
    tx({ id: "emipay", amount: 2_500, dateTime: d(10, 5), emiId: "E1", paymentAllocationType: "regularEmi" }),
    // People cash legs.
    tx({ id: "lent", amount: 1_500, dateTime: d(10, 7), isPersonLedgerMovement: true, linkedPersonId: "P1" }),
    tx({ id: "gotback", type: "income", amount: 700, dateTime: d(10, 12), isPersonLedgerMovement: true, linkedPersonId: "P1" }),
    // Never counted.
    tx({ id: "deleted", amount: 9_999, dateTime: d(10, 1), deletedAt: d(10, 2) }),
    tx({ id: "excluded", amount: 888, dateTime: d(10, 1), excludeFromCalculations: true }),
    // Outside the cycle on both sides.
    tx({ id: "before", amount: 600, dateTime: d(9, 17), categoryId: "food" }),
    tx({ id: "after", amount: 1_234, dateTime: d(10, 18), categoryId: "food" }),
  ];
  const expenses = [
    {
      id: "x-dinner",
      description: "Dinner",
      totalAmount: 3_000,
      date: d(10, 6),
      categoryId: "food",
      accountId: BANK,
      transactionId: "dinner",
      splitType: "exact",
      participants: [
        { personId: null, name: "Me", share: 1_000, installmentId: null, isMe: true },
        { personId: "P2", name: "Friend", share: 2_000, installmentId: "i1", isMe: false },
      ],
      scheduleId: "SCH",
      notes: "",
      createdAt: d(10, 6),
      deletedAt: null,
    },
  ] as unknown as Expense[];
  const emiPayments = [
    { scheduleId: "S-E1", date: d(10, 5), amount: 2_500, recordedEarlier: false },
    { scheduleId: "S-E1", date: d(10, 1), amount: 1_000, recordedEarlier: true },
  ];
  const loanPayments: LoanScheduledPayment[] = [
    { direction: "taken", installmentDueDate: d(10, 15), amount: 1_200, date: d(10, 15), transactionId: "loanpay", deletedAt: null },
  ];
  // BANK history (all-time effects): +50,000 −15,000 −3,000 −2,000 −3,000 +20,000 −1,200 −2,500 −1,500 +700 −600 −1,234 = +40,666
  // → opening 10,000, current 50,666.
  const accounts = [
    { id: BANK, currentBalance: 50_666 },
    { id: CARD, currentBalance: -4_000 + 500 + 3_000 }, // −500
    { id: WALLET, currentBalance: 2_000 },
  ];
  const mySpendCtx = mySpendContextFromRecords({ transactions, expenses, loans: [{ id: "L1", agreementKind: "loan" }], emis: [{ id: "E1", purchaseTransactionId: null }] });
  const sources = buildPeriodReportSources({
    transactions,
    spendTransactions: transactions,
    mySpendCtx,
    creditCards: [{ id: "cc", accountId: CARD }],
    emis: [],
    expenses,
    emiPayments,
    loanPayments,
    installmentsByScheduleId: { SCH: [{ amountPaid: 500 }] },
    accounts,
  });
  return { transactions, sources, accounts };
}

describe("report periods", () => {
  it("current cycle with start day 18 is 18 Oct – 17 Nov, day-granular", () => {
    const p = resolveReportPeriod({ kind: "cycle", offset: 0 }, START_DAY, NOW);
    expect(p.start).toEqual(new Date(2026, 10, 18));
    expect(p.end).toEqual(new Date(2026, 11, 17, 23, 59, 59, 999));
    expect(p.monthGranular).toBe(false);
    expect(p.isCurrent).toBe(true);
  });

  it("previous cycle is 18 Oct – 17 Nov when today is the 19th", () => {
    const p = resolveReportPeriod({ kind: "cycle", offset: -1 }, START_DAY, NOW);
    expect(p.start).toEqual(new Date(2026, 9, 18));
    expect(p.end).toEqual(new Date(2026, 10, 17, 23, 59, 59, 999));
    expect(previousReportPeriod(p, START_DAY, NOW).start).toEqual(new Date(2026, 8, 18));
    expect(selectionForTrendPoint(p, START_DAY, NOW)).toEqual({ kind: "cycle", offset: -1 });
  });

  it("start day 1 cycles and calendar months bucket by effectiveMonth", () => {
    expect(resolveReportPeriod({ kind: "cycle", offset: 0 }, 1, NOW).monthGranular).toBe(true);
    const m = resolveReportPeriod({ kind: "month", year: 2026, month: 1 }, START_DAY, NOW);
    expect(m.start).toEqual(new Date(2026, 1, 1));
    expect(m.end).toEqual(new Date(2026, 1, 28, 23, 59, 59, 999));
    expect(m.label).toBe(new Date(2026, 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }));
  });

  it("a custom range's previous period is the equal-length window right before it", () => {
    const r = resolveReportPeriod({ kind: "range", start: new Date(2026, 10, 10), end: new Date(2026, 10, 19) }, START_DAY, NOW);
    expect(r.days).toBe(10);
    const prev = previousReportPeriod(r, START_DAY, NOW);
    expect(prev.start).toEqual(new Date(2026, 9, 31));
    expect(prev.end).toEqual(new Date(2026, 10, 9, 23, 59, 59, 999));
  });

  it("trend periods are contiguous, oldest first, and carry the year when crossing years", () => {
    const p = resolveReportPeriod({ kind: "cycle", offset: 0 }, START_DAY, NOW);
    const series = trendPeriods(p, START_DAY, 14, NOW);
    expect(series).toHaveLength(14);
    for (let i = 1; i < series.length; i++) expect(series[i].start.getTime()).toBe(series[i - 1].end.getTime() + 1);
    expect(series[series.length - 1].start).toEqual(p.start);
    expect(series[0].shortLabel).toMatch(/'25$/);
  });
});

describe("periodFigures — previous cycle (18 Oct – 17 Nov), hand-computed", () => {
  const { sources } = fixture();
  const period = resolveReportPeriod({ kind: "cycle", offset: -1 }, START_DAY, NOW);
  const f = periodFigures(sources, period);

  it("Income: salary only — no disbursement, no card refund, no transfer leg, no People money", () => {
    expect(f.income).toBe(50_000);
  });

  it("Total outflow (Month Cycle meaning): rent + card purchase + whole dinner + loan repayment + EMI paid", () => {
    // 15,000 + 4,000 + 3,000 + 1,200 + 2,500 (recorded-earlier 1,000 and the EMI's bank row are not added)
    expect(f.outflow).toBe(25_700);
    expect(f.outflowBreakdown).toEqual({ "My Expenses": 21_200, "Shared Expenses": 2_000, EMIs: 2_500 });
    expect(f.net).toBe(24_300);
  });

  it("My Spend: my share only, loan repayment of cash borrowed is not spend, refund not netted", () => {
    // 15,000 + 4,000 + 1,000 (my dinner share) + 2,500 — EMI E1 has no recorded purchase, so its payment IS the
    // consumption record (my-spend rule); the loan repayment (cash borrowed) is not spend.
    expect(f.mySpend).toBe(22_500);
    expect(f.othersShare).toBe(2_000);
    expect(f.totalPurchase).toBe(24_500);
    expect(Object.fromEntries([...f.spendByCategory].map(([k, v]) => [k, v.amount]))).toEqual({ rent: 15_000, food: 5_000, misc: 2_500 });
  });

  it("Cash basis: card purchase replaced by the card bill payment; split collection is money in", () => {
    expect(f.cash.income).toBe(50_000);
    expect(f.cash.expenses).toBe(19_200); // rent 15,000 + dinner 3,000 + loan repayment 1,200
    expect(f.cash.creditCardPayments).toBe(3_000);
    expect(f.cash.moneyIn).toBe(50_500); // + friend's 500
    expect(f.cash.moneyOut).toBe(24_700); // + EMI 2,500
  });

  it("Debt and People lines", () => {
    expect(f.debt).toEqual({ emiPaid: 2_500, loanRepaid: 1_200, loanCollected: 0, cardBillPayments: 3_000 });
    expect(f.people).toEqual({ receivedFromPeople: 700, paidToPeople: 1_500 });
  });
});

describe("periodDetail — accounts and cards", () => {
  const { sources } = fixture();
  const period = resolveReportPeriod({ kind: "cycle", offset: -1 }, START_DAY, NOW);
  const detail = periodDetail(sources, period);

  it("bank: opening 9,400, closing 51,900, in − out = closing − opening", () => {
    const bank = detail.accounts.find((a) => a.accountId === BANK)!;
    expect(bank.opening).toBe(9_400); // 10,000 − the 600 on 17 Oct
    expect(bank.closing).toBe(51_900); // current 50,666 + the 1,234 on 18 Nov walked back
    expect(bank.moneyIn).toBe(70_700); // 50,000 + 20,000 + 700
    expect(bank.moneyOut).toBe(28_200); // 15,000 + 3,000 + 2,000 + 3,000 + 1,200 + 2,500 + 1,500
    expect(bank.transfersOut).toBe(5_000);
    expect(bank.closing - bank.opening).toBe(bank.moneyIn - bank.moneyOut);
  });

  it("card: purchases, refunds and payments", () => {
    expect(detail.cards).toEqual([{ accountId: CARD, purchases: 4_000, refunds: 500, payments: 3_000 }]);
  });

  it("daily distribution adds back to the period totals", () => {
    const days = [...detail.daily.values()];
    expect(days.reduce((s, v) => s + v.mySpend, 0)).toBe(detail.mySpend);
    expect(days.reduce((s, v) => s + v.income, 0)).toBe(detail.income);
  });

  it("transfers between my own accounts leave the sum of all accounts' net movement equal to real income − real spend", () => {
    const net = detail.accounts.reduce((s, a) => s + (a.moneyIn - a.moneyOut), 0);
    // in: 50,000 + 20,000 + 700 + 500 (refund) | out: 15,000 + 4,000 + 3,000 + 1,200 + 2,500 + 1,500 — transfers cancel.
    expect(net).toBe(71_200 - 27_200);
  });
});

describe("equivalence with the existing screens", () => {
  it("cashFlowForRange over a calendar month equals the Dashboard's cashFlowThisMonth", () => {
    const { sources } = fixture();
    const range = { start: new Date(2026, 10, 1), end: new Date(2026, 10, 30, 23, 59, 59, 999) };
    const a = cashFlowForRange({ transactions: sources.cashRows, range, monthGranular: true, emiPaid: 2_500, loanPaid: 0, moneyReceived: 500 });
    const b = cashFlowThisMonth({ transactions: sources.cashRows, emiPaidThisMonth: 2_500, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 500, now: NOW });
    expect({ moneyIn: a.moneyIn, moneyOut: a.moneyOut, net: a.net }).toEqual(b);
  });

  it("a cycle's Income / Outflow are exactly the Month Cycle's amountFor over the same inputs", () => {
    const { sources } = fixture();
    const period = resolveReportPeriod({ kind: "cycle", offset: -1 }, START_DAY, NOW);
    const strategy = { kind: "reportsPeriod" as const, isMonthGranular: false };
    expect(periodFigures(sources, period).outflow).toBe(amountFor("combinedExpenses", strategy, period, sources.financialInputs));
  });

  it("an accounting-month override is honoured by a calendar month, not by a day-granular cycle", () => {
    const { transactions } = fixture();
    const moved = tx({ id: "moved", amount: 999, dateTime: d(9, 30), accountingMonth: new Date(2026, 10, 1), categoryId: "food" });
    const base = buildPeriodReportSources(rawFrom(transactions));
    const withMoved = buildPeriodReportSources(rawFrom([...transactions, moved]));
    const spendIn = (s: typeof base, sel: Parameters<typeof resolveReportPeriod>[0]) => periodFigures(s, resolveReportPeriod(sel, START_DAY, NOW)).mySpend;
    const nov = { kind: "month" as const, year: 2026, month: 10 };
    const oct = { kind: "month" as const, year: 2026, month: 9 };
    const cycle = { kind: "cycle" as const, offset: -1 };
    expect(spendIn(withMoved, nov) - spendIn(base, nov)).toBe(999); // counted in its accounting month
    expect(spendIn(withMoved, oct) - spendIn(base, oct)).toBe(0); // not in its calendar month
    expect(spendIn(withMoved, cycle) - spendIn(base, cycle)).toBe(999); // a custom cycle uses the real date (30 Oct)
  });
});

describe("balance and net worth walk-back", () => {
  it("account balances equal a brute-force replay", () => {
    const { transactions, accounts } = fixture();
    const cutoffs = [new Date(2026, 9, 1), new Date(2026, 10, 1), new Date(2026, 10, 18), NOW];
    const got = accountBalancesAtCutoffs({ accounts, transactions, cutoffs });
    // Bank on 1 Oct: before everything → opening 10,000. On 1 Nov: 10,000 − 600 + 50,000 − 15,000 + 20,000 = 64,400.
    expect(got.get(BANK)).toEqual([10_000, 64_400, 51_900, 50_666]);
    expect(got.get(CARD)).toEqual([0, 0, -500, -500]);
  });

  it("net worth walk-back skips transfers, People legs, loan / EMI rows and walks lender charges", () => {
    const { transactions } = fixture();
    const cutoff = new Date(2026, 10, 1);
    const got = netWorthAtCutoffs({ transactions, netWorthNow: 100_000, lenderChargeEvents: [{ chargeId: "c", date: d(10, 9), delta: -50, kind: "billed" }], cutoffs: [cutoff] });
    // NW-changing rows on/after 1 Nov: groceries −4,000, refund +500, dinner −3,000, after −1,234 (excluded/deleted skipped)
    const after = [-4_000, 500, -3_000, -1_234].reduce((s, v) => s + v, 0);
    expect(got[0]).toBe(100_000 - after - -50);
    // Sanity: the brute-force filter used by the Dashboard before extraction.
    const brute = transactions
      .filter((t) => t.deletedAt == null && !t.excludeFromCalculations && t.transferId == null && !t.isPersonLedgerMovement && t.loanId == null && t.emiId == null && t.dateTime >= cutoff)
      .reduce((s, t) => s + signedAmount(t), 0);
    expect(brute).toBe(after);
  });
});

/** Rebuild the raw inputs of a fixture with different transactions. */
function rawFrom(transactions: Transaction[]) {
  const f = fixture();
  return {
    transactions,
    spendTransactions: transactions,
    mySpendCtx: mySpendContextFromRecords({ transactions, expenses: [], loans: [{ id: "L1", agreementKind: "loan" as const }], emis: [] }),
    creditCards: [{ id: "cc", accountId: CARD }],
    emis: [],
    expenses: [],
    emiPayments: [],
    loanPayments: [],
    installmentsByScheduleId: {},
    accounts: f.accounts,
  };
}
