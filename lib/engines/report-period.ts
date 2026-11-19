/**
 * The reporting period shared by Reports and Analytics — a Month Cycle (the user's configured start day), a plain
 * calendar month, or a custom date range. Pure; built only on the Month Cycle window helpers in
 * `month-cycle-range.ts`, so "this cycle" here is exactly the window the Month Cycle page shows.
 *
 * `monthGranular` is the bucketing rule every figure of the period uses (the Month Cycle rule, `mySpendBucketDate`):
 *  - a calendar-month window (a calendar month, or a cycle when the start day is 1) buckets by `effectiveMonth`, so a
 *    "count this in month X" override is honoured;
 *  - a custom mid-month cycle or a custom range buckets by the transaction's real date.
 */

import { adjacentCycleRange, cycleRangeFor, isInCycle } from "@/lib/engines/month-cycle-range";

export type ReportPeriodSelection =
  /** 0 = the cycle containing today, -1 = the previous one, … */
  | { kind: "cycle"; offset: number }
  /** A calendar month (`month` 0-based). */
  | { kind: "month"; year: number; month: number }
  /** Inclusive custom range (start-of-day … end-of-day). */
  | { kind: "range"; start: Date; end: Date };

export interface ReportPeriod {
  kind: ReportPeriodSelection["kind"];
  start: Date;
  end: Date;
  monthGranular: boolean;
  /** Full label: "November 2026", "18 Oct – 17 Nov 2026", "1 Oct – 15 Nov 2026". */
  label: string;
  /** Axis label: "Nov", "Nov '25" when `withYear`. */
  shortLabel: string;
  /** Today falls inside it. */
  isCurrent: boolean;
  /** Days in the window (whole days). */
  days: number;
  /** Days already elapsed (= `days` for a past window, 0 for a future one). */
  daysElapsed: number;
}

const MS_PER_DAY = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function monthRange(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(year, month, 1), end: new Date(year, month + 1, 0, 23, 59, 59, 999) };
}

function isWholeCalendarMonth(range: { start: Date; end: Date }): boolean {
  const m = monthRange(range.start.getFullYear(), range.start.getMonth());
  return m.start.getTime() === range.start.getTime() && m.end.getTime() === range.end.getTime();
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const fmtDayYear = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function rangeLabel(start: Date, end: Date): string {
  return start.getFullYear() === end.getFullYear() ? `${fmtDay(start)} – ${fmtDayYear(end)}` : `${fmtDayYear(start)} – ${fmtDayYear(end)}`;
}

function build(kind: ReportPeriod["kind"], range: { start: Date; end: Date }, monthGranular: boolean, now: Date): ReportPeriod {
  const calendar = isWholeCalendarMonth(range);
  const label = calendar ? range.start.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) : rangeLabel(range.start, range.end);
  // A cycle is named after the month it ENDS in (the Month Cycle header rule, `cycleRangeForMonth`).
  const named = kind === "range" ? range.start : calendar ? range.start : range.end;
  const shortLabel = named.toLocaleDateString("en-IN", { month: "short" });
  const days = Math.round((startOfDay(range.end).getTime() - startOfDay(range.start).getTime()) / MS_PER_DAY) + 1;
  const elapsed =
    now.getTime() < range.start.getTime()
      ? 0
      : now.getTime() > range.end.getTime()
        ? days
        : Math.round((startOfDay(now).getTime() - startOfDay(range.start).getTime()) / MS_PER_DAY) + 1;
  return { kind, start: range.start, end: range.end, monthGranular, label, shortLabel, isCurrent: isInCycle(now, range), days, daysElapsed: elapsed };
}

export function resolveReportPeriod(selection: ReportPeriodSelection, startDay: number, now: Date): ReportPeriod {
  switch (selection.kind) {
    case "cycle": {
      let range = cycleRangeFor(startDay, now);
      const step = selection.offset < 0 ? -1 : 1;
      for (let i = 0; i < Math.abs(selection.offset); i++) range = adjacentCycleRange(startDay, range, step);
      // The Month Cycle rule: a start day of 1 is a calendar month (effectiveMonth), any other is day-granular.
      return build("cycle", range, startDay <= 1, now);
    }
    case "month":
      return build("month", monthRange(selection.year, selection.month), true, now);
    case "range": {
      const a = startOfDay(selection.start);
      const b = endOfDay(selection.end);
      const range = a.getTime() <= b.getTime() ? { start: a, end: b } : { start: startOfDay(selection.end), end: endOfDay(selection.start) };
      return build("range", range, false, now);
    }
  }
}

/**
 * The comparable period immediately before: the previous cycle (same start day), the previous calendar month, or the
 * equal-length window right before a custom range.
 */
export function previousReportPeriod(period: ReportPeriod, startDay: number, now: Date): ReportPeriod {
  if (period.kind === "cycle") return build("cycle", adjacentCycleRange(startDay, period, -1), period.monthGranular, now);
  if (period.kind === "month") return build("month", monthRange(period.start.getFullYear(), period.start.getMonth() - 1), true, now);
  const end = endOfDay(new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate() - 1));
  const start = startOfDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - (period.days - 1)));
  return build("range", { start, end }, false, now);
}

/**
 * `count` consecutive periods ending with `period` (oldest first) — cycles for a cycle, calendar months for a
 * calendar month or a custom range (a range's trend is the calendar months up to the month it ends in). Short labels
 * carry the year when the series spans more than one year.
 */
export function trendPeriods(period: ReportPeriod, startDay: number, count: number, now: Date): ReportPeriod[] {
  const out: ReportPeriod[] = [];
  if (period.kind === "cycle") {
    let current: ReportPeriod = period;
    out.unshift(current);
    for (let i = 1; i < count; i++) {
      current = previousReportPeriod(current, startDay, now);
      out.unshift(current);
    }
  } else {
    const anchor = period.kind === "month" ? period.start : period.end;
    for (let i = count - 1; i >= 0; i--) out.push(build("month", monthRange(anchor.getFullYear(), anchor.getMonth() - i), true, now));
  }
  const years = new Set(out.map((p) => (p.kind === "cycle" ? p.end : p.start).getFullYear()));
  if (years.size === 1) return out;
  // New objects — never mutate the caller's period (it may be a frozen React value).
  return out.map((p) => {
    const named = p.kind === "cycle" && !isWholeCalendarMonth(p) ? p.end : p.start;
    return { ...p, shortLabel: `${named.toLocaleDateString("en-IN", { month: "short" })} '${String(named.getFullYear()).slice(2)}` };
  });
}

/** The period that contains `date` — the same kind as `period` (used to drill a trend bar back into a period). */
export function selectionForTrendPoint(point: ReportPeriod, startDay: number, now: Date): ReportPeriodSelection {
  if (point.kind === "cycle") {
    // Count cycles between today's and this one.
    let offset = 0;
    let range = cycleRangeFor(startDay, now);
    const target = point.start.getTime();
    const step = target < range.start.getTime() ? -1 : 1;
    for (let guard = 0; guard < 600 && range.start.getTime() !== target; guard++) {
      range = adjacentCycleRange(startDay, range, step);
      offset += step;
    }
    return { kind: "cycle", offset };
  }
  return { kind: "month", year: point.start.getFullYear(), month: point.start.getMonth() };
}
