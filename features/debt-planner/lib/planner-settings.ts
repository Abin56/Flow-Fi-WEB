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

const STRATEGIES: readonly PayoffStrategy[] = ["avalanche", "snowball", "duePriority", "custom"];

/**
 * Storage is untrusted input (hand-edited, left by an older build, or written by another tab): keep only
 * values of the right shape so a bad entry falls back to the defaults instead of crashing the page.
 */
function sanitize(raw: unknown): StoredPlannerSettings {
  if (raw == null || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: StoredPlannerSettings = {};
  if (typeof r.budget === "string") out.budget = r.budget;
  if (typeof r.strategy === "string" && (STRATEGIES as readonly string[]).includes(r.strategy)) out.strategy = r.strategy as PayoffStrategy;
  if (Array.isArray(r.customOrder) && r.customOrder.every((id) => typeof id === "string")) out.customOrder = r.customOrder as string[];
  return out;
}

export function loadPlannerSettings(): StoredPlannerSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DEBT_PLANNER_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
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
