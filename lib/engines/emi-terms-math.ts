/**
 * The two interest-schedule helpers `EmiRepository` uses when it re-amortizes an EMI, in one place so the
 * repository and the read-only Edit Terms preview (`emi-terms-plan.ts`) can never drift apart.
 */

import type { InterestPeriodBreakdown } from "@/lib/engines/interest-calculator";
import { nextDueDate, type ScheduleType } from "@/lib/models/payment-schedule";

export interface PrecomputedAmount {
  amountDue: number;
  principalPortion: number;
  interestPortion: number;
}

export function precomputedFromPeriods(periods: InterestPeriodBreakdown[]): PrecomputedAmount[] {
  return periods.map((p) => ({
    amountDue: p.paymentAmount,
    principalPortion: p.principalPortion,
    interestPortion: p.interestPortion,
  }));
}

/**
 * Due date of the first installment of the regenerated tail. With nothing settled the tail IS the whole schedule, so
 * it starts at the EMI's own first date (installment #1 is never moved by a terms edit); otherwise it continues one
 * period after the last settled installment, snapped to the due day for monthly EMIs.
 */
export function termsTailFirstDueDate(args: {
  frequency: ScheduleType;
  startDate: Date;
  lastSettledDueDate: Date | null;
  dueDayOfMonth: number | null;
}): Date {
  const { frequency, startDate, lastSettledDueDate, dueDayOfMonth } = args;
  if (lastSettledDueDate == null) return startDate;
  const next = nextDueDate(frequency, lastSettledDueDate);
  if (dueDayOfMonth == null || frequency !== "monthly") return next;
  const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  return new Date(next.getFullYear(), next.getMonth(), Math.min(dueDayOfMonth, lastDayOfMonth));
}

/**
 * Invariants of a regenerated tail, checked before anything is written: it must be non-empty while principal is
 * outstanding, carry exactly that principal (to the cent per installment), start where the schedule says it
 * starts, and have strictly increasing due dates after the last settled installment.
 */
export function termsTailProblems(args: {
  tail: readonly { dueDate: Date; amountDue: number; principalPortion: number | null }[];
  outstandingPrincipal: number;
  firstDueDate: Date;
  lastSettledDueDate: Date | null;
}): string[] {
  const { tail, outstandingPrincipal, firstDueDate, lastSettledDueDate } = args;
  const problems: string[] = [];
  if (tail.length === 0) {
    if (outstandingPrincipal > 0.005) problems.push(`₹${outstandingPrincipal.toLocaleString("en-IN")} of principal would be left unscheduled.`);
    return problems;
  }
  const scheduled = tail.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0);
  if (Math.abs(scheduled - outstandingPrincipal) > 0.01 * tail.length + 0.005) {
    problems.push(`The new schedule carries ₹${scheduled.toFixed(2)} of principal but ₹${outstandingPrincipal.toFixed(2)} is outstanding.`);
  }
  if (tail[0]!.dueDate.getTime() !== firstDueDate.getTime()) problems.push("The first new due date does not match the schedule anchor.");
  if (lastSettledDueDate != null && tail[0]!.dueDate.getTime() <= lastSettledDueDate.getTime()) problems.push("The first new due date is not after the last settled installment.");
  for (let k = 1; k < tail.length; k++) {
    if (tail[k]!.dueDate.getTime() <= tail[k - 1]!.dueDate.getTime()) {
      problems.push("The new due dates are not strictly increasing.");
      break;
    }
  }
  return problems;
}

/**
 * True per-installment count for `calculate`'s `installmentsPerYear` rate normalization — weekly gets its own
 * exact value (52) instead of being forced through the monthly bucket, which previously overstated weekly
 * interest by ~4.3x. "custom" isn't offered by the EMI form, so 12 (monthly) is a safe placeholder if that ever
 * changes; "oneTime" isn't a valid EMI installment frequency but is included for exhaustiveness.
 */
export function installmentsPerYearFor(scheduleType: ScheduleType): number {
  switch (scheduleType) {
    case "weekly":
      return 52;
    case "monthly":
    case "oneTime":
    case "custom":
      return 12;
  }
}
