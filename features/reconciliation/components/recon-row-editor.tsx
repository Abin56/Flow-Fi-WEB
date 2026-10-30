"use client";

/**
 * The draft editor for one statement row — inside the row's sheet on desktop (`ReconRowSheet`), and the Details
 * tab of the row's sheet on phones. Its layout follows its own width (container queries), so the same
 * fields fold from one dense band into two columns without the page knowing.
 *
 * Captured values — date, description, amount, Charge/Credit — are editable (D6) through Smart Capture's own patch
 * rules, and any change must be re-confirmed. OCR checks are settled here too: what's unclear is said once, beside
 * the row's strip of the original screenshot, with ONE confirmation (`confirmRowValues`) — a value that has to be
 * picked (dropped decimal point, several amounts) gets its candidates instead. Category and notes are draft fields used only by the final approval;
 * the account is the review's statement account (read-only). Person and Split stay disabled until their write paths
 * are proven safe. Nothing here writes to FlowFi or touches an existing transaction.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, GitCompareArrows, Landmark, Lock, Shapes, ShieldCheck, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SHEET_AMOUNT_TONE, SHEET_BUTTON, SHEET_FIELD, SheetAvatar, SheetNav, SheetPicker, SheetRail, SheetRailBlock, SheetSection, TransactionSheet, type SheetPickerOption } from "@/components/finance/transaction-sheet";
import { categoryIconFor } from "@/features/transactions/hooks/use-transactions-data";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { currentIssues, openIssues, rowConfirmPlan, type RowPatch } from "@/features/smart-capture/lib/capture-review";
import type { CaptureField, CaptureIssue } from "@/features/smart-capture/lib/parse-pasted-statement";
import { RowZoom } from "@/features/smart-capture/components/ocr-source-view";
import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import { canConfirmRowValues } from "../lib/decisions";
import type { Category } from "@/lib/models/category";
import type { ReconRow, RowDecision } from "../lib/types";
import { formatRowDate } from "./recon-ui";

function toDateInput(date: Date | null): string {
  if (!date) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function fromDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const FIELD = SHEET_FIELD;
const LABEL = "flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-foreground/70";

/**
 * A text field that commits on blur / Enter — each commit is one edit (and one re-match), not one per keystroke. It also
 * commits if it disappears with a change still typed (the sheet closed by a click outside it, or another row opened), so
 * nothing typed is lost. Escape puts the field back to its saved value and commits nothing.
 */
function CommitInput({ value, onCommit, label, className, inputMode, type = "text" }: { value: string; onCommit: (v: string) => void; label: string; className?: string; inputMode?: "decimal"; type?: string }) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(value);
  }
  const reverting = useRef(false);
  const latest = useRef({ draft, value, onCommit });
  useEffect(() => {
    latest.current = { draft, value, onCommit };
  });
  useEffect(
    () => () => {
      const l = latest.current;
      if (!reverting.current && l.draft !== l.value) l.onCommit(l.draft);
    },
    [],
  );
  const commit = () => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      aria-label={label}
      type={type}
      inputMode={inputMode}
      value={draft}
      onChange={(e) => {
        reverting.current = false;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          reverting.current = true;
          setDraft(value);
        }
        e.stopPropagation();
      }}
      className={cn(FIELD, className)}
    />
  );
}

/** The one confirmation names what it accepts: "Confirm ₹452.00 · Charge", or the plain row check. */
export function confirmActionLabel(row: ReconRow): string {
  const fields = rowConfirmPlan(row)?.fields ?? [];
  if (fields.length === 0) return row.source === "ocr" && !row.needsReconfirm ? "Row matches the image" : "Values are correct";
  const order: CaptureField[] = ["date", "amount", "direction"];
  const parts = order
    .filter((f) => fields.includes(f))
    .map((f) =>
      f === "amount" ? `₹${row.amount!.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : f === "date" ? formatRowDate(row.date) : row.direction === "credit" ? "Credit" : "Charge",
    );
  return `Confirm ${parts.join(" · ")}`;
}

export function categoriesForDirection(categories: Category[], direction: ReconRow["direction"]): Category[] {
  const wanted = direction === "credit" ? "income" : "expense";
  return categories.filter((c) => c.isActive !== false && c.deletedAt == null && (c.type === wanted || c.type === "both"));
}

export function ReconRowEditor({
  row,
  decision,
  categories,
  onPatch,
  onConfirmRow,
  onConfirmField,
  onDecide,
  accountLabel = null,
  screenshot = null,
}: {
  row: ReconRow;
  decision: RowDecision;
  categories: Category[];
  /** The capture's screenshot (this tab only) — the row's strip is shown beside its checks. */
  screenshot?: OcrCapture | null;
  /** The statement account ("HDFC Millennia •••• 4821") — read-only here; it's chosen once for the whole review. */
  accountLabel?: string | null;
  onPatch: (patch: RowPatch) => void;
  onConfirmRow: () => void;
  onConfirmField: (field: CaptureField) => void;
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  const open = openIssues(row);
  const informational = currentIssues(row).filter((i) => !i.blocking);
  const options = categoriesForDirection(categories, row.direction);
  const flagged = open.length > 0 || row.needsReconfirm;
  const pickers = open.filter((i, n) => (i.code === "decimal_missing" || i.code === "multiple_amounts") && open.findIndex((o) => o.code === i.code) === n);
  const specific = open.filter((i, n) => i.code !== "ocr_unverified" && !pickers.includes(i) && open.findIndex((o) => o.code === i.code) === n);
  // The generic "compare with the image" only when nothing more specific is open — one problem, said once.
  const lines: CaptureIssue[] = specific.length > 0 || pickers.length > 0 ? specific : open.filter((i) => i.code === "ocr_unverified").slice(0, 1);
  const canConfirm = canConfirmRowValues(row);
  const categoryOptions: SheetPickerOption[] = options.map((c) => {
    const CategoryIcon = categoryIconFor(c.iconKey);
    return { value: c.name, label: c.name, icon: <CategoryIcon className="size-4" strokeWidth={2} /> };
  });

  return (
    <div className="@container" data-testid="row-editor">
      {/* One card in two rows (values · import details) beside the checks — as short as it can be, so the statement stays in view. */}
      <div className="grid items-start gap-x-5 gap-y-4 @min-[60rem]:grid-cols-[minmax(0,1fr)_minmax(260px,330px)]">
        <SheetSection title="Row details" hint="Statement values are editable — re-confirm after a change" role="group">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 @min-[44rem]:grid-cols-12">
            <label className={cn(LABEL, "@min-[44rem]:col-span-3")}>
              Date
              <CommitInput type="date" label="Date" value={toDateInput(row.date)} onCommit={(v) => onPatch({ date: fromDateInput(v) })} />
            </label>
            <label className={cn(LABEL, "@min-[44rem]:col-span-2")}>
              Amount (₹)
              <CommitInput
                label="Amount"
                inputMode="decimal"
                value={row.amount == null ? "" : row.amount.toFixed(2)}
                className="text-right font-semibold tabular-nums"
                onCommit={(v) => {
                  const n = Number(v.replace(/[,\s₹]/g, ""));
                  onPatch({ amount: v.trim() === "" || !Number.isFinite(n) ? null : n });
                }}
              />
            </label>
            <label className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-4")}>
              Merchant / description
              <CommitInput label="Description" value={row.description} onCommit={(v) => onPatch({ description: v })} />
            </label>
            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-3")}>
              Type
              <div role="radiogroup" aria-label="Charge or credit" className="grid h-10 grid-cols-2 rounded-[10px] bg-secondary p-1 ring-1 ring-border-strong/60 ring-inset">
                {(["debit", "credit"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={row.direction === d}
                    onClick={() => row.direction !== d && onPatch({ direction: d })}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-[8px] text-[13px] font-semibold transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none",
                      row.direction === d ? (d === "debit" ? "bg-card text-[oklch(0.5_0.19_25)] shadow-e2 dark:text-expense" : "bg-card text-[oklch(0.44_0.13_149)] shadow-e2 dark:text-success") : "text-foreground/72 hover:text-foreground",
                    )}
                  >
                    {d === "debit" ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownLeft className="size-3.5" aria-hidden />}
                    {d === "debit" ? "Charge" : "Credit"}
                  </button>
                ))}
              </div>
            </div>

            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-4")}>
              Category
              <SheetPicker
                value={decision.category}
                onValueChange={(v) => onDecide({ category: v })}
                options={categoryOptions}
                placeholder={options.length ? "Choose a category" : "No categories for this type"}
                emptyIcon={<Shapes className="size-4" />}
                caption={decision.category ? (row.direction === "credit" ? "Income category" : "Expense category") : "Needed to import as new"}
                ariaLabel="Category"
              />
            </div>
            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-3")}>
              Account
              <div className="flex min-h-14 items-center gap-2.5 rounded-xl border border-border bg-secondary/60 px-3 py-2" data-testid="editor-account" title="From the statement — chosen once for the whole review">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-card text-foreground/72 shadow-e1">
                  <Landmark className="size-4" aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-foreground">{accountLabel ?? "Choose the statement account first"}</span>
                  <span className="truncate text-[11.5px] font-medium text-foreground/72">Statement account</span>
                </span>
                <Lock className="size-3.5 shrink-0 text-foreground/55" aria-hidden />
              </div>
            </div>
            <label className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-3")}>
              Notes
              <Textarea
                aria-label="Notes"
                value={decision.notes}
                onChange={(e) => onDecide({ notes: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                rows={1}
                className={cn(SHEET_FIELD, "h-10 min-h-10 resize-y py-2")}
                placeholder="Optional"
              />
            </label>
            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-2")}>
              In this import
              <div className="flex h-10 items-center justify-between gap-2 rounded-[10px] border border-border-strong bg-card px-3 shadow-e1">
                <span className="truncate text-[13px] font-semibold text-foreground" title={row.captureExcluded ? "Excluded in Smart Capture — change it there" : undefined}>
                  {row.captureExcluded ? "Excluded" : row.include ? "Included" : "Left out"}
                </span>
                {row.captureExcluded ? (
                  // Smart Capture's exclusion stands — re-including (and the OCR checks that would need) happens there.
                  <span className="sr-only" data-testid="capture-excluded">
                    Excluded in Smart Capture
                  </span>
                ) : (
                  <Switch checked={row.include} onCheckedChange={(v) => onPatch({ include: v })} aria-label="Include this row" />
                )}
              </div>
            </div>
          </div>
        </SheetSection>

        <SheetRail label="Checks">
          {/* Flags and the row's confirmation are never folded away. */}
          <SheetRailBlock icon={flagged ? AlertTriangle : CheckCircle2} tone={flagged ? "warning" : "success"} title="Checks">
            {flagged || informational.length > 0 ? (
              <ul className="space-y-1.5" aria-label="Flags">
                {row.needsReconfirm && (
                  <li className="flex items-start gap-1.5 text-foreground">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> You changed this row — check the values against the statement and confirm.
                  </li>
                )}
                {lines.map((issue, i) => (
                  <li key={`${issue.code}-${i}`} className="flex items-start gap-1.5 text-foreground">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">{issue.message}</span>
                  </li>
                ))}
                {pickers.map((issue) => (
                  <li key={issue.code} className="flex flex-col gap-1.5 text-foreground" data-testid="amount-picker">
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1">{issue.message}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 pl-5" role="group" aria-label="Amount candidates">
                      {row.amountCandidates.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={row.amount === value}
                          onClick={() => onPatch({ amount: value })}
                          className={cn("h-7 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors", row.amount === value ? "border-primary bg-primary/15" : "border-border bg-card hover:border-primary")}
                        >
                          ₹{value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </button>
                      ))}
                      {issue.confirmOnly && issue.field && (
                        <ClayButton size="sm" variant="secondary" disabled={row.amount == null} onClick={() => onConfirmField(issue.field!)}>
                          {row.amount != null ? `Confirm ₹${row.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Confirm amount"}
                        </ClayButton>
                      )}
                    </span>
                  </li>
                ))}
                {informational.map((issue, i) => (
                  <li key={`info-${issue.code}-${i}`} className="flex items-start gap-1.5 text-foreground/72">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nothing flagged on this row.</p>
            )}
            {screenshot && row.ocr && (
              <div className="mt-2.5 flex flex-col gap-1" data-testid="editor-evidence">
                <p className="text-[11px] font-medium text-foreground/72">Original image{row.ocr.flaggedBoxes?.length ? " · unclear values outlined" : ""}</p>
                <RowZoom capture={screenshot} box={row.ocr.box} flagged={row.ocr.flaggedBoxes ?? []} />
                <p className="text-[11px] text-foreground/60">
                  Text as read: <span className="font-mono break-all text-foreground/80">{row.sourceText.replace(/\t/g, "  ")}</span>
                </p>
              </div>
            )}
            {flagged && canConfirm ? (
              <button type="button" data-testid="confirm-row" className={cn(SHEET_BUTTON.secondary, "mt-2.5 h-9 w-full")} onClick={onConfirmRow}>
                <CheckCircle2 className="size-4 text-[oklch(0.44_0.13_149)] dark:text-success" /> {confirmActionLabel(row)}
              </button>
            ) : (
              !flagged && (
                <p className="mt-1.5 flex items-center gap-1.5 font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
                  <CheckCircle2 className="size-3.5" /> {row.confirmed || row.confirmedFields.length > 0 ? "Values checked" : row.source === "ocr" ? "Read clearly — nothing to check" : "Values checked"}
                </p>
              )
            )}
          </SheetRailBlock>

          {/* Person and Split are shown so the shape is clear, but stay off — their existing write workflows haven't been
              verified as safe for an import, and this editor never writes anything itself. */}
          <SheetRailBlock icon={Users} title="Ownership" data-testid="editor-ownership">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-full bg-primary/15 px-2.5 py-0.5 text-[12px] font-semibold text-primary-accent-text">My own {row.direction === "credit" ? "credit" : "expense"}</span>
              <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-[12px] text-foreground/72" aria-disabled="true" data-testid="editor-person">
                <UserRound className="size-3" /> Person: off
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border py-0.5 pr-2.5 pl-1 text-[12px] text-foreground/72">
                <Switch checked={false} disabled aria-label="Split expense (not available yet)" className="scale-75" />
                Split: off
              </span>
            </div>
            <p className="mt-1.5 text-[11.5px] text-foreground/72" title="Their existing write paths haven't been verified as safe for an import.">Person and split can&apos;t be part of an import yet.</p>
          </SheetRailBlock>
        </SheetRail>
      </div>
    </div>
  );
}

/**
 * The desktop row editor: a full-width sheet dropping down from the top of the viewport (rendered in a portal, never
 * inside either table's scroll container), so the lower part of both the New Statement and Existing FlowFi sheets —
 * with the selected row — stays in view. While it is open it is the only workspace in use (it is modal); the comparison
 * dock below keeps its own open/collapsed state. Opening, closing or moving only changes what is shown — every edit is
 * committed field by field as it is made (draft only), so there is nothing to discard and nothing reaches FlowFi.
 */
export function ReconRowSheet({
  open,
  row,
  rowNumber,
  nav,
  stateLabel,
  onClose,
  onCompare,
  children,
}: {
  open: boolean;
  row: ReconRow;
  rowNumber: number;
  nav?: { position: number; total: number; onPrev?: () => void; onNext?: () => void };
  /** The row's review state in words ("Undecided", "Keep existing" …). */
  stateLabel?: string | null;
  onClose: () => void;
  /** Present when the row has been compared with FlowFi. */
  onCompare?: (rowId: string) => void;
  children: React.ReactNode;
}) {
  /** J / K move between rows when no field or menu has focus — like the statement grid. Moving never decides anything. */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!nav || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== "j" && e.key !== "k") return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="switch"], [role="radio"]')) return;
    e.preventDefault();
    (e.key === "j" ? nav.onNext : nav.onPrev)?.();
  }
  const tone = row.direction === "credit" ? SHEET_AMOUNT_TONE.credit : row.direction === "debit" ? SHEET_AMOUNT_TONE.debit : SHEET_AMOUNT_TONE.unknown;
  const sign = row.direction === "credit" ? "+" : row.direction === "debit" ? "−" : "";
  return (
    <TransactionSheet
      open={open}
      onRequestClose={onClose}
      closeLabel="Close row details"
      testId="row-editor-panel"
      progress={nav ? { current: nav.position, total: nav.total } : undefined}
      onKeyDown={onKeyDown}
      header={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-72 items-center gap-3.5">
            <SheetAvatar tone={row.direction === "credit" ? "credit" : row.direction === "debit" ? "debit" : "neutral"}>#{rowNumber}</SheetAvatar>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.09em] text-hero-foreground/68 uppercase">Statement row {rowNumber} · draft</p>
              <div className="flex min-w-0 items-center gap-2.5">
                <DialogTitle className="truncate font-heading text-[21px] leading-tight font-bold tracking-tight text-hero-foreground" title={row.description}>
                  {row.description || "No description"}
                </DialogTitle>
                {stateLabel && <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-0.5 text-[11.5px] font-semibold text-hero-foreground ring-1 ring-white/12">{stateLabel}</span>}
              </div>
              <DialogDescription className="mt-0.5 text-[12.5px] text-hero-foreground/65 tabular-nums">{formatRowDate(row.date, true)}</DialogDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-5">
            <div className="text-right">
              <p className="text-[11px] font-semibold tracking-[0.09em] text-hero-foreground/68 uppercase">{row.direction === "credit" ? "Credit" : row.direction === "debit" ? "Charge" : "Charge / Credit?"}</p>
              <p className={cn("mt-1 font-heading text-[32px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums", tone)}>
                {row.amount == null ? "₹ —" : `${sign}₹${row.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </p>
            </div>
            {nav && (
              <SheetNav label="Move between rows" position={`${nav.position} / ${nav.total}`} prevLabel="Previous row" nextLabel="Next row" onPrev={nav.onPrev} onNext={nav.onNext} />
            )}
          </div>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2.5 px-4 py-3 sm:px-6 lg:px-8">
          <p className="mr-auto flex min-w-0 items-center gap-2 text-[12.5px] text-foreground/72">
            <ShieldCheck className="size-4 shrink-0 text-[oklch(0.44_0.13_149)] dark:text-success" aria-hidden />
            Draft only — edits stay in this review; nothing is saved to FlowFi until final approval.
          </p>
          {onCompare && (
            <button type="button" onClick={() => onCompare(row.id)} className={SHEET_BUTTON.secondary}>
              <GitCompareArrows className="size-4" /> Compare with FlowFi
            </button>
          )}
          <button type="button" onClick={onClose} className={cn(SHEET_BUTTON.primary, "px-6")}>
            Done
          </button>
        </div>
      }
    >
      <div key={row.id} className="px-4 py-4 sm:px-6 lg:px-8 sm:py-5">
        {children}
      </div>
    </TransactionSheet>
  );
}
