"use client";

/**
 * The desktop Review & Import toolbar — ONE compact line (it wraps to two only on narrow laptops) that replaces the
 * hero header, the account bar, the filter chips and the summary strip, so the two spreadsheets get the screen:
 *
 *   ← Review & Import │ ▣ octane •••• 3456 Change │ ● 9 pending  ◌ 2 possible  ⚠ 9 to check │ Search · Filter · Keep exact · Import new rows │ ⌨ ⤢ ⛶ 🗑
 *
 * Every control is the same one as before (same handlers, same testids); only the layout changed. Explanations live in
 * tooltips and popovers. Financial totals and import progress sit in the footer bar.
 */

import Link from "next/link";
import { ArrowLeft, Check, Expand, Keyboard, Link2, ListFilter, ListPlus, Maximize2, Minimize2, ScanSearch, Search, Shrink, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FOCUS_TOGGLE_TESTID } from "../hooks/use-focus-mode";
import { FILTER_HINT, FILTER_LABEL, SHORTCUTS, SORT_LABEL, type ReconFilter, type ReconSort } from "./recon-toolbar";
import { Count, type SummaryCounts } from "./review-import-summary";

const FILTER_ORDER: ReconFilter[] = ["all", "open", "possible", "exact", "near", "multiple", "no_match", "in_inbox", "conflict", "imported", "decided", "excluded"];

function Divider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-border" />;
}

function IconAction({ label, title, onClick, pressed, tone, testId, children }: { label: string; title?: string; onClick: () => void; pressed?: boolean; tone?: "danger" | "accent"; testId?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      data-testid={testId}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        tone === "accent" && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
        tone === "danger" && "hover:bg-danger/10 hover:text-danger",
      )}
    >
      {children}
    </button>
  );
}

export interface ReviewToolbarProps {
  /** The account segment (ReconAccountBar variant="inline"). */
  account: React.ReactNode;
  /** Matching has run: show statuses, filters and bulk actions. */
  ready: boolean;
  filter: ReconFilter;
  onFilter: (f: ReconFilter) => void;
  counts: Record<ReconFilter, number>;
  query: string;
  onQuery: (q: string) => void;
  sort: ReconSort;
  onSort: (s: ReconSort) => void;
  summary: SummaryCounts | null;
  onNextCheck: () => void;
  bulkImportCount: number;
  onBulkImport: () => void;
  bulkLinkCount: number;
  onBulkLink: () => void;
  undoBulkCount: number;
  onUndoBulk: () => void;
  focus: { on: boolean; toggle: () => void; canFullscreen: boolean; fullscreen: boolean; toggleFullscreen: () => void };
  onDiscard?: () => void;
}

export function ReviewToolbar(p: ReviewToolbarProps) {
  const filterActive = p.filter !== "all";
  const filters = FILTER_ORDER.filter((f) => f === "all" || f === "open" || p.counts[f] > 0);
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border-strong/60 bg-card px-1.5 py-0.5" data-testid="workspace-header">
      <Link
        href="/smart-capture"
        data-testid="back-to-capture"
        title="Back to Smart Capture"
        aria-label="Back to Smart Capture"
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" />
      </Link>
      <h1 className="shrink-0 font-heading text-[13.5px] font-semibold tracking-tight text-foreground">Review &amp; Import</h1>
      <Divider />
      <div className="min-w-0 shrink">{p.account}</div>

      {p.ready && p.summary && (
        <>
          <Divider />
          <div className="flex shrink-0 items-center gap-1 text-[11px]" aria-label="Review status">
            <button
              type="button"
              onClick={() => p.onFilter(p.filter === "open" ? "all" : "open")}
              aria-pressed={p.filter === "open"}
              title={FILTER_HINT.open}
              className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-medium transition-colors hover:bg-muted", p.filter === "open" ? "bg-foreground text-background hover:bg-foreground/90" : "text-foreground/75")}
              data-testid="status-pending"
            >
              <span aria-hidden className={cn("size-1.5 rounded-full", p.filter === "open" ? "bg-current" : p.counts.open > 0 ? "bg-warning" : "bg-muted-foreground/50")} />
              <span className="tabular-nums">{p.counts.open}</span> pending
            </button>
            <button
              type="button"
              onClick={() => p.onFilter(p.filter === "possible" ? "all" : "possible")}
              aria-pressed={p.filter === "possible"}
              title="Rows where FlowFi already has a transaction that could be the same one — check each before deciding."
              className={cn("inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-muted [&_dl]:contents [&_dt]:order-2 [&_dd]:order-1", p.filter === "possible" && "bg-foreground hover:bg-foreground/90 [&_*]:text-background!")}
              data-testid="status-possible"
            >
              <dl className="flex items-baseline gap-1">
                <Count label="possible matches" value={p.summary.possibleDuplicates} testId="summary-duplicates" tone={p.summary.possibleDuplicates > 0 ? "primary" : undefined} />
              </dl>
            </button>
            {p.summary.toCheck > 0 ? (
              <button
                type="button"
                onClick={p.onNextCheck}
                title="Open the next row whose captured date / amount needs a look. Rows are never confirmed for you."
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-foreground/75 transition-colors hover:bg-muted [&_dl]:contents"
                data-testid="next-check"
              >
                <ScanSearch className="size-3.5 text-warning" aria-hidden />
                <dl className="flex items-baseline gap-1 [&_dt]:order-2 [&_dd]:order-1">
                  <Count label="to check" value={p.summary.toCheck} testId="summary-to-check" />
                </dl>
              </button>
            ) : (
              <dl className="hidden">
                <Count label="to check" value={0} testId="summary-to-check" />
              </dl>
            )}
          </div>
        </>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1" data-testid="recon-toolbar">
        <div className="relative w-36 min-w-0 2xl:w-44">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={p.query} onChange={(e) => p.onQuery(e.target.value)} placeholder="Search rows" aria-label="Search rows" className="h-7 rounded-md pl-7 text-xs" />
        </div>
        {p.ready && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  filterActive ? "border-primary/50 bg-primary/10 text-foreground" : "border-border-strong/70 text-muted-foreground hover:text-foreground",
                )}
                aria-label={filterActive ? `Filter: ${FILTER_LABEL[p.filter]}` : "Filter and sort rows"}
                data-testid="filter-menu"
              >
                <ListFilter className="size-3.5" aria-hidden />
                {filterActive ? <span className="max-w-[9rem] truncate">{FILTER_LABEL[p.filter]}</span> : "Filter"}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-1.5">
              <p className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Show</p>
              <div role="radiogroup" aria-label="Filter rows" className="flex flex-col">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={p.filter === f}
                    title={FILTER_HINT[f]}
                    onClick={() => p.onFilter(f)}
                    className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted", p.filter === f && "bg-primary/10 font-medium")}
                  >
                    <span className="min-w-0 flex-1 truncate">{FILTER_LABEL[f]}</span>
                    <span className="text-muted-foreground tabular-nums">{p.counts[f]}</span>
                    {p.filter === f ? <Check className="size-3.5 text-primary-accent-text" aria-hidden /> : <span className="size-3.5" />}
                  </button>
                ))}
              </div>
              <p className="mt-1 border-t border-border px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Order</p>
              <div role="radiogroup" aria-label="Sort rows" className="flex flex-col">
                {(Object.keys(SORT_LABEL) as ReconSort[]).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={p.sort === s} onClick={() => p.onSort(s)} className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted", p.sort === s && "bg-primary/10 font-medium")}>
                    <span className="min-w-0 flex-1">{SORT_LABEL[s]}</span>
                    {p.sort === s && <Check className="size-3.5 text-primary-accent-text" aria-hidden />}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        {filterActive && (
          <IconAction label="Show all rows" onClick={() => p.onFilter("all")}>
            <X className="size-3.5" />
          </IconAction>
        )}
        {p.ready &&
          (p.undoBulkCount > 0 ? (
            <ClayButton size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={p.onUndoBulk}>
              <Undo2 className="size-3.5" /> Undo bulk keep ({p.undoBulkCount})
            </ClayButton>
          ) : (
            <ClayButton
              size="sm"
              variant={p.bulkLinkCount > 0 ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={p.onBulkLink}
              disabled={p.bulkLinkCount === 0}
              title="Keeps the existing FlowFi transaction only for rows with one unique exact match. You confirm first, and can undo."
              aria-label={`Keep existing for exact matches (${p.bulkLinkCount})`}
            >
              <Link2 className="size-3.5" /> <span className="max-xl:sr-only">Keep exact</span> ({p.bulkLinkCount})
            </ClayButton>
          ))}
        {p.ready && p.bulkImportCount > 0 && (
          <ClayButton size="sm" className="h-7 px-2 text-xs" onClick={p.onBulkImport} data-testid="bulk-import-open" title="Import every clean row with no possible match — you pick categories first; nothing is written until final approval.">
            <ListPlus className="size-3.5" /> Import new rows ({p.bulkImportCount})
          </ClayButton>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Divider />
        {p.ready && (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" data-testid="shortcuts" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                <Keyboard className="size-4" />
              </button>
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
        <IconAction
          label={p.focus.on ? "Exit Focus Mode" : "Enter Focus Mode"}
          title={p.focus.on ? "Exit Focus Mode (Esc or F)" : "Focus Mode — hide the sidebar and top bar (F)"}
          onClick={p.focus.toggle}
          pressed={p.focus.on}
          tone={p.focus.on ? "accent" : undefined}
          testId={FOCUS_TOGGLE_TESTID}
        >
          {p.focus.on ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconAction>
        {p.focus.canFullscreen && (
          <IconAction label={p.focus.fullscreen ? "Exit full screen" : "Full screen"} title={p.focus.fullscreen ? "Exit full screen (Esc)" : "Full screen — the whole display for the two tables"} onClick={p.focus.toggleFullscreen} pressed={p.focus.fullscreen} testId="fullscreen-toggle">
            {p.focus.fullscreen ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
          </IconAction>
        )}
        {p.onDiscard && (
          <IconAction label="Discard this review" onClick={p.onDiscard} tone="danger">
            <Trash2 className="size-3.5" />
          </IconAction>
        )}
      </div>
    </header>
  );
}
