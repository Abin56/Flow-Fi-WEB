"use client";

/**
 * Composes the Budgets page's real data/actions from the ported `Budget`
 * model, `BudgetRepository`, and the `budget-insight` engine — replaces
 * `lib/mock/budgets-data.ts` as the page's data source.
 *
 * Known, accepted gaps (not silently faked — called out here instead of a
 * TODO): the ported `Budget` model has no 50/30/20 Needs/Wants/Savings
 * bucket concept and no month-over-month trend field, so the mock's
 * "Budget Overview by type" donut and per-category trend percentages are
 * replaced with a real per-category spend breakdown and dropped
 * respectively, rather than inventing numbers with no backing data.
 */

import { useMemo } from "react";
import { useBudgets } from "@/hooks/use-budgets";
import { useCategories } from "@/hooks/use-categories";
import { useTransactions } from "@/hooks/use-transactions";
import { computeBudgetInsight, resolveBudgetPeriod, type BudgetInsightResult } from "@/lib/engines/budget-insight";
import type { Budget } from "@/lib/models/budget";
import type { Category } from "@/lib/models/category";
import { effectiveMonth, type Transaction } from "@/lib/models/transaction";
import { createBudgetRepository } from "@/lib/repositories/repository-factory";
import type { CreateBudgetParams } from "@/lib/repositories/budget-repository";
import { useAuthStore } from "@/store/auth-store";

export interface BudgetRow {
  budget: Budget;
  category: Category | undefined;
  insight: BudgetInsightResult;
}

function isRealExpense(t: Transaction): boolean {
  return t.type === "expense" && t.deletedAt == null && t.transferId == null && !t.excludeFromCalculations;
}

/**
 * Daily budgets are scoped to a single real calendar day, so `accountingMonth`
 * reassignment doesn't apply there — only monthly/category budgets (which always
 * span exactly one calendar month per `resolveBudgetPeriod`) bucket by accounting
 * month, matching Dashboard/Analytics/Reports instead of raw `dateTime`.
 */
function isWithinBudgetPeriod(
  t: Transaction,
  budget: Budget,
  period: { periodStart: Date; periodEnd: Date },
): boolean {
  if (budget.type === "daily" && budget.categoryId == null) {
    return t.dateTime >= period.periodStart && t.dateTime <= period.periodEnd;
  }
  const effective = effectiveMonth(t);
  return (
    effective.getFullYear() === period.periodStart.getFullYear() &&
    effective.getMonth() === period.periodStart.getMonth()
  );
}

/** Live-joined Budgets-page rows — one per active `Budget`, spend computed from real transactions. */
export function useBudgetRows(): { rows: BudgetRow[]; isLoading: boolean } {
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();

  const rows = useMemo(() => {
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
    const expenses = (transactions as Transaction[]).filter(isRealExpense);

    return (budgets as Budget[]).map((budget) => {
      const period = resolveBudgetPeriod(budget);
      const spent = expenses
        .filter((t) => isWithinBudgetPeriod(t, budget, period))
        .filter((t) => budget.categoryId == null || t.categoryId === budget.categoryId)
        .reduce((sum, t) => sum + t.amount, 0);

      const insight = computeBudgetInsight({
        limit: budget.amount,
        spent,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });

      return {
        budget,
        category: budget.categoryId ? categoryById.get(budget.categoryId) : undefined,
        insight,
      };
    });
  }, [budgets, categories, transactions]);

  return { rows, isLoading: budgetsLoading || categoriesLoading || transactionsLoading };
}

/** This month's total expense per calendar day — powers the real "Daily Average" chart. */
export function useDailySpend(): { days: number[]; average: number } {
  const { data: transactions = [] } = useTransactions();

  return useMemo(() => {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const days = new Array(daysInMonth).fill(0);
    for (const t of transactions as Transaction[]) {
      if (!isRealExpense(t)) continue;
      const effective = effectiveMonth(t);
      if (effective.getFullYear() !== now.getFullYear() || effective.getMonth() !== now.getMonth()) continue;
      // dateTime's day-of-month can exceed the accounting month's day count
      // (e.g. Jan 31 accounted to Feb) — clamp so it can't index past the array.
      const dayIndex = Math.min(t.dateTime.getDate(), daysInMonth) - 1;
      days[dayIndex] += t.amount;
    }
    const average = days.reduce((s, v) => s + v, 0) / daysInMonth;
    return { days, average };
  }, [transactions]);
}

/** Create/edit/delete actions wired to the real repository, scoped to the signed-in user. */
export function useBudgetActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const repository = createBudgetRepository(uid);
    return {
      createBudget: (params: CreateBudgetParams) => repository.createBudget(params),
      editBudget: (budget: Budget, amount: number) => repository.editBudget(budget, amount),
      deleteBudget: (budget: Budget) => repository.softDelete(budget),
    };
  }, [uid]);
}

const BREAKDOWN_COLORS = ["primary", "expense", "success", "warning", "purple"] as const;
export type BreakdownColor = (typeof BREAKDOWN_COLORS)[number];

export interface BudgetTypeBreakdownItem {
  type: string;
  budget: number;
  spent: number;
  color: BreakdownColor;
}

/**
 * "Budget Overview" donut data — grouped by real `Category.name` since the
 * `Budget` model has no Needs/Wants/Savings type taxonomy (see hook doc
 * comment). Only category-scoped budgets are included; the overall monthly
 * budget (no `categoryId`) isn't a "category" to break down.
 */
export function budgetTypeBreakdownFrom(rows: BudgetRow[]): BudgetTypeBreakdownItem[] {
  return rows
    .filter((r) => r.category != null)
    .map((r, index) => ({
      type: r.category!.name,
      budget: r.insight.limit,
      spent: r.insight.spent,
      color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length],
    }));
}
