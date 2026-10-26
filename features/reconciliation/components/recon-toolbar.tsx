"use client";

/** Filter chips (by match state / decision), search, sort, and the D5 bulk “already recorded” for unique exact matches. */

import { Link2, Search, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ReconFilter = "all" | "open" | "exact" | "near" | "multiple" | "no_match" | "in_inbox" | "conflict" | "imported" | "decided" | "excluded";
export type ReconSort = "statement" | "date" | "amount" | "attention";

export const FILTER_LABEL: Record<ReconFilter, string> = {
  all: "All",
  open: "Needs decision",
  exact: "Exact",
  near: "Near",
  multiple: "Multiple",
  no_match: "No match",
  in_inbox: "In Inbox",
  conflict: "Needs review",
  imported: "Imported",
  decided: "Decided",
  excluded: "Excluded",
};

const SORT_LABEL: Record<ReconSort, string> = { statement: "Statement order", date: "Date", amount: "Amount (high → low)", attention: "Needs attention first" };

export function ReconToolbar({
  filter,
  onFilter,
  counts,
  query,
  onQuery,
  sort,
  onSort,
  bulkCount,
  onBulkLink,
  undoCount,
  onUndo,
}: {
  filter: ReconFilter;
  onFilter: (f: ReconFilter) => void;
  counts: Record<ReconFilter, number>;
  query: string;
  onQuery: (q: string) => void;
  sort: ReconSort;
  onSort: (s: ReconSort) => void;
  bulkCount: number;
  onBulkLink: () => void;
  undoCount: number;
  onUndo: () => void;
}) {
  const filters = (Object.keys(FILTER_LABEL) as ReconFilter[]).filter((f) => f === "all" || f === "open" || counts[f] > 0);
  return (
    <div className="flex flex-col gap-2" data-testid="recon-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search merchant or amount" aria-label="Search rows" className="h-8 rounded-lg pl-9 text-sm" />
        </div>
        <Select value={sort} onValueChange={(v) => onSort(v as ReconSort)}>
          <SelectTrigger aria-label="Sort rows" className="h-8 w-auto min-w-40 rounded-lg text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABEL) as ReconSort[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SORT_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {undoCount > 0 ? (
          <ClayButton size="sm" variant="secondary" onClick={onUndo}>
            <Undo2 className="size-3.5" /> Undo bulk “already recorded” ({undoCount})
          </ClayButton>
        ) : (
          <ClayButton size="sm" variant="secondary" onClick={onBulkLink} disabled={bulkCount === 0} title="Marks only rows with one unique exact match as already recorded. You confirm first, and can undo.">
            <Link2 className="size-3.5" /> Mark exact matches already recorded ({bulkCount})
          </ClayButton>
        )}
      </div>
      <div className="-mx-1 flex flex-wrap gap-1.5 px-1" role="toolbar" aria-label="Filter rows">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => onFilter(f)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
              filter === f ? "border-transparent bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {FILTER_LABEL[f]}
            <span className={cn("tabular-nums", filter === f ? "text-background/70" : "text-muted-foreground/70")}>{counts[f]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
