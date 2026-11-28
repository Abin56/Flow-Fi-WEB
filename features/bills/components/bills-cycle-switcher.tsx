"use client";

import { CalendarDays, ChevronLeft, ChevronRight, Info, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface BillsCycleNav {
  previous: () => void;
  next: () => void;
  current: () => void;
  pickMonth: (year: number, month: number) => void;
}

interface Props {
  nav: BillsCycleNav;
  periodLabel: string;
  rangeLabel: string;
  isCustomCycle: boolean;
  isCurrent: boolean;
  startDay: number;
  /** The last day of the selected cycle — names the month the picker highlights (same rule as the Month Cycle header). */
  selectedEnd: Date;
}

/** Step between Month Cycles (the configured start day, not calendar months) or jump to one from a month grid. */
export function BillsCycleSwitcher({ nav, periodLabel, rangeLabel, isCustomCycle, isCurrent, startDay, selectedEnd }: Props) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(selectedEnd.getFullYear());
  const today = new Date();

  return (
    <div role="group" aria-label="Bills cycle" className="flex flex-wrap items-center gap-1">
      {!isCurrent && (
        <button
          type="button"
          onClick={nav.current}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border-strong/60 bg-card px-2 text-xs font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
        >
          <RotateCcw className="size-3" strokeWidth={2} />
          This cycle
        </button>
      )}
      <div className="flex items-center rounded-lg border border-border-strong/60 bg-card p-px">
        <button type="button" onClick={nav.previous} aria-label="Previous cycle" className={ICON_BUTTON}>
          <ChevronLeft className="size-4" strokeWidth={1.9} />
        </button>
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (o) setYear(selectedEnd.getFullYear());
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Choose cycle"
              className="min-h-7 min-w-28 rounded-md px-1.5 text-center transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
            >
              <span className="flex items-center justify-center gap-1.5 text-xs font-semibold whitespace-nowrap text-foreground" aria-live="polite">
                {periodLabel}
                <CalendarDays className="size-3.5 shrink-0 text-foreground/60" aria-hidden />
              </span>
              {isCustomCycle ? null : <span className="sr-only">{rangeLabel}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" aria-label="Previous year" onClick={() => setYear((y) => y - 1)} className={cn(ICON_BUTTON, "size-7")}>
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-sm font-semibold text-foreground tabular-nums">{year}</span>
              <button type="button" aria-label="Next year" onClick={() => setYear((y) => y + 1)} className={cn(ICON_BUTTON, "size-7")}>
                <ChevronRight className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {MONTHS_SHORT.map((m, i) => {
                const isSelected = selectedEnd.getFullYear() === year && selectedEnd.getMonth() === i;
                const isThisMonth = today.getFullYear() === year && today.getMonth() === i;
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      nav.pickMonth(year, i);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-8 rounded-[6px] text-xs font-semibold transition-colors",
                      isSelected ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary",
                      !isSelected && isThisMonth && "ring-1 ring-primary-accent-text/60",
                    )}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
        <button type="button" onClick={nav.next} aria-label="Next cycle" className={ICON_BUTTON}>
          <ChevronRight className="size-4" strokeWidth={1.9} />
        </button>
      </div>
      <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="About this cycle"
            className="inline-flex size-6 items-center justify-center rounded-full text-foreground/65 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[18rem]">
          {isCustomCycle
            ? `Cycles follow your Month Cycle: the ${ordinalDay(startDay)} of each month to the day before the next (${rangeLabel}). A bill lands in the cycle of its due date; anything unpaid from an earlier cycle stays here until it is paid.`
            : "Cycles follow your Month Cycle (calendar month). A bill lands in the cycle of its due date; anything unpaid from an earlier cycle stays here until it is paid."}
        </TooltipContent>
      </Tooltip>
      </TooltipProvider>
    </div>
  );
}
