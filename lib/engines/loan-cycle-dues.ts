/**
 * Which Loan installments are owed in one cycle — the per-installment view Month Cycle and a Person's
 * page read, straight from the Loan's schedule `Installment`s (the same documents Loan & EMI, Bills'
 * `computeUpcomingDues` and every payment/advance-payment write update). Pure: nothing is stored or
 * re-amortized here, so a payment, partial payment or re-amortized schedule shows up everywhere at once.
 *
 * Rules (mirroring Flutter's per-cycle `loanCycleViewRecordProvider` and `upcoming-dues.ts`):
 *  - An installment belongs to the cycle containing its `dueDate`.
 *  - Amount is the installment's remainder (`amountDue − amountPaid`) — a partly paid ₹3,000 with
 *    ₹1,000 paid is ₹2,000 owed, still unpaid. Fully paid or skipped installments are never owed.
 *  - An installment due before the cycle and still unpaid by today is carried as `overdue`, kept as its
 *    own row (never folded into the current amount), so it can't silently disappear.
 *  - Never the Loan principal: remaining principal is context, not this cycle's obligation.
 */

import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";

export interface LoanCycleDueLoan {
  id: string;
  isClosed: boolean;
  installments: readonly Installment[];
}

export interface LoanCycleDue {
  loanId: string;
  installmentId: string;
  sequenceNumber: number;
  installmentCount: number;
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
  /** Still owed on this installment. */
  remaining: number;
  /** Past its due date and still unpaid. */
  overdue: boolean;
  /** Due in an EARLIER cycle, still unpaid — carried into this one (always also `overdue`). */
  carriedForward: boolean;
  isPartiallyPaid: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Every unpaid installment of `loan` due within `cycle` plus earlier overdue ones, oldest first. */
export function loanCycleDues(loan: LoanCycleDueLoan, cycle: { start: Date; end: Date }, now: Date = new Date()): LoanCycleDue[] {
  if (loan.isClosed) return [];
  const scheduled = loan.installments.filter((i) => i.deletedAt == null && !i.isSkipped);
  const start = dayIndex(cycle.start);
  const end = dayIndex(cycle.end);
  const today = dayIndex(now);
  const result: LoanCycleDue[] = [];
  for (const i of scheduled) {
    const remaining = round2(remainingAmount(i));
    if (remaining <= 0) continue;
    const due = dayIndex(i.dueDate);
    const inCycle = due >= start && due <= end;
    const carried = due < start && due < today;
    if (!inCycle && !carried) continue;
    result.push({
      loanId: loan.id,
      installmentId: i.id,
      sequenceNumber: i.sequenceNumber,
      installmentCount: scheduled.length,
      dueDate: i.dueDate,
      amountDue: i.amountDue,
      amountPaid: i.amountPaid,
      remaining,
      overdue: due < today,
      carriedForward: carried,
      isPartiallyPaid: i.amountPaid > 0,
    });
  }
  return result.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/** Split totals so carried-over overdue and this cycle's dues are never merged silently. */
export function loanCycleDueTotals(dues: readonly LoanCycleDue[]): { dueThisCycle: number; carriedOverdue: number; total: number } {
  let dueThisCycle = 0;
  let carriedOverdue = 0;
  for (const d of dues) {
    if (d.carriedForward) carriedOverdue += d.remaining;
    else dueThisCycle += d.remaining;
  }
  return { dueThisCycle: round2(dueThisCycle), carriedOverdue: round2(carriedOverdue), total: round2(dueThisCycle + carriedOverdue) };
}
