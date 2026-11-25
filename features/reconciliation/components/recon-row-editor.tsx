"use client";

/**
 * The row editor (2026-11-25) — the one place to see and change everything about a captured statement row, opened from
 * the row (description click, ✎, Enter or double-click) as the full-width top sheet over the table.
 *
 *   Description · Category                       ← what the user reads first; FlowFi pre-fills both when reliable
 *   Date · Amount · Type · Account                ← the captured values; an unclear OCR read says so under its field,
 *                                                   with its own "Looks right" — the only confirmation left
 *   What is this credit? / Who is it for?         ← the financial meaning: never guessed
 *   More: notes · include · the bank's narration
 *
 * Every change is accepted as it is made and kept in this tab's draft — there is no separate Save and no "re-confirm
 * the amount" after an unrelated edit. Close just closes. Import (footer) imports THIS row now, through the same keyed,
 * server-re-checked approval as every other import. Nothing here writes to FlowFi on its own.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronDown, GitCompareArrows, Landmark, Loader2, Lock, ScanLine, Shapes, ShieldCheck, Sparkles, Undo2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SHEET_AMOUNT_TONE, SHEET_BUTTON, SHEET_FIELD, SheetAvatar, SheetNav, SheetPicker, SheetRail, SheetRailBlock, SheetSection, TransactionSheet, type SheetPickerOption } from "@/components/finance/transaction-sheet";
import { categoryIconFor } from "@/features/transactions/hooks/use-transactions-data";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/forms/date-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { currentIssues, openIssues, rowConfirmPlan, type RowPatch } from "@/features/smart-capture/lib/capture-review";
import type { CaptureField, CaptureIssue } from "@/features/smart-capture/lib/parse-pasted-statement";
import { RowZoom } from "@/features/smart-capture/components/ocr-source-view";
import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import { canConfirmRowValues } from "../lib/decisions";
import type { RowIntel } from "../lib/row-intelligence";
import type { RowStatus } from "../lib/row-status";
import type { ReconRow, RowDecision } from "../lib/types";
import { ReconOwnershipEditor } from "./recon-ownership-editor";
import { StatusChip, formatRowDate } from "./recon-ui";

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
const LABEL = "flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-foreground/80";

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
    // A date that is half-typed reads as "" — keep the saved date rather than clearing it.
    if (draft !== value && !(type === "date" && draft === "")) onCommit(draft);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      reverting.current = true;
      setDraft(value);
    }
    e.stopPropagation();
  };
  if (type === "date") {
    return (
      <DateInput
        aria-label={label}
        value={draft}
        onChange={(e) => {
          reverting.current = false;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={keys}
        className={cn(FIELD, className)}
      />
    );
  }
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
      onKeyDown={keys}
      className={cn(FIELD, className)}
    />
  );
}

/** The row-level confirmation names what it accepts: "Confirm ₹452.00 · Charge", or the plain image check. */
export function confirmActionLabel(row: ReconRow): string {
  const fields = rowConfirmPlan(row)?.fields ?? [];
  if (fields.length === 0) return row.source === "ocr" && !row.needsReconfirm ? "Row matches the image" : "Values are correct";
  const order: CaptureField[] = ["date", "amount", "direction"];
  const parts = order
    .filter((f) => fields.includes(f))
    .map((f) =>
      f === "amount" ? `₹${row.amount!.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : f === "date" ? formatRowDate(row.date) : row.direction === "credit" ? "Credit" : "Debit",
    );
  return `Confirm ${parts.join(" · ")}`;
}

export function categoriesForDirection(categories: Category[], direction: ReconRow["direction"]): Category[] {
  const wanted = direction === "credit" ? "income" : "expense";
  return categories.filter((c) => c.isActive !== false && c.deletedAt == null && (c.type === wanted || c.type === "both"));
}

type NoteTarget = "date" | "amount" | "type" | "row";

/** Which field an issue belongs beside — so a date problem is said under the date, an amount problem under the amount. */
const NOTE_TARGET: Partial<Record<CaptureIssue["code"], NoteTarget>> = {
  no_date: "date",
  low_confidence_date: "date",
  year_assumed: "date",
  no_amount: "amount",
  multiple_amounts: "amount",
  decimal_missing: "amount",
  amount_without_decimals: "amount",
  low_confidence_amount: "amount",
  balance_mismatch: "amount",
  direction_unclear: "type",
  low_confidence_direction: "type",
  direction_inferred: "type",
};
const FIELD_OF: Record<Exclude<NoteTarget, "row">, CaptureField> = { date: "date", amount: "amount", type: "direction" };

type Note = { tone: "warning" | "info"; text: string };

/** A short note under its own field: a warning while the value needs action, a quiet line otherwise. */
function FieldNotes({ notes, testId, action }: { notes: Note[]; testId?: string; action?: React.ReactNode }) {
  if (notes.length === 0 && !action) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <ul className="flex flex-col gap-0.5">
        {notes.map((n) => (
          <li key={n.text} className={cn("flex items-start gap-1.5 text-[11.5px] leading-snug font-medium", n.tone === "warning" ? "text-[oklch(0.5_0.12_70)] dark:text-warning" : "text-foreground/72")}>
            {n.tone === "warning" ? <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> : <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0">{n.text}</span>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What a credit is — the user's choice, never inferred. The last two are recorded elsewhere, so nothing is imported here. */
export type CreditChoice = "income" | "refund" | "people" | "transfer";
export const CREDIT_CHOICES: { id: CreditChoice; label: string; hint: string }[] = [
  { id: "income", label: "Income", hint: "Money you earned or received for good — salary, a gift, a sale." },
  { id: "refund", label: "Refund", hint: "Money back for something you paid for." },
  { id: "people", label: "From a person I lent to", hint: "A repayment or reimbursement — record it in People so it is counted once. Not imported here." },
  { id: "transfer", label: "From my own account", hint: "Money moved between your own accounts — record it as a Transfer. Not imported here." },
];
export function creditChoiceOf(decision: RowDecision): CreditChoice | null {
  if (decision.kind === "ignore" && decision.skipReason) return decision.skipReason;
  return decision.creditAs ?? null;
}
/** The draft patch a credit choice makes. Income / Refund also say "from someone else" — the own-account option sits right beside them. */
export function creditChoicePatch(choice: CreditChoice, decision: RowDecision): Partial<RowDecision> {
  if (choice === "people" || choice === "transfer") return { kind: "ignore", skipReason: choice };
  return { ...(decision.kind === "ignore" ? { kind: null } : {}), creditAs: choice, notOwnTransferAck: true, skipReason: null };
}

export function ReconRowEditor({
  row,
  decision,
  categories,
  intel,
  shownDescription,
  onImportDescription,
  onPatch,
  onConfirmRow,
  onConfirmField,
  onDecide,
  ownTransferConfirm = null,
  accountLabel = null,
  screenshot = null,
  people = [],
  status = null,
}: {
  row: ReconRow;
  decision: RowDecision;
  categories: Category[];
  /** FlowFi's suggestions for the row (clean description, reliable category, ranked alternatives). */
  intel?: RowIntel;
  /** The description shown — the user's own, or FlowFi's wording — and whether it is FlowFi's. */
  shownDescription?: { text: string; auto: boolean };
  /** Sets the description the transaction is imported with; null = back to FlowFi's wording. */
  onImportDescription?: (text: string | null) => void;
  /** The capture's screenshot (this tab only) — the row's strip is shown beside the details. */
  screenshot?: OcrCapture | null;
  /** The statement account ("HDFC Millennia •••• 4821") — read-only here; it's chosen once for the whole review. */
  accountLabel?: string | null;
  /** The user's People — who a person / split expense can be assigned to. */
  people?: Pick<Person, "id" | "name">[];
  /** The "not to/from my own account" question this row's rail needs (null = none). */
  ownTransferConfirm?: string | null;
  status?: RowStatus | null;
  onPatch: (patch: RowPatch) => void;
  onConfirmRow: () => void;
  onConfirmField: (field: CaptureField) => void;
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  const open = openIssues(row);
  const informational = currentIssues(row).filter((i) => !i.blocking);
  const options = categoriesForDirection(categories, row.direction);
  const unique = (list: CaptureIssue[]) => list.filter((i, n) => list.findIndex((o) => o.code === i.code) === n);
  const pickers = unique(open.filter((i) => i.code === "decimal_missing" || i.code === "multiple_amounts"));
  const specific = unique(open.filter((i) => i.code !== "ocr_unverified" && !pickers.includes(i)));
  // The generic "compare with the image" only when nothing more specific is open — one problem, said once.
  const generic = specific.length === 0 && pickers.length === 0 ? unique(open.filter((i) => i.code === "ocr_unverified")).slice(0, 1) : [];

  const notesFor = (target: NoteTarget): Note[] => {
    const at = (i: CaptureIssue) => (NOTE_TARGET[i.code] ?? "row") === target;
    const warnings = [...specific, ...generic].filter(at).map((i): Note => ({ tone: "warning", text: i.message }));
    const infos = unique(informational.filter((i) => !open.includes(i) && at(i))).map((i): Note => ({ tone: "info", text: i.message }));
    return [...warnings, ...infos];
  };
  const today = new Date();
  const future = row.date != null && row.date.getTime() > new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  const dateNotes = notesFor("date");
  if (future) dateNotes.push({ tone: "warning", text: "This date is in the future — check it against the statement." });
  const amountNotes = notesFor("amount");
  const typeNotes = notesFor("type");
  const rowNotes = notesFor("row");
  const blockedAt = (target: NoteTarget) => open.some((i) => NOTE_TARGET[i.code] === target);
  // A strict (unclear OCR) issue on ONE field: that field gets its own "Looks right" — accepted the moment it's clicked,
  // or the moment the user types a corrected value. Nothing else on the row is asked again.
  const strictOn = (target: Exclude<NoteTarget, "row">) => open.some((i) => i.strict && i.field === FIELD_OF[target] && !i.confirmOnly) && (target === "date" ? row.date != null : target === "amount" ? row.amount != null : row.direction != null);
  const looksRight = (target: Exclude<NoteTarget, "row">) =>
    strictOn(target) ? (
      <button type="button" data-testid={`confirm-${FIELD_OF[target]}`} onClick={() => onConfirmField(FIELD_OF[target])} className="inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-border-strong bg-card px-2 text-[12px] font-semibold text-foreground shadow-e1 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <CheckCircle2 className="size-3.5 text-[oklch(0.44_0.13_149)] dark:text-success" aria-hidden />
        {target === "date" ? `${formatRowDate(row.date)} looks right` : target === "amount" ? `${money(row.amount!)} looks right` : `${row.direction === "credit" ? "Credit" : "Debit"} looks right`}
      </button>
    ) : null;
  // A row-level check (compare with the image, a joined line, a possible repeat) — one button, only when no field is still open.
  const rowLevel = canConfirmRowValues(row) && !(["date", "amount", "type"] as const).some((t) => strictOn(t));
  const ranked = new Set(intel?.ranked ?? []);
  const categoryOptions: SheetPickerOption[] = [...options].sort((a, b) => Number(ranked.has(b.name)) - Number(ranked.has(a.name))).map((c) => {
    const CategoryIcon = categoryIconFor(c.iconKey);
    return { value: c.name, label: c.name, icon: <CategoryIcon className="size-4" strokeWidth={2} /> };
  });
  const categoryValue = decision.category ?? intel?.category ?? null;
  const categoryAuto = decision.category == null && intel?.category != null;
  const shown = shownDescription ?? { text: row.description, auto: false };
  const narration = shown.text !== row.description ? row.description : null;
  const showEvidence = screenshot != null && row.ocr != null;
  const creditChoice = creditChoiceOf(decision);
  const importable = !(decision.kind === "ignore" && decision.skipReason);

  return (
    <div className="@container" data-testid="row-editor">
      <div className={cn("grid items-start gap-x-3 gap-y-3", showEvidence && "@min-[56rem]:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]")}>
        <SheetSection compact title="Transaction" aside={status ? <StatusChip status={status} /> : undefined} role="group">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 @min-[44rem]:grid-cols-12">
            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-7")}>
              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5">
                  Description
                  {shown.auto && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-primary-accent-text" title="Worded by FlowFi from the bank narration — edit it freely; your words are kept.">
                      <Sparkles className="size-3" aria-hidden /> auto
                    </span>
                  )}
                </span>
                <CommitInput label="Description" value={shown.text} onCommit={(v) => onImportDescription?.(v.trim() && v.trim() !== (intel?.description?.text ?? row.description) ? v : null)} />
              </label>
              {narration && (
                <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-foreground/60" data-testid="editor-narration">
                  <span className="shrink-0">Bank:</span>
                  <span className="min-w-0 truncate font-mono text-foreground/75" title={narration}>
                    {narration}
                  </span>
                  {!shown.auto && intel?.description && (
                    <button type="button" onClick={() => onImportDescription?.(null)} className="inline-flex shrink-0 items-center gap-1 font-medium text-primary-accent-text hover:underline" data-testid="description-reset">
                      <Undo2 className="size-3" aria-hidden /> FlowFi wording
                    </button>
                  )}
                </p>
              )}
              <FieldNotes notes={rowNotes} testId="row-notes" />
            </div>
            <div className={cn(LABEL, "col-span-2 @min-[44rem]:col-span-5")}>
              <span className="flex items-center gap-1.5">
                Category
                {categoryAuto && (
                  <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-primary-accent-text" title={intel?.categoryBasis === "history" ? "From your own earlier transactions with this payee." : "From what this merchant sells."}>
                    <Sparkles className="size-3" aria-hidden /> suggested
                  </span>
                )}
              </span>
              <SheetPicker compact value={categoryValue} onValueChange={(v) => onDecide({ category: v })} options={categoryOptions} placeholder={options.length ? "Choose a category" : "No categories for this type"} emptyIcon={<Shapes className="size-4" />} ariaLabel="Category" />
              {!categoryValue && importable && <span className="text-[11.5px] font-medium text-[oklch(0.5_0.12_70)] dark:text-warning">Needed to import</span>}
            </div>

            <label className={cn(LABEL, "@min-[44rem]:col-span-3")}>
              Date
              <CommitInput type="date" label="Date" value={toDateInput(row.date)} onCommit={(v) => onPatch({ date: fromDateInput(v) })} className={cn(blockedAt("date") && "border-warning")} />
              <FieldNotes notes={dateNotes} testId="date-notes" action={looksRight("date")} />
            </label>
            <div className={cn(LABEL, "@min-[44rem]:col-span-3")}>
              <label className="flex flex-col gap-1">
                Amount (₹)
                <CommitInput
                  label="Amount"
                  inputMode="decimal"
                  value={row.amount == null ? "" : row.amount.toFixed(2)}
                  className={cn("text-right font-semibold tabular-nums", blockedAt("amount") && "border-warning")}
                  onCommit={(v) => {
                    const n = Number(v.replace(/[,\s₹]/g, ""));
                    onPatch({ amount: v.trim() === "" || !Number.isFinite(n) ? null : n });
                  }}
                />
              </label>
              <FieldNotes notes={amountNotes} testId="amount-notes" action={looksRight("amount")} />
              {pickers.map((issue) => (
                <div key={issue.code} className="flex flex-col gap-1.5" data-testid="amount-picker">
                  <FieldNotes notes={[{ tone: "warning", text: issue.message }]} />
                  <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Amount candidates">
                    {row.amountCandidates.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={row.amount === value}
                        onClick={() => onPatch({ amount: value })}
                        className={cn("h-7 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors", row.amount === value ? "border-primary bg-primary/15" : "border-border bg-card hover:border-primary")}
                      >
                        {money(value)}
                      </button>
                    ))}
                    {issue.confirmOnly && issue.field && (
                      <button type="button" disabled={row.amount == null} onClick={() => onConfirmField(issue.field!)} className={cn(SHEET_BUTTON.secondary, "h-7 px-2.5 text-xs")}>
                        {row.amount != null ? `Confirm ${money(row.amount)}` : "Confirm amount"}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className={cn(LABEL, "@min-[44rem]:col-span-3")}>
              Type
              <div role="radiogroup" aria-label="Debit or credit" className={cn("grid h-10 grid-cols-2 rounded-[10px] bg-secondary p-1 ring-1 ring-inset", blockedAt("type") ? "ring-warning" : "ring-border-strong/60")}>
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
                    {d === "debit" ? "Debit" : "Credit"}
                  </button>
                ))}
              </div>
              <FieldNotes notes={typeNotes} testId="type-notes" action={looksRight("type")} />
            </div>
            <div className={cn(LABEL, "@min-[44rem]:col-span-3")}>
              Account
              <div className="flex h-10 items-center gap-2 rounded-[10px] border border-border bg-secondary/60 px-2.5" data-testid="editor-account" title="From the statement — chosen once for the whole review">
                <Landmark className="size-3.5 shrink-0 text-foreground/65" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{accountLabel ?? "Choose the statement account first"}</span>
                <Lock className="size-3 shrink-0 text-foreground/50" aria-hidden />
              </div>
            </div>
          </div>

          {rowLevel && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/[0.08] px-2.5 py-1.5" data-testid="row-check">
              <AlertTriangle className="size-3.5 shrink-0 text-[oklch(0.5_0.12_70)] dark:text-warning" aria-hidden />
              <span className="min-w-0 flex-1 text-[12px] font-medium text-foreground/80">{rowNotes.length === 0 ? "Read from a screenshot — compare it with the image once." : "Check this once against the statement."}</span>
              <button type="button" data-testid="confirm-row" className={cn(SHEET_BUTTON.secondary, "h-7 px-2.5 text-[12px]")} onClick={onConfirmRow}>
                <CheckCircle2 className="size-3.5 text-[oklch(0.44_0.13_149)] dark:text-success" /> {confirmActionLabel(row)}
              </button>
            </div>
          )}

          {/* The financial meaning — never guessed: what a credit is, whether a UPI/NEFT line went to someone else, who an expense is for. */}
          {!row.captureExcluded && row.direction === "credit" && (
            <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-2.5" data-testid="editor-credit-type">
              <span className="text-[12px] font-semibold text-foreground/80">What is this credit?</span>
              <div role="radiogroup" aria-label="What is this credit?" className="flex flex-wrap gap-1.5">
                {CREDIT_CHOICES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={creditChoice === c.id}
                    title={c.hint}
                    data-testid={`credit-${c.id}`}
                    onClick={() => onDecide(creditChoicePatch(c.id, decision))}
                    className={cn("h-8 rounded-lg border px-3 text-[12.5px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", creditChoice === c.id ? "border-primary bg-primary/15 text-foreground" : "border-border-strong/70 bg-card text-foreground/80 hover:bg-secondary/60")}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {creditChoice && <p className="text-[11.5px] text-foreground/65">{CREDIT_CHOICES.find((c) => c.id === creditChoice)!.hint}</p>}
            </div>
          )}
          {!row.captureExcluded && row.direction === "debit" && ownTransferConfirm && (
            <label className="flex items-start gap-2 border-t border-border-subtle pt-2.5 text-[12px] text-foreground/85" data-testid="own-transfer-confirm">
              <Checkbox checked={decision.notOwnTransferAck === true} onCheckedChange={(v) => onDecide({ notOwnTransferAck: v === true })} aria-label="Paid to someone else — not my own account or card" />
              <span>
                <span className="font-semibold">Paid to someone else</span> — not to my own account or card. <span className="text-foreground/60">If it was, record it as a Transfer instead.</span>
              </span>
            </label>
          )}
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-2.5" data-testid="editor-ownership">
            {row.direction === "debit" && !row.captureExcluded ? (
              <ReconOwnershipEditor row={row} ownership={decision.ownership} people={people} onChange={(ownership) => onDecide({ ownership })} />
            ) : (
              <p className="flex items-center gap-1.5 text-[12px] text-foreground/72">
                <Users className="size-3.5 text-foreground/65" aria-hidden />
                <span className="inline-flex items-center rounded-full bg-primary/15 px-2.5 py-0.5 font-semibold text-primary-accent-text">My own {row.direction === "credit" ? "credit" : "expense"}</span>
              </p>
            )}
          </div>

          <details className="group rounded-lg border border-border-subtle" data-testid="editor-more">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold text-foreground/75 select-none hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden /> More — notes, include, bank details
            </summary>
            <div className="grid grid-cols-1 gap-3 border-t border-border-subtle p-2.5 @min-[44rem]:grid-cols-12">
              <label className={cn(LABEL, "@min-[44rem]:col-span-7")}>
                Notes
                <Textarea aria-label="Notes" value={decision.notes} onChange={(e) => onDecide({ notes: e.target.value })} onKeyDown={(e) => e.stopPropagation()} rows={1} className={cn(SHEET_FIELD, "h-10 min-h-10 resize-none py-2")} placeholder="Optional" />
              </label>
              <div className={cn(LABEL, "@min-[44rem]:col-span-5")}>
                In this import
                <div className="flex h-10 items-center justify-between gap-2 rounded-[10px] border border-border-strong bg-card px-3 shadow-e1">
                  <span className="truncate text-[13px] font-semibold text-foreground" title={row.captureExcluded ? "Excluded in Smart Capture — change it there" : undefined}>
                    {row.captureExcluded ? "Excluded" : row.include ? "Included" : "Left out"}
                  </span>
                  {row.captureExcluded ? (
                    <span className="sr-only" data-testid="capture-excluded">
                      Excluded in Smart Capture
                    </span>
                  ) : (
                    <Switch checked={row.include} onCheckedChange={(v) => onPatch({ include: v })} aria-label="Include this row" />
                  )}
                </div>
              </div>
              <p className="text-[11px] text-foreground/60 @min-[44rem]:col-span-12">
                Bank narration: <span className="font-mono break-all text-foreground/80">{row.description}</span>
                {row.referenceNumber ? (
                  <>
                    {" "}
                    · Reference <span className="font-mono text-foreground/80">{row.referenceNumber}</span>
                  </>
                ) : null}
                . It is kept with the imported transaction for checking later.
              </p>
            </div>
          </details>
        </SheetSection>

        {showEvidence && row.ocr && (
          <SheetRail label="Original image" className="gap-2.5">
            <SheetRailBlock compact icon={ScanLine} title="Original image">
              <div className="flex flex-col gap-1" data-testid="editor-evidence">
                <p className="text-[11px] font-medium text-foreground/72">{row.ocr.flaggedBoxes?.length ? "Unclear values outlined" : "As read from your screenshot"}</p>
                <RowZoom capture={screenshot!} box={row.ocr.box} flagged={row.ocr.flaggedBoxes ?? []} />
                {row.sourceText && (
                  <p className="text-[11px] text-foreground/60">
                    Text as read: <span className="font-mono break-all text-foreground/80">{row.sourceText.replace(/\t/g, "  ")}</span>
                  </p>
                )}
              </div>
            </SheetRailBlock>
          </SheetRail>
        )}
      </div>
    </div>
  );
}

/**
 * The desktop row editor: a full-width sheet dropping down from the top of the viewport (rendered in a portal, never
 * inside the table's scroll container), so the lower part of the statement — with the selected row — stays in view.
 * Every edit is already in the draft as it is made: Close only closes. Import imports this row now.
 */
export function ReconRowSheet({
  open,
  row,
  rowNumber,
  nav,
  title,
  status = null,
  onClose,
  onReviewMatch,
  importAction = null,
  children,
}: {
  open: boolean;
  row: ReconRow;
  rowNumber: number;
  nav?: { position: number; total: number; onPrev?: () => void; onNext?: () => void };
  /** The description shown in the header (clean wording or the user's own). */
  title?: string;
  status?: RowStatus | null;
  onClose: () => void;
  /** Present when FlowFi has a possible match for the row — opens the comparison under the row. */
  onReviewMatch?: () => void;
  /** This row's own Import (null = not offered, e.g. already imported or skipped). */
  importAction?: { enabled: boolean; running: boolean; reason: string | null; onImport: () => void } | null;
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
  const heading = title || row.description || "No description";
  const imported = status?.kind === "imported";
  return (
    <TransactionSheet
      open={open}
      onRequestClose={onClose}
      closeLabel="Close row details"
      testId="row-editor-panel"
      compact
      progress={nav ? { current: nav.position, total: nav.total } : undefined}
      onKeyDown={onKeyDown}
      header={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
            <SheetAvatar compact tone={row.direction === "credit" ? "credit" : row.direction === "debit" ? "debit" : "neutral"}>#{rowNumber}</SheetAvatar>
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold tracking-[0.1em] whitespace-nowrap text-hero-foreground/68 uppercase">Statement row {rowNumber}</p>
              <DialogTitle className="max-w-full truncate font-heading text-[17px] leading-tight font-bold tracking-tight text-hero-foreground" title={heading}>
                {heading}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[12px] text-hero-foreground/70 tabular-nums">{formatRowDate(row.date, true)}</DialogDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p
              aria-label={`${row.direction === "credit" ? "Credit" : row.direction === "debit" ? "Debit" : "Debit or credit unknown"} ${row.amount == null ? "no amount" : `${sign}₹${row.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}`}
              className={cn("font-heading text-[24px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums", tone)}
            >
              {row.amount == null ? "₹ —" : `${sign}₹${row.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </p>
            {nav && <SheetNav compact label="Move between rows" position={`${nav.position} / ${nav.total}`} prevLabel="Previous row" nextLabel="Next row" onPrev={nav.onPrev} onNext={nav.onNext} />}
          </div>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-3 py-2 sm:px-5">
          <p className="mr-auto flex min-w-0 basis-64 items-center gap-2 text-[12px] text-foreground/72" data-testid="editor-save-note">
            <ShieldCheck className="size-4 shrink-0 text-[oklch(0.44_0.13_149)] dark:text-success" aria-hidden />
            {imported ? "Imported — this row is a FlowFi transaction now." : status && status.kind !== "ready" && importAction ? status.reason : "Changes are kept as you go. Nothing is in FlowFi until you import."}
          </p>
          {onReviewMatch && (
            <button type="button" onClick={onReviewMatch} className={cn(SHEET_BUTTON.secondary, "h-9")} data-testid="editor-review-match">
              <GitCompareArrows className="size-4" /> Review match
            </button>
          )}
          <button type="button" onClick={onClose} className={cn(importAction ? SHEET_BUTTON.secondary : SHEET_BUTTON.primary, "h-9 px-5")} data-testid="editor-close">
            Close
          </button>
          {importAction && (
            <button
              type="button"
              disabled={!importAction.enabled || importAction.running}
              onClick={importAction.onImport}
              title={importAction.reason ?? "Import this row now — FlowFi is re-checked first, and it is never written twice."}
              data-testid="import-as-transaction"
              className={cn(SHEET_BUTTON.primary, "h-9 px-5 disabled:opacity-50")}
            >
              {importAction.running ? <Loader2 className="size-4 animate-spin" /> : null}
              {importAction.running ? "Importing…" : "Import now"}
            </button>
          )}
        </div>
      }
    >
      <div key={row.id} className="px-3 py-3 sm:px-5">
        {children}
      </div>
    </TransactionSheet>
  );
}
