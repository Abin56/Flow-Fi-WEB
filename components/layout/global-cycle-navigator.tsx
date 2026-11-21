"use client";

/**
 * Compact top-bar control for the globally selected Month Cycle window (`useGlobalCycle`). Prev/next
 * step one cycle at a time; the label opens a month/year picker (mirrors the Month Cycle page's own
 * `CyclePicker`); "Current cycle" snaps back to the cycle containing today. Reuses the canonical cycle
 * engine only — never writes the configured cycle RULE (Settings → Month cycle).
 */

import { CalendarRange, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useGlobalCycle } from "@/features/month-cycle/hooks/use-global-cycle";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function GlobalCycleNavigator() {
  const cycle = useGlobalCycle();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(cycle.cycleRange.end.getFullYear());
  const today = cycle.now;
  const reduceMotion = useReducedMotion();

  return (
    <div
      className={cn(
        "flex h-8.5 shrink-0 items-center rounded-full border bg-muted/70 pr-0.5 pl-1 transition-colors",
        cycle.isCurrentCycle ? "border-border" : "border-primary-accent-text/50 bg-primary/10",
      )}
    >
      <button
        type="button"
        aria-label="Previous cycle"
        onClick={cycle.goToPreviousCycle}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
      </button>

      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setYear(cycle.cycleRange.end.getFullYear());
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Choose cycle"
            className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-full px-2 text-xs font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-background sm:text-[13px]"
          >
            <CalendarRange className="size-3 shrink-0 text-muted-foreground" />
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", cycle.isCurrentCycle ? "bg-primary-accent-text" : "bg-muted-foreground/50")}
            />
            <span className="relative grid">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={cycle.cycleRange.start.getTime()}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
                  className="col-start-1 row-start-1 truncate"
                >
                  {cycle.label}
                </motion.span>
              </AnimatePresence>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground">Viewing cycle</p>
            {cycle.isCurrentCycle && (
              <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-foreground dark:text-primary-accent-text">Current</span>
            )}
          </div>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setYear((y) => y - 1)}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-semibold text-foreground tabular-nums">{year}</span>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => setYear((y) => y + 1)}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS_SHORT.map((m, i) => {
              const isSelected = cycle.cycleRange.end.getFullYear() === year && cycle.cycleRange.end.getMonth() === i;
              const isThisMonth = today.getFullYear() === year && today.getMonth() === i;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    cycle.goToCycleForMonth(year, i);
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
          <button
            type="button"
            disabled={cycle.isCurrentCycle}
            onClick={() => {
              cycle.goToCurrentCycle();
              setOpen(false);
            }}
            className="mt-2 h-7 w-full rounded-[6px] border border-border-strong text-xs font-semibold text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Back to current cycle
          </button>
        </PopoverContent>
      </Popover>

      <button
        type="button"
        onClick={cycle.goToNextCycle}
        aria-label="Next cycle"
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <ChevronRight className="size-3.5" strokeWidth={1.75} />
      </button>

      {!cycle.isCurrentCycle && (
        <button
          type="button"
          onClick={cycle.goToCurrentCycle}
          aria-label="Back to current cycle"
          title="Back to current cycle"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-background hover:text-primary-accent-text dark:text-primary-accent-text/80"
        >
          <RotateCcw className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
