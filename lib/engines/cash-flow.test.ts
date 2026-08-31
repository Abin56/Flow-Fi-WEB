import { describe, expect, it } from "vitest";
import { cashFlowThisMonth, moneyReceivedForRange, moneyReceivedThisMonth, type CashFlowTransaction } from "./cash-flow";
import { billsPaid, type DashboardBillOccurrence } from "./dashboard-aggregation";

function transaction(overrides: Partial<CashFlowTransaction> = {}): CashFlowTransaction {
  return {
    type: "expense",
    amount: 100,
    effectiveMonth: new Date("2026-07-01"),
    isDeleted: false,
    isTransfer: false,
    ...overrides,
  };
}

describe("cashFlowThisMonth", () => {
  it("excludes transfers and deleted transactions from both income and expense totals", () => {
    const summary = cashFlowThisMonth({
      transactions: [
        transaction({ type: "income", amount: 1000 }),
        transaction({ type: "income", amount: 5000, isTransfer: true }),
        transaction({ type: "expense", amount: 200, isDeleted: true }),
        transaction({ type: "expense", amount: 300 }),
      ],
      emiPaidThisMonth: 0,
      loanPaidThisMonth: 0,
      billsPaidThisMonth: 0,
      moneyReceivedThisMonth: 0,
      now: new Date("2026-07-15"),
    });
    expect(summary.moneyIn).toBe(1000);
    expect(summary.moneyOut).toBe(300);
    expect(summary.net).toBe(700);
  });

  it("adds emi/loan/bill paid-this-month and money-received on top of transaction totals", () => {
    const summary = cashFlowThisMonth({
      transactions: [transaction({ type: "income", amount: 1000 }), transaction({ type: "expense", amount: 300 })],
      emiPaidThisMonth: 50,
      loanPaidThisMonth: 25,
      billsPaidThisMonth: 400,
      moneyReceivedThisMonth: 150,
      now: new Date("2026-07-15"),
    });
    expect(summary.moneyIn).toBe(1150);
    expect(summary.moneyOut).toBe(775);
  });
});

describe("moneyReceivedForRange", () => {
  const range = { start: new Date("2026-07-01"), end: new Date("2026-07-31T23:59:59.999") };

  it("sums installment.amountPaid for a split expense whose linked transaction falls in range", () => {
    const total = moneyReceivedForRange({
      expenses: [{ isSplit: true, scheduleId: "sched-1", transactionId: "t1" }],
      transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-07-10"), isDeleted: false, excludeFromCalculations: false }]]),
      installmentsByScheduleId: { "sched-1": [{ amountPaid: 200 }, { amountPaid: 300 }] },
      ...range,
    });
    expect(total).toBe(500);
  });

  it("skips a non-split expense", () => {
    const total = moneyReceivedForRange({
      expenses: [{ isSplit: false, scheduleId: null, transactionId: "t1" }],
      transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-07-10"), isDeleted: false, excludeFromCalculations: false }]]),
      installmentsByScheduleId: {},
      ...range,
    });
    expect(total).toBe(0);
  });

  it("skips when the linked transaction is deleted or excludeFromCalculations", () => {
    const base = {
      expenses: [{ isSplit: true, scheduleId: "sched-1", transactionId: "t1" }],
      installmentsByScheduleId: { "sched-1": [{ amountPaid: 200 }] },
      ...range,
    };
    expect(
      moneyReceivedForRange({
        ...base,
        transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-07-10"), isDeleted: true, excludeFromCalculations: false }]]),
      }),
    ).toBe(0);
    expect(
      moneyReceivedForRange({
        ...base,
        transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-07-10"), isDeleted: false, excludeFromCalculations: true }]]),
      }),
    ).toBe(0);
  });

  it("skips when the linked transaction's effectiveMonth falls outside the range", () => {
    const total = moneyReceivedForRange({
      expenses: [{ isSplit: true, scheduleId: "sched-1", transactionId: "t1" }],
      transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-06-30"), isDeleted: false, excludeFromCalculations: false }]]),
      installmentsByScheduleId: { "sched-1": [{ amountPaid: 200 }] },
      ...range,
    });
    expect(total).toBe(0);
  });

  it("moneyReceivedThisMonth defaults the range to the given `now`'s calendar month", () => {
    const total = moneyReceivedThisMonth(
      {
        expenses: [{ isSplit: true, scheduleId: "sched-1", transactionId: "t1" }],
        transactionsById: new Map([["t1", { effectiveMonth: new Date("2026-07-20"), isDeleted: false, excludeFromCalculations: false }]]),
        installmentsByScheduleId: { "sched-1": [{ amountPaid: 75 }] },
      },
      new Date("2026-07-05"),
    );
    expect(total).toBe(75);
  });
});

describe("billsPaid (lib/engines/dashboard-aggregation.ts) — wired into Cashflow's billsPaidThisMonth", () => {
  it("buckets each occurrence's amountPaid by its own due date, not a payment date", () => {
    const occurrences: DashboardBillOccurrence[] = [
      { dueDate: new Date("2026-07-05"), amountPaid: 1200 },
      { dueDate: new Date("2026-06-30"), amountPaid: 900 },
    ];
    const total = billsPaid(occurrences, { start: new Date("2026-07-01"), end: new Date("2026-07-31T23:59:59.999") });
    expect(total).toBe(1200);
  });
});
