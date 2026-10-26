"use client";

/**
 * Desktop reconciliation grid — a bordered, spreadsheet-like table. On desktop the workspace fits the viewport and
 * this grid's body is the one region that scrolls during ordinary review (the column header stays put above it); no
 * horizontal scroller — columns that don't fit fold the description to two lines instead.
 */

import { forwardRef } from "react";
import { ChevronDown, GitCompareArrows, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { openIssues } from "@/features/smart-capture/lib/capture-review";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { DecisionChip, Money, StateBadge, formatRowDate } from "./recon-ui";

const COLS = "grid-cols-[2.5rem_5.25rem_minmax(0,1fr)_9.5rem_11.5rem_9.5rem_2.5rem]";
/** Every cell after the first carries a column rule; cells stretch to the row's height and centre their content. */
const CELLS = "[&>*]:self-stretch [&>*]:content-center [&>*]:px-2.5 [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-border/60";

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
  expandedId: string | null;
  onSelect: (rowId: string) => void;
  onToggleExpand: (rowId: string) => void;
  onCompare: (rowId: string) => void;
  renderEditor: (row: ReconRow) => React.ReactNode;
  /** Shown in the Match column while results are withheld (no account yet, still loading, or a load failed). */
  pendingLabel: string;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Desktop viewport-fit layout: the body scrolls inside the grid. False = the page scrolls (short windows). */
  contained?: boolean;
}

export const ReconTable = forwardRef<HTMLDivElement, ReconTableProps>(function ReconTable(
  { rows, numberOf, matches, decisions, selectedId, expandedId, onSelect, onToggleExpand, onCompare, renderEditor, onKeyDown, pendingLabel, contained = true },
  ref,
) {
  return (
    <div
      ref={ref}
      role="grid"
      aria-label="Statement rows"
      aria-rowcount={rows.length}
      aria-activedescendant={selectedId ? `recon-row-${selectedId}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="recon-grid"
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring", contained && "h-full")}
    >
      <div role="row" className={cn("grid h-9 shrink-0 items-stretch border-b border-border bg-muted text-[11px] font-semibold tracking-wide text-muted-foreground uppercase", COLS, CELLS)}>
        <span role="columnheader" className="text-right">
          #
        </span>
        <span role="columnheader">Date</span>
        <span role="columnheader">Description</span>
        <span role="columnheader" className="text-right">
          Amount
        </span>
        <span role="columnheader">Match in FlowFi</span>
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
          const flagged = row.needsReconfirm || (row.include && openIssues(row).length > 0);
          return (
            <div key={row.id} className={cn("border-b border-border last:border-b-0", !row.include && "opacity-60")}>
              <div
                id={`recon-row-${row.id}`}
                role="row"
                aria-selected={selected}
                data-testid="recon-row"
                data-row-id={row.id}
                data-state={match?.state ?? "pending"}
                onClick={() => onSelect(row.id)}
                className={cn(
                  "relative grid h-14 cursor-pointer scroll-my-2 items-stretch transition-colors",
                  COLS,
                  CELLS,
                  selected ? "bg-primary/[0.08]" : "hover:bg-muted/50",
                  selected && "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
                )}
              >
                <span role="gridcell" className="text-right text-xs text-muted-foreground tabular-nums">
                  {numberOf(row.id)}
                </span>
                <span role="gridcell" className="text-xs whitespace-nowrap text-foreground tabular-nums">
                  {formatRowDate(row.date)}
                </span>
                <span role="gridcell" className="min-w-0">
                  <span className={cn("block break-words text-sm leading-snug font-medium text-foreground", flagged ? "truncate" : "line-clamp-2")} title={row.description}>
                    {row.description || "No description"}
                  </span>
                  {flagged && <span className="block truncate text-[11px] text-warning">{row.needsReconfirm ? "Edited — confirm values" : "Check flagged values"}</span>}
                </span>
                <span role="gridcell" className="text-right whitespace-nowrap">
                  <Money amount={row.amount} direction={row.direction} />
                </span>
                <span role="gridcell" className="min-w-0">
                  {match ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCompare(row.id);
                      }}
                      className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Compare row ${numberOf(row.id)}`}
                    >
                      <StateBadge state={match.state} />
                      <span className="block w-full truncate text-[11px] text-muted-foreground">{evidenceLine(match)}</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground" data-testid="match-pending">
                      {evidenceLine(undefined, pendingLabel)}
                    </span>
                  )}
                </span>
                <span role="gridcell" className="min-w-0">
                  {match?.state === "excluded" ? <span className="text-xs text-muted-foreground">Not imported</span> : <DecisionChip kind={decision?.kind ?? null} />}
                </span>
                <span role="gridcell" className="flex items-center justify-center px-0!">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} row ${numberOf(row.id)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(row.id);
                    }}
                    className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ChevronDown className={cn("size-4 transition-transform duration-fast", expanded && "rotate-180")} />
                  </button>
                </span>
              </div>
              {expanded && (
                <div className="border-t border-border bg-muted/25 px-4 py-4 sm:pl-14" data-testid="row-editor-panel">
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground">
                    <PencilLine className="size-3.5 text-muted-foreground" /> Transaction details — draft only
                    {match && (
                      <button type="button" onClick={() => onCompare(row.id)} className="ml-auto inline-flex items-center gap-1.5 font-medium text-primary-accent-text underline-offset-4 hover:underline">
                        <GitCompareArrows className="size-3.5" /> Compare with FlowFi
                      </button>
                    )}
                  </div>
                  {renderEditor(row)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
