"use client";

import { Landmark } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FloatingCard } from "@/components/foundation/floating-card";
import { StaggerItem } from "@/components/foundation/animated-container";
import { CurrencyCell, DateCell } from "@/components/finance";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";

const ACCENT_TEXT: Record<LoanRow["accent"], string> = {
  primary: "text-primary-accent-text",
  success: "text-success",
  warning: "text-warning-foreground",
  purple: "text-purple",
  expense: "text-expense",
};

const ACCENT_BG: Record<LoanRow["accent"], string> = {
  primary: "bg-primary/25 ring-primary/40",
  success: "bg-success/18 ring-success/35",
  warning: "bg-warning/25 ring-warning/40",
  purple: "bg-purple/18 ring-purple/35",
  expense: "bg-expense/15 ring-expense/35",
};

const ACCENT_BAR: Record<LoanRow["accent"], string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  purple: "bg-purple",
  expense: "bg-expense",
};

interface LoanCardProps {
  row: LoanRow;
  onClick: () => void;
}

/** Repayment-timeline card — the primary metric is "N of M installments paid" (a slim bar keyed to
 *  installment count), not an amount-percentage ring like Credit Cards' utilization or Budgets' spend bar.
 *  This is deliberate: Loans is about progress through a fixed schedule over time, so counting installments
 *  reads more truthfully than a raw amount ratio (which reducing-balance amortization would skew early on). */
export function LoanCard({ row, onClick }: LoanCardProps) {
  const { loan, lenderName, direction, totalInstallments, installmentsPaid, outstandingPrincipal, emiAmount, nextDueDate, accent } =
    row;
  const installmentPercent = totalInstallments > 0 ? Math.round((installmentsPaid / totalInstallments) * 100) : 0;
  const remainingInstallments = totalInstallments - installmentsPaid;

  return (
    <StaggerItem>
      <FloatingCard
        role="button"
        tabIndex={0}
        onClick={onClick}
        className="flex h-full cursor-pointer flex-col gap-4 px-5 py-5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-2xl shadow-e1 ring-1", ACCENT_BG[accent], ACCENT_TEXT[accent])}>
              <Landmark className="size-5" strokeWidth={2.25} />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="truncate font-heading text-base font-semibold text-foreground">{loan.name ?? "Loan"}</h3>
              <p className="truncate text-xs text-muted-foreground">{lenderName}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {/* Virtually every loan on this page is "taken" (money borrowed) — the badge only
             *  surfaces for the rare "given" case, so it doesn't read as ambiguous debt. */}
            {direction === "given" && <ClayBadge tone="success">Money I Lent</ClayBadge>}
            {row.beneficiaryPersonId && (
              <ClayBadge tone="primary" className="max-w-40 truncate">
                For {row.beneficiaryName ?? "someone else"}
              </ClayBadge>
            )}
            {loan.interest && <ClayBadge tone="neutral">{loan.interest.ratePercent}% p.a.</ClayBadge>}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted ring-1 ring-border/60" style={{ boxShadow: "var(--shadow-pressed-sm)" }}>
            <div
              className={cn("h-full rounded-full transition-[width] duration-700 ease-out", ACCENT_BAR[accent])}
              style={{ width: `${installmentPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-medium tabular-nums text-foreground">
              {installmentsPaid} of {totalInstallments} installments paid
            </span>
            <span className="font-medium text-foreground/70">{remainingInstallments} left</span>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border bg-muted/60 px-3 py-2.5">
          <span className="text-xs font-medium text-foreground/70">Outstanding</span>
          <CurrencyCell amount={outstandingPrincipal} signed={false} className="text-lg font-semibold" />
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 border-t border-border/60 pt-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">EMI</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {emiAmount.toLocaleString("en-IN")}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-xs text-muted-foreground">Next due</span>
            {nextDueDate ? <DateCell date={nextDueDate} /> : <span className="text-sm text-muted-foreground">—</span>}
          </div>
        </div>
      </FloatingCard>
    </StaggerItem>
  );
}
