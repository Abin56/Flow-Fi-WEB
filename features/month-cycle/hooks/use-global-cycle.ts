"use client";

/**
 * Reads/moves the ONE globally selected accounting cycle (top-bar navigator). Always resolves the
 * window with the same canonical engine every other cycle consumer uses (`cycleRangeFor`/
 * `adjacentCycleRange`/`cycleRangeForMonth`), against the user's real configured cycle RULE
 * (`useMonthCycleStartDay`) — this hook only moves which window is being viewed, never that rule.
 *
 * A page opts in by seeding its own local "browsed cycle" state from `referenceDay` and re-following
 * it until the user changes the cycle locally (see `useMonthCycleData`'s follow/override split). A
 * page that keeps its own independent period concept (calendar month, custom date range) simply never
 * reads this hook, exactly as before.
 */

import { useMemo } from "react";
import { adjacentCycleRange, cycleRangeFor, cycleRangeForMonth, isInCycle } from "@/lib/engines/month-cycle-range";
import { formatCycleLabel } from "@/lib/engines/person-cycle-statement";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { useGlobalCycleStore } from "@/store/global-cycle-store";

export function useGlobalCycle() {
  const monthCycleStartDay = useMonthCycleStartDay();
  const referenceDay = useGlobalCycleStore((s) => s.referenceDay);
  const setReferenceDay = useGlobalCycleStore((s) => s.setReferenceDay);
  const now = useMemo(() => new Date(), []);
  const referenceDate = referenceDay ?? now;

  const cycleRange = useMemo(() => cycleRangeFor(monthCycleStartDay, referenceDate), [monthCycleStartDay, referenceDate]);
  const isCurrentCycle = isInCycle(now, cycleRange);
  const label = useMemo(() => formatCycleLabel({ start: cycleRange.start, end: cycleRange.end }), [cycleRange]);

  return {
    now,
    referenceDay,
    cycleRange,
    label,
    isCurrentCycle,
    monthCycleStartDay,
    goToPreviousCycle: () => setReferenceDay(adjacentCycleRange(monthCycleStartDay, cycleRange, -1).start),
    goToNextCycle: () => setReferenceDay(adjacentCycleRange(monthCycleStartDay, cycleRange, 1).start),
    goToCurrentCycle: () => setReferenceDay(null),
    goToCycleForMonth: (year: number, month: number) => setReferenceDay(cycleRangeForMonth(monthCycleStartDay, year, month).start),
  };
}
