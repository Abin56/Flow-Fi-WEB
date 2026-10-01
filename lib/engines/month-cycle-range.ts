/**
 * Pure Month Cycle window helpers (no React/Firebase) — the user's configured cycle range, cycle
 * stepping, and "is this obligation owed in this cycle" — shared by `use-month-cycle-data.ts` and tests.
 */

import { CycleAnchor } from "@/lib/engines/cycle-engine";

/**
 * The user's configured Month Cycle window containing `now` — a plain
 * calendar month when `startDay` is 1 (every existing user's default,
 * unchanged), otherwise the `startDay`-to-`startDay`-minus-a-day-next-month
 * window built on the same `CycleAnchor` engine credit card statement cycles
 * already use (anchored one day early, at `startDay - 1`, since the engine's
 * anchor day is defined as the cycle's *closing* day — anchoring at
 * `startDay - 1` makes `startDay` itself the first day of the next cycle).
 */
export function cycleRangeFor(startDay: number, now: Date): { start: Date; end: Date } {
  if (startDay <= 1) {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
  }
  const period = new CycleAnchor(startDay - 1).currentCycleFor(now);
  return {
    start: new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate()),
    end: new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate(), 23, 59, 59, 999),
  };
}

export function isInCycle(date: Date, range: { start: Date; end: Date }): boolean {
  return date.getTime() >= range.start.getTime() && date.getTime() <= range.end.getTime();
}

/**
 * Whether an unpaid obligation due on `dueDate` is owed in `range`: due inside it, or due in an earlier
 * cycle and already past due by `now` (carried forward) — the same rule `loanCycleDues` and
 * `cardBillsDueInCycle` apply, so nothing unpaid silently disappears when the cycle rolls over.
 */
export function isOwedInCycle(dueDate: Date, range: { start: Date; end: Date }, now: Date): boolean {
  if (isInCycle(dueDate, range)) return true;
  const day = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate()).getTime();
  const start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return day < start && day < today;
}

/**
 * `date` shifted by `months` calendar months, day-of-month clamped to the target month's last
 * valid day (so e.g. 31 Aug + 1 month lands on 30 Sep, not rolls over into October) — used to
 * step the cycle-switcher between cycles. A fixed day-of-month shift always lands somewhere
 * inside the target cycle's ~month-long window, since each cycle corresponds to exactly one
 * such step regardless of `startDay`.
 */
export function shiftMonthsClamped(date: Date, months: number): Date {
  const targetMonthIndex = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), lastDayOfTargetMonth));
}
