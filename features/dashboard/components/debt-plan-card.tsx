"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowRight, CalendarCheck2, CheckCircle2, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DashPanel, DashPanelHeader } from "@/features/dashboard/components/dash-ui";
import { buildDebtPlanSummary, DEBT_PLANNER_HREF, type DebtPlanSummary } from "@/features/dashboard/lib/debt-plan-summary";
import { useDebtPlan, useDebtPlannerData } from "@/features/debt-planner/hooks/use-debt-planner-data";
import { defaultPlanBudget, loadPlannerSettings, toPlanAmount } from "@/features/debt-planner/lib/planner-settings";
import type { DebtCategory } from "@/lib/engines/debt-position";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Stronger than the shared `DASH_LABEL` grey — readable on large FHD panels. */
const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-foreground/75 uppercase";

/** Same swatches as the Debt Planner's total-debt bar. */
const SWATCH: Record<DebtCategory, string> = {
  creditCards: "bg-royal",
  loans: "bg-foreground",
  emis: "bg-sky",
  people: "bg-purple",
};

/**
 * Dashboard entry to the Debt Planner. Figures come from the planner's own hooks/engines
 * (`useDebtPlannerData` → `buildDebtSnapshot`, `useDebtPlan` → `simulatePayoff`) using this viewer's
 * saved planner budget/strategy — never from the Dashboard's Net Worth liabilities. Summary + navigation
 * only: nothing here pays, settles or records anything.
 */
export function DebtPlanCard() {
  const { snapshot, required, monthCycleStartDay, now, isLoading } = useDebtPlannerData();
  const [stored] = useState(loadPlannerSettings);
  const budget = toPlanAmount(stored.budget ?? defaultPlanBudget(required.total));
  const { plan } = useDebtPlan(
    snapshot,
    { monthlyBudget: budget, strategy: stored.strategy ?? "avalanche", customOrder: stored.customOrder ?? [], extraAmount: 0, extraTargetId: null },
    monthCycleStartDay,
    now,
  );
  return <DebtPlanCardView summary={isLoading ? null : buildDebtPlanSummary(snapshot, required, plan, budget)} />;
}

function Metric({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 px-4 py-2.5", className)}>
      <span className={LABEL}>{label}</span>
      <div className="truncate text-[15px] leading-tight font-bold text-foreground tabular-nums">{children}</div>
    </div>
  );
}

export function DebtPlanCardView({ summary }: { summary: DebtPlanSummary | null }) {
  return (
    <DashPanel label="Debt plan">
      <DashPanelHeader icon={TrendingDown} title="Debt plan" aside={<span className="text-xs font-medium text-foreground/75">From Debt Planner</span>} />
      {summary == null ? (
        <div className="flex flex-col gap-3 p-4" data-testid="debt-plan-loading">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : summary.debtCount === 0 ? (
        <div className="flex flex-1 items-center gap-3 px-4 py-5">
          <CheckCircle2 className="size-8 shrink-0 text-success" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-foreground">You&apos;re debt-free</p>
            <p className="text-[13px] text-foreground/75">No balance on any card, loan, EMI or to a person right now.</p>
          </div>
        </div>
      ) : (
        <DebtPlanBody summary={summary} />
      )}
    </DashPanel>
  );
}

function DebtPlanBody({ summary: s }: { summary: DebtPlanSummary }) {
  const short = s.shortfall != null;
  const coverTotal = Math.max(s.budget, s.required, 1);
  return (
    <div className="flex flex-1 flex-col">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:divide-x sm:divide-border-strong/40">
        {/* Headline: total + budget coverage */}
        <div className="flex flex-col gap-2 border-b border-border-strong/40 px-4 py-3 sm:border-b-0">
          <p className={LABEL}>Total remaining debt</p>
          <p className="text-[28px] leading-none font-bold tracking-tight text-foreground tabular-nums" data-testid="debt-plan-total">
            {formatCurrency(s.total)}
          </p>
          <p className="text-xs text-foreground/75">
            {s.debtCount} {s.debtCount === 1 ? "debt" : "debts"}
            {s.overdue > 0 && <span className="font-semibold text-expense"> · {formatCurrency(s.overdue)} overdue</span>}
          </p>

          {/* Budget coverage: required vs extra (or shortfall) this cycle */}
          <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
            <div className={cn("h-full", short ? "bg-expense" : "bg-foreground")} style={{ width: `${(Math.min(s.budget, s.required) / coverTotal) * 100}%` }} />
            {!short && s.extra > 0 && <div className="h-full bg-primary" style={{ width: `${(s.extra / coverTotal) * 100}%` }} />}
          </div>

          {short ? (
            <p className="flex items-center gap-1.5 rounded-[6px] border border-expense/50 bg-expense/10 px-2 py-1 text-xs font-semibold text-expense" role="status">
              <AlertTriangle className="size-3.5 shrink-0" />
              {formatCurrency(s.shortfall!)} short this cycle
            </p>
          ) : (
            <p className="text-xs text-foreground/75">
              Budget {formatCurrency(s.budget)} covers required payments
              {s.extra > 0 && <> + <span className="font-semibold text-foreground">{formatCurrency(s.extra)}</span> extra</>}
            </p>
          )}
        </div>

        {/* Cycle metrics */}
        <div className="grid grid-cols-2 content-center divide-x divide-y divide-border-strong/40 sm:grid-cols-1 sm:divide-x-0 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <Metric label={`Required · ${s.periodLabel}`}>
            <span data-testid="debt-plan-required">{formatCurrency(s.required)}</span>
          </Metric>
          <Metric label="Extra budget">
            {short ? <span className="text-expense">{formatCurrency(0)}</span> : formatCurrency(s.extra)}
          </Metric>
          <Metric label="Projected debt-free" className="col-span-2 sm:col-span-1">
            {s.debtFree.kind === "date" ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CalendarCheck2 className="size-4" />
                {s.debtFree.label}
              </span>
            ) : s.debtFree.kind === "noDebt" ? (
              <span className="text-success">Debt-free</span>
            ) : (
              <span className="text-[13px] font-semibold text-foreground/85" data-testid="debt-plan-unavailable">
                {s.debtFree.reason}
              </span>
            )}
          </Metric>
        </div>
      </div>

      {/* Breakdown */}
      {s.breakdown.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border-strong/40 px-4 py-2">
          {s.breakdown.map((b) => (
            <li key={b.category}>
              <Link href={b.href} className="inline-flex items-center gap-1.5 rounded-[4px] text-xs text-foreground hover:underline">
                <span className={cn("size-2 rounded-[2px]", SWATCH[b.category])} aria-hidden />
                {b.label}
                <span className="font-bold tabular-nums">{formatCurrency(b.amount)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Next priority + CTA */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border-strong/40 px-4 py-2.5">
        {s.priority ? (
          <div className="min-w-0 text-xs">
            <span className={LABEL}>{s.priority.reason === "extra" ? "Next priority" : "Largest due"}</span>
            <p className="truncate text-foreground">
              <span className="font-semibold">{s.priority.name}</span>
              <span className="text-foreground/75"> · {s.priority.kindLabel} · </span>
              <span className="font-bold tabular-nums">{formatCurrency(s.priority.outstanding)}</span>
              <span className="text-foreground/75"> remaining</span>
            </p>
          </div>
        ) : (
          <span />
        )}
        <Link
          href={DEBT_PLANNER_HREF}
          data-testid="debt-plan-cta"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Open Debt Planner
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </Link>
      </div>
    </div>
  );
}
