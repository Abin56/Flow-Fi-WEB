"use client";

import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { CompactHeaderBar } from "@/components/layout/compact-header";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MyMoneyData } from "@/features/my-money/hooks/use-my-money-data";
import type { ObligationItem } from "@/features/my-money/lib/my-money";

const FIGURE_LABEL = "text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const NAV_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-[5px] text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";

/**
 * The compact My Money bar: period nav (same `data.nav` handlers as the expanded header), the same To pay figure the
 * summary shows, and the single most actionable item — `next` — as a CTA, so scrolling never loses the thing to act on.
 * No new figures or actions; everything here already exists above the fold.
 */
export function MyMoneyCompactBar({
  progress,
  reduceMotion,
  top,
  data,
  next,
}: {
  progress: number;
  reduceMotion: boolean;
  /** `barTop` from `useCompactHeader`. */
  top: number;
  data: MyMoneyData;
  next: ObligationItem | null;
}) {
  const { toPay } = data;
  return (
    <CompactHeaderBar label="My Money quick bar" progress={progress} reduceMotion={reduceMotion} top={top}>
      <span className="min-w-0 shrink-0 truncate px-2 font-heading text-sm font-bold tracking-tight text-foreground">My Money</span>

      <div className="flex shrink-0 items-center gap-0.5">
        {!data.isCurrent && (
          <button type="button" onClick={data.nav.current} aria-label="Jump to this month" className={NAV_BUTTON}>
            <RotateCcw className="size-3.5" strokeWidth={2} />
          </button>
        )}
        <button type="button" onClick={data.nav.previous} aria-label="Previous period" className={NAV_BUTTON}>
          <ChevronLeft className="size-4" strokeWidth={1.9} />
        </button>
        <span className="min-w-[4.5rem] px-1 text-center text-xs font-semibold text-foreground">{data.periodLabel}</span>
        <button type="button" onClick={data.nav.next} aria-label="Next period" className={NAV_BUTTON}>
          <ChevronRight className="size-4" strokeWidth={1.9} />
        </button>
      </div>

      <span className="ml-auto hidden min-w-0 flex-col items-end px-2 text-right leading-tight sm:flex">
        <span className={cn(FIGURE_LABEL, "whitespace-nowrap")}>To pay</span>
        <span
          className={cn(
            "text-sm font-bold whitespace-nowrap tabular-nums",
            toPay.count === 0 ? "text-success" : toPay.overdue > 0 ? "text-expense" : "text-foreground",
          )}
        >
          {formatCurrency(toPay.total)}
        </span>
      </span>

      {next && (
        <Link
          href={next.href}
          className={cn(
            "ml-auto flex h-10 min-w-0 shrink-0 items-center gap-1.5 rounded-[6px] border px-2.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:ml-0 sm:px-3",
            next.status === "overdue"
              ? "border-expense/60 bg-expense/10 text-expense hover:bg-expense/15"
              : "border-primary-accent-text bg-primary text-primary-foreground hover:opacity-90",
          )}
        >
          <span className="hidden truncate sm:inline">{next.title} ·</span>
          <span className="truncate tabular-nums">{formatCurrency(next.remaining)}</span>
          <ArrowRight className="size-3 shrink-0" strokeWidth={2.2} />
        </Link>
      )}
    </CompactHeaderBar>
  );
}
