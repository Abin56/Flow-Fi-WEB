import { expect, it } from "vitest";
import { dashboardCashFlowWeeks } from "@/features/dashboard/lib/weekly-cash-flow";
import { cashFlowThisMonth, type CashFlowTransaction } from "@/lib/engines/cash-flow";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";

it("reconciles the chart to the month including schedule payments and split receipts", () => {
  const date = (day: number) => new Date(2026, 10, day, 12);
  const transaction = { type: "income", isDeleted: false, isTransfer: false, effectiveMonth: date(1) } as const;
  const transactions: CashFlowTransaction[] = [
    { ...transaction, amount: 500, dateTime: new Date(2026, 9, 31, 12) },
    { ...transaction, type: "expense", amount: 120, dateTime: date(7) },
    { ...transaction, amount: 999, dateTime: date(12), isTransfer: true },
  ];
  const legacyPayment = { date: date(9), installmentDueDate: date(1), amount: 1000, direction: "given", transactionId: null, deletedAt: null } as const;
  const loanPayments: LoanScheduledPayment[] = [legacyPayment, { ...legacyPayment, transactionId: "existing-cash-leg" }];
  const weeks = dashboardCashFlowWeeks({
    now: date(28),
    transactions,
    emiPayments: [{ amount: 600, date: date(17) }],
    loanPayments,
    splitReceipts: {
      expenses: [{ isSplit: true, scheduleId: "split", transactionId: "fronted" }],
      transactionsById: new Map([["fronted", { effectiveMonth: date(1), dateTime: date(8), isDeleted: false, excludeFromCalculations: false }]]),
      installmentsByScheduleId: { split: [{ amountPaid: 250 }] },
    },
  });
  expect(weeks).toEqual([
    { label: "1-7", moneyIn: 0, moneyOut: 120, value: -120 },
    { label: "8-14", moneyIn: 1250, moneyOut: 0, value: 1250 },
    { label: "15-21", moneyIn: 0, moneyOut: 600, value: -600 },
    { label: "22-31", moneyIn: 500, moneyOut: 0, value: 500 },
  ]);
  const monthly = cashFlowThisMonth({
    now: date(28), transactions, emiPaidThisMonth: 600, loanPaidThisMonth: 0,
    loanReceivedThisMonth: 1000, billsPaidThisMonth: 0, moneyReceivedThisMonth: 250,
  });
  expect(weeks.reduce((net, week) => net + week.value, 0)).toBe(monthly.net);
});
