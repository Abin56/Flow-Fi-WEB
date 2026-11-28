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
    <div data-testid={testId} className="relative min-w-0 bg-card px-2.5 pt-2.5 pb-2 @xl/bills:px-3">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", accent)} />
      <div className="flex flex-col gap-y-0.5 @5xl/bills:flex-row @5xl/bills:flex-wrap @5xl/bills:items-baseline @5xl/bills:justify-between @5xl/bills:gap-x-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground/70 uppercase">
          <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
          {label}
        </div>
        <p className={cn("font-heading text-xl leading-tight font-bold wrap-anywhere tracking-tight tabular-nums @sm/bills:text-[1.375rem]", tone ?? "text-foreground")}>
          {formatCurrency(amount)}
        </p>
      </div>
      <p className="mt-0.5 text-xs text-foreground/70">{meta}</p>
    </div>
  );
}

/**
 * The four answers the page exists for. Every figure is the engine's (`buildBillsOverview`) — nothing is summed here, and
 * the same obligations feed My Money's "To pay", so the two pages agree to the rupee.
 */
export function BillsSummary({ data }: { data: BillsOverviewData }) {
  const { summary, nextPeriodLabel } = data;
  const next = summary.next;
  const byKind = OBLIGATION_KINDS.filter((k) => summary.byKind[k] > 0);

  return (
    <section aria-label="Payment summary" className="overflow-hidden rounded-xl border border-border-strong/55 bg-card">
      <div className="grid grid-cols-2 gap-px bg-border-strong/35 @2xl/bills:grid-cols-4">
        <Cell
          testId="bills-summary-due"
          label="Due this cycle"
          icon={Wallet}
          amount={summary.dueThisCycle}
          tone={summary.dueThisCycleCount === 0 ? "text-success" : undefined}
          accent={summary.overdue > 0 ? "bg-expense" : summary.dueSoon > 0 ? "bg-warning" : summary.dueThisCycleCount === 0 ? "bg-success" : "bg-primary"}
          meta={
            summary.dueThisCycleCount === 0 ? (
              "Nothing due"
            ) : (
              <>
                {summary.dueThisCycleCount} payment{summary.dueThisCycleCount === 1 ? "" : "s"}
                {summary.overdue > 0 && <span className="text-expense"> · includes overdue</span>}
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
          meta={summary.overdue > 0 ? `${summary.overdueCount} past due` : "Nothing past due"}
        />
        <Cell
          testId="bills-summary-upcoming"
          label="Upcoming"
          icon={CalendarClock}
          amount={summary.upcoming}
          accent="bg-border-strong/70"
          meta={summary.upcomingCount > 0 ? `${summary.upcomingCount} due · ${nextPeriodLabel}` : `Nothing due · ${nextPeriodLabel}`}
        />
        <Cell
          testId="bills-summary-paid"
          label="Paid"
          icon={CheckCircle2}
          amount={summary.paid}
          tone={summary.paid > 0 ? "text-success" : undefined}
          accent={summary.paid > 0 ? "bg-success" : "bg-border-strong/70"}
          meta={summary.paidCount > 0 ? `${summary.paidCount} payment${summary.paidCount === 1 ? "" : "s"} this cycle` : "No payments this cycle"}
        />
      </div>
      {byKind.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border-strong/35 bg-secondary/35 px-2.5 py-1.5 text-xs text-foreground/75 @xl/bills:px-3">
          <span className="font-semibold text-foreground/70">To pay by type</span>
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
