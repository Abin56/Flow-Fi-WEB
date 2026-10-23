"use client";

import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { reconcileRows, type CommitmentRow, type CommitmentSummary, type OwnershipKind } from "@/features/loans/lib/my-commitments";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<OwnershipKind, string> = { mine: "Mine", shared: "Shared", others: "Others", review: "Unconfirmed" };
const KIND_TONE: Record<OwnershipKind, string> = {
  mine: "border-success/50 bg-success/15 text-foreground",
  shared: "border-primary-accent-text/50 bg-primary/15 text-foreground",
  others: "border-border-strong bg-secondary text-muted-foreground",
  review: "border-warning-foreground/50 bg-warning/15 text-foreground dark:border-warning/60",
};

const money = (paise: number | null) => (paise == null ? "—" : `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const dateLabel = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-baseline justify-between gap-2 @3xl:block", className)}>
      <span className="text-[11px] text-muted-foreground @3xl:hidden">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

const COLS = "@3xl:grid-cols-[minmax(0,1.6fr)_6rem_6rem_6rem_6.5rem_6rem_minmax(0,2fr)]";

function RowItem({ row }: { row: CommitmentRow }) {
  return (
    <li className={cn("grid gap-x-3 gap-y-1 border-t border-border px-3 py-3 text-sm transition-colors hover:bg-secondary/50 @3xl:items-start", COLS, "border-l-[3px]", row.counts === "none" ? "border-l-transparent bg-secondary/20 text-muted-foreground" : "border-l-success")}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold uppercase", row.counts === "none" ? "bg-secondary text-muted-foreground" : "bg-success/20 text-success")}>
          {row.name.trim().charAt(0)}
        </span>
        <span className="min-w-0 truncate font-semibold text-foreground" title={row.name}>
          {row.name}
        </span>
        <span className={cn("shrink-0 rounded-full border px-2 py-px text-[11px] font-semibold", KIND_TONE[row.kind])}>{KIND_LABEL[row.kind]}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">#{row.sequenceNumber}</span>
      </div>
      <Cell label="Due">{dateLabel(row.dueDate)}</Cell>
      <Cell label="Full installment"><span className="font-semibold text-foreground">{money(row.duePaise)}</span></Cell>
      <Cell label="My share">{money(row.minePaise)}</Cell>
      <Cell label="Attributed paid"><span className={row.minePaidPaise ? "font-medium text-success" : undefined}>{money(row.minePaidPaise)}</span></Cell>
      <Cell label="My remaining"><span className={row.mineRemainingPaise ? "font-semibold text-expense" : undefined}>{money(row.mineRemainingPaise)}</span></Cell>
      <div className="min-w-0 text-xs">
        <p className={row.counts === "none" ? "text-muted-foreground" : "text-foreground/90"}>{row.reason}</p>
        <p className="mt-0.5 inline-flex rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{row.lenderNote}</p>
      </div>
    </li>
  );
}

function Group({ title, rows }: { title: string; rows: readonly CommitmentRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className={cn(LE_RADIUS.card, "overflow-hidden border border-border")}>
      <div role="presentation" className={cn("hidden gap-x-3 bg-secondary/60 px-3 py-2 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase @3xl:grid", COLS)}>
        <span>Agreement</span>
        <span>Due</span>
        <span>Full</span>
        <span>My share</span>
        <span title="Lender payments split by your share — not proof you paid from your own account.">Attributed paid</span>
        <span>My remaining</span>
        <span>Included / why</span>
      </div>
      <ul>
        {rows.map((r) => (
          <RowItem key={r.key} row={r} />
        ))}
      </ul>
      </div>
    </div>
  );
}

/**
 * Read-only installment-level view of exactly what the summary above is made of. The rows are the ones the summary
 * is folded from (`commitmentRows` → `foldCommitmentRows`) — nothing is recomputed here. A reconciliation check runs
 * over what is displayed and, if it ever disagrees with the summary, says so instead of showing a total.
 */
export function EmiBreakdown({ rows, summary, windowLabel }: { rows: readonly CommitmentRow[]; summary: CommitmentSummary; windowLabel: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sorted = useMemo(() => [...rows].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.name.localeCompare(b.name) || a.sequenceNumber - b.sequenceNumber), [rows]);
  const month = sorted.filter((r) => r.scope === "month");
  const overdue = sorted.filter((r) => r.scope === "overdue");
  const problems = useMemo(() => (open ? reconcileRows(rows, summary) : []), [open, rows, summary]);
  if (rows.length === 0) return null;

  const m = summary.mine;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(LE_RADIUS.input, "inline-flex h-8 w-fit items-center gap-1 border border-border-strong px-2.5 text-xs font-medium text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring")}
      >
        View EMI breakdown
        <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-4">
          <ul className={cn(LE_RADIUS.card, "list-disc space-y-1 border border-border bg-secondary/40 py-3 pr-3 pl-7 text-xs text-muted-foreground")}>
            <li>“Attributed paid” is the lender payment split by your share. It is not proof that you paid from your own account.</li>
            <li>Others’ and unconfirmed EMIs are listed to show why they are not in My EMI — Confirmed. Loans you gave are not part of this view.</li>
            <li>Only installments due in {windowLabel}, plus earlier unpaid overdue ones, are listed.</li>
          </ul>

          {problems.length > 0 ? (
            <p role="alert" className="text-xs font-medium text-expense">
              This breakdown could not be reconciled with the summary ({problems.join(", ")}), so no total is shown for it.
            </p>
          ) : (
            <p className={cn(LE_RADIUS.control, "border border-success/40 bg-success/10 px-3 py-2 text-xs text-foreground")} data-testid="breakdown-reconciled">
              Adds up to the figures above: My EMI — Confirmed ₹{(m.scheduledPaise / 100).toLocaleString("en-IN")} · Already paid ₹{(m.attributedPaidPaise / 100).toLocaleString("en-IN")} · Still to pay ₹
              {(m.remainingPaise / 100).toLocaleString("en-IN")} · {m.installments} {m.installments === 1 ? "installment" : "installments"} across {m.records} {m.records === 1 ? "agreement" : "agreements"}.
            </p>
          )}

          {month.length === 0 && <p className="text-sm text-muted-foreground">No installments due in {windowLabel}.</p>}
          <Group title={`Due in ${windowLabel}`} rows={month} />
          <Group title="Overdue from earlier months (not part of the month)" rows={overdue} />
        </div>
      )}
    </div>
  );
}
