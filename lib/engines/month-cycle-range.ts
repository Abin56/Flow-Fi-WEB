/**
 * Pure Month Cycle window helpers (no React/Firebase) — the user's configured cycle range, cycle
 * stepping, and "is this obligation owed in this cycle" — shared by `use-month-cycle-data.ts` and tests.
 */

import { effectiveMonth, type Transaction } from "@/lib/models/transaction";

/**
 * A stored cycle start day coerced to a supported value: an integer 1–31 (29–31 clamp to the last day
 * of shorter months inside `cycleRangeFor`); anything missing or invalid falls back to 1 (calendar month).
 */
export function normalizeCycleStartDay(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(31, Math.max(1, Math.trunc(n)));
}

/** "1st", "2nd", "3rd", "11th", "18th", "21st" … */
export function ordinalDay(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  return `${day}${day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
}

/**
 * The user's configured Month Cycle window containing `now` — a plain
 * calendar month when `startDay` is 1 (every existing user's default,
 * unchanged), otherwise the `startDay`-to-`startDay`-minus-a-day-next-month
 * window (start day clamped to the month's length).
 */
export function cycleRangeFor(startDay: number, now: Date): { start: Date; end: Date } {
  if (startDay <= 1) {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
  }
  // Each cycle starts on `startDay` (clamped to short months: 31 → 28/29 Feb, 30 Apr…) and ends the day before
  // the next one starts — contiguous, never overlapping, correct across the year boundary. (`CycleAnchor`
  // reproduces a Dart month-arithmetic quirk that put January-ending cycles' start a year late; it stays
  // as-is for card statements, which must match the Flutter app.)
  const startIn = (year: number, month: number) => new Date(year, month, Math.min(startDay, new Date(year, month + 1, 0).getDate()));
  let start = startIn(now.getFullYear(), now.getMonth());
  if (now.getTime() < start.getTime()) start = startIn(now.getFullYear(), now.getMonth() - 1);
  const next = startIn(start.getFullYear(), start.getMonth() + 1);
  return { start, end: new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1, 23, 59, 59, 999) };
}

/**
 * The date a Transaction's My Spend is bucketed by in the Month Cycle (hero figure, drill-down rows, top
 * category): the purchase's own `dateTime` for a custom mid-month cycle, `effectiveMonth` (explicit
 * `accountingMonth` override, else the purchase's calendar month) for the plain calendar-month cycle. Never
 * the date a card bill, loan or person is later paid — those settlements are not spend (`my-spend.ts`).
 */
export function mySpendBucketDate(t: Transaction, isCustomCycle: boolean): Date {
  return isCustomCycle ? t.dateTime : effectiveMonth(t);
}

/**
 * The cycle immediately before (`-1`) or after (`+1`) `range` — the cycle containing the day before its start,
 * or the day after its end — so stepping never skips or repeats a cycle, whatever the start day or month length.
 */
export function adjacentCycleRange(startDay: number, range: { start: Date; end: Date }, direction: -1 | 1): { start: Date; end: Date } {
  const edge =
    direction < 0
      ? new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() - 1, 12)
      : new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1, 12);
  return cycleRangeFor(startDay, edge);
}

/**
 * The cycle named after calendar month `month` (0-based) of `year` — the calendar month itself for start day 1,
 * otherwise the cycle that ENDS in that month (e.g. start day 18, October → 18 Sep … 17 Oct), the same month the
 * cycle header names.
 */
export function cycleRangeForMonth(startDay: number, year: number, month: number): { start: Date; end: Date } {
  if (startDay <= 1) return cycleRangeFor(startDay, new Date(year, month, 1, 12));
  // The day before this month's (clamped) cycle start always lies in the cycle that ends in this month.
  const startThisMonth = Math.min(startDay, new Date(year, month + 1, 0).getDate());
  return cycleRangeFor(startDay, new Date(year, month, startThisMonth - 1, 12));
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
