"use client";

/**
 * The Savings planner's money picture for the CURRENT Month Cycle — a read-only composition of figures other screens
 * already own, so Savings can never disagree with them:
 *  - Commitments still due / already paid → `useMyMoneyData` (the same `buildCycleObligations` Month Cycle, Bills and
 *    My Money read: card bills, Loan / EMI installments, bills — partial payments, card-funded EMIs counted once).
 *  - Income, outflow, My Spend per cycle → `useFinancialReportData().figuresFor` (the Reports / Analytics period engine,
 *    Month Cycle meaning). Savings transfers are invisible to all of these (proved in `savings-goals.test.ts`).
 *  - Goal money → `useSavingsPosition` (derived from entries).
 * Every combination of those figures is in `lib/engines/savings-plan.ts`. Nothing here writes.
 */

import { useMemo } from "react";
import { useMyMoneyData } from "@/features/my-money/hooks/use-my-money-data";
import { useFinancialReportData } from "@/features/reports/hooks/use-financial-report-data";
import { useSavingsPosition } from "@/features/savings/hooks/use-savings-data";
import { isSavingsAccount, round2 } from "@/lib/engines/savings-goals";
import {
  estimateSpendingBuffer,
  lockedByAccount,
  monthlyPlanSummary,
  savingsCapacity,
  typicalSurplus,
  type CycleWindow,
  type DueBreakdown,
} from "@/lib/engines/savings-plan";

export interface PlannerCycle extends CycleWindow {
  label: string;
  rangeLabel: string;
  daysLeft: number;
}

export function useSavingsPlanner(spendingBufferOverride: number | null) {
  const savings = useSavingsPosition();
  const money = useMyMoneyData();
  const report = useFinancialReportData();

  const cycle: PlannerCycle = useMemo(() => {
    const end = money.cycleRange.end;
    const today = new Date(money.now.getFullYear(), money.now.getMonth(), money.now.getDate()).getTime();
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
    return { start: money.cycleRange.start, end, label: money.periodLabel, rangeLabel: money.rangeLabel, daysLeft: Math.max(0, Math.round((endDay - today) / 86_400_000)) };
  }, [money.cycleRange, money.now, money.periodLabel, money.rangeLabel]);

  // Commitments still due this cycle (counted obligations only, live remainders) and what was already paid.
  const due: DueBreakdown = useMemo(() => {
    const out: DueBreakdown = { total: 0, overdue: 0, card: 0, loan: 0, emi: 0, bill: 0, count: 0 };
    for (const o of money.obligations) {
      if (!o.countsTowardTotal || o.remaining <= 0.005) continue;
      out[o.kind] = round2(out[o.kind] + o.remaining);
      if (o.status === "overdue") out.overdue = round2(out.overdue + o.remaining);
      out.count += 1;
    }
    out.total = round2(out.card + out.loan + out.emi + out.bill);
    return out;
  }, [money.obligations]);

  const upcoming = useMemo(
    () =>
      money.obligations
        .filter((o) => o.countsTowardTotal && o.remaining > 0.005)
        .slice(0, 6)
        .map((o) => ({ key: o.key, kind: o.kind, title: o.title, detail: o.detail, amount: o.remaining, dueDate: o.dueDate, status: o.status, href: o.href })),
    [money.obligations],
  );

  // This cycle + the three before it, from the shared period engine.
  const { isLoading: reportLoading, figuresFor, resolve, hasRecordsIn } = report;
  const figures = useMemo(() => {
    if (reportLoading) return null;
    const current = figuresFor(resolve({ kind: "cycle", offset: 0 }));
    // Cycles before the first record are "no records", never ₹0 (the Reports rule).
    const past = [-1, -2, -3].map((offset) => resolve({ kind: "cycle", offset })).filter((p) => hasRecordsIn(p)).map((p) => figuresFor(p));
    return { current, past };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `hasRecordsIn` is a fresh closure each render over `firstRecordDate`, which `figuresFor` already tracks via its sources.
  }, [reportLoading, figuresFor, resolve, report.firstRecordDate]);

  const spend = useMemo(() => estimateSpendingBuffer(figures?.past.map((f) => f.mySpend) ?? [], money.spending.mySpend), [figures, money.spending.mySpend]);
  const surplus = useMemo(() => (figures ? typicalSurplus(figures.past.map((f) => ({ income: f.income, outflow: f.outflow }))) : null), [figures]);

  const buffer = spendingBufferOverride ?? spend.buffer;
  const savingAccounts = useMemo(() => savings.accounts.filter(isSavingsAccount), [savings.accounts]);
  const capacity = useMemo(
    () => savingsCapacity({ accounts: savingAccounts, reservedByAccount: savings.position.reservedByAccount, due, spendingBuffer: buffer }),
    [savingAccounts, savings.position.reservedByAccount, due, buffer],
  );

  const plan = useMemo(() => monthlyPlanSummary(savings.position, cycle, money.now), [savings.position, cycle, money.now]);
  const locked = useMemo(() => lockedByAccount(savings.position, money.now), [savings.position, money.now]);

  return {
    ...savings,
    now: money.now,
    cycle,
    due,
    upcoming,
    paidThisCycle: money.completed.total,
    spentThisCycle: money.spending.mySpend,
    incomeThisCycle: figures?.current.income ?? null,
    outflowThisCycle: figures?.current.outflow ?? null,
    typicalSpend: spend.typical,
    suggestedBuffer: spend.buffer,
    surplus,
    capacity,
    plan,
    lockedByAccount: locked,
    /** The money picture is still loading — goals can already render. */
    pictureLoading: money.isLoading || report.isLoading,
  };
}

export type SavingsPlanner = ReturnType<typeof useSavingsPlanner>;
