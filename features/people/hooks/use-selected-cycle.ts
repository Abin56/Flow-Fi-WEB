"use client";

import { useState } from "react";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { cycleContaining, type StatementCycle } from "@/lib/engines/person-cycle-statement";

/**
 * The People cycle selection, always a cycle of the user's global accounting cycle (Settings → Month
 * cycle). When the start day changes (or finishes loading), the selection is re-resolved to the new
 * cycle containing the old selection's last day, capped at the current cycle — so "current" stays
 * current. Only the grouping window moves; no record is touched.
 */
export function useSelectedCycle(initial?: StatementCycle): [StatementCycle, (next: StatementCycle) => void, number] {
  const startDay = useMonthCycleStartDay();
  const [state, setState] = useState(() => ({ startDay, cycle: initial ?? cycleContaining(new Date(), startDay) }));
  let { cycle } = state;
  if (state.startDay !== startDay) {
    // Adjust-state-during-render: React re-renders immediately, no stale-cycle frame. Never past the
    // current cycle — People navigation stops at "now".
    const current = cycleContaining(new Date(), startDay);
    const candidate = cycleContaining(state.cycle.end, startDay);
    cycle = candidate.start.getTime() > current.start.getTime() ? current : candidate;
    setState({ startDay, cycle });
  }
  return [cycle, (next) => setState({ startDay, cycle: next }), startDay];
}
