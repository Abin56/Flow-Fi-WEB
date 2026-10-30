"use client";

/**
 * One reviewed transaction — a compact, expandable row.
 *
 * Collapsed: merchant · date · signed amount · Charge/Credit · one status.
 * Expanded:  editable values; what still needs a look, said once, with ONE
 *            primary action (`rowConfirmPlan` — it covers every unclear field
 *            and the row check together); the row's strip of the original
 *            image beside the text the computer read from it.
 *
 * Every unresolved item is reachable from the collapsed status ("Fix amount",
 * "Check", …); choosing it expands the row. Gates live in capture-review.ts —
 * this component only renders them.
 */

import { useId, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Circle, CircleCheck, ImageIcon, Info, ScanText, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { ACTION_META } from "@/features/transaction-studio/lib/action-metadata";
import { KIND_LABEL, type CaptureField, type CaptureIssue } from "../lib/parse-pasted-statement";
import { CAPTURE_ACTIONS_BY_DIRECTION, currentIssues, isComplete, needsCorrection, openIssues, rowConfirmPlan, type CaptureAction, type ReviewRow, type RowConfirmPlan, type RowPatch } from "../lib/capture-review";
import { COLUMN_LABEL, type DisplayColumn } from "../lib/source-layout";
import type { OcrCapture } from "./capture-input";
import { RowZoom } from "./ocr-source-view";

const FIELD_LABEL: Record<CaptureField, string> = { date: "date", amount: "amount", direction: "Charge/Credit" };

const inputClass = "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/50";
const flaggedClass = "border-warning ring-2 ring-warning/20";
const labelClass = "flex min-w-0 flex-col gap-1 text-[11px] font-medium text-muted-foreground";

function toDateInput(date: Date | null): string {
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateInput(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null;
}

export const formatAmount = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDate = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "No date");

function uniqueByCode<T extends { code: string }>(items: T[]): T[] {
  return items.filter((item, i) => items.findIndex((o) => o.code === item.code) === i);
}

// --- adaptive columns (presentation only: a column is where a value is drawn, never how it is read) ------------------

/**
 * Fixed track widths in px (rem = 16), each including its cell padding (2×10) — wide enough that a date like
 * "05 Sep 2026" and an amount up to "−₹12,34,567.89" are never truncated. The merchant takes whatever is left, but
 * never less than `MERCHANT_MIN`.
 */
const COLUMN_PX: Record<Exclude<DisplayColumn, "merchant">, number> = { date: 104, amount: 128, direction: 96, debit: 128, credit: 128 };
const MERCHANT_MIN = 144;
/** Row chrome around the grid: padding 2×12, checkbox 18 + 12 gap, status 112, chevron 16 + 12 gap. */
const ROW_CHROME = 24 + 18 + 12 + 112 + 16 + 12;
/** Cells are separated by a column rule and their own padding, not by a gap. */
const GRID_GAP = 0;

/** The list width (px) at which these columns line up as a grid with a readable merchant; narrower → ordered flow. */
export function gridMinWidth(columns: readonly DisplayColumn[]): number {
  const tracks = columns.reduce((sum, c) => sum + (c === "merchant" ? MERCHANT_MIN : COLUMN_PX[c]), 0);
  return ROW_CHROME + tracks + (columns.length - 1) * GRID_GAP;
}

const RIGHT_ALIGNED: ReadonlySet<DisplayColumn> = new Set(["amount", "debit", "credit"]);

/** One grid template shared by the header strip and every row, so values line up under their headings. */
function gridStyle(columns: readonly DisplayColumn[]): React.CSSProperties {
  return { "--review-cols": columns.map((c) => (c === "merchant" ? "minmax(0,1fr)" : `${COLUMN_PX[c] / 16}rem`)).join(" ") } as React.CSSProperties;
}

/**
 * Wide enough list: an aligned grid with a header, each cell stretched to the row's height with a column rule on its
 * left. Otherwise (phones, a narrow list beside the screenshot): the same cells in the same order, flowing and wrapping.
 */
const CELL_RULES = "[&>*]:self-stretch [&>*]:content-center [&>*]:border-l [&>*]:border-border/60 [&>*]:px-2.5 [&>*:first-child]:border-l-0 [&>*:first-child]:pl-0";
const GRID_CLASS = `grid min-w-0 flex-1 items-center gap-x-0 text-left focus-visible:outline-none [grid-template-columns:var(--review-cols)] ${CELL_RULES}`;
const FLOW_CLASS = "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-left focus-visible:outline-none";

const HEADER_CLASS = "sticky top-0 z-[1] flex h-8 items-stretch gap-3 border-b border-border bg-muted px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase";

/** Sticky heading row for the grid layout (only rendered while the grid is in use). */
export function ReviewColumnHeader({ columns }: { columns: readonly DisplayColumn[] }) {
  return (
    <li aria-hidden="true" data-testid="review-columns-header" className={HEADER_CLASS}>
      <span className="size-4.5 shrink-0 self-center" />
      <span className={cn("grid min-w-0 flex-1 gap-x-0 [grid-template-columns:var(--review-cols)]", CELL_RULES)} style={gridStyle(columns)}>
        {columns.map((c) => (
          <span key={c} data-col-header={c} className={cn("truncate", RIGHT_ALIGNED.has(c) && "text-right")}>
            {COLUMN_LABEL[c]}
          </span>
        ))}
      </span>
      <span className="w-28 shrink-0 content-center border-l border-border/60 pl-2.5">Status</span>
      <span className="size-4 shrink-0" />
    </li>
  );
}

/**
 * Heading for the standard layout (the source's column order couldn't be confirmed): it names what each part of the
 * row shows without implying any statement column order.
 */
export function ReviewStandardHeader() {
  return (
    <li aria-hidden="true" data-testid="review-standard-header" className={HEADER_CLASS}>
      <span className="size-4.5 shrink-0 self-center" />
      <span className="min-w-0 flex-1 content-center">Transaction · date</span>
      <span className="w-36 shrink-0 content-center border-l border-border/60 pr-1 text-right">Amount</span>
      <span className="w-28 shrink-0 content-center border-l border-border/60 pl-2.5">Status</span>
      <span className="size-4 shrink-0" />
    </li>
  );
}

function DirectionLabel({ row }: { row: ReviewRow }) {
  const credit = row.direction === "credit";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", row.direction == null ? "text-warning" : credit ? "text-success" : "text-expense")}>
      {row.direction == null ? "C/D ?" : credit ? <><ArrowDownLeft className="size-3" /> Credit</> : <><ArrowUpRight className="size-3" /> Charge</>}
    </span>
  );
}

/** One value of a collapsed row, drawn in whichever column the layout puts it. Values come from `row` untouched. */
function ColumnCell({ column, row, index, columns, grid }: { column: DisplayColumn; row: ReviewRow; index: number; columns: readonly DisplayColumn[]; grid: boolean }) {
  const credit = row.direction === "credit";
  const amountText = row.amount == null ? "₹ —" : `${row.direction == null ? "" : credit ? "+" : "−"}₹${formatAmount(row.amount)}`;
  const amountTone = row.amount == null ? "text-warning" : credit ? "text-success" : "text-foreground";
  const base = { "data-col": column } as const;

  if (column === "date") {
    return (
      <span {...base} className={cn("shrink-0 whitespace-nowrap tabular-nums", grid ? "text-sm" : "text-xs", row.date == null ? "font-medium text-warning" : "text-foreground/90")}>
        {formatDate(row.date)}
      </span>
    );
  }
  if (column === "merchant") {
    return (
      <span {...base} className={cn("min-w-0 flex-1", !grid && "basis-32")}>
        <span className="block truncate text-sm font-semibold text-foreground" title={row.description}>
          {row.description}
        </span>
        {(row.kind !== "purchase" || row.source === "ocr") && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {row.kind !== "purchase" && <span>{KIND_LABEL[row.kind]}</span>}
            {row.source === "ocr" && <ScanText className="size-3" aria-label="OCR" />}
          </span>
        )}
        <span className="sr-only">Row {index}</span>
      </span>
    );
  }
  if (column === "amount") {
    return (
      <span {...base} className="flex shrink-0 flex-col items-end justify-center text-right">
        <span className={cn("text-sm font-semibold whitespace-nowrap tabular-nums", amountTone)}>{amountText}</span>
        {!columns.includes("direction") && <DirectionLabel row={row} />}
      </span>
    );
  }
  if (column === "direction") {
    return (
      <span {...base} className="shrink-0">
        <DirectionLabel row={row} />
      </span>
    );
  }
  // Separate Debit / Credit columns: the amount is drawn under the column its *confirmed direction* names. With no
  // direction yet it is drawn (flagged) in the first of the two — never silently placed under one of them as a fact.
  const mine = column === "debit" ? "debit" : "credit";
  const firstSplit = columns.find((c) => c === "debit" || c === "credit");
  const unknown = row.direction == null && firstSplit === column;
  if (row.amount == null || (row.direction !== mine && !unknown)) {
    return (
      <span {...base} className={cn("text-right text-sm text-muted-foreground/50", !grid && "hidden")} aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <span {...base} className="flex shrink-0 flex-col items-end justify-center text-right">
      {!grid && <span className="text-[10px] font-medium text-muted-foreground uppercase">{COLUMN_LABEL[column]}</span>}
      <span className={cn("text-sm font-semibold whitespace-nowrap tabular-nums", unknown ? "text-warning" : column === "credit" ? "text-success" : "text-foreground")}>₹{formatAmount(row.amount)}</span>
      {unknown && <DirectionLabel row={row} />}
    </span>
  );
}

export type RowStatus = "ready" | "fix" | "check" | "excluded" | "imported";

export function rowStatus(row: ReviewRow): RowStatus {
  if (row.committedTransactionId) return "imported";
  if (!row.include) return "excluded";
  if (needsCorrection(row)) return "fix";
  if (openIssues(row).length > 0) return "check";
  return "ready";
}

/** What the collapsed "fix" status says — the most important unresolved field. */
function fixLabel(row: ReviewRow): string {
  const open = openIssues(row);
  if (row.amount == null || open.some((i) => i.code === "decimal_missing" || i.code === "no_amount" || i.code === "multiple_amounts")) return "Fix amount";
  if (row.date == null || open.some((i) => i.code === "no_date")) return "Fix date";
  return "Fix Charge/Credit";
}

/** What the collapsed "check" status says: the unclear field(s) when that's what's open, else what kind of look. */
function checkLabel(row: ReviewRow): string {
  const fields = rowConfirmPlan(row)?.fields ?? [];
  if (fields.length === 1) return `Check ${fields[0] === "direction" ? "C/D" : fields[0]}`;
  if (fields.length > 1) return "Check values";
  if (openIssues(row).some((i) => i.code === "possible_repeat")) return "Check repeat";
  return "Check";
}

/** ₹ amount with two decimals while idle; free typing while focused. */
function AmountField({ id, value, onChange, flagged }: { id: string; value: number | null; onChange: (v: number | null) => void; flagged: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={cn("flex h-9 min-w-0 items-center rounded-lg border border-input bg-background pl-2.5 focus-within:ring-2 focus-within:ring-ring/50", flagged && flaggedClass)}>
      <span className="text-sm text-muted-foreground">₹</span>
      <input
        id={id}
        aria-label="Amount"
        inputMode="decimal"
        placeholder="0.00"
        value={draft ?? (value == null ? "" : formatAmount(value))}
        onFocus={() => setDraft(value == null ? "" : String(value))}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const raw = e.target.value.replace(/[,₹\s]/g, "");
          if (raw === "") onChange(null);
          else if (Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
        className="h-full w-full min-w-0 bg-transparent pr-3 text-right text-sm font-semibold tabular-nums outline-none"
      />
    </div>
  );
}

function DirectionToggle({ value, onChange, flagged }: { value: ReviewRow["direction"]; onChange: (d: "debit" | "credit") => void; flagged: boolean }) {
  return (
    <div className={cn("inline-flex h-9 w-full rounded-lg border border-input bg-muted/40 p-0.5", flagged && flaggedClass)} role="group" aria-label="Direction">
      {(["debit", "credit"] as const).map((dir) => {
        const active = value === dir;
        const Icon = dir === "debit" ? ArrowUpRight : ArrowDownLeft;
        return (
          <button
            key={dir}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(dir)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold transition-colors",
              active ? (dir === "debit" ? "bg-expense text-expense-foreground shadow-e1" : "bg-success text-success-foreground shadow-e1") : "text-muted-foreground hover:bg-background hover:text-foreground",
            )}
          >
            {active ? <Check className="size-3.5" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
            {dir === "debit" ? "Charge" : "Credit"}
          </button>
        );
      })}
    </div>
  );
}

function StatusBadge({ status, row, onResolve }: { status: RowStatus; row: ReviewRow; onResolve: () => void }) {
  if (status === "ready")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CircleCheck className="size-4" /> <span className="hidden sm:inline">Ready</span>
      </span>
    );
  if (status === "imported")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CircleCheck className="size-4" /> <span className="hidden sm:inline">Imported</span>
      </span>
    );
  if (status === "excluded") return <span className="text-xs text-muted-foreground">Excluded</span>;
  const fix = status === "fix";
  return (
    <button
      type="button"
      data-testid="row-status"
      aria-label={fix ? fixLabel(row) : checkLabel(row)}
      onClick={(e) => {
        e.stopPropagation();
        onResolve();
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        fix ? "bg-warning/15 text-warning hover:bg-warning/25" : "text-muted-foreground ring-1 ring-border hover:bg-muted hover:text-foreground",
      )}
    >
      {fix ? <AlertTriangle className="size-3.5" /> : <Circle className="size-3.5" />}
      <span className="hidden truncate sm:inline">{fix ? fixLabel(row) : checkLabel(row)}</span>
    </button>
  );
}

/**
 * A correction that needs a value chosen first (a dropped decimal point, several amounts on one line): the
 * candidates, and — for a dropped decimal — its own explicit confirm, since picking alone never accepts an amount.
 */
function FieldCorrection({ issue, row, onConfirmField, onPatch }: { issue: CaptureIssue; row: ReviewRow; onConfirmField: (f: CaptureField) => void; onPatch: (p: RowPatch) => void }) {
  const field = issue.field;
  const canConfirm = field != null && (field === "amount" ? row.amount != null && row.amount > 0 : field === "date" ? row.date != null : row.direction != null);
  return (
    <li className="flex flex-col gap-2 py-2 @lg:flex-row @lg:items-center">
      <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-foreground">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
        <span>{issue.message}</span>
      </p>
      {(issue.code === "decimal_missing" || (issue.code === "multiple_amounts" && row.amountCandidates.length > 1)) && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Amount candidates">
          {row.amountCandidates.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={row.amount === value}
              onClick={() => onPatch({ amount: value })}
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors",
                row.amount === value ? "border-primary bg-primary/15 text-foreground" : "border-border bg-background hover:border-primary",
              )}
            >
              ₹{formatAmount(value)}
            </button>
          ))}
        </div>
      )}
      {field && issue.confirmOnly && (
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirmField(field)}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-foreground px-3 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Check className="size-3.5" />
          {field === "amount" && row.amount != null ? `Confirm ₹${formatAmount(row.amount)}` : `Confirm ${FIELD_LABEL[field]}`}
        </button>
      )}
    </li>
  );
}

export function ReviewRowItem({
  row,
  index,
  expanded,
  focused,
  ocr,
  columns = null,
  grid = true,
  onToggle,
  onExpand,
  onFocus,
  onPatch,
  onConfirmField,
  onConfirmRow,
  onUnconfirm,
}: {
  row: ReviewRow;
  index: number;
  expanded: boolean;
  focused: boolean;
  ocr: OcrCapture | null;
  /** Display order of the collapsed row's values; null = the standard layout (merchant over date, amount on the right). */
  columns?: readonly DisplayColumn[] | null;
  /** The list is wide enough for `columns` to line up as a grid under a header; false = the same order, flowing and wrapping. */
  grid?: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onFocus: () => void;
  onPatch: (p: RowPatch) => void;
  onConfirmField: (field: CaptureField) => void;
  /** The row's one confirmation (`confirmRow`). */
  onConfirmRow: () => void;
  /** Withdraws every confirmation on the row (`unconfirmRow`). */
  onUnconfirm: () => void;
}) {
  const panelId = useId();
  const status = rowStatus(row);
  const open = openIssues(row);
  const issues = currentIssues(row);
  const fieldOpen = uniqueByCode(open.filter((i) => i.field != null));
  const flagged = (f: CaptureField) => fieldOpen.some((i) => i.field === f) || (f === "amount" && row.amount == null) || (f === "date" && row.date == null) || (f === "direction" && row.direction == null);
  const plan = rowConfirmPlan(row);
  const credit = row.direction === "credit";

  return (
    <li
      data-testid="review-row"
      data-row-id={row.id}
      data-status={status}
      data-date={toDateInput(row.date)}
      data-description={row.description}
      data-amount={row.amount ?? ""}
      data-direction={row.direction ?? ""}
      onFocusCapture={onFocus}
      className={cn(
        "group relative scroll-mt-10 scroll-mb-28 border-b border-border last:border-b-0 lg:scroll-mb-4",
        // Selected: a tinted row with an accent bar; keyboard focus: an inset ring around the whole row.
        focused && "bg-primary/[0.07] before:absolute before:inset-y-0 before:left-0 before:z-[1] before:w-[3px] before:bg-primary",
        expanded && !focused && "bg-muted/30",
        "has-[button[aria-expanded]:focus-visible]:ring-2 has-[button[aria-expanded]:focus-visible]:ring-ring has-[button[aria-expanded]:focus-visible]:ring-inset",
      )}
    >
      {/* Collapsed summary — the whole line toggles the details. A fixed height while the cells line up as a grid. */}
      <div
        data-testid="review-row-summary"
        className={cn(
          "flex cursor-pointer items-center gap-3 px-3 transition-colors",
          columns && !grid ? "min-h-12 py-2" : columns ? "h-11" : "h-14",
          !row.include && "opacity-55",
          focused ? "hover:bg-primary/[0.04]" : "hover:bg-muted/50",
        )}
        onClick={() => {
          onFocus();
          onToggle();
        }}
      >
        <span onClick={(e) => e.stopPropagation()} className="flex">
          <Checkbox checked={row.include} onCheckedChange={(v) => onPatch({ include: v === true })} aria-label={`Include ${row.description}`} />
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${row.description}`}
          data-layout={columns ? (grid ? "grid" : "flow") : "standard"}
          className={columns ? (grid ? GRID_CLASS : FLOW_CLASS) : "flex min-w-0 flex-1 items-stretch self-stretch text-left focus-visible:outline-none"}
          style={columns && grid ? gridStyle(columns) : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onFocus();
            onToggle();
          }}
        >
          {columns ? (
            columns.map((column) => <ColumnCell key={column} column={column} row={row} index={index} columns={columns} grid={grid} />)
          ) : (
            <>
              <span className="min-w-0 flex-1 content-center pr-2.5">
                <span className="block truncate text-sm font-semibold text-foreground" title={row.description}>
                  {row.description}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatDate(row.date)}</span>
                  {row.kind !== "purchase" && <span>· {KIND_LABEL[row.kind]}</span>}
                  {row.source === "ocr" && (
                    <span className="inline-flex items-center gap-0.5" title="Read from a screenshot">
                      · <ScanText className="size-3" aria-label="OCR" />
                    </span>
                  )}
                  <span className="sr-only">Row {index}</span>
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end justify-center border-l border-border/60 pr-1 pl-2.5 sm:w-36">
                <span className={cn("text-sm font-semibold whitespace-nowrap tabular-nums", row.amount == null ? "text-warning" : credit ? "text-success" : "text-foreground")}>
                  {row.amount == null ? "₹ —" : `${credit ? "+" : "−"}₹${formatAmount(row.amount)}`}
                </span>
                <span className={cn("mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium", row.direction == null ? "text-warning" : credit ? "text-success" : "text-expense")}>
                  {row.direction == null ? "C/D ?" : credit ? <><ArrowDownLeft className="size-3" /> Credit</> : <><ArrowUpRight className="size-3" /> Charge</>}
                </span>
              </span>
            </>
          )}
        </button>
        <span className={cn("flex shrink-0 justify-end self-stretch sm:w-28 sm:justify-start sm:border-l sm:border-border/60 sm:pl-2.5", "items-center")}>
          <StatusBadge status={status} row={row} onResolve={onExpand} />
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} aria-hidden />
      </div>

      {/* Details — animated open/close (grid rows 0fr → 1fr), content unmounted when closed. */}
      <div id={panelId} className={cn("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          {expanded && (
            <div className="@container flex flex-col gap-2.5 px-3 pb-4 sm:pr-4 sm:pl-12" data-testid="row-details">
              {/* Values — description on its own line until there's room for all four side by side; the amount always
                  gets a full-width (or ≥ 10.5rem) cell, so a long figure is never clipped inside its input. */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-background/60 p-2.5 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(10.5rem,1.1fr)] @3xl:grid-cols-[9.5rem_minmax(0,1fr)_10.5rem_11rem]">
                <label className={cn(labelClass, "col-span-2 @md:col-span-3 @3xl:col-span-1 @3xl:col-start-2 @3xl:row-start-1")}>
                  Description
                  <input aria-label="Description" value={row.description} onChange={(e) => onPatch({ description: e.target.value })} className={cn(inputClass, "font-medium")} />
                </label>
                <label className={cn(labelClass, "@3xl:col-start-1 @3xl:row-start-1")}>
                  Date
                  <input type="date" aria-label="Date" value={toDateInput(row.date)} onChange={(e) => onPatch({ date: fromDateInput(e.target.value) })} className={cn(inputClass, "tabular-nums", flagged("date") && flaggedClass)} />
                </label>
                <div className={labelClass}>
                  Charge / Credit
                  <DirectionToggle value={row.direction} onChange={(direction) => onPatch({ direction })} flagged={flagged("direction")} />
                </div>
                <label className={cn(labelClass, "col-span-2 @md:col-span-1")} htmlFor={`${panelId}-amount`}>
                  Amount
                  <AmountField id={`${panelId}-amount`} value={row.amount} onChange={(amount) => onPatch({ amount })} flagged={flagged("amount")} />
                </label>
                {row.direction && (
                  <div className="col-span-full flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-muted-foreground" role="group" aria-label="Action">
                    Import as
                    {CAPTURE_ACTIONS_BY_DIRECTION[row.direction].map((action: CaptureAction) => (
                      <button
                        key={action}
                        type="button"
                        aria-pressed={row.action === action}
                        onClick={() => onPatch({ action })}
                        className={cn("h-6 rounded-full border px-2.5 font-medium transition-colors", row.action === action ? "border-foreground/40 bg-foreground/5 text-foreground" : "border-border hover:text-foreground")}
                      >
                        {ACTION_META[action].label}
                      </button>
                    ))}
                    <span className="text-muted-foreground/70">· category is chosen at approval</span>
                  </div>
                )}
              </div>

              <RowCheck row={row} status={status} open={open} issues={issues} plan={plan} onConfirmField={onConfirmField} onPatch={onPatch} onConfirmRow={onConfirmRow} onUnconfirm={onUnconfirm} />

              {ocr && row.ocr && <RowEvidence ocr={ocr} row={row} />}

              <details className="text-[11px] text-muted-foreground">
                <summary className="w-fit cursor-pointer select-none hover:text-foreground">Technical details</summary>
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  <dt>Source</dt>
                  <dd className="font-mono break-words whitespace-pre-wrap text-foreground/80">{row.sourceText}</dd>
                  <dt>Lines</dt>
                  <dd>
                    {row.lineStart + 1}
                    {row.lineEnd > row.lineStart ? `–${row.lineEnd + 1}` : ""}
                  </dd>
                  {row.extraColumns.length > 0 && (
                    <>
                      <dt>Other columns</dt>
                      <dd>{row.extraColumns.join(" · ")}</dd>
                    </>
                  )}
                  {row.ocr && (
                    <>
                      <dt>OCR</dt>
                      <dd>lowest date/amount/C-D confidence {Math.round(row.ocr.minConfidence)}%</dd>
                    </>
                  )}
                </dl>
              </details>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

const CONFIRM_ORDER: CaptureField[] = ["date", "amount", "direction"];

/** The one action's label names exactly what it accepts: "Confirm ₹452.00 · Charge", or the plain row check. */
export function confirmLabel(row: ReviewRow, plan: RowConfirmPlan): string {
  if (plan.fields.length === 0) return row.source === "ocr" ? "Row matches the image" : "Values are correct";
  const parts = CONFIRM_ORDER.filter((f) => plan.fields.includes(f)).map((f) =>
    f === "amount" ? `₹${formatAmount(row.amount!)}` : f === "date" ? formatDate(row.date) : row.direction === "credit" ? "Credit" : "Charge",
  );
  return `Confirm ${parts.join(" · ")}`;
}

/**
 * What's left to do on the row, said once: one line per distinct problem (the generic "compare with the image" only
 * when nothing more specific is open), value pickers where a value must be chosen, and ONE primary action.
 */
function RowCheck({
  row,
  status,
  open,
  issues,
  plan,
  onConfirmField,
  onPatch,
  onConfirmRow,
  onUnconfirm,
}: {
  row: ReviewRow;
  status: RowStatus;
  open: CaptureIssue[];
  issues: CaptureIssue[];
  plan: RowConfirmPlan | null;
  onConfirmField: (f: CaptureField) => void;
  onPatch: (p: RowPatch) => void;
  onConfirmRow: () => void;
  onUnconfirm: () => void;
}) {
  const pickers = uniqueByCode(open.filter((i) => i.code === "decimal_missing" || i.code === "multiple_amounts"));
  const specific = uniqueByCode(open.filter((i) => i.code !== "ocr_unverified" && !pickers.includes(i)));
  const lines = specific.length > 0 || pickers.length > 0 ? specific : uniqueByCode(open.filter((i) => i.code === "ocr_unverified"));
  const advisories = uniqueByCode(issues.filter((i) => !i.blocking && i.code !== "ocr_unverified"));
  const confirmedByUser = row.confirmed || row.confirmedFields.length > 0;
  const ready = status === "ready";

  if (status === "excluded" || status === "imported") {
    return row.notes.length > 0 ? <Notes items={row.notes} /> : null;
  }

  return (
    <div
      data-testid="row-check"
      data-state={status}
      className={cn("rounded-xl border px-3 py-2.5", ready ? "border-success/30 bg-success/[0.04]" : status === "fix" ? "border-warning/40 bg-warning/[0.05]" : "border-border bg-muted/30")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold", ready ? "text-success" : status === "fix" ? "text-warning" : "text-foreground")}>
          {ready ? <CircleCheck className="size-4 shrink-0" /> : status === "fix" ? <AlertTriangle className="size-4 shrink-0" /> : <Circle className="size-4 shrink-0" />}
          <span className="min-w-0">
            {ready
              ? confirmedByUser
                ? `Ready — ${row.source === "ocr" ? "checked against the image" : "values confirmed"} by you${row.bulkConfirmed ? " (bulk)" : ""}`
                : row.source === "ocr"
                  ? `Ready — date, amount and Charge/Credit read clearly${row.ocr?.secondRead?.length ? ", unclear values double-checked by a second read" : ""}`
                  : "Ready — nothing to check"
              : status === "fix"
                ? plan
                  ? "Check the highlighted values"
                  : "Needs a correction"
                : "Needs a quick check"}
          </span>
        </p>
        {!ready && plan && (
          <button
            type="button"
            data-testid="confirm-row"
            onClick={onConfirmRow}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-e1 transition-colors hover:bg-[var(--primary-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Check className="size-3.5" />
            {confirmLabel(row, plan)}
          </button>
        )}
        {confirmedByUser && (
          <button type="button" aria-label="Undo verification" onClick={onUnconfirm} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <Undo2 className="size-3" /> Undo
          </button>
        )}
      </div>

      {!ready && (lines.length > 0 || pickers.length > 0) && (
        <ul className="mt-1.5 flex flex-col divide-y divide-border/60" aria-label="Corrections needed">
          {lines.map((issue) => (
            <li key={issue.code} className="flex items-start gap-1.5 py-1.5 text-xs text-foreground/85">
              <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", status === "fix" ? "bg-warning" : "bg-muted-foreground/60")} aria-hidden />
              {issue.message}
            </li>
          ))}
          {pickers.map((issue) => (
            <FieldCorrection key={issue.code} issue={issue} row={row} onConfirmField={onConfirmField} onPatch={onPatch} />
          ))}
        </ul>
      )}
      {!ready && !isComplete(row) && <p className="mt-1 text-[11px] text-muted-foreground">Fill in the missing value{row.amount == null && row.date == null ? "s" : ""} above.</p>}
      {(advisories.length > 0 || row.notes.length > 0) && <Notes items={[...advisories.map((i) => i.message), ...row.notes]} />}
    </div>
  );
}

function Notes({ items }: { items: string[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-muted-foreground">
      {[...new Set(items)].map((note) => (
        <li key={note} className="flex items-start gap-1.5">
          <Info className="mt-px size-3 shrink-0" />
          {note}
        </li>
      ))}
    </ul>
  );
}

/** The row's own strip of the original image, kept visibly apart from the text the computer read from it. */
function RowEvidence({ ocr, row }: { ocr: OcrCapture; row: ReviewRow }) {
  return (
    <figure className="flex flex-col gap-1.5" data-testid="row-evidence">
      <figcaption className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <ImageIcon className="size-3.5" aria-hidden /> Original image
        {row.ocr!.flaggedBoxes?.length ? <span className="font-normal">· unclear values outlined</span> : null}
      </figcaption>
      <RowZoom capture={ocr} box={row.ocr!.box} flagged={row.ocr!.flaggedBoxes ?? []} />
      <p className="flex min-w-0 items-start gap-1.5 text-[11px] text-muted-foreground">
        <ScanText className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">Text as read:</span>
        <span className="min-w-0 font-mono break-all text-foreground/80" data-testid="row-ocr-text">
          {row.sourceText.replace(/\t/g, "  ")}
        </span>
      </p>
    </figure>
  );
}
