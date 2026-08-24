"use client";

import { AnimatedNumber } from "@/components/foundation/animated-number";
import { FloatingCard } from "@/components/foundation/floating-card";
import { formatCurrency } from "@/lib/format";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";

/** EMI-flavored sibling of LoansSummary — total remaining balance (derived from real installments, never a
 *  cached number) across every not-closed EMI, plus the next-installment outlay and how much of the total
 *  original principal has been repaid so far. */
export function EmisSummary({ rows }: { rows: EmiRow[] }) {
  const activeRows = rows.filter((r) => r.status !== "closed");
  const totalRemaining = activeRows.reduce((sum, r) => sum + r.remainingBalance, 0);
  // See the module doc comment on `useEmiActions`/`useEmiRows` for why this
  // is a straight sum of each EMI's next-due installment amount rather than
  // a cadence-normalized "monthly" figure.
  const totalNextInstallmentOutlay = activeRows.reduce((sum, r) => sum + (r.nextInstallment?.amountDue ?? 0), 0);
  const totalPrincipal = rows.reduce((sum, r) => sum + r.emi.principalAmount, 0);
  const repaidPercent = totalPrincipal > 0 ? Math.round(((totalPrincipal - totalRemaining) / totalPrincipal) * 100) : 0;

  return (
    <FloatingCard interactive={false} elevation={2} className="flex flex-wrap items-center gap-8 px-7 py-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Total Remaining</p>
        <span className="font-heading text-4xl font-semibold tracking-tight tabular-nums text-foreground">
          <AnimatedNumber value={totalRemaining} format={formatCurrency} />
        </span>
      </div>
      <div className="h-10 w-px bg-border/60" />
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Next Installments Due</p>
        <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          <AnimatedNumber value={totalNextInstallmentOutlay} format={formatCurrency} />
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
        {activeRows.length} active EMI{activeRows.length === 1 ? "" : "s"} — balances tracked from real installment
        schedules, not a cached number
      </p>
    </FloatingCard>
  );
}
