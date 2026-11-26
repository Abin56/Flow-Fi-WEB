/**
 * "Due now" beside "Total outstanding" for money a person owes me — a READ-ONLY projection over what already exists:
 * the People statement's open items and the postponements stored by `person-payment-deferral.ts`. Nothing here writes,
 * and no balance, statement figure, payment allocation or advance rule reads it.
 *
 *   due now = total outstanding − open amounts postponed to AFTER the viewed cycle
 *
 * Only for the current cycle and future ones. A postponement is stored as it stands TODAY, so applying it to a closed
 * cycle would restate what was due back then: a closed cycle gets no projection at all (null).
 *
 * A payment not tied to one item already lowers the total, and `postponed` is capped at that total — so such money
 * counts against what is due now first, and neither figure can go below zero.
 */

import { cycleContaining, type StatementCycle, type StatementRow } from "@/lib/engines/person-cycle-statement";
import { defaultTargetCycle, deferralView, resolveExpectedCycle, type DeferralView } from "@/lib/engines/person-payment-deferral";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

const EPSILON = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The cycle ended before today — history, never re-projected. */
export function isClosedCycle(cycle: StatementCycle, today: Date = new Date()): boolean {
  return dayIdx(cycle.end) < dayIdx(today);
}

/** Expected only after `cycle` ends: the chosen day when there is one, else the expected cycle's first day. */
export function isPostponedBeyond(view: Pick<DeferralView, "status" | "date" | "cycle">, cycle: StatementCycle): boolean {
  return view.status !== "resolved" && dayIdx(view.date ?? view.cycle.start) > dayIdx(cycle.end);
}

export interface DueNowProjection {
  total: number;
  postponed: number;
  dueNow: number;
}

export type DueNowRow = Pick<StatementRow, "key" | "kind" | "date" | "signedAmount" | "remainingNow">;

export function projectDueNow(params: {
  /** What they owe me at the cycle's end — the statement's own figure; returned unchanged. */
  total: number;
  /** The person's statement rows over their whole history (`remainingNow` = still open today). */
  rows: readonly DueNowRow[];
  deferrals: readonly PersonPaymentDeferral[];
  cycle: StatementCycle;
  startDay: number;
  today?: Date;
}): DueNowProjection | null {
  const today = params.today ?? new Date();
  if (isClosedCycle(params.cycle, today)) return null;
  const byKey = new Map(params.deferrals.map((d) => [d.obligationKey, d]));
  let postponed = 0;
  for (const row of params.rows) {
    if (row.kind !== "obligation" || row.signedAmount <= 0 || (row.remainingNow ?? 0) <= EPSILON) continue;
    // Dated after the cycle: not part of this cycle's total, so there is nothing to take out of it.
    if (dayIdx(row.date) > dayIdx(params.cycle.end)) continue;
    const deferral = byKey.get(row.key);
    const view = deferral ? deferralView(deferral, row.remainingNow, params.startDay, today) : null;
    if (view && isPostponedBeyond(view, params.cycle)) postponed += row.remainingNow!;
  }
  const total = round2(Math.max(0, params.total));
  const capped = round2(Math.min(postponed, total));
  return { total, postponed: capped, dueNow: round2(total - capped) };
}

export type QuickPostpone =
  /** One click moves the expectation to `target`. */
  | { allowed: true; target: StatementCycle }
  /** Already expected in a cycle after today's — a second click must not push it further. */
  | { allowed: false; cycle: StatementCycle; date: Date | null };

/**
 * The one-click "Postpone → next cycle". Allowed while nothing is postponed, and again once the expected cycle has
 * arrived (or passed) with money still open. The target is the People engine's own default: the cycle after whichever
 * is latest — today's, the item's own, or the current expectation.
 */
export function quickPostpone(params: { deferral: PersonPaymentDeferral | null | undefined; obligationDate: Date; startDay: number; today?: Date }): QuickPostpone {
  const today = params.today ?? new Date();
  const active = params.deferral?.state === "active" ? params.deferral.expected : null;
  const expected = resolveExpectedCycle(active, params.startDay);
  if (expected && expected.start.getTime() > cycleContaining(today, params.startDay).start.getTime()) {
    return { allowed: false, cycle: expected, date: active?.date ?? null };
  }
  return { allowed: true, target: defaultTargetCycle(params.obligationDate, today, params.startDay, expected) };
}
