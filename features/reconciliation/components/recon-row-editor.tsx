"use client";

/**
 * The expandable draft editor for one statement row (inline on desktop, the Details tab of the sheet on phones).
 * Captured values — date, description, amount, Charge/Credit — are editable (D6) through Smart Capture's own patch
 * rules, and any change must be re-confirmed. Category and notes are draft fields used only by the final approval;
 * the account is the review's statement account (read-only). Person and Split stay disabled until their write paths
 * are proven safe. Nothing here writes to FlowFi or touches an existing transaction.
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { currentIssues, openIssues, type RowPatch } from "@/features/smart-capture/lib/capture-review";
import type { CaptureField } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { Category } from "@/lib/models/category";
import type { ReconRow, RowDecision } from "../lib/types";

function toDateInput(date: Date | null): string {
  if (!date) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function fromDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A text field that commits on blur / Enter — each commit is one edit (and one re-match), not one per keystroke. */
function CommitInput({ value, onCommit, label, className, inputMode, type = "text" }: { value: string; onCommit: (v: string) => void; label: string; className?: string; inputMode?: "decimal"; type?: string }) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      aria-label={label}
      type={type}
      inputMode={inputMode}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
      className={cn("h-9 rounded-xl text-sm", className)}
    />
  );
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
}: {
  row: ReconRow;
  decision: RowDecision;
  categories: Category[];
  /** The statement account ("HDFC Millennia •••• 4821") — read-only here; it's chosen once for the whole review. */
  accountLabel?: string | null;
  onPatch: (patch: RowPatch) => void;
  onConfirmRow: () => void;
  onConfirmField: (field: CaptureField) => void;
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  const open = openIssues(row);
  const informational = currentIssues(row).filter((i) => !i.blocking);
  const needsRowConfirm = row.needsReconfirm || open.some((i) => !i.strict);
  const options = categoriesForDirection(categories, row.direction);

  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="row-editor">
      <section aria-label="Statement values" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-foreground">Statement values</h4>
          {row.captureExcluded ? (
            // Smart Capture's exclusion stands — re-including (and the OCR checks that would need) happens there.
            <span className="text-xs text-muted-foreground" data-testid="capture-excluded">
              Excluded in Smart Capture
            </span>
          ) : (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Include
              <Switch checked={row.include} onCheckedChange={(v) => onPatch({ include: v })} aria-label="Include this row" />
            </label>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Date
            <CommitInput type="date" label="Date" value={toDateInput(row.date)} onCommit={(v) => onPatch({ date: fromDateInput(v) })} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Amount (₹)
            <CommitInput
              label="Amount"
              inputMode="decimal"
              value={row.amount == null ? "" : row.amount.toFixed(2)}
              className="text-right font-mono tabular-nums"
              onCommit={(v) => {
                const n = Number(v.replace(/[,\s₹]/g, ""));
                onPatch({ amount: v.trim() === "" || !Number.isFinite(n) ? null : n });
              }}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-muted-foreground">
            Merchant / description
            <CommitInput label="Description" value={row.description} onCommit={(v) => onPatch({ description: v })} />
          </label>
        </div>
        <div role="radiogroup" aria-label="Charge or credit" className="inline-flex w-fit rounded-xl bg-muted p-0.5">
          {(["debit", "credit"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={row.direction === d}
              onClick={() => row.direction !== d && onPatch({ direction: d })}
              className={cn("rounded-lg px-3 py-1 text-xs font-medium transition-colors", row.direction === d ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground")}
            >
              {d === "debit" ? "Charge" : "Credit"}
            </button>
          ))}
        </div>

        {(open.length > 0 || row.needsReconfirm || informational.length > 0) && (
          <ul className="space-y-1.5" aria-label="Flags">
            {row.needsReconfirm && (
              <li className="flex items-start gap-2 text-xs text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" /> You changed this row — check the values against the statement and confirm.
              </li>
            )}
            {open.map((issue, i) => (
              <li key={`${issue.code}-${i}`} className="flex flex-wrap items-start gap-2 text-xs text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{issue.message}</span>
                {issue.strict && issue.field && (
                  <ClayButton size="sm" variant="secondary" onClick={() => onConfirmField(issue.field!)}>
                    Confirm {issue.field === "direction" ? "Charge/Credit" : issue.field}
                  </ClayButton>
                )}
              </li>
            ))}
            {informational.map((issue, i) => (
              <li key={`info-${issue.code}-${i}`} className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-px size-3.5 shrink-0" /> {issue.message}
              </li>
            ))}
          </ul>
        )}
        {needsRowConfirm ? (
          <ClayButton size="sm" variant="secondary" className="w-fit" onClick={onConfirmRow}>
            <CheckCircle2 className="size-3.5" /> Values are correct
          </ClayButton>
        ) : (
          open.length === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="size-3.5" /> Values checked
            </p>
          )
        )}
      </section>

      <section aria-label="Draft details" className="flex flex-col gap-3">
        <h4 className="text-xs font-semibold text-foreground">Draft details</h4>
        <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Account
          <p className="flex h-9 items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 text-sm text-foreground" data-testid="editor-account">
            <span className="truncate">{accountLabel ?? "Choose the statement account first"}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">from the statement</span>
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Category
          <Select value={decision.category ?? undefined} onValueChange={(v) => onDecide({ category: v })}>
            <SelectTrigger className="h-9 w-full rounded-xl text-sm" aria-label="Category">
              <SelectValue placeholder={options.length ? "Choose a category" : "No categories for this type"} />
            </SelectTrigger>
            <SelectContent>
              {options.map((c) => (
                <SelectItem key={c.id} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground" data-testid="editor-ownership">
          Ownership
          <span className="inline-flex w-fit items-center rounded-lg bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary-accent-text">My own {row.direction === "credit" ? "credit" : "expense"}</span>
          {/* Person and Split are shown so the shape of the editor is clear, but they stay off: their existing write
              workflows haven't been verified as safe for an import, and this editor never writes anything itself. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              Person
              <span className="flex h-9 cursor-not-allowed items-center gap-1.5 rounded-xl border border-dashed border-border px-3 text-xs text-muted-foreground opacity-70" aria-disabled="true" data-testid="editor-person">
                <Users className="size-3.5" /> Not available yet
              </span>
            </div>
            <div className="flex flex-col gap-1">
              Split expense
              <span className="flex h-9 items-center gap-2 rounded-xl border border-dashed border-border px-3 text-xs text-muted-foreground opacity-70">
                <Switch checked={false} disabled aria-label="Split expense (not available yet)" />
                Off
              </span>
            </div>
          </div>
          <span>Person and split can&apos;t be part of an import yet — their write paths haven&apos;t been verified as safe.</span>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Notes
          <Textarea
            aria-label="Notes"
            value={decision.notes}
            onChange={(e) => onDecide({ notes: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            rows={2}
            className="min-h-0 rounded-xl text-sm"
            placeholder="Optional"
          />
        </label>
      </section>
    </div>
  );
}
