"use client";

/**
 * Review & Import's compact summary strip and the bulk "Import new rows" dialog.
 *
 * Summary: the included rows' money (current edited values, `reviewTotals`) and the counts that decide what's left —
 * possible duplicates, rows to check, rows that will be imported. One line on desktop, wrapping on phones; figures
 * never truncate.
 *
 * Bulk dialog: lists every row the bulk would decide (see lib/bulk-import.ts for who's left out and why), with its
 * category — suggested from history when unambiguous, otherwise chosen here (one choice can fill all the empty ones).
 * Applying records ordinary draft `import_new` decisions; nothing is written until the final Import.
 */

import { useState } from "react";
import { ArrowDownToLine, ListPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrencyPrecise } from "@/lib/format";
import type { ReviewTotals } from "@/features/smart-capture/lib/capture-review";
import type { BulkImportPlan } from "../lib/bulk-import";
import type { ReconRow } from "../lib/types";
import { Money, formatRowDate } from "./recon-ui";

export interface SummaryCounts {
  included: number;
  possibleDuplicates: number;
  toCheck: number;
  willImport: number;
}

export function ReviewImportSummary({
  totals,
  counts,
  bulkCount,
  onBulk,
  onNextCheck,
}: {
  totals: ReviewTotals;
  counts: SummaryCounts;
  bulkCount: number;
  onBulk: () => void;
  onNextCheck: () => void;
}) {
  const net = totals.net;
  return (
    <section aria-label="Import summary" data-testid="import-summary" className="@container flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-3 py-2 sm:px-4">
      <dl className="flex min-w-0 flex-wrap items-start gap-x-5 gap-y-1.5 @2xl:items-baseline">
        <Figure label="Debits" value={`${totals.debits > 0 ? "−" : ""}${formatCurrencyPrecise(totals.debits)}`} testId="total-debits" amount={totals.debits} />
        <Figure label="Credits" value={`${totals.credits > 0 ? "+" : ""}${formatCurrencyPrecise(totals.credits)}`} testId="total-credits" amount={totals.credits} tone={totals.credits > 0 ? "success" : undefined} />
        <Figure label={net < 0 ? "Net outflow" : net > 0 ? "Net inflow" : "Net"} value={formatCurrencyPrecise(Math.abs(net))} testId="total-net" amount={net} />
      </dl>
      <span className="hidden h-6 w-px bg-border @2xl:block" aria-hidden />
      <dl className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
        <Count label="Included" value={counts.included} testId="summary-included" />
        <Count label="Possible duplicates" value={counts.possibleDuplicates} testId="summary-duplicates" tone={counts.possibleDuplicates > 0 ? "warning" : undefined} />
        <Count label="To check / correct" value={counts.toCheck} testId="summary-to-check" tone={counts.toCheck > 0 ? "warning" : undefined} />
        <Count label="Will import" value={counts.willImport} testId="summary-will-import" tone={counts.willImport > 0 ? "primary" : undefined} />
      </dl>
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
        {counts.toCheck > 0 && (
          <ClayButton size="sm" variant="secondary" onClick={onNextCheck} data-testid="next-check">
            <ArrowDownToLine className="size-3.5" /> Next check
          </ClayButton>
        )}
        {bulkCount > 0 && (
          <ClayButton size="sm" onClick={onBulk} data-testid="bulk-import-open">
            <ListPlus className="size-3.5" /> Import new rows ({bulkCount})
          </ClayButton>
        )}
      </div>
      {totals.uncounted > 0 && (
        <p className="w-full text-[11px] text-muted-foreground">
          {totals.uncounted} included row{totals.uncounted === 1 ? "" : "s"} without an amount or Charge/Credit not counted yet. Totals use included rows&apos; current values.
        </p>
      )}
    </section>
  );
}

function Figure({ label, value, testId, amount, tone }: { label: string; value: string; testId: string; amount: number; tone?: "success" }) {
  return (
    <div className="flex min-w-0 flex-col @2xl:flex-row @2xl:items-baseline @2xl:gap-1.5" data-testid={testId} data-value={amount.toFixed(2)}>
      <dt className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn("text-sm font-semibold whitespace-nowrap tabular-nums", tone === "success" ? "text-success" : "text-foreground")}>{value}</dd>
    </div>
  );
}

function Count({ label, value, testId, tone }: { label: string; value: number; testId: string; tone?: "warning" | "primary" }) {
  return (
    <div className={cn("flex items-baseline gap-1", value === 0 && "opacity-60")} data-testid={testId}>
      <dt>{label}</dt>
      <dd className={cn("text-xs font-semibold tabular-nums", tone === "warning" ? "text-warning" : tone === "primary" ? "text-primary-accent-text" : "text-foreground")}>{value}</dd>
    </div>
  );
}

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export function BulkImportDialog({
  open,
  onOpenChange,
  plan,
  rowsById,
  numberOf,
  categoryNames,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: BulkImportPlan;
  rowsById: Map<string, ReconRow>;
  numberOf: (rowId: string) => number;
  /** Active expense categories (names — what decisions store). */
  categoryNames: string[];
  onApply: (choices: { rowId: string; category: string }[]) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [fillAll, setFillAll] = useState("");
  // Re-seed whenever the dialog opens on a (possibly different) plan.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const key = open ? plan.rows.map((r) => r.rowId).join(",") : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setChosen(Object.fromEntries(plan.rows.filter((r) => r.suggestedCategory).map((r) => [r.rowId, r.suggestedCategory!])));
    setFillAll("");
  }
  const withCategory = plan.rows.filter((r) => chosen[r.rowId]);
  const missing = plan.rows.length - withCategory.length;
  const total = withCategory.reduce((sum, r) => sum + Math.round((rowsById.get(r.rowId)?.amount ?? 0) * 100), 0) / 100;
  const suggested = plan.rows.filter((r) => r.suggestedCategory);
  const unsuggested = plan.rows.filter((r) => !r.suggestedCategory);

  const rowItem = (r: BulkImportPlan["rows"][number]) => {
    const row = rowsById.get(r.rowId);
    if (!row) return null;
    return (
      <li key={r.rowId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_11rem]" data-testid="bulk-import-row" data-row-id={r.rowId}>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">{row.description || "No description"}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            #{numberOf(r.rowId)} · {formatRowDate(row.date)}
            {r.suggestedCategory && chosen[r.rowId] === r.suggestedCategory ? ` · suggested from ${r.historyCount} earlier` : ""}
          </span>
        </span>
        <Money amount={row.amount} direction={row.direction} className="text-right" />
        <select
          aria-label={`Category for ${row.description}`}
          value={chosen[r.rowId] ?? ""}
          onChange={(e) => setChosen((c) => ({ ...c, [r.rowId]: e.target.value }))}
          className={cn(selectClass, "col-span-2 sm:col-span-1", !chosen[r.rowId] && "border-warning")}
        >
          <option value="">Choose a category…</option>
          {categoryNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] gap-3 sm:max-w-2xl" data-testid="bulk-import-dialog">
        <DialogHeader>
          <DialogTitle>Import {plan.rows.length} new row{plan.rows.length === 1 ? "" : "s"}?</DialogTitle>
          <DialogDescription>
            Charges with no possible match in FlowFi, values read clearly, and no rule against importing them. Each one becomes a draft “Import new” — nothing is saved until the final Import.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55dvh] flex-col gap-3 overflow-y-auto">
          {unsuggested.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-semibold text-foreground">Need a category ({unsuggested.length})</h3>
                <select
                  aria-label="Category for every row without one"
                  value={fillAll}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFillAll(v);
                    if (v) setChosen((c) => ({ ...c, ...Object.fromEntries(unsuggested.filter((r) => !c[r.rowId]).map((r) => [r.rowId, v])) }));
                  }}
                  className={cn(selectClass, "ml-auto w-auto min-w-44")}
                  data-testid="bulk-fill-all"
                >
                  <option value="">Set all empty to…</option>
                  {categoryNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <ul className="divide-y divide-border rounded-xl border border-border">{unsuggested.map(rowItem)}</ul>
            </section>
          )}
          {suggested.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-foreground">Category from your history ({suggested.length})</h3>
              <ul className="divide-y divide-border rounded-xl border border-border">{suggested.map(rowItem)}</ul>
            </section>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Not included: credits{plan.creditsLeft > 0 ? ` (${plan.creditsLeft} — choose Refund or Income on each)` : ""}, possible duplicates, rows still to check or correct, and rows a rule blocks. You can change or undo any of these decisions before importing.
        </p>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-xs text-foreground tabular-nums" data-testid="bulk-import-tally">
            {withCategory.length} row{withCategory.length === 1 ? "" : "s"} · −{formatCurrencyPrecise(total)}
            {missing > 0 && <span className="text-warning"> · {missing} without a category stay undecided</span>}
          </p>
          <div className="flex gap-2">
            <ClayButton variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </ClayButton>
            <ClayButton disabled={withCategory.length === 0} onClick={() => onApply(withCategory.map((r) => ({ rowId: r.rowId, category: chosen[r.rowId] })))} data-testid="bulk-import-apply">
              Mark {withCategory.length} for import
            </ClayButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
