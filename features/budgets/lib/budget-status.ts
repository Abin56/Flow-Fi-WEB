import type { BudgetInsightResult } from "@/lib/engines/budget-insight";

/**
 * Sourced from the engine's own `isOverBudget`/`alertLevel` — never a
 * locally re-derived percent threshold. A rounded display percent (100%)
 * can't distinguish "spent exactly the limit" from "spent 100.4% of the
 * limit"; `isOverBudget` (backed by the unrounded `remaining < 0`) can, so
 * this can never show "At Risk" for a budget the engine considers over.
 */
export function statusFor(insight: BudgetInsightResult): { label: string; tone: "success" | "warning" | "expense" } {
  if (insight.isOverBudget) return { label: "Over Budget", tone: "expense" };
  if (insight.alertLevel === "at90" || insight.alertLevel === "at100") return { label: "At Risk", tone: "warning" };
  return { label: "On Track", tone: "success" };
}
