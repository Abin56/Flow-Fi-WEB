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

interface StatSpec {
  lane: CandidateLane;
  label: string;
  caption: string;
  Icon: LucideIcon;
  iconClass: string;
}

const STATS: StatSpec[] = [
  { lane: "needsAccount", label: "Needs account", caption: "Pick where it posts", Icon: TriangleAlert, iconClass: "text-warning" },
  { lane: "needsReview", label: "Needs review", caption: "Low or unsure parse", Icon: ScanSearch, iconClass: "text-warning" },
  { lane: "duplicate", label: "Duplicates", caption: "Matches a saved transaction", Icon: CopyX, iconClass: "text-danger" },
  { lane: "noIssues", label: "Clean", caption: "No flags · still needs your OK", Icon: Check, iconClass: "text-primary" },
];

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
  // Duplicates appear only when there are some (or the list is already narrowed to them) — a permanent zero is noise.
  const stats = STATS.filter((s) => s.lane !== "duplicate" || counts.duplicate > 0 || active === "duplicate");
  const show = (n: number) => (loading ? "–" : String(n));

  return (
    <section
      aria-label="Inbox overview"
      className="@container rounded-2xl border border-white/10 bg-surface-hero p-3 text-hero-foreground shadow-e2 sm:p-5"
      data-testid="candidates-overview"
    >
      <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-center @3xl:gap-8">
        <div className="flex items-baseline justify-between gap-3 @3xl:block @3xl:w-60 @3xl:shrink-0">
          <div>
            <p className="hidden text-xs font-semibold tracking-[0.14em] text-hero-foreground/75 uppercase @3xl:block">Waiting for review</p>
            <p className="flex items-baseline gap-2 @3xl:mt-1">
              <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums @3xl:text-4xl" data-testid="overview-waiting">
                {show(waiting)}
              </span>
              <span className="text-sm text-hero-foreground/75">
                <span className="@3xl:hidden">waiting for review</span>
                <span className="hidden @3xl:inline">from SMS</span>
              </span>
            </p>
          </div>
          <p className="text-xs text-hero-foreground/75 @3xl:mt-2" data-testid="candidates-progress">
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
                    "min-h-10 @3xl:min-h-[4.5rem] @3xl:content-between @3xl:gap-y-1 @3xl:p-3",
                    on ? "border-primary bg-white/12" : "border-white/15 bg-white/[0.05] hover:bg-white/10",
                    FOCUS_RING,
                    "focus-visible:ring-offset-surface-hero",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-hero-foreground">
                    <Icon className={cn("size-3.5 shrink-0", iconClass)} aria-hidden />
                    <span className="truncate">{label}</span>
                  </span>
                  <span className="text-base leading-none font-semibold tabular-nums @3xl:text-xl" data-testid={`overview-count-${lane}`}>
                    {show(counts[lane])}
                  </span>
                  <span className="hidden text-xs leading-tight text-hero-foreground/75 @3xl:col-span-2 @3xl:block">{caption}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
