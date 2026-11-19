"use client";

/**
 * The New Statement sheet — the left spreadsheet of the comparison workspace: one dense, ruled, single-line row per
 * captured statement line (# · Date · Description · Amount · Match · Decision · ✎). Its body scrolls on its own under
 * a sticky column header. Columns follow the pane's own width (container queries), not the window's: a narrow pane
 * folds the Match column into the description cell, so the sheet never scrolls sideways however the divider is dragged.
 *
 * Selecting a row drives the Existing FlowFi sheet; rows that are possible matches for the FlowFi transaction picked
 * over there get a quiet highlight here (synchronised selection — never synchronised scrolling).
 *
 * Without a statement account the Match column says "Account missing" and, as evidence only, where similar
 * transactions live (account-hints.ts) — nothing is compared or decided until the account is chosen.
 *
 * Editing a row never opens a form inside the table: the pencil, Enter or a double-click opens the row's sheet,
 * which the workspace renders over the viewport — the table stays a list and the row stays highlighted.
 */

import { forwardRef } from "react";
import { PencilLine, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import { rowCheckLabel } from "../lib/decisions";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { QuickDecideMenu, type QuickAction } from "./recon-decision-menu";
import { ACCOUNT_MISSING_META, DecisionChip, Mark, Money, SHEET_CELLS, SHEET_FRAME, SHEET_HEAD, SHEET_ROW, STATE_META, formatRowDate } from "./recon-ui";

/** Narrow pane: # · description (date folded in) · amount · decision · ✎. ≥30rem adds Date; ≥38rem adds Match. */
const COLS =
  "grid-cols-[1.75rem_minmax(0,1fr)_6.75rem_8rem_1.75rem] @min-[30rem]:grid-cols-[2rem_4rem_minmax(0,1fr)_7.5rem_8rem_2rem] @min-[38rem]:grid-cols-[2rem_4rem_minmax(0,1fr)_7.25rem_7.75rem_8rem_1.75rem] @min-[56rem]:grid-cols-[2.25rem_4.25rem_minmax(0,1fr)_7.75rem_8.5rem_8.5rem_2rem]";
const DATE_COL = "hidden @min-[30rem]:block";
const WIDE_ONLY = "hidden @min-[38rem]:block";
const NARROW_ONLY = "@min-[38rem]:hidden";

/** One short line of evidence for the row's best possible match. */
export function evidenceLine(match: RowMatch | undefined, pendingLabel = "Choose the statement account"): string {
  if (!match) return pendingLabel;
  if (match.state === "already_imported") return "Imported earlier from this row";
  if (match.state === "excluded") return "Excluded in Smart Capture";
  const best = match.candidates.find((c) => c.recordId === match.suggestedRecordId) ?? match.candidates[0];
  if (match.state === "multiple") return `${match.candidates.length} candidates`;
  if (best) return [describeAmountDelta(best.amountDeltaPaise).replace(" in FlowFi", ""), describeDayGap(best.dayGap).replace(" in FlowFi", "")].join(" · ");
  if (match.pendingSms.length > 0) return "SMS waiting in Inbox";
  if (match.conflicts[0]) return match.conflicts[0];
  return "Nothing similar on this account";
}

/** Cross-account evidence for a row while no statement account is chosen. */
export interface RowAccountHint {
  /** Similar transactions found across the user's accounts. */
  count: number;
  /** The best one's account ("octane •••• 3456"), null when none. */
  account: string | null;
}

export function accountHintLine(hint: RowAccountHint | null | undefined): string {
  if (!hint || hint.count === 0) return "Nothing similar in any account";
  return `${hint.count} similar on ${hint.account ?? "another account"}`;
}

export interface ReconTableProps {
  rows: ReconRow[];
  numberOf: (rowId: string) => number;
  matches: Map<string, RowMatch>;
  decisions: Record<string, RowDecision>;
  selectedId: string | null;
  /** The row whose editor sheet is open (null = closed). */
  expandedId: string | null;
  onSelect: (rowId: string) => void;
  onToggleExpand: (rowId: string) => void;
  /** The row's warning indicator: opens its editor on the value that needs attention. */
  onFixRow?: (rowId: string) => void;
  onCompare: (rowId: string) => void;
  /** Shown in the Match column while results are withheld (no account yet, still loading, or a load failed). */
  pendingLabel: string;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** The quick-decide options for a row (null = nothing to decide, e.g. excluded or not yet compared). */
  quickActions?: (row: ReconRow) => QuickAction[] | null;
  /** Desktop viewport-fit layout: the body scrolls inside the grid. False = the page scrolls (short windows). */
  contained?: boolean;
  /** Rows that could be the FlowFi transaction selected in the other sheet. */
  highlightIds?: Set<string>;
  /** The sheet's title bar (title, count) — the left page's heading. */
  header?: React.ReactNode;
  /** No statement account chosen: the Match column shows "Account missing" plus cross-account evidence. */
  accountMissing?: boolean;
  accountHintOf?: (rowId: string) => RowAccountHint | null;
}

export const ReconTable = forwardRef<HTMLDivElement, ReconTableProps>(function ReconTable(
  { rows, numberOf, matches, decisions, selectedId, expandedId, onSelect, onToggleExpand, onFixRow, onCompare, onKeyDown, pendingLabel, quickActions, contained = true, highlightIds, header, accountMissing = false, accountHintOf },
  ref,
) {
  return (
    <section aria-label="New statement" className={cn(SHEET_FRAME, contained && "h-full")} data-testid="statement-sheet">
      {header}
      <div
        ref={ref}
        role="grid"
        aria-label="Statement rows"
        aria-rowcount={rows.length}
        aria-activedescendant={selectedId ? `recon-row-${selectedId}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="recon-grid"
        className="group/grid flex min-h-0 min-w-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div role="row" className={cn(SHEET_HEAD, COLS, SHEET_CELLS)}>
          <span role="columnheader" className="text-right">
            #
          </span>
          <span role="columnheader" className={DATE_COL}>
            Date
          </span>
          <span role="columnheader">Description</span>
          <span role="columnheader" className="text-right">
            Amount
          </span>
          <span role="columnheader" className={WIDE_ONLY}>
            Match
          </span>
          <span role="columnheader">Decision</span>
          <span role="columnheader" className="sr-only">
            Details
          </span>
        </div>
        <div data-testid="recon-grid-body" className={cn("min-h-0 flex-1", contained && "overflow-y-auto overscroll-contain [scrollbar-gutter:stable]")}>
          {rows.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">No rows match these filters.</p>}
          {rows.map((row) => {
            const match = matches.get(row.id);
            const decision = decisions[row.id];
            const selected = row.id === selectedId;
            const expanded = row.id === expandedId;
            const related = !selected && (highlightIds?.has(row.id) ?? false);
            const checkLabel = rowCheckLabel(row);
            const keepBoth = !!match && (match.candidates.length > 0 || match.pendingSms.length > 0);
            // A left stripe marks the rows already decided (green); rows still waiting stay plain, so nothing is orange by default.
            const stripe = !match || match.state === "excluded" || !row.include ? null : decision?.kind && decision.kind !== "investigate" ? "bg-success/70" : null;
            const actions = quickActions?.(row) ?? null;
            const hint = accountMissing && row.include && !row.captureExcluded ? (accountHintOf?.(row.id) ?? null) : null;
            const meta = match ? STATE_META[match.state] : null;
            const evidence = match ? evidenceLine(match) : accountMissing ? accountHintLine(hint) : pendingLabel;
            const matchCell = match && meta ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCompare(row.id);
                }}
                title={`${meta.label} — ${evidence}. ${meta.hint}`}
                data-evidence={evidence}
                className="flex h-full w-full min-w-0 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                aria-label={`Compare row ${numberOf(row.id)}`}
              >
                <Mark tone={meta.tone} icon={meta.icon} className="shrink-0">
                  {meta.label}
                </Mark>
              </button>
            ) : accountMissing && row.include && !row.captureExcluded ? (
              <span className="flex min-w-0 items-center gap-1.5" title={`${ACCOUNT_MISSING_META.hint} ${evidence}.`} data-testid="match-account-missing">
                <Mark tone={ACCOUNT_MISSING_META.tone} icon={ACCOUNT_MISSING_META.icon} className="shrink-0">
                  {ACCOUNT_MISSING_META.label}
                </Mark>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">{evidence}</span>
              </span>
            ) : (
              <span className="block truncate text-[11px] text-muted-foreground" data-testid="match-pending">
                {evidenceLine(undefined, pendingLabel)}
              </span>
            );
            return (
              <div
                key={row.id}
                id={`recon-row-${row.id}`}
                role="row"
                aria-selected={selected}
                data-testid="recon-row"
                data-row-id={row.id}
                data-state={match?.state ?? "pending"}
                data-account-missing={!match && accountMissing ? "true" : undefined}
                data-amount={row.amount ?? ""}
                data-direction={row.direction ?? ""}
                data-description={row.description}
                data-decision={decision?.kind ?? ""}
                data-related={related || undefined}
                onClick={() => onSelect(row.id)}
                onDoubleClick={(e) => {
                  // Double-click opens the row's sheet; controls inside the row keep their own clicks.
                  if (!expanded && !(e.target as HTMLElement).closest("button, a, [role=menu], [role=dialog]")) onToggleExpand(row.id);
                }}
                className={cn(
                  SHEET_ROW,
                  COLS,
                  SHEET_CELLS,
                  !row.include && "opacity-60",
                  // Selected: tinted + a hairline frame, stronger while the sheet has keyboard focus. Related (a possible
                  // match for the FlowFi transaction picked opposite): a lighter tint and the right-edge tick.
                  selected
                    ? "bg-primary/[0.16]! inset-ring-2 inset-ring-primary/70 group-focus-visible/grid:bg-primary/[0.22]!"
                    : related
                      ? "bg-primary/[0.06]! hover:bg-primary/[0.09]!"
                      : "hover:bg-muted/60!",
                )}
              >
                {(selected || stripe) && <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px] border-0! p-0!", selected ? "bg-primary" : stripe)} />}
                {related && <span aria-hidden className="pointer-events-none absolute inset-y-1 right-0 w-[3px] rounded-l border-0! bg-primary/60 p-0!" />}
                <span role="gridcell" className="text-right text-[11px] text-muted-foreground tabular-nums">
                  {numberOf(row.id)}
                </span>
                <span role="gridcell" className={cn("text-xs whitespace-nowrap text-foreground tabular-nums", DATE_COL)}>
                  {formatRowDate(row.date)}
                </span>
                <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
                  {/* The description keeps a readable width; the check tag and the narrow status mark give way first. */}
                  <span className={cn("min-w-[6.5rem] flex-1 truncate text-[13px] text-foreground", selected ? "font-semibold" : "font-medium")} title={row.description}>
                    <span className="text-muted-foreground @min-[30rem]:hidden">{formatRowDate(row.date)} · </span>
                    {row.description || "No description"}
                  </span>
                  {checkLabel && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(row.id);
                        (onFixRow ?? onToggleExpand)(row.id);
                      }}
                      title={`${checkLabel} — click to fix it`}
                      aria-label={`${checkLabel} (row ${numberOf(row.id)})`}
                      data-testid="row-check-label"
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-warning outline-none transition-colors hover:bg-warning/15 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <TriangleAlert className="size-3.5" aria-hidden />
                      <span className="sr-only">{checkLabel}</span>
                    </button>
                  )}
                  {/* Narrow pane: the match state rides on the description's right edge. */}
                  <span className={cn("flex max-w-[45%] min-w-0 shrink justify-end overflow-hidden", NARROW_ONLY)}>
                    {meta ? (
                      <Mark tone={meta.tone} icon={meta.icon} title={`${meta.label} — ${evidence}`}>
                        {meta.short}
                      </Mark>
                    ) : accountMissing ? (
                      <Mark tone={ACCOUNT_MISSING_META.tone} icon={ACCOUNT_MISSING_META.icon} title={evidence}>
                        No account
                      </Mark>
                    ) : null}
                  </span>
                </span>
                <span role="gridcell" className="text-right whitespace-nowrap">
                  <Money amount={row.amount} direction={row.direction} className="text-[13px]" />
                </span>
                <span role="gridcell" className={cn("min-w-0 px-0!", WIDE_ONLY)}>
                  <span className="flex h-full min-w-0 items-center px-2">{matchCell}</span>
                </span>
                <span role="gridcell" className="min-w-0 px-1!">
                  {match?.state === "excluded" || row.removedFromReview ? (
                    <span className="flex items-center justify-between gap-1 px-1">
                      <span className="truncate text-[12px] text-muted-foreground">{row.removedFromReview ? "Removed" : "Not imported"}</span>
                      {actions && <QuickDecideMenu rowNumber={numberOf(row.id)} kind={null} actions={actions} onOpen={() => onSelect(row.id)} />}
                    </span>
                  ) : (
                    <span className="flex min-w-0 items-center justify-between gap-1 px-1">
                      <DecisionChip kind={decision?.kind ?? null} keepBoth={keepBoth} />
                      {actions && <QuickDecideMenu rowNumber={numberOf(row.id)} kind={decision?.kind ?? null} actions={actions} onOpen={() => onSelect(row.id)} />}
                    </span>
                  )}
                </span>
                <span role="gridcell" className="flex items-center justify-center px-0!">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} row ${numberOf(row.id)}`}
                    title={expanded ? "Close row details" : "Edit row details"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(row.id);
                    }}
                    className={cn(
                      "grid size-6 place-items-center rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      expanded ? "bg-primary/15 text-primary-accent-text" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <PencilLine className="size-3.5" />
                  </button>
                </span>
              </div>
            );
          })}
          {/* The sheet ends where the statement ends — no filler rows; the rest of the pane stays quiet. */}
          {rows.length > 0 && (
            <p className="px-3 py-1.5 text-[11px] text-muted-foreground/70" data-testid="statement-end">
              End of statement · {rows.length} row{rows.length === 1 ? "" : "s"} shown
            </p>
          )}
        </div>
      </div>
    </section>
  );
});
