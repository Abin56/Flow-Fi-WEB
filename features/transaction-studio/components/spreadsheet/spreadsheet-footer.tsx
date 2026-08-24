"use client";

import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import type { StudioSummary } from "../../lib/summary";

function Stat({
  label,
  value,
  tone,
  prominent,
}: {
  label: string;
  value: string;
  tone?: "success" | "expense" | "warning" | "royal" | "muted";
  /** Net Balance is the bottom line the rest of the summary rolls up to — sized a step above every other stat so it reads first. */
  prominent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          prominent ? "text-base font-bold" : "text-sm",
          tone === "success" && "text-success",
          tone === "expense" && "text-expense",
          tone === "warning" && "text-warning",
          tone === "royal" && "text-royal",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function SpreadsheetFooter({ summary }: { summary: StudioSummary }) {
  return (
    <div className="flex items-center gap-6 overflow-x-auto border-t bg-surface-elevated px-4 py-3" style={{ borderTopColor: "var(--grid-line)" }}>
      <Stat label="Rows" value={String(summary.totalRows)} />
      <Stat label="Included" value={String(summary.includedRows)} tone="success" />
      <Stat label="Ignored" value={String(summary.ignoredRows)} tone="muted" />
      <div className="h-8 w-px shrink-0 bg-border" />
      <Stat label="Expenses" value={formatCurrencyPrecise(summary.expensesTotal)} tone="expense" />
      <Stat label="Income" value={formatCurrencyPrecise(summary.incomeTotal)} tone="success" />
      <Stat label="Transfers" value={formatCurrencyPrecise(summary.transfersTotal)} tone="royal" />
      <Stat label="EMIs" value={formatCurrencyPrecise(summary.emiTotal)} tone="warning" />
      <Stat label="Loan Payments" value={formatCurrencyPrecise(summary.loanPaymentTotal)} tone="warning" />
      <div className="h-8 w-px shrink-0 bg-border" />
      <Stat label="My Amount" value={formatCurrencyPrecise(summary.myAmount)} />
      <Stat label="Shared Amount" value={formatCurrencyPrecise(summary.sharedAmount)} />
      <Stat label="Someone Else" value={formatCurrencyPrecise(summary.someoneElseAmount)} tone="muted" />
      <div className="h-8 w-px shrink-0 bg-border" />
      <Stat
        label="Net Balance"
        value={`${summary.netBalance >= 0 ? "+" : "−"}${formatCurrencyPrecise(Math.abs(summary.netBalance))}`}
        tone={summary.netBalance >= 0 ? "success" : "expense"}
        prominent
      />
      {summary.pendingReviewRows > 0 && <Stat label="Pending Review" value={String(summary.pendingReviewRows)} tone="warning" />}
    </div>
  );
}
