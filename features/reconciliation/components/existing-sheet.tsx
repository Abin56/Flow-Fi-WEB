"use client";

/**
 * The Existing FlowFi sheet — the right page of the dual-sheet merge studio. It shows what FlowFi already has on the
 * statement account for the row selected in the New Statement sheet:
 *  - Matches: the matcher's possible matches for that row (and an SMS still waiting in the Inbox), best first.
 *  - Account ledger: every live transaction on the account in the statement period, with the same evidence wherever
 *    the matcher has any — so genuine repeats, near amounts and date offsets can be read side by side.
 * Read-only: selecting a transaction only picks what the comparison dock compares against. A transaction that can't
 * be this row (other direction, more than ₹1.00 or 31 days apart, already kept by another row) stays visible but is
 * marked view-only, with the reason. Records on other accounts never appear here.
 */

import { forwardRef } from "react";
import { ArrowLeftRight, Inbox, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import { originText, type ExistingEntry, type ExistingSheetMode } from "../lib/merge-studio";
import type { MatchCandidate, ReconRow } from "../lib/types";
import { Mark, Money, OWNER_LABEL, SHEET_HEAD, SHEET_TITLE_BAR } from "./recon-ui";

const COLS = "grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] @min-[26rem]:grid-cols-[4.5rem_minmax(0,1fr)_7.75rem_7.5rem] @min-[46rem]:grid-cols-[5rem_minmax(0,1fr)_8.5rem_6.5rem_6.75rem_8.5rem]";
const DATE_COL = "hidden @min-[26rem]:block";
const CELLS = "[&>*]:self-stretch [&>*]:content-center [&>*]:px-2 [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-border/35";
const WIDE_ONLY = "hidden @min-[46rem]:block";
const NARROW_ONLY = "@min-[46rem]:hidden";

export const TIER_SHORT: Record<MatchCandidate["tier"], string> = { exact: "Exact", same_merchant_date: "Merchant & day", near: "Near" };

function shortDelta(text: string): string {
  return text.replace(" in FlowFi", "");
}

/** The match-strength cell: what the matcher says about this record for the selected row. */
function StrengthCell({ entry, numberOf }: { entry: ExistingEntry; numberOf: (rowId: string) => number }) {
  const c = entry.candidate;
  const chip =
    entry.role === "imported" ? (
      <Mark tone="success">Imported earlier</Mark>
    ) : entry.role === "sms" ? (
      <Mark tone="purple" icon={Inbox}>
        SMS · Inbox
      </Mark>
    ) : entry.role === "suggested" || entry.role === "candidate" ? (
      <Mark tone={c?.tier === "exact" ? "primary" : "warning"} title={entry.role === "suggested" ? "The matcher's best unique match — still only a suggestion." : c ? TIER_SHORT[c.tier] : undefined}>
        {c ? TIER_SHORT[c.tier] : "Possible"}
        {entry.role === "suggested" ? " · best" : ""}
      </Mark>
    ) : entry.role === "linkable" ? (
      <Mark tone="muted" title="Outside the automatic ±3-day window, but inside the manual search (₹1.00, 31 days).">
        Search match
      </Mark>
    ) : (
      <span className="text-[11px] text-muted-foreground">—</span>
    );
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      {chip}
      {entry.linkedRowId && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success" data-testid="existing-kept-by">
          <ArrowLeftRight className="size-3" aria-hidden /> Kept by row {numberOf(entry.linkedRowId)}
        </span>
      )}
    </span>
  );
}

export interface ExistingSheetProps {
  entries: ExistingEntry[];
  mode: ExistingSheetMode;
  onMode: (mode: ExistingSheetMode) => void;
  query: string;
  onQuery: (q: string) => void;
  row: ReconRow | null;
  rowNumber: number | null;
  selectedRecordId: string | null;
  onSelect: (recordId: string) => void;
  accountLabel: string;
  numberOf: (rowId: string) => number;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Withheld results ("Loading FlowFi records…") — shown instead of rows until every source has loaded. */
  pendingLabel: string | null;
  matchCount: number;
}

export const ExistingSheet = forwardRef<HTMLDivElement, ExistingSheetProps>(function ExistingSheet(
  { entries, mode, onMode, query, onQuery, row, rowNumber, selectedRecordId, onSelect, accountLabel, numberOf, onKeyDown, pendingLabel, matchCount },
  ref,
) {
  const empty = pendingLabel
    ? pendingLabel
    : !row
      ? "Select a statement row to see what FlowFi already has."
      : query.trim()
        ? "Nothing on this account fits the search."
        : mode === "matches"
          ? `No possible match on ${accountLabel} for row ${rowNumber}.`
          : "No transactions on this account in the statement period.";
  return (
    <section aria-label="Existing FlowFi" className="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border-strong/70 bg-card shadow-e1" data-testid="existing-sheet" data-mode={mode}>
      <header className={SHEET_TITLE_BAR}>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 text-[13px] leading-tight font-semibold text-foreground">Existing FlowFi</h2>
          <p className="hidden truncate text-[11px] text-muted-foreground @min-[40rem]:block" title={accountLabel}>
            {accountLabel} · same account only
          </p>
        </div>
        <div role="radiogroup" aria-label="Existing transactions to show" className="flex shrink-0 rounded-lg bg-foreground/[0.06] p-0.5 text-[11px] font-medium">
          {(
            [
              ["matches", `Matches${row ? ` (${matchCount})` : ""}`],
              ["ledger", "Account ledger"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-testid={`existing-mode-${m}`}
              onClick={() => onMode(m)}
              className={cn("rounded-md px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", mode === m ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-32 shrink-0 @min-[40rem]:w-44">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search" aria-label="Search existing transactions" className="h-7 rounded-lg pl-8 text-xs" />
        </div>
      </header>
      <div
        ref={ref}
        role="grid"
        aria-label="Existing FlowFi transactions"
        aria-rowcount={entries.length}
        aria-activedescendant={selectedRecordId && entries.some((e) => e.record.id === selectedRecordId) ? `existing-row-${selectedRecordId}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="existing-grid"
        className="group/grid flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div role="row" className={cn(SHEET_HEAD, COLS, CELLS)}>
          <span role="columnheader" className={DATE_COL}>
            Date
          </span>
          <span role="columnheader">Merchant · origin</span>
          <span role="columnheader" className="text-right">
            Amount
          </span>
          <span role="columnheader" className={WIDE_ONLY}>
            Δ Amount
          </span>
          <span role="columnheader" className={WIDE_ONLY}>
            Δ Date
          </span>
          <span role="columnheader">Match</span>
        </div>
        <div data-testid="existing-grid-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          {(pendingLabel || entries.length === 0) && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground" data-testid="existing-empty">
                {empty}
              </p>
              {!pendingLabel && row && mode === "matches" && !query.trim() && (
                <button type="button" onClick={() => onMode("ledger")} className="text-xs font-medium text-primary-accent-text underline-offset-4 hover:underline">
                  Browse the account ledger
                </button>
              )}
            </div>
          )}
          {!pendingLabel &&
            entries.map((entry) => {
              const { record, candidate } = entry;
              const selected = record.id === selectedRecordId;
              const evidence = candidate ? `${shortDelta(describeAmountDelta(candidate.amountDeltaPaise))} · ${shortDelta(describeDayGap(candidate.dayGap))}` : null;
              const possible = entry.role !== "context";
              return (
                <div
                  key={record.id}
                  id={`existing-row-${record.id}`}
                  role="row"
                  aria-selected={selected}
                  aria-disabled={entry.viewOnly ? true : undefined}
                  data-testid="existing-row"
                  data-record-id={record.id}
                  data-role={entry.role}
                  data-view-only={entry.viewOnly?.code}
                  title={entry.viewOnly?.message}
                  onClick={() => onSelect(record.id)}
                  className={cn(
                    "relative grid h-10 cursor-pointer scroll-my-2 items-stretch border-b border-border/70 transition-colors",
                    COLS,
                    CELLS,
                    selected ? "bg-primary/[0.08] inset-ring inset-ring-primary/30 group-focus-visible/grid:bg-primary/[0.13]" : possible ? "bg-primary/[0.035] hover:bg-primary/[0.06]" : "hover:bg-muted/45",
                    entry.viewOnly && !selected && "text-muted-foreground [&_*]:text-muted-foreground/90",
                  )}
                >
                  {selected && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] border-0! bg-primary p-0!" />}
                  {!selected && possible && <span aria-hidden className="pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-r border-0! bg-primary/50 p-0!" />}
                  <span role="gridcell" className={cn("text-xs whitespace-nowrap tabular-nums", DATE_COL)}>
                    {record.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}
                  </span>
                  <span role="gridcell" className="min-w-0">
                    <span className={cn("block truncate text-[13px] leading-snug text-foreground", selected ? "font-semibold" : "font-medium")} title={record.description}>
                      {record.description || "No description"}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="shrink-0 @min-[26rem]:hidden">{record.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })} ·</span>
                      <span className="shrink-0">{originText(record)}</span>
                      {record.owner && <span className="truncate text-purple">· {OWNER_LABEL[record.owner]}</span>}
                      {record.isTransferLeg && <span className="truncate">· Transfer</span>}
                      {evidence && <span className={cn("truncate", NARROW_ONLY)}>· {evidence}</span>}
                    </span>
                  </span>
                  <span role="gridcell" className="text-right whitespace-nowrap">
                    <Money amount={record.amount} direction={record.direction} />
                  </span>
                  <span role="gridcell" className={cn("text-xs tabular-nums", WIDE_ONLY, candidate && candidate.amountDeltaPaise !== 0 ? "text-warning" : "text-muted-foreground")}>
                    {candidate ? (candidate.amountDeltaPaise === 0 ? "Same" : shortDelta(describeAmountDelta(candidate.amountDeltaPaise))) : "—"}
                  </span>
                  <span role="gridcell" className={cn("text-xs", WIDE_ONLY, candidate && candidate.dayGap !== 0 ? "text-warning" : "text-muted-foreground")}>
                    {candidate ? shortDelta(describeDayGap(candidate.dayGap)) : "—"}
                  </span>
                  <span role="gridcell" className="min-w-0">
                    <StrengthCell entry={entry} numberOf={numberOf} />
                  </span>
                </div>
              );
            })}
        </div>
      </div>
    </section>
  );
});
