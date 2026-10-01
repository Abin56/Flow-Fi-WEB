"use client";

import { AlertTriangle, ArrowUpRight, CalendarRange, Calculator, Info, ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import type { PayoffStrategy } from "@/lib/engines/debt-payoff";
import { cn } from "@/lib/utils";
import { useDebtPlan, useDebtPlannerData } from "@/features/debt-planner/hooks/use-debt-planner-data";
import { DEBT_PLANNER_STORAGE_KEY, defaultPlanBudget, loadPlannerSettings, toPlanAmount as toAmount } from "@/features/debt-planner/lib/planner-settings";
import { DebtList, focusOrder, NextFocus, paymentHref } from "./debt-list";
import { CalculationDetails, DebtCommandHeader } from "./debt-overview";
import { ExtraPaymentPanel } from "./extra-payment";
import { BudgetScenariosPanel, PayoffRoadmap, StrategySection } from "./payoff-plan";
import { Disclosure } from "./planner-ui";
import { OwnershipOverview, type DebtView } from "./ownership-overview";
import { requiredByOwnership } from "@/lib/engines/debt-position";

/**
 * Debt Planner — read + simulate. Budget, strategy and extra amount are planning values kept only in this
 * browser (a per-viewer convenience); nothing here creates a Transaction, pays an installment or a card,
 * touches People, an Account, principal or Net Worth. Payment actions link to the existing flows.
 *
 * Layout follows the questions a user asks, in order: how much do I owe → what's due now → what can I
 * afford (command header) → which debt comes first (focus + strategy, beside the register) → when am I
 * debt-free (roadmap) → what if I pay more (simulations). Diagnostics sit collapsed at the bottom.
 */

export function DebtPlannerWorkspace() {
  const { snapshot, reconciliation, affordability, required, monthCycleStartDay, now, isLoading } = useDebtPlannerData();

  // This viewer's last planning values (storage may be unavailable — then the defaults apply).
  const [stored] = useState(loadPlannerSettings);
  const [budgetInput, setBudgetInput] = useState<string | null>(stored.budget ?? null);
  const [strategy, setStrategy] = useState<PayoffStrategy>(stored.strategy ?? "avalanche");
  const [customOrder, setCustomOrder] = useState<string[]>(stored.customOrder ?? []);
  const [extraInput, setExtraInput] = useState("5000");
  const [extraTargetId, setExtraTargetId] = useState<string | null>(null);
  // "My debt" is the default planning perspective; the full liability is one click away.
  const [view, setView] = useState<DebtView>("mine");

  // Default budget = this cycle's required payments, rounded up to the next ₹500.
  const defaultBudget = defaultPlanBudget(required.total);
  const budgetText = budgetInput ?? defaultBudget;

  useEffect(() => {
    try {
      window.localStorage.setItem(DEBT_PLANNER_STORAGE_KEY, JSON.stringify({ budget: budgetInput ?? undefined, strategy, customOrder }));
    } catch {
      /* planning values are a convenience only */
    }
  }, [budgetInput, strategy, customOrder]);

  const { plan, impact, scenarios, isStale } = useDebtPlan(
    snapshot,
    { monthlyBudget: toAmount(budgetText), strategy, customOrder, extraAmount: toAmount(extraInput), extraTargetId },
    monthCycleStartDay,
    now,
  );

  const names = new Map(snapshot.positions.map((p) => [p.id, p.name]));
  const byId = new Map(snapshot.positions.map((p) => [p.id, p]));
  const focusId = focusOrder(plan)[0] ?? null;
  const issues = snapshot.warnings.length;
  const requiredSplit = requiredByOwnership(required.byDebt, snapshot.positions);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Debt Planner</h1>
          <p className="text-sm text-foreground/80">What you owe, what&apos;s due, and your path to debt-free.</p>
        </div>
        <Link
          href="/month-cycle"
          className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CalendarRange className="size-4" />
          Month Cycle · {affordability.label}
        </Link>
      </header>

      {isLoading ? (
        <>
          <Skeleton className={cn(LE_RADIUS.panel, "h-64")} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <Skeleton className={cn(LE_RADIUS.panel, "h-56")} />
            <Skeleton className={cn(LE_RADIUS.panel, "h-56")} />
          </div>
        </>
      ) : snapshot.positions.length === 0 ? (
        <div className={cn(LE_RADIUS.panel, "border border-dashed border-border-strong bg-card")}>
          <EmptyState icon={Wallet} title="No debt to plan" description="You don't owe anything on a card, loan, EMI or to a person right now." />
        </div>
      ) : (
        <>
          <OwnershipOverview snapshot={snapshot} requiredSplit={requiredSplit} view={view} onView={setView} />

          <DebtCommandHeader
            snapshot={snapshot}
            required={required}
            plan={plan}
            affordability={affordability}
            budgetInput={budgetText}
            onBudgetInput={setBudgetInput}
            names={names}
          />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <DebtList positions={snapshot.positions} plan={plan} requiredByDebt={required.byDebt} now={now} focusId={focusId} view={view} />
            <div className="flex min-w-0 flex-col gap-6 md:grid md:grid-cols-2 xl:flex">
              <NextFocus plan={plan} positions={snapshot.positions} strategy={strategy} requiredByDebt={required.byDebt} />
              <StrategySection positions={snapshot.positions} strategy={strategy} onStrategy={setStrategy} customOrder={customOrder} onCustomOrder={setCustomOrder} />
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] xl:items-start">
            <PayoffRoadmap plan={plan} positions={snapshot.positions} isStale={isStale} />
            <div className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-4">
              <ExtraPaymentPanel
                positions={snapshot.positions}
                strategy={strategy}
                amountInput={extraInput}
                onAmountInput={setExtraInput}
                targetId={extraTargetId}
                onTarget={setExtraTargetId}
                impact={impact}
              />
              <BudgetScenariosPanel scenarios={scenarios} currentBudget={toAmount(budgetText)} onPick={(b) => setBudgetInput(String(b))} />
            </div>
          </div>

          <div className="flex flex-col border-t border-border-strong">
            {issues > 0 && (
              <Disclosure title="Data quality" icon={ShieldCheck} summary={`${issues} ${issues === 1 ? "issue" : "issues"}`}>
                <ul className="flex flex-col">
                  {snapshot.warnings.map((w, i) => {
                    const p = byId.get(w.debtId);
                    const link = p ? paymentHref(p) : null;
                    return (
                      <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border/70 py-2 last:border-b-0">
                        {w.severity === "warning" ? (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning" strokeWidth={2.25} />
                        ) : (
                          <Info className="mt-0.5 size-4 shrink-0 text-foreground/80" />
                        )}
                        <div className="min-w-0 flex-1 text-[13px] text-foreground">
                          {p && <p className="font-semibold">{p.name}</p>}
                          <p className="text-foreground/85">{w.message}</p>
                        </div>
                        {link && (
                          <Link
                            href={link.href}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-foreground underline decoration-border-strong underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {link.label}
                            <ArrowUpRight className="size-3.5" />
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Disclosure>
            )}
            <Disclosure title="How is this calculated?" icon={Calculator} summary={reconciliation.matches ? "Matches Net Worth" : "Check Net Worth"}>
              <CalculationDetails snapshot={snapshot} reconciliation={reconciliation} />
            </Disclosure>
          </div>
        </>
      )}
    </div>
  );
}
