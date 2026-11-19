import { candidateDayKey } from "./filters";

/**
 * Day-wise browsing for the Inbox grid — pure, so it can be unit tested without the ledger.
 *
 * Everything here is derived from the `transactionDate` the candidates already carry (grouped by LOCAL calendar day, exactly
 * like the list's day headings). Nothing is written, nothing is re-sorted: the caller hands in rows already in display order
 * and gets them back bucketed by day in that same order.
 */

export interface DayEntry {
  /** Local `YYYY-MM-DD`. */
  key: string;
  /** Local `YYYY-MM`. */
  monthKey: string;
  /** Candidates on this day under the filters the caller applied. */
  count: number;
}

export interface MonthEntry {
  /** Local `YYYY-MM`. */
  key: string;
  /** Candidates in this month (sum of its days). */
  count: number;
  /** Days of this month that have at least one candidate. */
  dayCount: number;
}

export interface DayIndex<T> {
  /** Days that have candidates, oldest → newest (calendar order, the way the strip reads left → right). Never contains an empty day. */
  days: DayEntry[];
  /** Months that have candidates, oldest → newest. */
  months: MonthEntry[];
  /** Candidates per day key, each list in the order they were handed in (the active sort). */
  byDay: Map<string, T[]>;
}

/** Buckets `items` (already in display order) by the local day `dateOf` returns. Every item lands in exactly one day. */
export function buildDayIndex<T>(items: readonly T[], dateOf: (item: T) => Date): DayIndex<T> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const key = candidateDayKey(dateOf(item));
    const list = byDay.get(key);
    if (list) list.push(item);
    else byDay.set(key, [item]);
  }
  const days: DayEntry[] = [...byDay.entries()]
    .map(([key, list]) => ({ key, monthKey: key.slice(0, 7), count: list.length }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const months = new Map<string, MonthEntry>();
  for (const day of days) {
    const month = months.get(day.monthKey);
    if (month) {
      month.count += day.count;
      month.dayCount += 1;
    } else months.set(day.monthKey, { key: day.monthKey, count: day.count, dayCount: 1 });
  }
  return { days, months: [...months.values()], byDay };
}

/** The month a day key belongs to. */
export function monthOfDay(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/**
 * The day to show when nothing was chosen yet: the day of the first row in display order for a date sort (so "Oldest first"
 * opens on the oldest day), otherwise the newest day.
 */
export function defaultDay(days: readonly DayEntry[], firstRowDay: string | null): string | null {
  if (days.length === 0) return null;
  if (firstRowDay && days.some((d) => d.key === firstRowDay)) return firstRowDay;
  return days[days.length - 1].key;
}

function dayNumber(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * Keeps the reviewer's chosen day while it still has candidates; when it has none (filters changed, or its last card was
 * dismissed) the closest remaining day takes over — the later one on a tie. Returns null only when there are no days at all.
 * `preferred` is never rewritten by this, so clearing the filter brings the original day straight back.
 */
export function resolveDay(preferred: string | null, days: readonly DayEntry[], fallback: string | null): string | null {
  if (days.length === 0) return null;
  if (preferred && days.some((d) => d.key === preferred)) return preferred;
  if (!preferred) return fallback && days.some((d) => d.key === fallback) ? fallback : days[days.length - 1].key;
  const target = dayNumber(preferred);
  let best = days[0];
  let bestGap = Infinity;
  for (const day of days) {
    const gap = Math.abs(dayNumber(day.key) - target);
    // `<=` over an ascending list: on a tie the later day wins.
    if (gap <= bestGap) {
      best = day;
      bestGap = gap;
    }
  }
  return best.key;
}

/** The neighbouring day that has candidates (-1 = earlier, +1 = later), or null at the end of the range. Crosses month and year boundaries. */
export function adjacentDay(current: string | null, days: readonly DayEntry[], delta: -1 | 1): string | null {
  if (!current) return null;
  const i = days.findIndex((d) => d.key === current);
  if (i < 0) return null;
  return days[i + delta]?.key ?? null;
}

/** The neighbouring month that has candidates (-1 = earlier, +1 = later), or null. Empty months are skipped. */
export function adjacentMonth(currentMonth: string | null, months: readonly MonthEntry[], delta: -1 | 1): string | null {
  if (!currentMonth) return null;
  const i = months.findIndex((m) => m.key === currentMonth);
  if (i < 0) return null;
  return months[i + delta]?.key ?? null;
}

/** The first or last day (with candidates) of a month. */
export function edgeDayOfMonth(monthKey: string, days: readonly DayEntry[], edge: "first" | "last"): string | null {
  const inMonth = days.filter((d) => d.monthKey === monthKey);
  if (inMonth.length === 0) return null;
  return (edge === "first" ? inMonth[0] : inMonth[inMonth.length - 1]).key;
}

function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const CHIP_WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short" });
const LONG_WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "long" });
const FULL_DATE = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "long", year: "numeric" });
const SHORT_DATE = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
const MONTH_ONLY = new Intl.DateTimeFormat("en-IN", { month: "long" });

/** The two lines of a day chip: "03" and "Sat". */
export function formatDayChip(dayKey: string): { day: string; weekday: string } {
  const date = parseDayKey(dayKey);
  return { day: String(date.getDate()).padStart(2, "0"), weekday: CHIP_WEEKDAY.format(date) };
}

/** "Saturday, 03 October 2026" for a screen reader / tooltip. */
export function formatDayLong(dayKey: string): string {
  const date = parseDayKey(dayKey);
  return `${LONG_WEEKDAY.format(date)}, ${FULL_DATE.format(date)}`;
}

/** "03 Oct" — a compact target for the previous / next day buttons. */
export function formatDayShort(dayKey: string): string {
  return SHORT_DATE.format(parseDayKey(dayKey));
}

/** The heading over the cards: "03 October 2026", plus "Today" / "Yesterday" when it is one (calendar days, not 24h blocks). */
export function formatDayTitle(dayKey: string, now: Date = new Date()): { title: string; relative: "Today" | "Yesterday" | null } {
  const title = FULL_DATE.format(parseDayKey(dayKey));
  if (dayKey === candidateDayKey(now)) return { title, relative: "Today" };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === candidateDayKey(yesterday)) return { title, relative: "Yesterday" };
  return { title, relative: null };
}

/** "October 2026" for `"2026-10"`. */
export function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return MONTH_YEAR.format(new Date(y, m - 1, 1));
}

/** "October" for `"2026-10"` (used under a year heading). */
export function formatMonthName(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return MONTH_ONLY.format(new Date(y, m - 1, 1));
}

/** The months grouped under their year, newest year first and newest month first inside it — the month menu's order. */
export function groupMonthsByYear(months: readonly MonthEntry[]): { year: string; months: MonthEntry[] }[] {
  const out: { year: string; months: MonthEntry[] }[] = [];
  for (const month of [...months].sort((a, b) => b.key.localeCompare(a.key))) {
    const year = month.key.slice(0, 4);
    const last = out[out.length - 1];
    if (last && last.year === year) last.months.push(month);
    else out.push({ year, months: [month] });
  }
  return out;
}
