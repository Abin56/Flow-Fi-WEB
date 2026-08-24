"use client";

import { Landmark } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FloatingCard } from "@/components/foundation/floating-card";
import { StaggerItem } from "@/components/foundation/animated-container";
import { CurrencyCell, DateCell } from "@/components/finance";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";

const ACCENT_TEXT: Record<LoanRow["accent"], string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning-foreground",
  purple: "text-purple",
  expense: "text-expense",
};

const ACCENT_BG: Record<LoanRow["accent"], string> = {
  primary: "bg-primary/12",
  success: "bg-success/15",
  warning: "bg-warning/18",
  purple: "bg-purple/15",
  expense: "bg-expense/12",
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
  const { loan, lenderName, totalInstallments, installmentsPaid, outstandingPrincipal, emiAmount, nextDueDate, accent } = row;
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
          <div className="flex items-center gap-3">
            <div className={cn("flex size-10 items-center justify-center rounded-2xl shadow-e1", ACCENT_BG[accent], ACCENT_TEXT[accent])}>
              <Landmark className="size-4.5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h3 className="truncate font-heading text-base font-semibold text-foreground">{loan.name ?? "Loan"}</h3>
              <p className="text-xs text-muted-foreground">{lenderName}</p>
            </div>
          </div>
          {loan.interest && <ClayBadge tone="neutral">{loan.interest.ratePercent}% p.a.</ClayBadge>}
        </div>

        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" style={{ boxShadow: "var(--shadow-pressed-sm)" }}>
            <div
              className={cn("h-full rounded-full transition-[width] duration-700 ease-out", ACCENT_BAR[accent])}
              style={{ width: `${installmentPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-medium tabular-nums text-foreground">
              {installmentsPaid} of {totalInstallments} installments paid
            </span>
            <span className="text-muted-foreground">{remainingInstallments} left</span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Outstanding</span>
          <CurrencyCell amount={outstandingPrincipal} signed={false} className="text-base font-semibold" />
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
