"use client";

import { ChevronLeft, ChevronRight, RotateCcw, UserPlus, X } from "lucide-react";
import { CompactHeaderBar } from "@/components/layout/compact-header";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { formatCycleLabel, sameCycle, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { cn } from "@/lib/utils";

const NAV_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-[5px] text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const FIGURE_LABEL = "text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/**
 * The compact People Ledger bar: cycle nav (same `onCycleChange`/`current` the expanded control drives), the same
 * "You need to receive" figure the cycle summary's hero shows, and Add Person (same handler as the header). No new
 * figures or actions. Only mounted on the list view — the person-detail view is its own page-replacing workspace.
 */
export function PeopleCompactBar({
  progress,
  reduceMotion,
  top,
  cycle,
  current,
  onCycleChange,
  toReceive,
  addPersonOpen,
  onToggleAddPerson,
  addDisabled,
}: {
  progress: number;
  reduceMotion: boolean;
  /** `barTop` from `useCompactHeader`. */
  top: number;
  cycle: StatementCycle;
  current: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  toReceive: number;
  addPersonOpen: boolean;
  onToggleAddPerson: () => void;
  addDisabled: boolean;
}) {
  const startDay = useMonthCycleStartDay();
  const isCurrent = sameCycle(cycle, current);

  return (
    <CompactHeaderBar label="People Ledger quick bar" progress={progress} reduceMotion={reduceMotion} top={top}>
      <span className="min-w-0 shrink-0 truncate px-2 font-heading text-sm font-bold tracking-tight text-foreground">People Ledger</span>

      <div className="flex shrink-0 items-center gap-0.5">
        {!isCurrent && (
          <button type="button" onClick={() => onCycleChange(current)} aria-label="Back to current cycle" className={NAV_BUTTON}>
            <RotateCcw className="size-3.5" strokeWidth={2} />
          </button>
        )}
        <button type="button" onClick={() => onCycleChange(shiftCycle(cycle, -1, startDay))} aria-label="Previous cycle" className={NAV_BUTTON}>
          <ChevronLeft className="size-4" strokeWidth={1.9} />
        </button>
        <span className="min-w-[5.5rem] truncate px-1 text-center text-xs font-semibold text-foreground">{formatCycleLabel(cycle, false)}</span>
        <button
          type="button"
          onClick={() => onCycleChange(shiftCycle(cycle, 1, startDay))}
          aria-label="Next cycle"
          disabled={isCurrent}
          className={cn(NAV_BUTTON, "disabled:pointer-events-none disabled:opacity-30")}
        >
          <ChevronRight className="size-4" strokeWidth={1.9} />
        </button>
      </div>

      <span className="ml-auto hidden min-w-0 flex-col items-end px-2 text-right leading-tight sm:flex">
        <span className={cn(FIGURE_LABEL, "whitespace-nowrap")}>To receive</span>
        <Money amount={Math.round(toReceive)} className="text-sm leading-none font-bold whitespace-nowrap text-success" />
      </span>

      <button
        type="button"
        onClick={onToggleAddPerson}
        disabled={addDisabled}
        aria-expanded={addPersonOpen}
        aria-label={addPersonOpen ? "Close add person" : "Add Person"}
        className={cn(
          "ml-auto flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border px-2.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:ml-0 sm:px-3.5",
          addPersonOpen ? "border-border-strong bg-card text-foreground hover:bg-secondary" : "border-primary-accent-text bg-primary text-primary-foreground hover:opacity-90",
        )}
      >
        {addPersonOpen ? <X className="size-4" strokeWidth={2} /> : <UserPlus className="size-4" strokeWidth={2} />}
        <span className="hidden sm:inline">{addPersonOpen ? "Close" : "Add Person"}</span>
      </button>
    </CompactHeaderBar>
  );
}
