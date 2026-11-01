"use client";

import { ArrowUp } from "lucide-react";
import { CompactHeaderBar } from "@/components/layout/compact-header";
import { cn } from "@/lib/utils";
import type { CandidateLane } from "../lib/candidate-status";
import type { CandidateViewFilter } from "../lib/filters";
import { visibleStats } from "./candidate-overview";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * The Inbox's compact bar: the overview band's numbers on one line, shown (by the shared `CompactHeaderBar` slot) once the
 * band has scrolled out of view. Same counts and the same lane toggles as the band — nothing new to learn or maintain —
 * so scrolling a long inbox never loses "how many are waiting" or the one-tap lane filters.
 */
export function CandidateCompactBar({
  progress,
  reduceMotion,
  top,
  loading,
  waiting,
  counts,
  active,
  onSelect,
}: {
  progress: number;
  reduceMotion: boolean;
  /** `barTop` from `useCompactHeader`. */
  top: number;
  loading: boolean;
  waiting: number;
  counts: Record<CandidateLane, number>;
  active: CandidateViewFilter;
  onSelect: (view: CandidateViewFilter) => void;
}) {
  const stats = visibleStats(counts, active);
  const show = (n: number) => (loading ? "–" : String(n));
  return (
    <CompactHeaderBar label="Transaction Inbox quick bar" progress={progress} reduceMotion={reduceMotion} top={top}>
      <button
        type="button"
        title="Back to top"
        aria-label="Back to top of the Inbox"
        onClick={(e) => e.currentTarget.closest("main")?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })}
        className={cn("hidden h-9 shrink-0 items-center gap-1 rounded-lg px-2 font-heading text-sm font-bold tracking-tight text-foreground hover:bg-secondary min-[480px]:inline-flex lg:h-8", FOCUS_RING)}
      >
        Inbox
        <ArrowUp className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
      <span className="flex shrink-0 items-baseline gap-1.5 rounded-lg bg-surface-hero px-2.5 py-1.5 text-hero-foreground">
        <span className="text-sm leading-none font-semibold tabular-nums">{show(waiting)}</span>
        <span className="text-xs leading-none text-hero-foreground/75">waiting</span>
      </span>
      <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {stats.map(({ lane, label, caption, Icon, iconClass }) => {
          const on = active === lane;
          return (
            <li key={lane} className="shrink-0">
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${label}, ${show(counts[lane])}`}
                disabled={loading}
                title={caption}
                onClick={() => onSelect(on ? "all" : lane)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold whitespace-nowrap transition-colors motion-reduce:transition-none lg:h-8",
                  on ? "border-transparent bg-foreground text-background" : "border-border bg-card text-foreground hover:bg-secondary",
                  FOCUS_RING,
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", on ? "text-background" : iconClass)} aria-hidden />
                <span className="hidden sm:inline">{label}</span>
                <span className="tabular-nums">{show(counts[lane])}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </CompactHeaderBar>
  );
}
