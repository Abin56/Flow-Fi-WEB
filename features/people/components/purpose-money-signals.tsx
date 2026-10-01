"use client";

/**
 * Purpose money outside the People page — kept deliberately small:
 *  - `MoneyToUseSignal`: one Dashboard line ("Money to use ₹7,000 · 3 items"), nothing when there is none.
 *  - `MonthCyclePurposePanel`: purposes with a due date in the cycle — its own informational section,
 *    never counted as Bills (a purpose is money I hold, not a bill I owe).
 */

import { ArrowRight, Target } from "lucide-react";
import Link from "next/link";
import { useAllPurposeSummary } from "@/features/people/hooks/use-purpose-funds";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { purposesDueIn } from "@/lib/engines/purpose-funds";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MoneyToUseSignal({ className }: { className?: string }) {
  const { summary, isLoading } = useAllPurposeSummary();
  if (isLoading || summary.open.length + summary.unassigned.length === 0) return null;
  const overdue = summary.open.filter((v) => v.overdue).length;
  return (
    <Link
      href="/people"
      aria-label="Money to use"
      className={cn(
        "flex items-center gap-2.5 rounded-[10px] border border-border-strong/60 border-l-4 border-l-settle-emi-edge bg-card px-4 py-2.5 text-sm shadow-e1 transition-colors hover:bg-secondary",
        className,
      )}
    >
      <Target className="size-4 shrink-0 text-settle-emi-text" strokeWidth={2} aria-hidden />
      <span className="font-semibold text-foreground">Money to use</span>
      <span className="font-bold text-foreground tabular-nums">{formatCurrency(summary.stillToUse)}</span>
      <span className="text-foreground/80">
        · {summary.open.length} {summary.open.length === 1 ? "item" : "items"}
        {overdue > 0 && <span className="font-semibold text-expense"> · {overdue} overdue</span>}
        {summary.unassignedTotal > 0 && <span className="font-semibold text-settle-emi-text"> · {formatCurrency(summary.unassignedTotal)} unassigned</span>}
      </span>
      <ArrowRight className="ml-auto size-4 text-foreground/70" aria-hidden />
    </Link>
  );
}

export function MonthCyclePurposePanel({ cycle, className }: { cycle: { start: Date; end: Date }; className?: string }) {
  const { summary, personName, isLoading } = useAllPurposeSummary();
  if (isLoading) return null;
  const due = purposesDueIn(summary, cycle);
  if (due.length === 0) return null;
  const total = due.reduce((s, v) => s + v.remaining, 0);
  return (
    <section aria-label="Money to use this cycle" className={cn("overflow-hidden rounded-[10px] border border-border-strong/60 bg-card shadow-e1", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border-strong/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <Target className="size-4 text-settle-emi-text" strokeWidth={2} aria-hidden />
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Money to use — due this cycle</h2>
        </div>
        <p className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(total)}</p>
      </div>
      <p className="border-b border-border-strong/40 px-4 py-1.5 text-xs font-medium text-foreground/80">
        Money people gave you for these purposes — already in your accounts. Not bills, not income.
      </p>
      <ul className="divide-y divide-border-strong/40">
        {due.map((v) => (
          <li key={v.fund.id} className={cn("flex items-center gap-3 border-l-4 px-4 py-2.5", v.overdue ? "border-l-expense" : v.status === "partial" ? "border-l-royal" : "border-l-settle-emi-edge")}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{v.fund.title}</p>
              <p className={cn("text-xs font-semibold", v.overdue ? "text-expense" : "text-foreground/80")}>
                From {personName(v.fund.personId)} · {v.overdue ? "Overdue" : "Due"} {formatStatementDate(v.fund.dueDate!, true)}
                {v.status === "partial" && ` · ${formatCurrency(v.used)} used`}
              </p>
            </div>
            <span className="shrink-0 text-sm font-bold text-foreground tabular-nums">{formatCurrency(v.remaining)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
