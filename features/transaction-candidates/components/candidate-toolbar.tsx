"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SmsCandidateDirection } from "@/lib/models/sms-transaction-candidate";
import type { FilterChip } from "../lib/candidate-filter-chips";
import { formatMonthKey } from "../lib/candidate-month-groups";
import { CANDIDATE_SORT_LABELS, CANDIDATE_SORT_ORDER, type CandidateSortKey } from "../lib/filters";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * Filter bar: ONE prominent search field, three quick filters (month, direction, sort) and a Filters button for everything
 * else, followed by removable chips for whatever is active. On a narrow workspace the quick filters live inside the Filters
 * sheet, so a phone sees just the search field and the button. The search text is the caller's (debounced upstream).
 */
export function CandidateToolbar({
  searchText,
  onSearchChange,
  compact,
  months,
  month,
  onMonth,
  direction,
  onDirection,
  sortKey,
  onSort,
  activeFilterCount,
  onOpenFilters,
  chips,
  onRemoveChip,
  canClearAll,
  onClearAll,
}: {
  searchText: string;
  onSearchChange: (text: string) => void;
  compact: boolean;
  months: string[];
  month: string | null;
  onMonth: (month: string | null) => void;
  direction: SmsCandidateDirection | null;
  onDirection: (direction: SmsCandidateDirection | null) => void;
  sortKey: CandidateSortKey;
  onSort: (key: CandidateSortKey) => void;
  activeFilterCount: number;
  onOpenFilters: () => void;
  chips: FilterChip[];
  onRemoveChip: (chip: FilterChip) => void;
  canClearAll: boolean;
  onClearAll: () => void;
}) {
  const field = "h-11 lg:h-10";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search merchant, amount, account, last 4…"
            aria-label="Search candidates"
            className={cn("pl-9", field)}
          />
        </div>

        {!compact && (
          <>
            <Select value={month ?? "all"} onValueChange={(v) => onMonth(v === "all" ? null : v)}>
              <SelectTrigger className={cn(field, "w-40")} aria-label="Filter by month">
                <SelectValue placeholder="All months" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {formatMonthKey(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div role="group" aria-label="Filter by direction" className="inline-flex shrink-0 rounded-[10px] border border-border-strong bg-card p-0.5">
              {([null, "debit", "credit"] as const).map((dir) => {
                const on = direction === dir;
                return (
                  <button
                    key={dir ?? "all"}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onDirection(dir)}
                    className={cn(
                      "inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors motion-reduce:transition-none lg:h-8",
                      FOCUS_RING,
                      on ? "bg-foreground text-background" : "text-foreground hover:bg-secondary",
                    )}
                  >
                    {dir === null ? "All" : dir === "debit" ? "Debit" : "Credit"}
                  </button>
                );
              })}
            </div>

            <Select value={sortKey} onValueChange={(v) => onSort(v as CandidateSortKey)}>
              <SelectTrigger className={cn(field, "w-48")} aria-label="Sort candidates">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CANDIDATE_SORT_ORDER.map((key) => (
                  <SelectItem key={key} value={key}>
                    {CANDIDATE_SORT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        <button
          type="button"
          onClick={onOpenFilters}
          data-testid="open-filters"
          className={cn("inline-flex shrink-0 items-center gap-2 rounded-[10px] border border-border-strong bg-card px-3.5 text-sm font-semibold text-foreground hover:bg-secondary", field, FOCUS_RING)}
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          Filters
          {activeFilterCount > 0 && (
            <span data-testid="active-filter-count" className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-bold text-primary-foreground tabular-nums">
              {activeFilterCount}
              <span className="sr-only"> active</span>
            </span>
          )}
        </button>
      </div>

      {(chips.length > 0 || canClearAll) && (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2" data-testid="filter-chips">
          {chips.map((chip) => (
            <li key={chip.id} className="inline-flex items-center rounded-full border border-border-strong bg-card py-0.5 pr-0.5 pl-3 text-xs font-semibold text-foreground">
              <span className="max-w-[16rem] truncate">{chip.label}</span>
              <button
                type="button"
                onClick={() => onRemoveChip(chip)}
                aria-label={chip.removeLabel}
                className={cn("ml-0.5 flex size-8 items-center justify-center rounded-full text-foreground hover:bg-secondary lg:size-7", FOCUS_RING)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {canClearAll && (
            <li>
              <button type="button" onClick={onClearAll} className={cn("inline-flex min-h-9 items-center rounded-lg px-2 text-sm font-semibold text-foreground underline-offset-2 hover:underline", FOCUS_RING)}>
                Clear filters
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
