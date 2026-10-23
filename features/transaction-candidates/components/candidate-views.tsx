"use client";

import { cn } from "@/lib/utils";
import type { CandidateViewFilter } from "../lib/filters";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * Compact segmented views over the review lanes: All · Attention needed · Clean · Duplicates. "Attention needed" is the
 * union of duplicate + needs account + needs review (see `CandidateViewFilter`); the finer lanes are reached from the
 * overview tiles. Counts follow the current search and filters, so they are exactly what each view would list.
 * Duplicates only appears when there are some (or it is already selected).
 */

const VIEWS: { view: CandidateViewFilter; label: string; hint: string }[] = [
  { view: "all", label: "All", hint: "Every candidate waiting for review" },
  { view: "attention", label: "Attention needed", hint: "Needs an account, a closer look, or looks like a duplicate" },
  { view: "noIssues", label: "Clean", hint: "No issues flagged — you still confirm the category before importing" },
  { view: "duplicate", label: "Duplicates", hint: "Look like a transaction you already have" },
];

export function CandidateViews({
  active,
  counts,
  onSelect,
}: {
  active: CandidateViewFilter;
  counts: Record<"all" | "attention" | "noIssues" | "duplicate", number>;
  onSelect: (view: CandidateViewFilter) => void;
}) {
  const visible = VIEWS.filter((v) => v.view !== "duplicate" || counts.duplicate > 0 || active === "duplicate");
  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
      <div role="group" aria-label="Inbox views" className="inline-flex w-max gap-1 rounded-xl border border-border bg-card p-1">
        {visible.map(({ view, label, hint }) => {
          const on = active === view;
          return (
            <button
              key={view}
              type="button"
              aria-pressed={on}
              title={hint}
              onClick={() => onSelect(view)}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-lg px-3.5 text-sm font-semibold whitespace-nowrap transition-colors motion-reduce:transition-none lg:min-h-10",
                FOCUS_RING,
                on ? "bg-foreground text-background" : "text-foreground hover:bg-secondary",
              )}
            >
              {label}
              <span
                data-testid={`lane-count-${view}`}
                className={cn("min-w-6 rounded-full px-1.5 py-0.5 text-center text-xs font-bold tabular-nums", on ? "bg-background/20" : "bg-muted")}
              >
                {counts[view as keyof typeof counts]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
