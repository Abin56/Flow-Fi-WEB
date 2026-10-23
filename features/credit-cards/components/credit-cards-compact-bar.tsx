"use client";

import { Download, FileText, MoreHorizontal, Plus, Settings2 } from "lucide-react";
import { CompactHeaderBar } from "@/components/layout/compact-header";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";
const FIGURE_LABEL = "text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

/**
 * The compact Credit Cards bar. Every figure and handler is passed in from the page, which already holds them: Credit used,
 * the utilization % the summary shows, Available, Add Card (`openAdd`) and the same three More actions as the header. Nothing
 * is calculated here. Narrow screens keep identity, Credit used (with its %), Add Card and More; Available joins at `lg`.
 */
export function CreditCardsCompactBar({
  progress,
  reduceMotion,
  top,
  creditUsed,
  utilizationPercent,
  available,
  onAdd,
  onViewStatements,
  onManageCards,
}: {
  progress: number;
  reduceMotion: boolean;
  /** `barTop` from `useCompactHeader`. */
  top: number;
  creditUsed: number;
  /** Already rounded/capped for display by the page. */
  utilizationPercent: number;
  available: number;
  onAdd: () => void;
  onViewStatements: () => void;
  onManageCards: () => void;
}) {
  const high = utilizationPercent >= 80;
  return (
    <CompactHeaderBar label="Credit Cards quick bar" progress={progress} reduceMotion={reduceMotion} top={top}>
      <span className="min-w-0 shrink-0 truncate px-2 font-heading text-sm font-bold tracking-tight text-foreground">Credit Cards</span>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 flex-col items-end px-1.5 text-right leading-tight sm:px-2">
          <span className={cn(FIGURE_LABEL, "whitespace-nowrap")}>
            Credit used<span className="sm:hidden"> · {utilizationPercent}%</span>
          </span>
          <span className="text-sm font-bold whitespace-nowrap text-foreground tabular-nums">{formatCurrency(creditUsed)}</span>
        </span>
        <span
          className={cn(
            "hidden h-7 shrink-0 items-center rounded-[6px] px-2 text-xs font-semibold tabular-nums sm:inline-flex",
            high ? "bg-expense/15 text-expense" : "bg-secondary text-foreground",
          )}
        >
          {utilizationPercent}% used
        </span>
        <span className="hidden min-w-0 flex-col items-end px-2 text-right leading-tight lg:flex">
          <span className={cn(FIGURE_LABEL, "whitespace-nowrap")}>Available</span>
          <span className="text-sm font-bold whitespace-nowrap text-success tabular-nums">{formatCurrency(available)}</span>
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions"
            className="flex size-10 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48 rounded-[8px]">
          <DropdownMenuItem onSelect={onViewStatements}>
            <FileText strokeWidth={1.75} />
            View statements
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageCards}>
            <Settings2 strokeWidth={1.75} />
            Manage cards
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <Download strokeWidth={1.75} />
            Export statements
            <span className={cn(SOON, "ml-auto")}>Soon</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={onAdd}
        aria-label="Add Card"
        className="flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-2.5 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5"
      >
        <Plus className="size-4" strokeWidth={2.25} />
        <span className="hidden sm:inline">Add Card</span>
      </button>
    </CompactHeaderBar>
  );
}
