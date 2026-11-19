"use client";

/**
 * The Existing FlowFi sheet — the right spreadsheet of the comparison workspace. It shows what FlowFi already has on
 * the statement account for the row selected in the New Statement sheet (Date · Description · Amount · Difference ·
 * Match):
 *  - Matches: the matcher's possible matches for that row (and an SMS still waiting in the Inbox), best first.
 *  - Account ledger: every live transaction on the account in the statement period, with the same evidence wherever
 *    the matcher has any — so genuine repeats, near amounts and date offsets can be read side by side.
 * Read-only: selecting a transaction only picks what the review strip compares against. A transaction that can't be
 * this row (other direction, too far apart in amount or time, already kept by another row) stays visible but is
 * marked view-only, with the reason.
 *
 * Cross-account evidence (account-hints.ts) is never a match and never selectable:
 *  - No statement account yet: similar transactions across every account, marked "Account not verified", each with an
 *    explicit "Use account" — choosing it is the user's action, after which the real matcher runs.
 *  - Account chosen: similar transactions on OTHER accounts are listed under "Other accounts — not compared", so a
 *    wrong account choice shows up instead of a silent "No match".
 */

import { forwardRef } from "react";
import { ArrowLeftRight, ChevronRight, Inbox, Search, SearchCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import type { AccountHint } from "../lib/account-hints";
import { originText, type ExistingEntry, type ExistingSheetMode } from "../lib/merge-studio";
import type { MatchCandidate, ReconRow } from "../lib/types";
import { Mark, Money, OWNER_LABEL, SHEET_CELLS, SHEET_FRAME, SHEET_HEAD, SHEET_ROW, SHEET_TITLE_BAR } from "./recon-ui";

const COLS = "grid-cols-[minmax(0,1fr)_7.25rem_8.5rem] @min-[26rem]:grid-cols-[4rem_minmax(0,1fr)_7.75rem_9rem]";
const DATE_COL = "hidden @min-[26rem]:block";

export const TIER_SHORT: Record<MatchCandidate["tier"], string> = { exact: "Possible match", same_merchant_date: "Possible match", near: "Possible match" };

function shortDelta(text: string): string {
  return text.replace(" in FlowFi", "");
}

/** "+₹2.00 · Same day" — the difference cell, in the order a reviewer checks it. */
function differenceText(c: MatchCandidate): string {
  const amount = c.amountDeltaPaise === 0 ? "Same amount" : shortDelta(describeAmountDelta(c.amountDeltaPaise));
  return `${amount} · ${shortDelta(describeDayGap(c.dayGap))}`;
}

const dayText = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });

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
      <Mark tone="primary" title={entry.role === "suggested" ? "The best unique match — still only a suggestion; you decide." : "A possible match — you decide."}>
        {c ? TIER_SHORT[c.tier] : "Possible match"}
      </Mark>
    ) : entry.role === "linkable" ? (
      <Mark tone="muted" title="Outside the automatic ±3-day window, but inside the manual search (31 days).">
        Search match
      </Mark>
    ) : (
      <span className="text-[11px] text-muted-foreground">—</span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {chip}
      {entry.linkedRowId && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-success" data-testid="existing-kept-by" title={`Kept by row ${numberOf(entry.linkedRowId)}`}>
          <ArrowLeftRight className="size-3" aria-hidden />
          <span className="sr-only">Kept by row {numberOf(entry.linkedRowId)}</span>
          <span aria-hidden>Row {numberOf(entry.linkedRowId)}</span>
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
  /** Cross-account evidence for the selected row (never matches). */
  hints?: AccountHint[];
  /** No statement account chosen: hints are the only content, each with "Use account". */
  accountMissing?: boolean;
  accountName?: (accountId: string) => string;
  onUseAccount?: (accountId: string) => void;
  /** Other statement rows that DO have a possible match — offered when the selected row has none. */
  otherMatches?: OtherMatchRow[];
  onJumpToRow?: (rowId: string) => void;
}

export interface OtherMatchRow {
  rowId: string;
  number: number;
  description: string;
  amount: number | null;
  direction: ReconRow["direction"];
  date: Date | null;
  label: string;
  exact: boolean;
}

const rowDay = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "No date");

export const ExistingSheet = forwardRef<HTMLDivElement, ExistingSheetProps>(function ExistingSheet(
  { entries, mode, onMode, query, onQuery, row, rowNumber, selectedRecordId, onSelect, accountLabel, numberOf, onKeyDown, pendingLabel, matchCount, hints = [], accountMissing = false, accountName = (id) => id, onUseAccount, otherMatches = [], onJumpToRow },
  ref,
) {
  const showHintsOnly = accountMissing && !!row && hints.length > 0;
  const otherAccountHints = !accountMissing && !pendingLabel && mode === "matches" && !query.trim() ? hints : [];
  const empty = pendingLabel
    ? pendingLabel
    : !row
      ? "Select a statement row to see what FlowFi already has."
      : query.trim()
        ? "Nothing on this account fits the search."
        : mode === "matches"
          ? `No match for Row ${rowNumber}`
          : "No transactions on this account in the statement period.";
  const showEmpty = !showHintsOnly && (pendingLabel || entries.length === 0);

  const hintRow = (h: AccountHint) => {
    const account = accountName(h.record.accountId!);
    return (
      <div
        key={`hint-${h.record.id}`}
        role="row"
        // Never selectable — but while the account is missing the row holds a working "Use account" button, which an
        // aria-disabled row would disable for assistive tech too.
        aria-disabled={accountMissing ? undefined : true}
        data-testid="existing-hint-row"
        data-record-id={h.record.id}
        data-account-id={h.record.accountId}
        title={`On ${account} — ${accountMissing ? "the statement account isn't chosen, so this is not compared" : "a different account, so it is not a match"}.`}
        className={cn(SHEET_ROW, COLS, SHEET_CELLS, "cursor-default")}
      >
        <span role="gridcell" className={cn("text-xs whitespace-nowrap tabular-nums", DATE_COL)}>
          {dayText(h.record.dateTime)}
        </span>
        <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-[45%] shrink-0 truncate rounded bg-muted px-1 text-[10.5px] leading-4 font-medium text-muted-foreground" title={account}>
            {account}
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground" title={h.record.description}>
            {h.record.description || "No description"}
          </span>
        </span>
        <span role="gridcell" className="text-right whitespace-nowrap">
          <Money amount={h.record.amount} direction={h.record.direction} className="text-[13px]" />
        </span>
        <span role="gridcell" className="flex min-w-0 items-center gap-1">
          {accountMissing && onUseAccount ? (
            <button
              type="button"
              onClick={() => onUseAccount(h.record.accountId!)}
              className="truncate rounded-md border border-border-strong/70 px-1.5 py-px text-[11px] font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Use ${account} as the statement account`}
              data-testid="use-hint-account"
            >
              Use account
            </button>
          ) : (
            <Mark tone="muted" title="A different account — never matched across accounts.">
              Other account
            </Mark>
          )}
        </span>
      </div>
    );
  };

  return (
    <section aria-label="Existing FlowFi" className={cn(SHEET_FRAME, "h-full")} data-testid="existing-sheet" data-mode={mode}>
      <header className={SHEET_TITLE_BAR}>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 text-[13px] leading-tight font-semibold text-foreground">Existing FlowFi</h2>
          <p className="hidden truncate text-[11px] text-muted-foreground @min-[34rem]:block" title={accountLabel}>
            {accountMissing ? "Account not verified — similar transactions in all accounts" : `${accountLabel} · same account only`}
          </p>
        </div>
        {!accountMissing && (
          <div role="radiogroup" aria-label="Existing transactions to show" className="flex shrink-0 rounded-md bg-foreground/[0.06] p-0.5 text-[11px] font-medium">
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
                className={cn("rounded px-2 py-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", mode === m ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="relative w-28 shrink-0 @min-[34rem]:w-40">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search" aria-label="Search existing transactions" className="h-7 rounded-md pl-7 text-xs" />
        </div>
      </header>
      {row && (
        // Which statement row this side belongs to — one quiet line, nothing to read.
        <p className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border/60 bg-primary/[0.045] px-2.5 text-[11.5px] text-muted-foreground" data-testid="existing-comparing" data-row-id={row.id}>
          <span className="font-semibold text-foreground">Row {rowNumber}</span>
          <span className="tabular-nums">· {rowDay(row.date)}</span>
        </p>
      )}
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
        <div role="row" className={cn(SHEET_HEAD, COLS, SHEET_CELLS)}>
          <span role="columnheader" className={DATE_COL}>
            Date
          </span>
          <span role="columnheader">Description</span>
          <span role="columnheader" className="text-right">
            Amount
          </span>
          <span role="columnheader">{showHintsOnly ? "Account" : "Match"}</span>
        </div>
        <div data-testid="existing-grid-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          {showEmpty && (
            <div className="flex flex-col gap-2 px-3 py-3">
              <div className="flex items-start gap-2.5">
                <span aria-hidden className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  {pendingLabel ? <Search className="size-3.5" /> : <SearchCheck className="size-3.5" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground" data-testid="existing-empty" title={row && !pendingLabel && mode === "matches" ? `Nothing on ${accountLabel} looks like this row.` : undefined}>
                    {accountMissing && row ? "Choose the statement account to compare." : empty}
                  </p>
                  {accountMissing && row && <p className="max-w-xs text-xs text-muted-foreground">Nothing similar to row {rowNumber} in any of your accounts. Matches are only checked on the account you choose.</p>}
                  {!pendingLabel && row && mode === "matches" && !query.trim() && (
                    <p className="text-xs text-muted-foreground" data-testid="existing-empty-hint">
                      Not a duplicate on this account.{" "}
                      <button type="button" onClick={() => onMode("ledger")} className="font-medium text-primary-accent-text underline-offset-4 hover:underline">
                        Browse the account ledger
                      </button>
                    </p>
                  )}
                </div>
              </div>
              {!pendingLabel && row && mode === "matches" && !query.trim() && otherMatches.length > 0 && onJumpToRow && (
                <div className="mt-1" data-testid="existing-other-rows">
                  <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
                    Other matches found <span className="rounded bg-primary/12 px-1 text-primary-accent-text normal-case tabular-nums">{otherMatches.length}</span>
                  </p>
                  <ul className="overflow-hidden rounded-md border border-border-strong/60">
                    {otherMatches.map((o) => (
                      <li key={o.rowId} className="border-b border-border/60 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => onJumpToRow(o.rowId)}
                          className="group/other flex h-8 w-full items-center gap-2 px-2 text-left text-xs transition-colors hover:bg-primary/[0.07] focus-visible:bg-primary/[0.07] focus-visible:outline-none"
                          data-testid="existing-other-row"
                          aria-label={`Compare row ${o.number}`}
                        >
                          <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{o.number}</span>
                          <span className="w-11 shrink-0 text-muted-foreground tabular-nums">{rowDay(o.date)}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground">{o.description || "No description"}</span>
                          <Money amount={o.amount} direction={o.direction} className="shrink-0 text-xs" />
                          <Mark tone="primary" className="w-24 shrink-0">
                            {o.label}
                          </Mark>
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/other:opacity-100" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {showHintsOnly && (
            <>
              <p className="border-b border-border/60 bg-warning/[0.07] px-2.5 py-1 text-[11px] text-foreground" data-testid="existing-hints-note">
                <span className="font-semibold text-warning">Account not verified.</span> Row {rowNumber} looks like {hints.length === 1 ? "this transaction" : `these ${hints.length} transactions`} — not compared until you choose the statement account.
              </p>
              {hints.map(hintRow)}
            </>
          )}
          {!pendingLabel &&
            entries.map((entry) => {
              const { record, candidate } = entry;
              const selected = record.id === selectedRecordId;
              const possible = entry.role !== "context";
              const differs = !!candidate && (candidate.amountDeltaPaise !== 0 || candidate.dayGap !== 0);
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
                  title={entry.viewOnly?.message ?? `${originText(record)}${record.owner ? ` · ${OWNER_LABEL[record.owner]}` : ""}${record.isTransferLeg ? " · Transfer" : ""}`}
                  onClick={() => onSelect(record.id)}
                  className={cn(
                    SHEET_ROW,
                    COLS,
                    SHEET_CELLS,
                    selected ? "bg-primary/[0.16]! inset-ring-2 inset-ring-primary/70 group-focus-visible/grid:bg-primary/[0.22]!" : possible ? "bg-primary/[0.04]! hover:bg-primary/[0.08]!" : "hover:bg-muted/60!",
                    entry.viewOnly && !selected && "text-muted-foreground [&_*]:text-muted-foreground/90",
                  )}
                >
                  {selected && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] border-0! bg-primary p-0!" />}
                  {!selected && possible && <span aria-hidden className="pointer-events-none absolute inset-y-1 left-0 w-[3px] rounded-r border-0! bg-primary/55 p-0!" />}
                  <span role="gridcell" className={cn("text-xs whitespace-nowrap tabular-nums", DATE_COL)}>
                    {dayText(record.dateTime)}
                  </span>
                  <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("min-w-0 truncate text-[13px] text-foreground", selected ? "font-semibold" : "font-medium")} title={record.description}>
                      <span className="text-muted-foreground @min-[26rem]:hidden">{dayText(record.dateTime)} · </span>
                      {record.description || "No description"}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">{originText(record)}</span>
                    {record.owner && <span className="hidden shrink-0 text-[10.5px] text-purple @min-[46rem]:inline">· {OWNER_LABEL[record.owner]}</span>}
                    {record.isTransferLeg && <span className="shrink-0 text-[10.5px] text-muted-foreground">· Transfer</span>}
                    {candidate && differs && (
                      <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="existing-difference">
                        · {differenceText(candidate)}
                      </span>
                    )}
                  </span>
                  <span role="gridcell" className="text-right whitespace-nowrap">
                    <Money amount={record.amount} direction={record.direction} className="text-[13px]" />
                  </span>
                  <span role="gridcell" className="min-w-0">
                    <StrengthCell entry={entry} numberOf={numberOf} />
                  </span>
                </div>
              );
            })}
          {!pendingLabel && mode === "matches" && !query.trim() && entries.length > 0 && !accountMissing && (
            <p className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground" data-testid="existing-footer">
              Not the one?{" "}
              <button type="button" onClick={() => onMode("ledger")} className="font-medium text-primary-accent-text underline-offset-4 hover:underline">
                Browse the account ledger
              </button>
            </p>
          )}
          {otherAccountHints.length > 0 && (
            <>
              <p className="border-y border-border/60 bg-muted/50 px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase" data-testid="existing-other-accounts">
                Other accounts — not compared ({otherAccountHints.length})
              </p>
              {otherAccountHints.map(hintRow)}
            </>
          )}
        </div>
      </div>
    </section>
  );
});
