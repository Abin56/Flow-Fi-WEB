"use client";

/**
 * The New Statement sheet — the left page of the dual-sheet merge studio: a bordered, spreadsheet-like grid of the
 * captured statement rows. Its body scrolls on its own under a sticky column header. Columns follow the pane's own
 * width (container queries), not the window's: a narrow pane folds the Match column into the description cell, so the
 * sheet never scrolls sideways however the divider is dragged.
 *
 * Selecting a row drives the Existing FlowFi sheet; rows that are possible matches for the FlowFi transaction picked
 * over there get a quiet highlight here (synchronised selection — never synchronised scrolling).
 *
 * Editing a row never opens a form inside the table: the pencil, Enter or a double-click opens the row's sheet,
 * which the workspace renders over the viewport — the table stays a list and the row stays highlighted.
 */

import { forwardRef } from "react";
import { PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import { rowCheckLabel } from "../lib/decisions";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { QuickDecideMenu, type QuickAction } from "./recon-decision-menu";
import { DecisionChip, Money, SHEET_HEAD, StateMark, formatRowDate } from "./recon-ui";

/** Narrow pane: # · date · description (+ match) · amount · decision · edit. Wide pane adds the Match column. */
/** Narrow pane (< 34rem): the date folds into the description line, so the sheet never scrolls sideways. */
const COLS =
  "grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_8rem_2.25rem] @min-[34rem]:grid-cols-[2.25rem_4.5rem_minmax(0,1fr)_8.25rem_8.75rem_2.25rem] @min-[50rem]:grid-cols-[2.5rem_5rem_minmax(0,1fr)_9rem_11rem_9.25rem_2.5rem]";
const DATE_COL = "hidden @min-[34rem]:block";
/** Cells stretch to the row's height and centre their content; faint column rules keep the sheet readable without boxing every cell. */
const CELLS = "[&>*]:self-stretch [&>*]:content-center [&>*]:px-2 [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-border/35";
const WIDE_ONLY = "hidden @min-[50rem]:block";
const NARROW_ONLY = "@min-[50rem]:hidden";

/** One line of evidence for the row's best possible match. */
export function evidenceLine(match: RowMatch | undefined, pendingLabel = "Choose the statement account"): string {
  if (!match) return pendingLabel;
  if (match.state === "already_imported") return "Imported earlier from this row";
  if (match.state === "excluded") return "Excluded in Smart Capture";
  const best = match.candidates.find((c) => c.recordId === match.suggestedRecordId) ?? match.candidates[0];
  if (match.state === "multiple") return `${match.candidates.length} possible matches`;
  if (best) return [describeAmountDelta(best.amountDeltaPaise).replace(" in FlowFi", ""), describeDayGap(best.dayGap).replace(" in FlowFi", "")].join(" · ");
  if (match.pendingSms.length > 0) return "SMS waiting in Inbox";
  if (match.conflicts[0]) return match.conflicts[0];
  return "Nothing similar on this account";
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
  /** The sheet's title bar (title, count, search) — the dual-sheet layout's page heading. */
  header?: React.ReactNode;
}

export const ReconTable = forwardRef<HTMLDivElement, ReconTableProps>(function ReconTable(
  { rows, numberOf, matches, decisions, selectedId, expandedId, onSelect, onToggleExpand, onCompare, onKeyDown, pendingLabel, quickActions, contained = true, highlightIds, header },
  ref,
) {
  return (
    <section aria-label="New statement" className={cn("@container flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border-strong/70 bg-card shadow-e1", contained && "h-full")} data-testid="statement-sheet">
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
        <div role="row" className={cn(SHEET_HEAD, COLS, CELLS)}>
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
            Match in FlowFi
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
            const flagged = checkLabel != null;
            const keepBoth = !!match && (match.candidates.length > 0 || match.pendingSms.length > 0);
            // A left stripe shows the review's progress at a glance: amber = still needs a decision, green = decided.
            const stripe = !match || match.state === "excluded" || !row.include ? null : decision?.kind && decision.kind !== "investigate" ? "bg-success/70" : "bg-warning/80";
            const actions = quickActions?.(row) ?? null;
            const matchCell = match ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCompare(row.id);
                }}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Compare row ${numberOf(row.id)}`}
              >
                <StateMark state={match.state} />
                <span className="block w-full truncate text-[11px] text-muted-foreground">{evidenceLine(match)}</span>
              </button>
            ) : (
              <span className="text-[11px] text-muted-foreground" data-testid="match-pending">
                {evidenceLine(undefined, pendingLabel)}
              </span>
            );
            return (
              <div key={row.id} className={cn("border-b border-border/70", !row.include && "opacity-60")}>
                <div
                  id={`recon-row-${row.id}`}
                  role="row"
                  aria-selected={selected}
                  data-testid="recon-row"
                  data-row-id={row.id}
                  data-state={match?.state ?? "pending"}
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
                    "relative grid h-10 cursor-pointer scroll-my-2 items-stretch transition-colors",
                    COLS,
                    CELLS,
                    // Selected: tinted + a hairline frame, stronger while the sheet has keyboard focus. Related (a possible
                    // match for the FlowFi transaction picked opposite): a lighter tint and the right-edge tick.
                    selected
                      ? "bg-primary/[0.08] inset-ring inset-ring-primary/30 group-focus-visible/grid:bg-primary/[0.13]"
                      : related
                        ? "bg-primary/[0.045] hover:bg-primary/[0.07]"
                        : "hover:bg-muted/45",
                  )}
                >
                  {(selected || stripe) && <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px] border-0! p-0!", selected ? "bg-primary" : stripe)} />}
                  {related && <span aria-hidden className="pointer-events-none absolute inset-y-1.5 right-0 w-[3px] rounded-l border-0! bg-primary/50 p-0!" />}
                  <span role="gridcell" className="text-right text-xs text-muted-foreground tabular-nums">
                    {numberOf(row.id)}
                  </span>
                  <span role="gridcell" className={cn("text-xs whitespace-nowrap text-foreground tabular-nums", DATE_COL)}>
                    {formatRowDate(row.date)}
                  </span>
                  <span role="gridcell" className="min-w-0">
                    <span className={cn("block truncate text-[13px] leading-snug text-foreground", selected ? "font-semibold" : "font-medium")} title={row.description}>
                      {row.description || "No description"}
                    </span>
                    {flagged ? (
                      <span className="block truncate text-[11px] text-warning" data-testid="row-check-label">{checkLabel}</span>
                    ) : (
                      <span className={cn("block truncate text-[11px] text-muted-foreground", NARROW_ONLY)}>
                        <span className="@min-[34rem]:hidden">{formatRowDate(row.date)} · </span>
                        {evidenceLine(match, pendingLabel)}
                      </span>
                    )}
                  </span>
                  <span role="gridcell" className="text-right whitespace-nowrap">
                    <Money amount={row.amount} direction={row.direction} />
                  </span>
                  <span role="gridcell" className={cn("min-w-0", WIDE_ONLY)}>
                    {matchCell}
                  </span>
                  <span role="gridcell" className="min-w-0">
                    {match?.state === "excluded" ? (
                      <span className="text-xs text-muted-foreground">Not imported</span>
                    ) : actions ? (
                      <QuickDecideMenu rowNumber={numberOf(row.id)} kind={decision?.kind ?? null} keepBoth={keepBoth} actions={actions} onOpen={() => onSelect(row.id)} />
                    ) : (
                      <DecisionChip kind={decision?.kind ?? null} keepBoth={keepBoth} />
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
                        "grid size-7 place-items-center rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        expanded ? "bg-primary/15 text-primary-accent-text" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                      )}
                    >
                      <PencilLine className="size-3.5" />
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
          {/* The sheet ends where the statement ends — no filler rows; the rest of the pane stays quiet. */}
          {rows.length > 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground/70" data-testid="statement-end">
              End of statement · {rows.length} row{rows.length === 1 ? "" : "s"} shown
            </p>
          )}
        </div>
      </div>
    </section>
  );
});
