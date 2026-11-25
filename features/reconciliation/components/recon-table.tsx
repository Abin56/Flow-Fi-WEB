"use client";

/**
 * The statement sheet — ONE compact, Excel-like table is the whole workspace (2026-11-25):
 *
 *   # · Date · Description · Amount · Type · Category · Match · Status · Action
 *
 * One ruled, single-line row per captured statement line. Its body scrolls on its own under a sticky column header.
 * Columns follow the pane's own width (container queries): a narrow pane drops Type, Category and Match first, so the
 * sheet never scrolls sideways.
 *
 *  - Description: FlowFi's clean wording ("Received from Mohan · UPI") with the bank's own narration muted beside it
 *    (full narration in the tooltip). Clicking it opens the row's details.
 *  - Category: picked right in the row; a reliable suggestion is pre-filled (marked "auto").
 *  - Match: "Possible match" opens the inline comparison under the row (inside the same scroll body — never clipped,
 *    never a second sheet).
 *  - Status: Ready · Possible match · Fix required · Imported · Skipped — one, never two.
 *  - Action: the row's ONE next step (Import, Review, Check date, Credit type…) rendered by the workspace, plus ⋯ and ✎.
 *
 * Without a statement account the Match column says "Account missing" with cross-account evidence (account-hints.ts).
 */

import { Fragment, forwardRef } from "react";
import { PencilLine, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import type { RowStatus } from "../lib/row-status";
import type { ReconRow, RowDecision, RowMatch } from "../lib/types";
import { QuickDecideMenu, type QuickAction } from "./recon-decision-menu";
import { ACCOUNT_MISSING_META, Mark, StatusChip, Money, SHEET_CELLS, SHEET_FRAME, SHEET_HEAD, SHEET_ROW, STATE_META, formatRowDate } from "./recon-ui";

/** ≥56rem: every column. ≥38rem: # · Date · Description · Amount · Status · Action. Narrow: # · Description · Amount · Action. */
const COLS =
  "grid-cols-[1.75rem_minmax(0,1fr)_6rem_12rem] @min-[38rem]:grid-cols-[2rem_4rem_minmax(0,1fr)_7.25rem_7rem_12.5rem] @min-[60rem]:grid-cols-[2rem_4.25rem_minmax(0,1fr)_7.5rem_4.25rem_9.5rem_7.5rem_6.75rem_13.5rem]";
const MID = "hidden @min-[38rem]:block";
const WIDE = "hidden @min-[60rem]:block";

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
  const different = match.notes.find((n) => n.kind === "different_reference");
  if (different) return "Same amount, different UPI reference";
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

/** The row's category cell: the value shown, whether FlowFi pre-filled it, and the choices (best first). */
export interface RowCategoryView {
  value: string | null;
  auto: boolean;
  /** Category names valid for the row's direction — suggested ones first. */
  options: string[];
  /** False for rows whose category no longer matters (imported, skipped, already recorded). */
  editable: boolean;
  /** The row needs a category before it can be imported. */
  needed: boolean;
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
  /** The ⋯ options for a row (null = nothing to decide, e.g. not yet compared). */
  quickActions?: (row: ReconRow) => QuickAction[] | null;
  /** Desktop viewport-fit layout: the body scrolls inside the grid. False = the page scrolls (short windows). */
  contained?: boolean;
  /** The sheet's title bar (title, count). */
  header?: React.ReactNode;
  /** No statement account chosen: the Match column shows "Account missing" plus cross-account evidence. */
  accountMissing?: boolean;
  accountHintOf?: (rowId: string) => RowAccountHint | null;
  /** The row's single status; null = matching not finished. */
  statusOf?: (row: ReconRow) => RowStatus | null;
  /** The description shown (clean wording or the user's own) and whether FlowFi derived it. */
  descriptionOf?: (row: ReconRow) => { text: string; auto: boolean };
  categoryOf?: (row: ReconRow) => RowCategoryView | null;
  onCategory?: (rowId: string, category: string | null) => void;
  /** The row's next step (Import / Review / Check date / Credit type …) — rendered by the workspace. */
  renderAction?: (row: ReconRow, status: RowStatus | null) => React.ReactNode;
  /** The row whose inline match review is open, and what to render under it (inside the same scroll body). */
  inlineId?: string | null;
  renderInline?: (row: ReconRow) => React.ReactNode;
  /** Remove the captured row from THIS review only (undoable). Never touches a FlowFi transaction. */
  onRemove?: (row: ReconRow) => void;
}

export const ReconTable = forwardRef<HTMLDivElement, ReconTableProps>(function ReconTable(
  { rows, numberOf, matches, decisions, selectedId, expandedId, onSelect, onToggleExpand, onCompare, onKeyDown, pendingLabel, quickActions, contained = true, header, accountMissing = false, accountHintOf, inlineId = null, renderInline, statusOf, descriptionOf, categoryOf, onCategory, renderAction, onRemove },
  ref,
) {
  return (
    <section aria-label="Statement" className={cn(SHEET_FRAME, contained && "h-full")} data-testid="statement-sheet">
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
          <span role="columnheader" className={MID}>
            Date
          </span>
          <span role="columnheader">Description</span>
          <span role="columnheader" className="text-right">
            Amount
          </span>
          <span role="columnheader" className={WIDE}>
            Type
          </span>
          <span role="columnheader" className={WIDE}>
            Category
          </span>
          <span role="columnheader" className={WIDE}>
            Match
          </span>
          <span role="columnheader" className={MID}>
            Status
          </span>
          <span role="columnheader">Action</span>
        </div>
        <div data-testid="recon-grid-body" className={cn("min-h-0 flex-1", contained && "overflow-y-auto overscroll-contain [scrollbar-gutter:stable]")}>
          {rows.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">No rows match these filters.</p>}
          {rows.map((row) => {
            const match = matches.get(row.id);
            const decision = decisions[row.id];
            const selected = row.id === selectedId;
            const expanded = row.id === expandedId;
            const status = statusOf ? statusOf(row) : null;
            const stripe = status?.kind === "ready" ? "bg-success/70" : status?.kind === "imported" ? "bg-success/40" : null;
            const actions = quickActions?.(row) ?? null;
            const hint = accountMissing && row.include && !row.captureExcluded ? (accountHintOf?.(row.id) ?? null) : null;
            const meta = match ? STATE_META[match.state] : null;
            const evidence = match ? evidenceLine(match) : accountMissing ? accountHintLine(hint) : pendingLabel;
            const shown = descriptionOf ? descriptionOf(row) : { text: row.description, auto: false };
            const narration = shown.text !== row.description ? row.description : null;
            const category = categoryOf?.(row) ?? null;
            const possible = !!match && match.state !== "already_imported" && match.state !== "excluded" && (match.candidates.length > 0 || match.pendingSms.length > 0);
            const matchCell = match && meta ? (
              match.state !== "excluded" ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCompare(row.id);
                  }}
                  title={`${meta.label} — ${evidence}. ${meta.hint}`}
                  data-evidence={evidence}
                  aria-expanded={inlineId === row.id}
                  className="flex h-full w-full min-w-0 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={`Compare row ${numberOf(row.id)}`}
                >
                  <Mark tone={meta.tone} icon={meta.icon} className={cn("shrink-0", possible && "underline-offset-2 hover:underline")}>
                    {meta.label}
                  </Mark>
                </button>
              ) : (
                <span className="flex min-w-0 items-center" title={`${meta.label} — ${evidence}`} data-evidence={evidence}>
                  <Mark tone={meta.tone} icon={meta.icon} className="shrink-0">
                    {meta.label}
                  </Mark>
                </span>
              )
            ) : accountMissing && row.include && !row.captureExcluded ? (
              <span className="flex min-w-0 items-center gap-1.5" title={`${ACCOUNT_MISSING_META.hint} ${evidence}.`} data-testid="match-account-missing">
                <Mark tone={ACCOUNT_MISSING_META.tone} icon={ACCOUNT_MISSING_META.icon} className="shrink-0">
                  {ACCOUNT_MISSING_META.label}
                </Mark>
                <span className="sr-only">{evidence}</span>
              </span>
            ) : (
              <span className="block truncate text-[11px] text-muted-foreground" data-testid="match-pending">
                {evidenceLine(undefined, pendingLabel)}
              </span>
            );
            return (
              <Fragment key={row.id}>
                <div
                  id={`recon-row-${row.id}`}
                  role="row"
                  aria-selected={selected}
                  data-testid="recon-row"
                  data-row-id={row.id}
                  data-state={match?.state ?? "pending"}
                  data-status={status?.kind ?? "checking"}
                  data-account-missing={!match && accountMissing ? "true" : undefined}
                  data-amount={row.amount ?? ""}
                  data-direction={row.direction ?? ""}
                  data-description={row.description}
                  data-display-description={shown.text}
                  data-decision={decision?.kind ?? ""}
                  onClick={() => onSelect(row.id)}
                  onDoubleClick={(e) => {
                    if (!expanded && !(e.target as HTMLElement).closest("button, a, select, [role=menu], [role=dialog]")) onToggleExpand(row.id);
                  }}
                  className={cn(
                    SHEET_ROW,
                    COLS,
                    SHEET_CELLS,
                    (!row.include || status?.kind === "skipped") && "opacity-60",
                    selected ? "bg-primary/[0.14]! inset-ring-2 inset-ring-primary/60 group-focus-visible/grid:bg-primary/[0.2]!" : "hover:bg-muted/60!",
                  )}
                >
                  {(selected || stripe) && <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px] border-0! p-0!", selected ? "bg-primary" : stripe)} />}
                  <span role="gridcell" className="text-right text-[11px] text-muted-foreground tabular-nums">
                    {numberOf(row.id)}
                  </span>
                  <span role="gridcell" className={cn("text-xs whitespace-nowrap text-foreground tabular-nums", MID)}>
                    {formatRowDate(row.date)}
                  </span>
                  <span role="gridcell" className="flex min-w-0 items-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(row.id);
                        onToggleExpand(row.id);
                      }}
                      title={narration ? `${shown.text}\nBank narration: ${narration}` : shown.text}
                      aria-label={`Open details for row ${numberOf(row.id)}: ${shown.text}`}
                      data-testid="row-description"
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("min-w-0 shrink truncate text-[13px] text-foreground", selected ? "font-semibold" : "font-medium")}>
                        <span className="text-muted-foreground @min-[38rem]:hidden">{formatRowDate(row.date)} · </span>
                        {shown.text || "No description"}
                      </span>
                      {narration && (
                        <span className="hidden min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/80 @min-[48rem]:block" data-testid="row-narration">
                          {narration}
                        </span>
                      )}
                    </button>
                  </span>
                  <span role="gridcell" className="text-right whitespace-nowrap">
                    <Money amount={row.amount} direction={row.direction} className="text-[13px]" />
                  </span>
                  <span role="gridcell" className={cn("truncate text-xs text-muted-foreground", WIDE)} data-testid="row-type">
                    {row.direction === "credit" ? "Credit" : row.direction === "debit" ? "Debit" : "—"}
                  </span>
                  <span role="gridcell" className={cn("min-w-0 px-1!", WIDE)}>
                    {category && category.editable ? (
                      <span className="relative flex h-full items-center">
                        <select
                          aria-label={`Category for row ${numberOf(row.id)}`}
                          data-testid="row-category"
                          data-auto={category.auto ? "true" : undefined}
                          value={category.value ?? ""}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          onChange={(e) => onCategory?.(row.id, e.target.value || null)}
                          className={cn(
                            "h-7 w-full min-w-0 cursor-pointer truncate rounded-md border bg-transparent pr-5 pl-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            category.value ? "border-transparent text-foreground hover:border-border-strong/70" : category.needed ? "border-warning/60 text-warning" : "border-transparent text-muted-foreground hover:border-border-strong/70",
                          )}
                          title={category.auto ? `${category.value} — suggested from your history / the merchant. Change it if it's wrong.` : (category.value ?? "Choose a category")}
                        >
                          <option value="">{category.needed ? "Choose…" : "—"}</option>
                          {category.options.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                        {category.auto && category.value && <Sparkles aria-label="Suggested" className="pointer-events-none absolute right-1 size-3 text-primary-accent-text" />}
                      </span>
                    ) : (
                      <span className="block truncate px-1 text-[12px] text-muted-foreground">{category?.value ?? "—"}</span>
                    )}
                  </span>
                  <span role="gridcell" className={cn("min-w-0 px-0!", WIDE)}>
                    <span className="flex h-full min-w-0 items-center px-2">{matchCell}</span>
                  </span>
                  <span role="gridcell" className={cn("min-w-0", MID)} title={status?.reason}>
                    <StatusChip status={status} />
                  </span>
                  <span role="gridcell" className="flex min-w-0 items-center justify-end gap-0.5 px-1!">
                    <span className="flex min-w-0 flex-1 items-center justify-start">{renderAction?.(row, status)}</span>
                    {actions && <QuickDecideMenu rowNumber={numberOf(row.id)} kind={decision?.kind ?? null} actions={actions} onOpen={() => onSelect(row.id)} />}
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Close editor for" : "Edit"} row ${numberOf(row.id)}`}
                      title={expanded ? "Close editor" : "Edit"}
                      data-testid="row-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand(row.id);
                      }}
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        expanded ? "bg-primary/15 text-primary-accent-text" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                      )}
                    >
                      <PencilLine className="size-3.5" />
                    </button>
                    {onRemove && row.include && status?.kind !== "imported" && (
                      <button
                        type="button"
                        title="Delete from this review (nothing in FlowFi changes — Undo restores it)"
                        aria-label={`Delete row ${numberOf(row.id)} from this review`}
                        data-testid="row-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(row);
                        }}
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </span>
                </div>
                {inlineId === row.id && renderInline?.(row)}
              </Fragment>
            );
          })}
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
