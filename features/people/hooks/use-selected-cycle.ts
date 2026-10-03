"use client";

import { useState } from "react";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { cycleContaining, type StatementCycle } from "@/lib/engines/person-cycle-statement";

/**
 * The People cycle selection, always a cycle of the user's global accounting cycle (Settings → Month
 * cycle). When the start day changes (or finishes loading), the selection is re-resolved to the new
 * cycle containing the old selection's last day, capped at the current cycle — so "current" stays
 * current. Only the grouping window moves; no record is touched.
 *
 * `anchor` (a cycle's start date from a `cycle=` return link) pins the selection to the cycle containing
 * that exact day instead — re-resolved the same way once the start day loads, so a return link always
 * lands on the cycle it was made from. Choosing another cycle drops the anchor.
 */
export function useSelectedCycle(initial?: StatementCycle, anchor?: Date | null): [StatementCycle, (next: StatementCycle) => void, number] {
  const startDay = useMonthCycleStartDay();
  const [state, setState] = useState(() => ({
    startDay,
    anchor: anchor ?? null,
    cycle: anchor != null ? capAtCurrent(cycleContaining(anchor, startDay), startDay) : (initial ?? cycleContaining(new Date(), startDay)),
  }));
  let { cycle } = state;
  if (state.startDay !== startDay) {
    // Adjust-state-during-render: React re-renders immediately, no stale-cycle frame. Never past the
    // current cycle — People navigation stops at "now".
    cycle = capAtCurrent(cycleContaining(state.anchor ?? state.cycle.end, startDay), startDay);
    setState({ startDay, anchor: state.anchor, cycle });
  }
  return [cycle, (next) => setState({ startDay, anchor: null, cycle: next }), startDay];
}

function capAtCurrent(candidate: StatementCycle, startDay: number): StatementCycle {
  const current = cycleContaining(new Date(), startDay);
  return candidate.start.getTime() > current.start.getTime() ? current : candidate;
}
