/**
 * Direct port of `lib/features/budget/domain/budget_insight.dart`
 * (`BudgetInsight`, `BudgetAlertLevel`) plus the period-resolution logic
 * from `lib/features/budget/presentation/providers/budget_insight_providers.dart`.
 * No UI or Firebase dependency — pure function over already-computed
 * `spent`/`limit` values, following the same convention as
 * `lib/engines/net-worth.ts` and `lib/engines/cash-flow.ts` (plain data in,
 * plain data out; "now" passed in rather than computed internally).
 */

/** Mirrors `BudgetAlertLevel`. */
export type BudgetAlertLevel = "none" | "at50" | "at75" | "at90" | "at100" | "over";

export interface BudgetInsightInput {
  limit: number;
  spent: number;
  periodStart: Date;
  periodEnd: Date;
  /** Defaults to the current time, mirroring `BudgetInsight`'s `now ?? DateTime.now()`. */
  now?: Date;
}

export interface BudgetInsightResult {
  limit: number;
  spent: number;
  periodStart: Date;
  periodEnd: Date;
  remaining: number;
  isOverBudget: boolean;
  /** Spent-of-limit ratio, clamped to a safe 0.0-1.0 range for progress UI. */
  usageRatio: number;
  /**
   * Raw (unclamped) usage percentage — used for alert-level thresholds so
   * "150% over" is distinguishable from "100% exactly" upstream if needed.
   */
  usageRatioRaw: number;
  alertLevel: BudgetAlertLevel;
  totalDays: number;
  /**
   * Days elapsed so far in the period, including today — always at least 1
   * (even on the period's first day) so average-spend math never divides
   * by zero.
   */
  daysElapsed: number;
  daysRemaining: number;
  averageDailySpend: number;
  /**
   * How much can still be spent per remaining day without exceeding the
   * budget. 0 on the period's last day (nothing left to average over).
   */
  averageDailyBudgetRemaining: number;
  /** Projected total spend for the full period at the current daily pace. */
  predictedTotalSpend: number;
  predictedToExceedBudget: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Mirrors `num.clampedProgress` — clamps to 0.0-1.0, guarding NaN/Infinity. */
function clampedProgress(ratio: number): number {
  if (Number.isNaN(ratio) || !Number.isFinite(ratio)) return 0;
  return Math.min(Math.max(ratio, 0), 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Mirrors `DateTime.difference(...).inDays` — whole days, truncated toward zero. */
function diffInDays(a: Date, b: Date): number {
  return Math.trunc((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Pure port of the `BudgetInsight` getters. */
export function computeBudgetInsight(input: BudgetInsightInput): BudgetInsightResult {
  const { limit, spent, periodStart, periodEnd } = input;
  const now = input.now ?? new Date();

  const remaining = limit - spent;
  const isOverBudget = remaining < 0;

  const usageRatioRaw = limit === 0 ? 0 : spent / limit;
  const usageRatio = limit === 0 ? 0 : clampedProgress(spent / limit);

  let alertLevel: BudgetAlertLevel;
  if (usageRatioRaw > 1) alertLevel = "over";
  else if (usageRatioRaw >= 1) alertLevel = "at100";
  else if (usageRatioRaw >= 0.9) alertLevel = "at90";
  else if (usageRatioRaw >= 0.75) alertLevel = "at75";
  else if (usageRatioRaw >= 0.5) alertLevel = "at50";
  else alertLevel = "none";

  const totalDays = diffInDays(periodEnd, periodStart) + 1;

  const elapsed = diffInDays(now, periodStart) + 1;
  const daysElapsed = clamp(elapsed, 1, totalDays);

  const daysRemaining = clamp(totalDays - daysElapsed, 0, totalDays);

  const averageDailySpend = spent / daysElapsed;
  const averageDailyBudgetRemaining = daysRemaining === 0 ? 0 : remaining / daysRemaining;
  const predictedTotalSpend = averageDailySpend * totalDays;
  const predictedToExceedBudget = predictedTotalSpend > limit;

  return {
    limit,
    spent,
    periodStart,
    periodEnd,
    remaining,
    isOverBudget,
    usageRatio,
    usageRatioRaw,
    alertLevel,
    totalDays,
    daysElapsed,
    daysRemaining,
    averageDailySpend,
    averageDailyBudgetRemaining,
    predictedTotalSpend,
    predictedToExceedBudget,
  };
}

/**
 * Minimal shape `resolveBudgetPeriod` needs from a `Budget` — kept local
 * (rather than importing `lib/models/budget.ts`) so this engine has no
 * dependency beyond plain data, matching `lib/engines/net-worth.ts`'s
 * convention of a trimmed local interface.
 */
export interface BudgetPeriodInput {
  type: "daily" | "monthly";
  categoryId: string | null;
}

export interface BudgetPeriod {
  periodStart: Date;
  periodEnd: Date;
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
}

/**
 * Direct port of the period selection in `budget_insight_providers.dart`:
 * - Daily budget: `[today, today]` (`DateTime.now().dateOnly`).
 * - Monthly budget (no `categoryId`): `[startOfMonth(anchor), endOfMonth(anchor)]`.
 * - Category budget (`categoryId` set): always the current month —
 *   `categoryBudgetInsightProvider` uses `now.startOfMonth`/`now.endOfMonth`
 *   regardless of `budget.type`.
 *
 * `anchor` defaults to now and doubles as the "which month" selector for
 * `monthlyBudgetInsightProvider`'s history view (an arbitrary past/future
 * month), and as "now" for daily/category budgets.
 */
export function resolveBudgetPeriod(budget: BudgetPeriodInput, anchor: Date = new Date()): BudgetPeriod {
  if (budget.categoryId != null) {
    return { periodStart: startOfMonth(anchor), periodEnd: endOfMonth(anchor) };
  }
  if (budget.type === "daily") {
    const today = dateOnly(anchor);
    return { periodStart: today, periodEnd: today };
  }
  return { periodStart: startOfMonth(anchor), periodEnd: endOfMonth(anchor) };
}
