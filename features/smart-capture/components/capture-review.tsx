"use client";

/**
 * Step 2 of Smart Capture — every extracted row is a candidate, never a
 * transaction. A spreadsheet-like, expandable grid: the user includes/excludes,
 * corrects values, confirms flagged fields individually, and checks rows
 * against the source (one by one, or in bulk for rows with nothing else
 * open). Nothing here writes anywhere.
 *
 * Separate ideas, shown separately:
 *  - Included for review — the row's checkbox; excluded rows stay visible (dimmed) and travel along, never imported.
 *  - Ready / Needs review / Needs correction — one rule (`needsCorrection`, `openIssues`). Rows read with clear
 *    evidence are Ready with no click; "Review issues" walks only the rest, one row at a time, and moves on by itself
 *    once a row is confirmed or excluded. Whether a row is imported at all is decided later, in Check duplicates, and
 *    only through its final approval.
 *  - The money summary — the included rows' current values (`reviewTotals`), by statement direction and by what each
 *    row will be imported as.
 *
 * Layout: on desktop the workspace fits the viewport — the summary, toolbar and action bar stay put and only the
 * grid (and, separately, the source panel beside it) scrolls. On phones there is one page scroll, the screenshot
 * opens in a viewer, and the action bar sticks to the bottom edge.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, CheckCheck, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleCheck, Eye, EyeOff, FileText, ImageIcon, ListChecks, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrencyPrecise } from "@/lib/format";
import type { CaptureParseResult } from "../lib/parse-pasted-statement";
import {
  applyRowPatch,
  bulkConfirm,
  bulkConfirmEligible,
  canContinue,
  confirmField,
  confirmRow,
  reviewProgress,
  reviewTotals,
  selectionCounts,
  undoBulkConfirm,
  unconfirmRow,
  type ReviewRow,
  type ReviewTotals,
  type RowPatch,
} from "../lib/capture-review";
import type { OcrCapture } from "./capture-input";
import { OcrSourceView, ScreenshotDialog } from "./ocr-source-view";
import { ColumnLayoutControl, useColumnLayout } from "./column-layout-control";
import { gridMinWidth, ReviewColumnHeader, ReviewRowItem, ReviewStandardHeader, rowStatus, type RowStatus } from "./review-row";

type Filter = "all" | "fix" | "check" | "ready" | "excluded";
type Sort = "source" | "date" | "amount";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "fix", label: "To fix" },
  { id: "check", label: "To check" },
  { id: "ready", label: "Ready" },
  { id: "excluded", label: "Excluded" },
];

function matchesFilter(status: RowStatus, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return status === "ready" || status === "imported";
  return status === filter;
}

// Phones: 44px touch targets with a short visible label (touch has no tooltips); desktop stays compact and icon-only until 2xl.
const toolButton = "inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-xs sm:h-7 sm:min-w-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

export function CaptureReview({
  parse,
  rows,
  onRowsChange,
  onBack,
  onContinue,
  ocr,
}: {
  parse: CaptureParseResult;
  rows: ReviewRow[];
  onRowsChange: (rows: ReviewRow[]) => void;
  onBack: () => void;
  onContinue: () => void;
  ocr?: OcrCapture | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("source");
  const [focusedId, setFocusedId] = useState<string | null>(rows[0]?.id ?? null);
  // Keyed by row id, so it survives filtering, sorting and editing.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showExcluded, setShowExcluded] = useState(true);
  const [showIgnored, setShowIgnored] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  /** The row "Review issues" is on (null = not walking the issues). */
  const [issueId, setIssueId] = useState<string | null>(null);
  const [issuesDone, setIssuesDone] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const columnLayout = useColumnLayout(parse);

  /**
   * Applies one row change. `settles`: an explicit confirm/exclude — when that leaves the current issue row Ready or
   * excluded, "Review issues" moves straight on to the next one. (Typing never moves on: an edit can clear a flag
   * mid-word.)
   */
  function update(id: string, change: (r: ReviewRow) => ReviewRow, settles = false) {
    const next = rows.map((r) => (r.id === id ? change(r) : r));
    onRowsChange(next);
    if (settles && issueId === id) {
      const status = rowStatus(next.find((r) => r.id === id)!);
      if (status === "ready" || status === "excluded") goToIssue(nextIssueAfter(id, next), next);
    }
  }
  const patch = (id: string, p: RowPatch) => update(id, (r) => applyRowPatch(r, p), p.include === false || p.confirmed === true);
  const setAll = (include: boolean) => onRowsChange(rows.map((r) => (r.committedTransactionId ? r : { ...r, include })));

  const progress = useMemo(() => reviewProgress(rows), [rows]);
  const totals = useMemo(() => reviewTotals(rows), [rows]);
  const selection = useMemo(() => selectionCounts(rows), [rows]);
  const statusById = useMemo(() => new Map(rows.map((r) => [r.id, rowStatus(r)])), [rows]);
  const eligible = useMemo(() => bulkConfirmEligible(rows), [rows]);
  const bulkCount = rows.filter((r) => r.bulkConfirmed && r.confirmed).length;

  const ordered = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const visible = useMemo(
    () => ordered.filter((r) => matchesFilter(statusById.get(r.id)!, filter) && (showExcluded || filter === "excluded" || r.include)),
    [ordered, statusById, filter, showExcluded],
  );
  /** Rows "Review issues" walks, in the order they're listed. */
  const issueIds = useMemo(() => ordered.filter((r) => isIssue(statusById.get(r.id)!)).map((r) => r.id), [ordered, statusById]);

  function nextIssueAfter(id: string | null, list: ReviewRow[], step: 1 | -1 = 1): string | null {
    const all = sortRows(list, sort);
    const issues = all.filter((r) => isIssue(rowStatus(r)));
    if (issues.length === 0) return null;
    const at = id == null ? -1 : all.findIndex((r) => r.id === id);
    if (step === 1) return (issues.find((r) => all.indexOf(r) > at) ?? issues[0]).id;
    return ([...issues].reverse().find((r) => all.indexOf(r) < at) ?? issues[issues.length - 1]).id;
  }

  /** Opens just this issue row (others collapse), brings it into view and puts focus on its one action. */
  function goToIssue(id: string | null, list: ReviewRow[] = rows) {
    setIssueId(id);
    setIssuesDone(id == null && list.some((r) => r.include));
    if (id == null) return;
    if (!matchesFilter(rowStatus(list.find((r) => r.id === id)!), filter)) setFilter("all");
    setFocusedId(id);
    setExpanded(new Set([id]));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const li = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
        li?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        (li?.querySelector<HTMLElement>('[data-testid="confirm-row"]') ?? li?.querySelector<HTMLElement>("button[aria-expanded]"))?.focus({ preventScroll: true });
      }),
    );
  }

  // Grid only where the columns fit with a readable merchant (the list shares the row with the screenshot panel, so
  // that depends on the list's own width, not the window's). Unknown width (first paint, no layout engine) = grid.
  const [listWidth, setListWidth] = useState(0);
  const listShown = visible.length > 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setListWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [listShown]);
  const grid = columnLayout.columns != null && (listWidth === 0 || listWidth >= gridMinWidth(columnLayout.columns));

  const filterCount = (f: Filter) => rows.filter((r) => matchesFilter(statusById.get(r.id)!, f)).length;

  const focused = rows.find((r) => r.id === focusedId) ?? null;
  const ready = canContinue(rows);
  const allIncluded = selection.total > 0 && selection.included === selection.total;
  const allVisibleExpanded = visible.length > 0 && visible.every((r) => expanded.has(r.id));

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** "Fix …" / "Check" on a collapsed row: open it and bring it into view. */
  function expandAndReveal(id: string) {
    if (issueId != null) setIssueId(id);
    setFocusedId(id);
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  }

  /** ↑/↓ move focus between rows (Enter/Space on a row opens its editor) — only while a row itself has focus, never inside an editor. */
  function onListKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [role=group]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const idx = visible.findIndex((r) => r.id === focusedId);
    const next = visible[Math.min(Math.max(idx + (e.key === "ArrowDown" ? 1 : -1), 0), visible.length - 1)];
    if (!next) return;
    e.preventDefault();
    setFocusedId(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${next.id}"] button[aria-expanded]`)?.focus();
  }

  // Keep the focused row valid when it's filtered away.
  useEffect(() => {
    if (focusedId && !rows.some((r) => r.id === focusedId)) setFocusedId(rows[0]?.id ?? null); // eslint-disable-line react-hooks/set-state-in-effect -- reconciling a stale selection
  }, [rows, focusedId]);

  const pct = (n: number) => (progress.included === 0 ? 0 : Math.round((n / progress.included) * 100));
  const issuePosition = issueId ? issueIds.indexOf(issueId) : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Summary — the included rows' money first, then where the review stands, then the one next step. */}
      <section aria-label="Review summary" data-testid="review-summary" className="@container flex flex-col gap-2.5 rounded-2xl border border-border bg-card px-3 py-3 sm:px-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] @3xl:items-end">
          <MoneyFigure label="Debits" detail={`${totals.debitCount} charge${totals.debitCount === 1 ? "" : "s"}`} value={totals.debits} sign="−" testId="total-debits" />
          <MoneyFigure label="Credits" detail={`${totals.creditCount} credit${totals.creditCount === 1 ? "" : "s"}`} value={totals.credits} sign="+" tone="success" testId="total-credits" />
          <MoneyFigure
            label={totals.net < 0 ? "Net outflow" : totals.net > 0 ? "Net inflow" : "Net"}
            detail="credits − debits"
            value={Math.abs(totals.net)}
            sign={totals.net < 0 ? "−" : totals.net > 0 ? "+" : ""}
            testId="total-net"
          />
          <div className="col-span-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 @3xl:col-span-1 @3xl:justify-end" aria-label="Review status">
            <ProgressFigure label="included" value={`${selection.included}`} of={selection.total} testId="progress-included" />
            <ProgressFigure label="ready" value={`${progress.ready}`} of={progress.included} tone={progress.ready === progress.included && progress.included > 0 ? "success" : "default"} testId="progress-ready" />
            <ProgressFigure label="to review" value={`${progress.toCheck}`} tone={progress.toCheck > 0 ? "attention" : "default"} testId="progress-check" />
            <ProgressFigure label="to correct" value={`${progress.fieldIssues}`} tone={progress.fieldIssues > 0 ? "warning" : "default"} testId="progress-fix" />
          </div>
        </div>
        <TotalsBreakdown totals={totals} />
        <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Rows ready" aria-valuemin={0} aria-valuemax={progress.included} aria-valuenow={progress.ready}>
          <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${pct(progress.ready)}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {issueIds.length > 0 && (
            <ClayButton size="sm" data-testid="review-issues" onClick={() => goToIssue(issueId && issueIds.includes(issueId) ? issueId : nextIssueAfter(null, rows))}>
              <ListChecks className="size-4" />
              Review issues ({issueIds.length})
            </ClayButton>
          )}
          {eligible.length > 0 && (
            <ClayButton size="sm" variant="secondary" onClick={() => setBulkOpen(true)}>
              <CheckCheck className="size-4" />
              Confirm all reviewed rows ({eligible.length})
            </ClayButton>
          )}
          {bulkCount > 0 && (
            <button type="button" onClick={() => onRowsChange(undoBulkConfirm(rows))} className={toolButton}>
              <Undo2 className="size-3.5" /> Undo bulk confirmation ({bulkCount})
            </button>
          )}
          <p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="review-hint">
            {progress.included === 0
              ? "Include at least one row."
              : issueIds.length === 0
                ? <span className="inline-flex items-center gap-1 font-medium text-success"><CircleCheck className="size-3.5" /> Every included row is ready — nothing to confirm.</span>
                : `${progress.ready} of ${progress.included} ready with no click needed. Only the ${issueIds.length} row${issueIds.length === 1 ? "" : "s"} below need${issueIds.length === 1 ? "s" : ""} you${progress.fieldIssues > 0 ? ` (${progress.fieldIssues} to correct — never bulk-confirmed)` : ""}.`}
          </p>
        </div>
      </section>

      <div className="grid min-h-0 min-w-0 flex-1 items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section aria-label="Extracted transactions" className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-border bg-card lg:overflow-hidden">
          {/* Toolbar — selection first, then view controls. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-muted/30 px-2.5 py-2 sm:px-3" data-testid="review-toolbar">
            <div className="flex items-center gap-1.5" role="group" aria-label="Selection">
              <Checkbox checked={allIncluded ? true : selection.included === 0 ? false : "indeterminate"} onCheckedChange={() => setAll(!allIncluded)} aria-label="Select all rows" />
              <button type="button" onClick={() => setAll(true)} disabled={allIncluded} className={toolButton}>
                Select all
              </button>
              <button type="button" onClick={() => setAll(false)} disabled={selection.included === 0} className={toolButton}>
                Deselect all
              </button>
              <span className="px-1 text-xs text-muted-foreground tabular-nums" data-testid="selection-count" aria-live="polite">
                <span className="font-semibold text-foreground">{selection.included}</span> included · {selection.excluded} excluded
              </span>
            </div>
            <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
            <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label="Filter rows">
              {FILTERS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={cn("h-11 min-w-11 rounded-lg px-2 text-xs transition-colors sm:h-7 sm:min-w-0", filter === id ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                >
                  {label} <span className="tabular-nums opacity-70">{filterCount(id)}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-0.5" data-testid="review-toolbar-actions">
              <button type="button" aria-pressed={showExcluded} aria-label="Show excluded rows" title={showExcluded ? "Excluded rows shown — click to hide" : "Excluded rows hidden — click to show"} onClick={() => setShowExcluded((v) => !v)} className={toolButton}>
                {showExcluded ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                <span className="sm:hidden">Excluded</span>
                <span className="hidden 2xl:inline">{showExcluded ? "Excluded shown" : "Excluded hidden"}</span>
              </button>
              {ocr && (
                <button type="button" onClick={() => setViewerOpen(true)} className={cn(toolButton, "lg:hidden")}>
                  <ImageIcon className="size-3.5" /> Screenshot
                </button>
              )}
              <ColumnLayoutControl state={columnLayout} />
              <button
                type="button"
                onClick={() => setSort(sort === "source" ? "date" : sort === "date" ? "amount" : "source")}
                className={toolButton}
                title="Change sort order" aria-label={`Sort: ${sort === "source" ? "statement order" : sort === "date" ? "by date" : "by amount"}`}
              >
                <ArrowDownUp className="size-3.5" />
                <span className="sm:hidden">Sort</span>
                <span className="hidden 2xl:inline">{sort === "source" ? "Statement order" : sort === "date" ? "By date" : "By amount"}</span>
              </button>
              <button type="button" onClick={() => setExpanded(allVisibleExpanded ? new Set() : new Set([...expanded, ...visible.map((r) => r.id)]))} className={toolButton} aria-label={allVisibleExpanded ? "Collapse all" : "Expand all"} title={allVisibleExpanded ? "Collapse all rows" : "Expand all rows"}>
                {allVisibleExpanded ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
                <span className="sm:hidden">{allVisibleExpanded ? "Collapse" : "Expand"}</span>
                <span className="hidden 2xl:inline">{allVisibleExpanded ? "Collapse all" : "Expand all"}</span>
              </button>
            </div>
          </div>

          {(issueId != null || issuesDone) && (
            <div data-testid="issue-navigator" className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/[0.06] px-2.5 py-1.5 text-xs sm:px-3" aria-live="polite">
              {issueId != null ? (
                <>
                  <span className="font-medium text-foreground tabular-nums">{issuePosition >= 0 ? `Issue ${issuePosition + 1} of ${issueIds.length}` : `Resolved · ${issueIds.length} left`}</span>
                  <span className="hidden text-muted-foreground sm:inline">— confirm or correct it, and the next one opens.</span>
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" className={toolButton} onClick={() => goToIssue(nextIssueAfter(issueId, rows, -1))} disabled={issueIds.length === 0} aria-label="Previous issue">
                      <ChevronLeft className="size-3.5" /> <span className="hidden sm:inline">Previous</span>
                    </button>
                    <button type="button" className={toolButton} onClick={() => goToIssue(nextIssueAfter(issueId, rows))} disabled={issueIds.length === 0} aria-label="Next issue">
                      <span className="hidden sm:inline">Next</span> <ChevronRight className="size-3.5" />
                    </button>
                    <button type="button" className={toolButton} onClick={() => setIssueId(null)} aria-label="Stop reviewing issues">
                      <X className="size-3.5" />
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1 font-medium text-success">
                    <CircleCheck className="size-3.5" /> All issues reviewed.
                  </span>
                  <span className="text-muted-foreground">Next: check for duplicates.</span>
                  <button type="button" className={cn(toolButton, "ml-auto")} onClick={() => setIssuesDone(false)} aria-label="Dismiss">
                    <X className="size-3.5" />
                  </button>
                </>
              )}
            </div>
          )}

          {visible.length === 0 ? (
            <p className="flex-1 px-4 py-12 text-center text-sm text-muted-foreground">
              {filter === "fix" ? "Nothing left to fix." : filter === "check" ? "Nothing left to check." : !showExcluded && selection.included === 0 ? "Every row is excluded — show excluded rows to include some." : "No rows match this filter."}
            </p>
          ) : (
            <ul ref={listRef} data-testid="review-list" onKeyDown={onListKeyDown} className="min-h-0 flex-1 lg:overflow-y-auto lg:overscroll-contain lg:[scrollbar-gutter:stable]">
              {columnLayout.columns && grid ? <ReviewColumnHeader columns={columnLayout.columns} /> : !columnLayout.columns ? <ReviewStandardHeader /> : null}
              {visible.map((row) => (
                <ReviewRowItem
                  key={row.id}
                  row={row}
                  index={rows.indexOf(row) + 1}
                  expanded={expanded.has(row.id)}
                  focused={row.id === focusedId}
                  ocr={ocr ?? null}
                  columns={columnLayout.columns}
                  grid={grid}
                  onToggle={() => toggle(row.id)}
                  onExpand={() => expandAndReveal(row.id)}
                  onFocus={() => setFocusedId(row.id)}
                  onPatch={(p) => patch(row.id, p)}
                  onConfirmField={(field) => update(row.id, (r) => confirmField(r, field), true)}
                  onConfirmRow={() => update(row.id, confirmRow, true)}
                  onUnconfirm={() => update(row.id, unconfirmRow)}
                />
              ))}
            </ul>
          )}

          {/* Desktop: the section's last line, below the grid's own scroll region, so it can't cover a row. Phones:
              sticks to the bottom edge (solid backdrop), and the page ends with room for the last row. */}
          <div data-testid="review-footer" className="sticky bottom-0 z-10 border-t border-border bg-card/95 px-2.5 py-2 backdrop-blur sm:px-3 lg:static lg:bg-muted/30 lg:backdrop-blur-none">
            <div className="flex items-center gap-2 sm:gap-3">
              <ClayButton variant="ghost" size="sm" onClick={onBack}>
                <span>
                  Back<span className="hidden sm:inline"> to capture</span>
                </span>
              </ClayButton>
              <div className="hidden min-w-0 flex-1 text-xs sm:block">
                <p className="truncate text-foreground" data-testid="footer-status">
                  {ready
                    ? `${progress.ready} row${progress.ready === 1 ? "" : "s"} ready to check for duplicates${selection.excluded > 0 ? ` · ${selection.excluded} excluded (never imported)` : ""}.`
                    : selection.included === 0
                      ? "Include at least one row to continue."
                      : `${progress.pending} row${progress.pending === 1 ? "" : "s"} still need${progress.pending === 1 ? "s" : ""} attention${progress.fieldIssues > 0 ? ` (${progress.fieldIssues} to fix)` : ""}.`}
                </p>
                <p className="text-muted-foreground" data-testid="no-import-note">
                  No transactions are imported yet.
                </p>
              </div>
              <ClayButton
                className="ml-auto"
                disabled={!ready}
                onClick={onContinue}
                aria-label={ready ? "Next: Check duplicates & details" : `Next: Check duplicates & details — ${progress.pending} row${progress.pending === 1 ? "" : "s"} still need attention`}
              >
                <span>
                  Next<span className="hidden sm:inline">: Check duplicates &amp; details</span>
                </span>
                {!ready && progress.pending > 0 && <span className="rounded-full bg-warning px-1.5 text-[10px] text-warning-foreground tabular-nums sm:hidden">{progress.pending} left</span>}
                <ChevronRight className="size-4" />
              </ClayButton>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground sm:hidden">No transactions are imported yet.</p>
          </div>
        </section>

        <aside aria-label="Source" className="flex min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto lg:overscroll-contain">
          {ocr && (
            <div className="hidden lg:block">
              <OcrSourceView capture={ocr} focused={focused} />
            </div>
          )}
          <SourcePreview parse={parse} focused={focused} rows={rows} title={ocr ? "Text as read" : "Original text"} />
          <div className="rounded-2xl border border-border bg-card px-3 py-2.5">
            <button type="button" aria-expanded={showIgnored} onClick={() => setShowIgnored((v) => !v)} className="flex w-full items-center gap-2 text-left text-sm font-medium text-foreground">
              <EyeOff className="size-4 text-muted-foreground" />
              Ignored text
              <span className="text-xs font-normal text-muted-foreground">
                {parse.ignored.length} line{parse.ignored.length === 1 ? "" : "s"}
              </span>
              <ChevronRight className={cn("ml-auto size-4 text-muted-foreground transition-transform", showIgnored && "rotate-90")} />
            </button>
            {showIgnored && (
              <ul className="mt-3 flex max-h-64 flex-col gap-1.5 overflow-auto">
                {parse.ignored.length === 0 && <li className="text-xs text-muted-foreground">Nothing was ignored.</li>}
                {parse.ignored.map((line) => (
                  <li key={line.lineIndex} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                      {line.reason === "summary" ? "Summary" : line.reason === "header" ? "Header" : "Other"}
                    </span>
                    <span className="min-w-0 font-mono break-words text-muted-foreground">{line.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {ocr && <ScreenshotDialog capture={ocr} focused={focused} open={viewerOpen} onOpenChange={setViewerOpen} />}

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Confirm {eligible.length} reviewed row{eligible.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Only confirm if you have compared {eligible.length === 1 ? "this row" : "these rows"} with the {ocr ? "screenshot" : "statement"}: date, merchant, amount and Charge/Credit.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-56 flex-col divide-y divide-border overflow-auto rounded-xl border border-border text-sm" data-testid="bulk-list">
            {eligible.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">{r.description}</span>
                <span className={cn("shrink-0 tabular-nums", r.direction === "credit" ? "text-success" : "text-foreground")}>
                  {r.direction === "credit" ? "+" : "−"}
                  {formatCurrencyPrecise(r.amount ?? 0)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Not included: rows with a missing or uncertain amount, date or Charge/Credit, cut-off or repeated rows, and excluded rows. Those need their own check. You can undo this before importing.
          </p>
          <DialogFooter>
            <ClayButton variant="secondary" onClick={() => setBulkOpen(false)}>
              Cancel
            </ClayButton>
            <ClayButton
              onClick={() => {
                onRowsChange(bulkConfirm(rows, new Set(eligible.map((r) => r.id))));
                setBulkOpen(false);
              }}
            >
              Confirm {eligible.length} row{eligible.length === 1 ? "" : "s"}
            </ClayButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProgressFigure({ label, value, of, tone = "default", testId }: { label: string; value: string; of?: number; tone?: "default" | "success" | "warning" | "attention"; testId: string }) {
  return (
    <div data-testid={testId} className="flex items-baseline gap-1">
      <p className="order-2 text-xs text-muted-foreground">{label}</p>
      <p className={cn("order-1 text-base font-semibold tabular-nums", tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "attention" ? "text-primary" : "text-foreground")}>
        {value}
        {of != null && <span className="text-xs font-medium text-muted-foreground"> / {of}</span>}
      </p>
    </div>
  );
}

/** A money total — never truncated: the figure steps down a size in a narrow summary instead of clipping digits. */
function MoneyFigure({ label, detail, value, sign, tone = "default", testId }: { label: string; detail: string; value: number; sign: string; tone?: "default" | "success"; testId: string }) {
  return (
    <div data-testid={testId} data-value={value.toFixed(2)} className="flex min-w-0 flex-col">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("text-sm font-semibold whitespace-nowrap tabular-nums @md:text-base @3xl:text-lg", tone === "success" && value > 0 ? "text-success" : "text-foreground")}>
        {value > 0 ? sign : ""}
        {formatCurrencyPrecise(value)}
      </p>
      <p className="text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/** What the debits/credits will be imported as — so a payment or a skipped row is never presented as an expense. */
function TotalsBreakdown({ totals }: { totals: ReviewTotals }) {
  const parts: [string, number][] = [
    ["Expenses", totals.expenses],
    ["Refunds", totals.refunds],
    ["Income", totals.income],
    ["Payments / EMI (not expenses)", totals.payments],
    ["Skipped at import", totals.skipped],
  ];
  const shown = parts.filter(([, v]) => v > 0);
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="totals-breakdown">
      {shown.length > 0 && (
        <>
          As imported:{" "}
          {shown.map(([label, v], i) => (
            <span key={label} className="whitespace-nowrap">
              {i > 0 && " · "}
              {label} <span className="font-medium text-foreground tabular-nums">{formatCurrencyPrecise(v)}</span>
            </span>
          ))}
          {" · "}
        </>
      )}
      Included rows only, current values{totals.uncounted > 0 ? ` · ${totals.uncounted} row${totals.uncounted === 1 ? "" : "s"} without an amount or Charge/Credit not counted yet` : ""}.
    </p>
  );
}

function sortRows(rows: ReviewRow[], sort: Sort): ReviewRow[] {
  if (sort === "date") return [...rows].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  if (sort === "amount") return [...rows].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  return rows;
}

const isIssue = (status: RowStatus) => status === "fix" || status === "check";

function SourcePreview({ parse, focused, rows, title }: { parse: CaptureParseResult; focused: ReviewRow | null; rows: ReviewRow[]; title: string }) {
  const lineOwner = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rows) for (let i = r.lineStart; i <= r.lineEnd; i++) map.set(i, r.id);
    return map;
  }, [rows]);
  const ignored = useMemo(() => new Set(parse.ignored.map((l) => l.lineIndex)), [parse.ignored]);
  const preRef = useRef<HTMLPreElement>(null);

  // Scroll only this panel (never the page) so the focused row's source lines stay in view.
  useEffect(() => {
    const pre = preRef.current;
    const line = focused ? pre?.querySelector<HTMLElement>(`[data-line="${focused.lineStart}"]`) : null;
    if (pre && line) pre.scrollTop = Math.max(0, line.offsetTop - pre.offsetTop - 24);
  }, [focused]);

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium text-foreground">
        <FileText className="size-4 text-muted-foreground" />
        {title}
        {focused && (
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Line{focused.lineEnd > focused.lineStart ? "s" : ""} {focused.lineStart + 1}
            {focused.lineEnd > focused.lineStart ? `–${focused.lineEnd + 1}` : ""}
          </span>
        )}
      </div>
      {/* Lines never wrap — wrapping split amounts like "434.61" across two lines and made them look misread. */}
      <pre ref={preRef} data-testid="source-text" className="max-h-[18rem] overflow-auto p-2 font-mono text-[11px] leading-5">
        {parse.lines.map((line, i) => {
          const owner = lineOwner.get(i);
          const active = focused != null && owner === focused.id;
          return (
            <div
              key={i}
              data-line={i}
              className={cn(
                "flex w-max min-w-full gap-2 rounded-md px-2 whitespace-pre",
                active ? "bg-primary/10 text-foreground" : owner ? "text-foreground/80" : ignored.has(i) ? "text-muted-foreground/60 line-through decoration-muted-foreground/30" : "text-muted-foreground/60",
              )}
            >
              <span className="w-6 shrink-0 text-right text-muted-foreground/50 select-none">{i + 1}</span>
              <span>{line || " "}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
