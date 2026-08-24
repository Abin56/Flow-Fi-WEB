"use client";

/**
 * Composes the Analytics page's real data from already-loaded Transaction/Category
 * records — same posture as `use-dashboard-data.ts`/`use-reports-data.ts`: every
 * figure below is a direct field read or group-by over real Firestore data, never a
 * fabricated calculation.
 *
 * Known, accepted gap: there's no balance-history/snapshot mechanism anywhere in this
 * codebase (see `use-reports-data.ts`'s module doc comment), so net-worth/account-
 * balance trends over time aren't derivable. Spending trends here are real, though —
 * unlike net worth, a transaction's month is a fixed historical fact recorded on the
 * transaction itself, so grouping already-loaded transactions by month produces a
 * genuine multi-month series, not an invented one. Financial health indicators are
 * derived from real this vs. last month figures only (savings rate, budget adherence),
 * not a fabricated 0-100 score like the dashboard's known-absent `financialHealth`.
 */

import { useMemo } from "react";
import { useBudgets } from "@/hooks/use-budgets";
import { useCategories } from "@/hooks/use-categories";
import { useTransactions } from "@/hooks/use-transactions";
import type { Budget } from "@/lib/models/budget";
import type { Category } from "@/lib/models/category";
import { effectiveMonth, isTransfer, type Transaction } from "@/lib/models/transaction";

const MONTH_LABEL = { month: "short" } as const;

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString("en-IN", MONTH_LABEL);
}

function categoryNameFor(categoryId: string, categories: Category[]): string {
  return categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

const TREND_MONTHS = 6;

export function useAnalyticsData() {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets();

  const isLoading = transactionsLoading || categoriesLoading || budgetsLoading;

  const now = useMemo(() => new Date(), []);

  // --- Last N real months present in the data, oldest first ---
  const months = useMemo(() => {
    const result: Date[] = [];
    for (let i = TREND_MONTHS - 1; i >= 0; i--) {
      result.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    }
    return result;
  }, [now]);

  // --- Spending trend: real expense totals per month, grouped by effective month ---
  const spendingTrend = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      totals.set(monthKey(effective), (totals.get(monthKey(effective)) ?? 0) + t.amount);
    }
    return months.map((m) => ({ label: monthLabel(m), value: totals.get(monthKey(m)) ?? 0 }));
  }, [transactions, months]);

  const incomeTrend = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "income" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      totals.set(monthKey(effective), (totals.get(monthKey(effective)) ?? 0) + t.amount);
    }
    return months.map((m) => ({ label: monthLabel(m), value: totals.get(monthKey(m)) ?? 0 }));
  }, [transactions, months]);

  const thisMonthSpend = spendingTrend[spendingTrend.length - 1]?.value ?? 0;
  const lastMonthSpend = spendingTrend[spendingTrend.length - 2]?.value ?? 0;
  const spendDelta = lastMonthSpend === 0 ? 0 : ((thisMonthSpend - lastMonthSpend) / lastMonthSpend) * 100;

  const thisMonthIncome = incomeTrend[incomeTrend.length - 1]?.value ?? 0;

  // --- Highest expense categories: this month's real expense totals, grouped by Category ---
  const topCategories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isSameMonth(effective, now)) continue;
      totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amount);
    }
    const total = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
    return Array.from(totals.entries())
      .map(([categoryId, amount]) => ({
        categoryId,
        category: categoryNameFor(categoryId, categories as Category[]),
        amount,
        percent: total === 0 ? 0 : Math.round((amount / total) * 100),
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8);
  }, [transactions, categories, now]);

  // --- Monthly insights: real this-vs-last-month deltas per category (top 5 movers) ---
  const categoryMovers = useMemo(() => {
    const thisMonth = new Map<string, number>();
    const lastMonth = new Map<string, number>();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (isSameMonth(effective, now)) {
        thisMonth.set(t.categoryId, (thisMonth.get(t.categoryId) ?? 0) + t.amount);
      } else if (isSameMonth(effective, lastMonthDate)) {
        lastMonth.set(t.categoryId, (lastMonth.get(t.categoryId) ?? 0) + t.amount);
      }
    }

    const categoryIds = new Set([...thisMonth.keys(), ...lastMonth.keys()]);
    return Array.from(categoryIds)
      .map((categoryId) => {
        const current = thisMonth.get(categoryId) ?? 0;
        const previous = lastMonth.get(categoryId) ?? 0;
        const delta = previous === 0 ? (current > 0 ? 100 : 0) : ((current - previous) / previous) * 100;
        return { categoryId, category: categoryNameFor(categoryId, categories as Category[]), current, previous, delta };
      })
      .filter((row) => row.current > 0 || row.previous > 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);
  }, [transactions, categories, now]);

  // --- Financial health indicators: real this-month savings rate + budget adherence, no fabricated score ---
  const healthIndicators = useMemo(() => {
    const savingsRate = thisMonthIncome === 0 ? 0 : ((thisMonthIncome - thisMonthSpend) / thisMonthIncome) * 100;

    const categoryBudgets = (budgets as Budget[]).filter((b) => b.categoryId != null);
    const spentByCategory = new Map<string, number>();
    for (const t of transactions as Transaction[]) {
      if (t.type !== "expense" || isTransfer(t) || t.deletedAt != null) continue;
      const effective = effectiveMonth(t);
      if (!isSameMonth(effective, now)) continue;
      spentByCategory.set(t.categoryId, (spentByCategory.get(t.categoryId) ?? 0) + t.amount);
    }
    const withinBudget = categoryBudgets.filter(
      (b) => (spentByCategory.get(b.categoryId as string) ?? 0) <= b.amount,
    ).length;
    const budgetAdherence = categoryBudgets.length === 0 ? null : (withinBudget / categoryBudgets.length) * 100;

    return { savingsRate, budgetAdherence, budgetsTracked: categoryBudgets.length };
  }, [thisMonthIncome, thisMonthSpend, budgets, transactions, now]);

  return {
    isLoading,
    spendingTrend,
    incomeTrend,
    thisMonthSpend,
    spendDelta,
    topCategories,
    categoryMovers,
    healthIndicators,
  };
}

export type AnalyticsData = ReturnType<typeof useAnalyticsData>;
