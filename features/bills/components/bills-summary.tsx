"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, Wallet, type LucideIcon } from "lucide-react";
import type { BillsOverviewData } from "@/features/bills/hooks/use-bills-overview";
import { OBLIGATION_KINDS } from "@/features/bills/lib/bills-overview";
import type { ObligationKind } from "@/features/my-money/lib/my-money";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_PLURAL: Record<ObligationKind, string> = { bill: "Bills", loan: "Loans", emi: "EMIs", card: "Card bills" };

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function Cell({
  label,
  icon: Icon,
  amount,
  tone,
  accent,
  meta,
  testId,
}: {
  label: string;
  icon: LucideIcon;
  amount: number;
  tone?: string;
  /** Thin top bar signalling the figure's state. */
  accent: string;
  meta: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="relative flex min-w-0 flex-col gap-1.5 px-4 pt-4 pb-3.5 sm:px-5">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", accent)} />
      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-foreground/70 uppercase">
        <Icon className="size-3.5" strokeWidth={2} aria-hidden />
        {label}
      </div>
      <p className={cn("font-heading text-[1.6rem] leading-none font-bold tracking-tight tabular-nums", tone ?? "text-foreground")}>{formatCurrency(amount)}</p>
      <p className="min-h-4 text-xs text-foreground/70">{meta}</p>
    </div>
  );
}

/**
 * The four answers the page exists for. Every figure is the engine's (`buildBillsOverview`) — nothing is summed here, and
 * the same obligations feed My Money's "To pay", so the two pages agree to the rupee.
 */
export function BillsSummary({ data }: { data: BillsOverviewData }) {
  const { summary, periodLabel, nextPeriodLabel } = data;
  const next = summary.next;
  const byKind = OBLIGATION_KINDS.filter((k) => summary.byKind[k] > 0);

  return (
    <section aria-label="Payment summary" className="overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
      <div className="grid grid-cols-2 divide-x divide-y divide-border-strong/40 lg:grid-cols-4 lg:divide-y-0">
        <Cell
          testId="bills-summary-due"
          label="Due this cycle"
          icon={Wallet}
          amount={summary.dueThisCycle}
          tone={summary.dueThisCycleCount === 0 ? "text-success" : undefined}
          accent={summary.overdue > 0 ? "bg-expense" : summary.dueSoon > 0 ? "bg-warning" : summary.dueThisCycleCount === 0 ? "bg-success" : "bg-primary"}
          meta={
            summary.dueThisCycleCount === 0 ? (
              `Nothing left to pay in ${periodLabel}`
            ) : (
              <>
                {summary.dueThisCycleCount} payment{summary.dueThisCycleCount === 1 ? "" : "s"}
                {summary.overdue > 0 && <span className="text-expense"> · incl. {formatCurrency(summary.overdue)} overdue</span>}
                {next && summary.overdue === 0 && ` · next ${shortDate(next.dueDate)}`}
              </>
            )
          }
        />
        <Cell
          testId="bills-summary-overdue"
          label="Overdue"
          icon={AlertTriangle}
          amount={summary.overdue}
          tone={summary.overdue > 0 ? "text-expense" : undefined}
          accent={summary.overdue > 0 ? "bg-expense" : "bg-border-strong/70"}
          meta={summary.overdue > 0 ? `${summary.overdueCount} past due — stays here until paid` : "Nothing past due"}
        />
        <Cell
          testId="bills-summary-upcoming"
          label="Upcoming"
          icon={CalendarClock}
          amount={summary.upcoming}
          accent="bg-border-strong/70"
          meta={summary.upcomingCount > 0 ? `${summary.upcomingCount} due next cycle · ${nextPeriodLabel}` : `Nothing due in ${nextPeriodLabel}`}
        />
        <Cell
          testId="bills-summary-paid"
          label="Paid"
          icon={CheckCircle2}
          amount={summary.paid}
          tone={summary.paid > 0 ? "text-success" : undefined}
          accent={summary.paid > 0 ? "bg-success" : "bg-border-strong/70"}
          meta={summary.paidCount > 0 ? `${summary.paidCount} paid in ${periodLabel}` : `No payments recorded in ${periodLabel}`}
        />
      </div>
      {byKind.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-strong/40 bg-secondary/30 px-4 py-2 text-xs text-foreground/75 sm:px-5">
          <span className="font-semibold text-foreground/70">Still to pay, by type</span>
          {byKind.map((k) => (
            <span key={k} className="tabular-nums">
              {KIND_PLURAL[k]} <span className="font-semibold text-foreground">{formatCurrency(summary.byKind[k])}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
