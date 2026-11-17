/**
 * Upcoming-cycle alert — pure rules (no React, no Firebase I/O) behind the in-app "Upcoming cycle" reminder.
 *
 * What it is: a heads-up, a day before the NEXT Month Cycle starts, of the collections that were postponed INTO that
 * cycle ("DAD ₹1,000, Rahul ₹2,000 · expected from 18 Nov"). What it is not: an overdue notice (those are the
 * follow-up reminders / the "lapsed" deferral status) and never a write — it reads deferrals and each obligation's
 * live remaining and produces a list. Nothing here records a payment or changes a balance.
 *
 * Cycles come from the canonical Month Cycle helpers (`cycleContaining` / `shiftCycle`), so a custom start day, short
 * months and the December → January rollover are handled by the same code every other People screen uses.
 */

import { cycleContaining, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { resolveExpectedCycle } from "@/lib/engines/person-payment-deferral";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

const EPSILON = 0.005;
/** The reminder appears this many days before the next cycle starts (configurable later — one place to change). */
export const UPCOMING_LEAD_DAYS = 1;

const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY_MS = 86_400_000;

/** Whole days from `today` to `date` (calendar days, DST-safe). */
export function daysBetween(today: Date, date: Date): number {
  return Math.round((dayIdx(date) - dayIdx(today)) / DAY_MS);
}

export interface UpcomingWindow {
  /** The cycle that starts next. */
  cycle: StatementCycle;
  /** Whole days until it starts (≥ 1: on the start day itself the cycle is current, not upcoming). */
  daysAway: number;
}

/**
 * The next cycle, when today is inside the reminder window (1 … `leadDays` days before it starts); otherwise null.
 * Read from the Month Cycle start day, never from a calendar month.
 */
export function upcomingCycleWindow(today: Date, startDay: number, leadDays: number = UPCOMING_LEAD_DAYS): UpcomingWindow | null {
  const next = shiftCycle(cycleContaining(today, startDay), 1, startDay);
  const daysAway = daysBetween(today, next.start);
  return daysAway >= 1 && daysAway <= Math.max(1, leadDays) ? { cycle: next, daysAway } : null;
}

export interface UpcomingCollection {
  personId: string;
  personName: string;
  obligationKey: string;
  title: string;
  /** The obligation's live remaining — what is still to collect. */
  amount: number;
  /** The exact day when one was chosen, else the cycle's first day. */
  expectedOn: Date;
}

export interface UpcomingCycleAlert {
  cycle: StatementCycle;
  daysAway: number;
  items: UpcomingCollection[];
  total: number;
  /** One row per person (their items summed), largest first. */
  people: { personId: string; personName: string; amount: number; count: number }[];
}

/**
 * Collections postponed into the upcoming cycle, with what is still owed on each. An obligation with nothing left
 * (paid, deleted) is skipped — the reminder never keeps a closed debt alive. Null outside the reminder window or with
 * nothing postponed there.
 */
export function upcomingCycleAlert(input: {
  today: Date;
  startDay: number;
  leadDays?: number;
  people: readonly { id: string; name: string }[];
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  /** Live remaining per obligation key for one person (from the all-time statement). */
  remainingOf: (personId: string) => ReadonlyMap<string, number>;
}): UpcomingCycleAlert | null {
  const window = upcomingCycleWindow(input.today, input.startDay, input.leadDays);
  if (!window) return null;
  const items: UpcomingCollection[] = [];
  for (const person of input.people) {
    const deferrals = input.deferralsByPerson[person.id] ?? [];
    if (deferrals.length === 0) continue;
    const remaining = input.remainingOf(person.id);
    for (const d of deferrals) {
      if (d.state !== "active" || d.expected == null) continue;
      const cycle = resolveExpectedCycle(d.expected, input.startDay);
      if (cycle == null || cycle.start.getTime() !== window.cycle.start.getTime()) continue;
      const left = remaining.get(d.obligationKey) ?? 0;
      if (left <= EPSILON) continue;
      items.push({
        personId: person.id,
        personName: person.name,
        obligationKey: d.obligationKey,
        title: d.obligationTitle,
        amount: Math.round(left * 100) / 100,
        expectedOn: d.expected.date ?? window.cycle.start,
      });
    }
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.expectedOn.getTime() - b.expectedOn.getTime() || a.personName.localeCompare(b.personName) || b.amount - a.amount);
  const byPerson = new Map<string, { personId: string; personName: string; amount: number; count: number }>();
  for (const i of items) {
    const row = byPerson.get(i.personId) ?? { personId: i.personId, personName: i.personName, amount: 0, count: 0 };
    row.amount = Math.round((row.amount + i.amount) * 100) / 100;
    row.count += 1;
    byPerson.set(i.personId, row);
  }
  return {
    cycle: window.cycle,
    daysAway: window.daysAway,
    items,
    total: Math.round(items.reduce((t, i) => t + i.amount, 0) * 100) / 100,
    people: [...byPerson.values()].sort((a, b) => b.amount - a.amount || a.personName.localeCompare(b.personName)),
  };
}

/** Cheap pre-check (no statements): is any active deferral expected in the next cycle while the window is open? */
export function hasUpcomingCandidate(deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>, today: Date, startDay: number, leadDays: number = UPCOMING_LEAD_DAYS): boolean {
  const window = upcomingCycleWindow(today, startDay, leadDays);
  if (!window) return false;
  return Object.values(deferralsByPerson).some((list) =>
    list.some((d) => {
      if (d.state !== "active" || d.expected == null) return false;
      return resolveExpectedCycle(d.expected, startDay)?.start.getTime() === window.cycle.start.getTime();
    }),
  );
}

/** Dismissal key: one reminder per cycle, so it never repeats once the user has seen it (and is fresh next cycle). */
export function upcomingAlertKey(cycle: StatementCycle): string {
  return `${cycle.start.getFullYear()}-${String(cycle.start.getMonth() + 1).padStart(2, "0")}-${String(cycle.start.getDate()).padStart(2, "0")}`;
}
