/**
 * Which Loan installment payments Cash Flow / the dashboard financial views may count from the
 * payment schedule, and in which direction. Pure — no UI or Firebase dependency. Mirrors the Flutter
 * rule in `cash_flow_providers.dart` / `expense_calculator_provider.dart` exactly.
 *
 * The double-count this prevents: a modern Loan payment (`LoanAdvancePaymentRepository.record`)
 * writes ONE physical `Transaction` (income/expense by loan direction) and stamps its id on every
 * `InstallmentPayment` it created (`transactionId`). Cash Flow already counts that Transaction, so
 * the schedule-derived line must skip it. Legacy payments (recorded before loans posted
 * Transactions) carry `transactionId == null`; for those the schedule is the ONLY record of the
 * money movement, so they are still counted — never hidden wholesale, never matched by amount/date.
 *
 * Direction comes from the Loan, never from a generic type: repaying money I borrowed ("taken") is
 * Money Out; a repayment received on money I lent ("given") is Money In.
 */

import type { LoanDirection } from "@/lib/models/loan";

export interface LoanScheduledPayment {
  direction: LoanDirection;
  /** The owning installment's due date — the dashboard financial views bucket by this. */
  installmentDueDate: Date;
  amount: number;
  /** When the payment actually happened — Cash Flow buckets Loan payments by this. */
  date: Date;
  transactionId: string | null;
  deletedAt: Date | null;
}

/** True when the schedule is the only record of this payment's money movement (legacy, unlinked). */
export function countsFromSchedule(payment: Pick<LoanScheduledPayment, "transactionId" | "deletedAt">): boolean {
  return payment.deletedAt == null && payment.transactionId == null;
}

export interface DateRangeLike {
  start: Date;
  end: Date;
}

function inRange(range: DateRangeLike, date: Date): boolean {
  return date.getTime() >= range.start.getTime() && date.getTime() <= range.end.getTime();
}

/** Money In / Money Out contributed by schedule-only (unlinked) Loan payments inside `range`. */
export function scheduleOnlyLoanFlows(
  payments: LoanScheduledPayment[],
  range: DateRangeLike,
  bucketBy: "paymentDate" | "dueDate",
): { moneyIn: number; moneyOut: number } {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const p of payments) {
    if (!countsFromSchedule(p)) continue;
    if (!inRange(range, bucketBy === "paymentDate" ? p.date : p.installmentDueDate)) continue;
    if (p.direction === "given") moneyIn += p.amount;
    else moneyOut += p.amount;
  }
  return { moneyIn, moneyOut };
}

/**
 * Input rows for `dashboard-aggregation.ts`'s `loanPaid` (which buckets `amountPaid` by `dueDate` and
 * treats everything as money out): only schedule-only payments on money I borrowed.
 */
export function dashboardLoanPaidRows(payments: LoanScheduledPayment[]): { dueDate: Date; amountPaid: number }[] {
  return payments
    .filter((p) => p.direction === "taken" && countsFromSchedule(p))
    .map((p) => ({ dueDate: p.installmentDueDate, amountPaid: p.amount }));
}
