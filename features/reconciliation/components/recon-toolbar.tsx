"use client";

/**
 * One compact row above the sheets: filter chips (by match state / decision), search, sort, and the D5 bulk "Keep
 * existing" — offered only for unambiguous rows (one unique exact match), with a confirmation and Undo.
 */

import { Keyboard, Link2, Search, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

const FILTER_HINT: Partial<Record<ReconFilter, string>> = {
  open: "Rows without a final decision yet — including “Review later”.",
  exact: "Possible match with the same amount and day.",
  near: "Possible match where the amount or date differs slightly.",
  no_match: "Nothing similar on this account.",
  excluded: "Left out in Smart Capture — never compared or imported.",
};

const SORT_LABEL: Record<ReconSort, string> = { statement: "Statement order", date: "Date", amount: "Amount (high → low)", attention: "Needs attention first" };

const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: "J / K  or  ↓ / ↑", does: "Move within a sheet" },
  { keys: "→ / ←", does: "Switch sheet (statement ⇄ FlowFi)" },
  { keys: "U", does: "Jump to the next undecided row" },
  { keys: "Enter", does: "Row details · in FlowFi: Keep existing" },
  { keys: "O", does: "Full comparison" },
  { keys: "E  or  L", does: "Keep existing — skip import" },
  { keys: "B", does: "Keep both (you confirm first)" },
  { keys: "N", does: "Import new" },
  { keys: "I", does: "Skip this transaction" },
  { keys: "?", does: "Review later" },
  { keys: "Z", does: "Undo the last draft decision" },
  { keys: "D", does: "Show / hide the field comparison" },
  { keys: "F", does: "Focus Mode on / off" },
  { keys: "Esc", does: "Leave Focus Mode (outside the sheets)" },
];

export function ReconToolbar({
  filter,
  onFilter,
  counts,
  query,
  onQuery,
  sort,
  onSort,
  showShortcuts = false,
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
  /** Desktop only — the keyboard shortcut list. */
  showShortcuts?: boolean;
  bulkCount: number;
  onBulkLink: () => void;
  undoCount: number;
  onUndo: () => void;
}) {
  const filters = (Object.keys(FILTER_LABEL) as ReconFilter[]).filter((f) => f === "all" || f === "open" || counts[f] > 0);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="recon-toolbar">
      <div className="order-1 flex w-full flex-wrap items-center gap-2 lg:order-none lg:ml-auto lg:w-auto">
        <div className="relative min-w-0 flex-1 basis-48 lg:w-40 lg:flex-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground lg:size-3.5" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search rows" aria-label="Search rows" className="h-8 rounded-lg pl-9 text-sm lg:h-7 lg:text-xs" />
        </div>
        <Select value={sort} onValueChange={(v) => onSort(v as ReconSort)}>
          <SelectTrigger aria-label="Sort rows" className="h-8 w-auto min-w-36 rounded-lg text-sm lg:h-7! lg:min-w-0 lg:text-xs">
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
            <Undo2 className="size-3.5" /> Undo bulk keep ({undoCount})
          </ClayButton>
        ) : (
          // Always present (so the count is discoverable) but quiet until there's something it could do.
          <ClayButton
            size="sm"
            variant={bulkCount > 0 ? "secondary" : "ghost"}
            onClick={onBulkLink}
            disabled={bulkCount === 0}
            title="Keeps the existing FlowFi transaction only for rows with one unique exact match. You confirm first, and can undo."
            aria-label={`Keep existing for exact matches (${bulkCount})`}
          >
            <Link2 className="size-3.5" /> Keep exact ({bulkCount})
          </ClayButton>
        )}
        {showShortcuts && (
          <Popover>
            <PopoverTrigger asChild>
              <ClayButton size="sm" variant="ghost" aria-label="Keyboard shortcuts" data-testid="shortcuts">
                <Keyboard className="size-4" />
              </ClayButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3">
              <p className="text-xs font-semibold text-foreground">Keyboard shortcuts</p>
              <p className="mb-2 text-[11px] text-muted-foreground">Click the rows first, then use these. They only change your draft.</p>
              <dl className="flex flex-col gap-1.5">
                {SHORTCUTS.map((s) => (
                  <div key={s.keys} className="flex items-baseline justify-between gap-3 text-xs">
                    <dt className="text-muted-foreground">{s.does}</dt>
                    <dd className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{s.keys}</dd>
                  </div>
                ))}
              </dl>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="order-2 flex min-w-0 flex-wrap gap-1.5 lg:order-first" role="toolbar" aria-label="Filter rows">
        {filters.map((f) => {
          const active = filter === f;
          const attention = f === "open" && counts.open > 0;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              title={FILTER_HINT[f]}
              onClick={() => onFilter(f)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active ? "border-transparent bg-foreground text-background" : attention ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "open" && !active && counts.open > 0 && <span aria-hidden className="size-1.5 rounded-full bg-warning" />}
              {FILTER_LABEL[f]}
              <span className={cn("tabular-nums", active ? "text-background/70" : attention ? "text-warning/80" : "text-muted-foreground/70")}>{counts[f]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
