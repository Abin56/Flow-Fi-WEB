/**
 * Money and calendar-day comparison for reconciliation — integer paise (no float drift) and IST calendar days.
 *
 * Amount bands (D4) are ADVISORY: a ₹0.02 or ₹1.00 difference makes a record a *possible* match to show the user,
 * never a rounded or merged value. Nothing here changes an amount.
 */

import type { AmountBand } from "./types";

export const PAISE_BAND_MAX = 10; // ₹0.10
export const ROUNDING_BAND_MAX = 100; // ₹1.00
export const DATE_WINDOW_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
/** India Standard Time has no daylight saving — a fixed +05:30. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

/** The band two amounts fall in, or null when they're more than ₹1.00 apart (not a candidate). */
export function amountBand(aPaise: number, bPaise: number): AmountBand | null {
  const diff = Math.abs(aPaise - bPaise);
  if (diff === 0) return "exact";
  if (diff <= PAISE_BAND_MAX) return "paise";
  if (diff <= ROUNDING_BAND_MAX) return "rounding";
  return null;
}

/**
 * IST calendar-day index of an instant — for existing transactions and SMS, whose `dateTime` is a real moment
 * (an 11:45 pm IST purchase is that IST day, even though it's the previous day in UTC).
 */
export function istDayIndex(instant: Date): number {
  return Math.floor((instant.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/**
 * Calendar-day index of a statement date — a captured row's date is a calendar date (parsed at local midnight),
 * not an instant, so its local Y/M/D is taken as-is. In an IST browser this equals `istDayIndex` for the same
 * date; elsewhere it still names the date printed on the statement.
 */
export function calendarDayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** "₹0.02 more", "₹1.00 less", "same amount" — existing relative to the statement. */
export function describeAmountDelta(deltaPaise: number): string {
  if (deltaPaise === 0) return "Same amount";
  const rupees = (Math.abs(deltaPaise) / 100).toFixed(2);
  return `₹${rupees} ${deltaPaise > 0 ? "more" : "less"} in FlowFi`;
}

/** "Same day", "1 day later", "2 days earlier" — existing relative to the statement. */
export function describeDayGap(dayGap: number): string {
  if (dayGap === 0) return "Same day";
  const n = Math.abs(dayGap);
  return `${n} day${n === 1 ? "" : "s"} ${dayGap > 0 ? "later" : "earlier"} in FlowFi`;
}
