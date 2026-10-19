/**
 * Outstanding bill obligations at OCCURRENCE level — one definition shared by Bills Stats, Month Cycle ("Bills")
 * and My Money ("To pay"), so they cannot disagree.
 *
 * A recurring bill is a template plus one independently tracked `BillOccurrence` per billing cycle. The Bills page
 * shows only the latest cycle, but an OLDER cycle can be unpaid again (its payment was cancelled), so obligations
 * are summed over every persisted, non-deleted occurrence — never "the latest one per bill". Each occurrence is
 * counted once, at its own remaining amount (partial payments respected).
 *
 * Pure and read-only: this is obligation reporting, not cash. It creates no transaction, moves no balance and
 * never feeds Money Out — a cancelled payment's refund is done by the payment repository, not here.
 */

import { isOwedInCycle } from "@/lib/engines/month-cycle-range";
import { billOccurrenceStatus, type BillOccurrence } from "@/lib/models/bill";

const EPS = 0.005;
const round2 = (v: number) => Math.round(v * 100) / 100;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export interface OutstandingBillOccurrence {
  billId: string;
  occurrence: BillOccurrence;
  /** What this cycle still owes (partial payments respected), > 0. */
  remaining: number;
  /** Due before today. */
  isOverdue: boolean;
}

/**
 * Every unpaid or part-paid cycle that is not skipped or deleted, whichever cycle of its bill it is.
 * `occurrences` may repeat an occurrence (e.g. the "current" cycle also listed in the full history): counted once by id.
 */
export function outstandingBillOccurrences(
  occurrences: ReadonlyArray<{ billId: string; occurrence: BillOccurrence }>,
  now: Date = new Date(),
): OutstandingBillOccurrence[] {
  const seen = new Set<string>();
  const today = dayStart(now);
  const out: OutstandingBillOccurrence[] = [];
  for (const { billId, occurrence } of occurrences) {
    if (seen.has(occurrence.id)) continue;
    seen.add(occurrence.id);
    if (occurrence.deletedAt != null) continue;
    const status = billOccurrenceStatus(occurrence, now);
    if (status === "paid" || status === "skipped") continue;
    const remaining = round2(Math.min(Math.max(occurrence.amount - occurrence.amountPaid, 0), occurrence.amount));
    if (remaining <= EPS) continue;
    out.push({ billId, occurrence, remaining, isOverdue: dayStart(occurrence.dueDate) < today });
  }
  return out.sort((a, b) => a.occurrence.dueDate.getTime() - b.occurrence.dueDate.getTime());
}

export interface BillObligationStats {
  /** Cycles already past due and still owing (includes part-paid ones). */
  overdueCount: number;
  overdueAmount: number;
  /** Cycles due today or later and still owing — kept apart from overdue. */
  upcomingCount: number;
  /** Remaining on cycles due in `now`'s calendar month. */
  dueThisMonth: number;
  /** Everything outstanding, overdue + upcoming. */
  outstandingTotal: number;
}

export function billObligationStats(outstanding: readonly OutstandingBillOccurrence[], now: Date = new Date()): BillObligationStats {
  let overdueCount = 0;
  let overdueAmount = 0;
  let upcomingCount = 0;
  let dueThisMonth = 0;
  let outstandingTotal = 0;
  for (const o of outstanding) {
    outstandingTotal += o.remaining;
    if (o.isOverdue) {
      overdueCount += 1;
      overdueAmount += o.remaining;
    } else {
      upcomingCount += 1;
    }
    const due = o.occurrence.dueDate;
    if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) dueThisMonth += o.remaining;
  }
  return { overdueCount, overdueAmount: round2(overdueAmount), upcomingCount, dueThisMonth: round2(dueThisMonth), outstandingTotal: round2(outstandingTotal) };
}

export interface BillCycleObligations {
  items: Array<OutstandingBillOccurrence & { carriedForward: boolean }>;
  /** Everything owed in the cycle, overdue carried over included. */
  total: number;
  count: number;
  /** The part of `total` that is already past due. */
  overdueTotal: number;
  overdueCount: number;
}

/** What Month Cycle / My Money owe for `range`: cycles due inside it, plus anything earlier and still past due (carried forward). */
export function billObligationsInCycle(
  outstanding: readonly OutstandingBillOccurrence[],
  range: { start: Date; end: Date },
  now: Date = new Date(),
): BillCycleObligations {
  const items = outstanding
    .filter((o) => isOwedInCycle(o.occurrence.dueDate, range, now))
    .map((o) => ({ ...o, carriedForward: dayStart(o.occurrence.dueDate) < dayStart(range.start) }));
  const overdue = items.filter((o) => o.isOverdue);
  return {
    items,
    total: round2(items.reduce((s, o) => s + o.remaining, 0)),
    count: items.length,
    overdueTotal: round2(overdue.reduce((s, o) => s + o.remaining, 0)),
    overdueCount: overdue.length,
  };
}
