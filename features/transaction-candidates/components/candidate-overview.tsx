"use client";

import { Check, CopyX, ScanSearch, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CandidateLane } from "../lib/candidate-status";
import type { CandidateViewFilter } from "../lib/filters";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * The Inbox's summary band — a deep-ink surface so the numbers anchor the page, with the lime accent kept for the one
 * selected tile only. Counts are the WHOLE queue (not the current search/filters) and come straight from
 * `countCandidatesByLane`, so they are the same partition the list uses: needs account + needs review + duplicates + clean
 * always equals "waiting".
 *
 * "Clean" means "no issues flagged" — the SMS reader found nothing wrong, NOT that the transaction is imported or verified;
 * the caption says so. Each stat is a toggle that narrows the list to that lane. No money totals: these are unconfirmed.
 */

export interface StatSpec {
  lane: CandidateLane;
  label: string;
  caption: string;
  Icon: LucideIcon;
  iconClass: string;
}

export const STATS: StatSpec[] = [
  { lane: "needsAccount", label: "Needs account", caption: "Pick where it posts", Icon: TriangleAlert, iconClass: "text-warning" },
  { lane: "needsReview", label: "Needs review", caption: "Low or unsure parse", Icon: ScanSearch, iconClass: "text-warning" },
  { lane: "duplicate", label: "Duplicates", caption: "Matches a saved transaction", Icon: CopyX, iconClass: "text-danger" },
  { lane: "noIssues", label: "Clean", caption: "No flags · still needs your OK", Icon: Check, iconClass: "text-primary" },
];

/** Duplicates appear only when there are some (or the list is already narrowed to them) — a permanent zero is noise. */
export function visibleStats(counts: Record<CandidateLane, number>, active: CandidateViewFilter): StatSpec[] {
  return STATS.filter((s) => s.lane !== "duplicate" || counts.duplicate > 0 || active === "duplicate");
}

/** Tint of each lane's slice in the hairline distribution bar along the band's bottom edge. */
const LANE_BAR_CLASS: Record<CandidateLane, string> = {
  needsAccount: "bg-warning",
  needsReview: "bg-warning/55",
  duplicate: "bg-danger",
  noIssues: "bg-primary",
};

export function CandidateOverview({
  loading,
  waiting,
  handled,
  counts,
  active,
  onSelect,
}: {
  loading: boolean;
  waiting: number;
  handled: number;
  counts: Record<CandidateLane, number>;
  active: CandidateViewFilter;
  onSelect: (view: CandidateViewFilter) => void;
}) {
  const stats = visibleStats(counts, active);
  const show = (n: number) => (loading ? "–" : String(n));
  const total = stats.reduce((sum, st) => sum + counts[st.lane], 0);

  return (
    <section
      aria-label="Inbox overview"
      className="@container relative overflow-hidden rounded-2xl border border-white/10 bg-surface-hero px-3 py-2.5 text-hero-foreground shadow-e2 sm:px-4 sm:py-3"
      data-testid="candidates-overview"
    >
      <div className="flex flex-col gap-2.5 @3xl:flex-row @3xl:items-center @3xl:gap-5">
        <div className="flex items-baseline justify-between gap-3 @3xl:w-56 @3xl:shrink-0 @3xl:flex-col @3xl:items-start @3xl:gap-0.5">
          <p className="hidden text-[11px] font-semibold tracking-[0.14em] text-hero-foreground/75 uppercase @3xl:block">Waiting for review</p>
          <div className="flex items-center gap-2.5">
            <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums @3xl:text-[2rem]" data-testid="overview-waiting">
              {show(waiting)}
            </span>
            <p className="flex flex-col text-hero-foreground/75">
              <span className="text-sm leading-tight">
                <span className="@3xl:hidden">waiting for review</span>
                <span className="hidden @3xl:inline">from SMS</span>
              </span>
              <span className="hidden text-xs leading-tight @3xl:block" data-testid="candidates-progress">
                {loading ? "Checking your inbox…" : `${handled} handled this session`}
              </span>
            </p>
          </div>
          <p className="text-xs text-hero-foreground/75 @3xl:hidden" data-testid="candidates-progress-narrow">
            {loading ? "Checking your inbox…" : `${handled} handled this session`}
          </p>
        </div>

        <ul className={cn("grid grid-cols-2 gap-2 @3xl:flex-1", stats.length === 4 ? "@3xl:grid-cols-4" : "@3xl:grid-cols-3")}>
          {stats.map(({ lane, label, caption, Icon, iconClass }) => {
            const on = active === lane;
            return (
              <li key={lane} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={loading}
                  title={caption}
                  onClick={() => onSelect(on ? "all" : lane)}
                  className={cn(
                    "grid w-full grid-cols-[1fr_auto] items-center gap-x-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-colors motion-reduce:transition-none",
                    "min-h-10 @3xl:min-h-[3.25rem] @3xl:grid-cols-[auto_1fr_auto] @3xl:gap-x-2.5 @3xl:px-3",
                    on ? "border-primary bg-white/12" : "border-white/15 bg-white/[0.05] hover:bg-white/10",
                    FOCUS_RING,
                    "focus-visible:ring-offset-surface-hero",
                  )}
                >
                  <span className="hidden size-7 items-center justify-center rounded-full bg-white/10 @3xl:flex">
                    <Icon className={cn("size-3.5 shrink-0", iconClass)} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-hero-foreground">
                      <Icon className={cn("size-3.5 shrink-0 @3xl:hidden", iconClass)} aria-hidden />
                      <span className="truncate">{label}</span>
                    </span>
                    <span className="hidden truncate text-[11px] leading-tight text-hero-foreground/70 @3xl:block">{caption}</span>
                  </span>
                  <span className="text-base leading-none font-semibold tabular-nums @3xl:text-xl" data-testid={`overview-count-${lane}`}>
                    {show(counts[lane])}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Decorative: how the queue splits across the lanes shown above. The numbers carry the meaning; this is only a glance. */}
      {!loading && total > 0 && (
        <div aria-hidden className="absolute inset-x-0 bottom-0 flex h-[3px] bg-white/10">
          {stats.map(({ lane }) => (counts[lane] > 0 ? <span key={lane} className={LANE_BAR_CLASS[lane]} style={{ width: `${(counts[lane] / total) * 100}%` }} /> : null))}
        </div>
      )}
    </section>
  );
}
