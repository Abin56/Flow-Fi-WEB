"use client";

import { useState } from "react";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { cycleContaining, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { useGlobalCycleStore } from "@/store/global-cycle-store";

/**
 * The People cycle selection, always a cycle of the user's global accounting cycle (Settings → Month
 * cycle). When the start day changes (or finishes loading), the selection is re-resolved to the new
 * cycle containing the old selection's last day, capped at the current cycle — so "current" stays
 * current. Only the grouping window moves; no record is touched.
 *
 * `anchor` (a cycle's start date from a `cycle=` return link) pins the selection to the cycle containing
 * that exact day instead — re-resolved the same way once the start day loads, so a return link always
 * lands on the cycle it was made from. Choosing another cycle drops the anchor.
 *
 * With neither `initial` nor `anchor` (the People Ledger list's own top-level call), the selection instead
 * FOLLOWS the top-bar's global cycle (`store/global-cycle-store.ts`) until the user picks a cycle on this
 * page, which detaches it into a local override — `followGlobal()` (the 5th tuple element) re-attaches it.
 * Always capped at "now": the global cycle may be ahead, but People navigation never goes past the current
 * cycle, exactly as before. A caller that passes `initial` (e.g. the per-person detail page, opened already
 * holding the list's active cycle) never follows the global cycle directly — it only ever shows what it's given.
 */
export function useSelectedCycle(
  initial?: StatementCycle,
  anchor?: Date | null,
): [StatementCycle, (next: StatementCycle) => void, number, boolean, () => void] {
  const startDay = useMonthCycleStartDay();
  const globalReferenceDay = useGlobalCycleStore((s) => s.referenceDay);
  // `anchor` is `Date | null` at the call site even when no return link is present (never `undefined` there),
  // so "no anchor" must treat null and undefined the same way `anchor != null` does everywhere else here.
  const canFollowGlobal = initial === undefined && anchor == null;

  const [state, setState] = useState(() => ({
    anchor: anchor ?? null,
    followsGlobal: canFollowGlobal,
    cycle:
      anchor != null
        ? cycleContaining(anchor, startDay)
        : (initial ?? cycleContaining(canFollowGlobal ? globalReferenceDay ?? new Date() : new Date(), startDay)),
  }));

  // Re-resolved every render from whichever day currently pins it (anchor > global-follow > the last picked
  // cycle's own end day) — handles a start-day change AND a moving global cycle with the same one rule, and
  // never past "now". Only replaces `state.cycle` (keeping its reference otherwise) when the value actually
  // changes, so dependants keyed on the returned cycle don't re-run every render for no reason.
  const pinDay = state.anchor ?? (state.followsGlobal ? globalReferenceDay ?? new Date() : state.cycle.end);
  const recomputed = capAtCurrent(cycleContaining(pinDay, startDay), startDay);
  const cycle = recomputed.start.getTime() === state.cycle.start.getTime() && recomputed.end.getTime() === state.cycle.end.getTime() ? state.cycle : recomputed;
  if (cycle !== state.cycle) {
    // Adjust-state-during-render: React re-renders immediately, no stale-cycle frame.
    setState((s) => ({ ...s, cycle }));
  }

  return [
    cycle,
    (next) => setState({ anchor: null, followsGlobal: false, cycle: next }),
    startDay,
    state.followsGlobal,
    () => setState({ anchor: null, followsGlobal: true, cycle }),
  ];
}

function capAtCurrent(candidate: StatementCycle, startDay: number): StatementCycle {
  const current = cycleContaining(new Date(), startDay);
  return candidate.start.getTime() > current.start.getTime() ? current : candidate;
}
