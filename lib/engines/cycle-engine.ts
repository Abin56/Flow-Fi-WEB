/**
 * Direct port of the shared Payment Cycle / Carry-Forward engine from
 * `lib/core/payment_schedule/domain/{cycle_anchor,cycle_item,cycle_engine}.dart`.
 *
 * Rule (unchanged from Flutter): for every item, classify its `cycleDate`
 * relative to `now` using a single anchor day of month.
 *  - Previous cycle, NOT settled -> carried into `previousCyclePending`.
 *  - Previous cycle, settled -> dropped entirely (never shown again here).
 *  - Current cycle -> always in `current`, paid or not.
 *  - Future cycle -> always in `future`, never in `current`/`previousCyclePending`.
 *
 * No UI or Firebase dependency — pure functions/types only.
 */

export type CycleClassification = "previous" | "current" | "future";

export interface CyclePeriod {
  start: Date;
  end: Date;
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

function periodContains(period: CyclePeriod, date: Date): boolean {
  const day = dateOnly(date);
  const start = dateOnly(period.start);
  const end = dateOnly(period.end);
  return !isBefore(day, start) && !isAfter(day, end);
}

function dayInMonth(year: number, month: number, day: number): Date {
  // month is 1-based here, mirroring the Dart implementation's inputs.
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const clampedDay = day > lastDayOfMonth ? lastDayOfMonth : day;
  return new Date(year, month - 1, clampedDay);
}

/** Dart's `~/` (truncating integer division, truncates toward zero). */
function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Dart's `%` on int (floored — always non-negative for a positive divisor). */
function flooredMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/**
 * Faithful port of `CycleAnchor._addMonths`, INCLUDING its use of Dart's
 * `~/` (truncating division) for the year, which — unlike a floor-based
 * division — can produce a year that doesn't match `%`'s floored month for
 * certain negative offsets (e.g. `_addMonths(31 Jan, -1)` lands on
 * `1 Jan of the FOLLOWING year`, not `1 Dec of the previous year`, because
 * `-1 ~/ 12 == 0` while `-1 % 12 == 11`). This is intentionally reproduced
 * bit-for-bit rather than "fixed", per the exact-port requirement — the
 * Flutter app is the source of truth and the web app must return identical
 * carry-forward classifications even where this diverges from what a
 * flooring implementation would produce.
 */
function addMonths(date: Date, months: number): Date {
  // date.month - 1 + months, 0-based, mirrors `date.month - 1 + months` in Dart (date.month is 1-based there).
  const targetMonthIndex = date.getMonth() + months;
  const targetYear = date.getFullYear() + truncDiv(targetMonthIndex, 12);
  const targetMonth = flooredMod(targetMonthIndex, 12) + 1; // 1-based
  return dayInMonth(targetYear, targetMonth, date.getDate());
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * A recurring monthly cycle boundary defined by a single anchor day of
 * month (default 17th) — e.g. a credit card's statement day.
 */
export class CycleAnchor {
  readonly anchorDay: number;

  constructor(anchorDay = 17) {
    this.anchorDay = anchorDay;
  }

  /** The CyclePeriod whose window contains `now` (the in-progress cycle). */
  currentCycleFor(now: Date = new Date()): CyclePeriod {
    const today = dateOnly(now);
    let end = dayInMonth(today.getFullYear(), today.getMonth() + 1, this.anchorDay);
    if (isBefore(end, today)) {
      end = addMonths(end, 1);
    }
    const start = addDays(addMonths(end, -1), 1);
    return { start, end };
  }

  /** The CyclePeriod immediately before currentCycleFor. */
  previousCycleFor(now: Date = new Date()): CyclePeriod {
    const current = this.currentCycleFor(now);
    const end = addMonths(current.end, -1);
    const start = addDays(addMonths(end, -1), 1);
    return { start, end };
  }

  /** Classifies `date` as previous/current/future relative to `now`. */
  classify(date: Date, now: Date = new Date()): CycleClassification {
    const current = this.currentCycleFor(now);
    if (periodContains(current, date)) return "current";
    if (isBefore(dateOnly(date), dateOnly(current.start))) return "previous";
    return "future";
  }
}

/**
 * The minimal feature-agnostic shape the cycle engine needs from any due
 * item (a Statement, Bill, or Installment) — mirrors Dart's `CycleItem`.
 */
export interface CycleItem {
  id: string;
  cycleDate: Date;
  isSettled: boolean;
  /** Defaults to true (every current source is carry-forward-eligible). */
  carryForwardEligible?: boolean;
}

export interface CycleEngineResult<T extends CycleItem> {
  previousCyclePending: T[];
  current: T[];
  future: T[];
}

/**
 * Classifies `items` against `anchor`, returning which are carried-forward
 * pending, current-cycle, or future-cycle. Pure — no I/O.
 */
export function classifyForCarryForward<T extends CycleItem>(
  items: T[],
  anchor: CycleAnchor,
  now: Date = new Date(),
): CycleEngineResult<T> {
  const previousCyclePending: T[] = [];
  const current: T[] = [];
  const future: T[] = [];

  for (const item of items) {
    const classification = anchor.classify(item.cycleDate, now);
    switch (classification) {
      case "previous": {
        const eligible = item.carryForwardEligible ?? true;
        if (!item.isSettled && eligible) previousCyclePending.push(item);
        break;
      }
      case "current":
        current.push(item);
        break;
      case "future":
        future.push(item);
        break;
    }
  }

  return { previousCyclePending, current, future };
}
