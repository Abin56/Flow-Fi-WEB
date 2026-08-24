"use client";

import { AnimatedNumber } from "@/components/foundation/animated-number";
import { FloatingCard } from "@/components/foundation/floating-card";
import { formatCurrency } from "@/lib/format";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";

interface LoansSummaryProps {
  rows: LoanRow[];
}

/** Loans-flavored sibling of AccountsSummary/BudgetsSummary — total outstanding principal across all loans
 *  and the total monthly EMI outlay, framing the page around "what's left to repay" rather than balance
 *  or spend. Figures are the same per-row values LoanCard/the detail drawer already render, just summed —
 *  no separate recomputation. */
export function LoansSummary({ rows }: LoansSummaryProps) {
  const totalOutstanding = rows.reduce((sum, r) => sum + r.outstandingPrincipal, 0);
  const totalMonthlyEmi = rows.reduce((sum, r) => sum + r.emiAmount, 0);
  const totalPrincipal = rows.reduce((sum, r) => sum + r.loan.loanAmount, 0);
  const repaidPercent = totalPrincipal > 0 ? Math.round(((totalPrincipal - totalOutstanding) / totalPrincipal) * 100) : 0;

  return (
    <FloatingCard interactive={false} elevation={2} className="flex flex-wrap items-center gap-8 px-7 py-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Total Outstanding</p>
        <span className="font-heading text-4xl font-semibold tracking-tight tabular-nums text-foreground">
          <AnimatedNumber value={totalOutstanding} format={formatCurrency} />
        </span>
      </div>
      <div className="h-10 w-px bg-border/60" />
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Monthly EMI Outlay</p>
        <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          <AnimatedNumber value={totalMonthlyEmi} format={formatCurrency} />
        </span>
      </div>
      <div className="h-10 w-px bg-border/60" />
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Repaid So Far</p>
        <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums text-success">
          <AnimatedNumber value={repaidPercent} format={(v) => `${v}%`} />
        </span>
      </div>
      <p className="ml-auto max-w-[16rem] text-xs text-muted-foreground">
        {rows.length} active loans — repayment timelines below track installments, not just amounts
      </p>
    </FloatingCard>
  );
}
