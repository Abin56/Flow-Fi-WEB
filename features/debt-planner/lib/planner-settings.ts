import type { PayoffStrategy } from "@/lib/engines/debt-payoff";

/**
 * The Debt Planner's per-viewer planning values (budget, strategy, custom order), kept only in this
 * browser. Shared by the planner workspace (reads + writes) and the Dashboard summary (reads only), so
 * both show the same plan.
 */

export const DEBT_PLANNER_STORAGE_KEY = "flowfi.debtPlanner.v1";

export interface StoredPlannerSettings {
  budget?: string;
  strategy?: PayoffStrategy;
  customOrder?: string[];
}

export function loadPlannerSettings(): StoredPlannerSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DEBT_PLANNER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredPlannerSettings) : {};
  } catch {
    return {};
  }
}

export function toPlanAmount(input: string): number {
  const v = Number(input);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Default budget = this cycle's required payments, rounded up to the next ₹500. */
export function defaultPlanBudget(requiredTotal: number): string {
  return String(Math.max(Math.ceil(requiredTotal / 500) * 500, 0));
}
