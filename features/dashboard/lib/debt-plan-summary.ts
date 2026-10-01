import type { PayoffPlan, requiredThisPeriod } from "@/lib/engines/debt-payoff";
import { DEBT_CATEGORY_LABEL, type DebtCategory, type DebtSnapshot } from "@/lib/engines/debt-position";

/**
 * Dashboard "Debt plan" summary — a pure PROJECTION of the Debt Planner's own outputs
 * (`buildDebtSnapshot` → `DebtSnapshot`, `requiredThisPeriod`, `simulatePayoff` → `PayoffPlan`).
 * It picks figures out; it never sums balances or re-derives a debt figure, so the Dashboard widget
 * always shows exactly what /debt-planner shows.
 */

export const DEBT_PLANNER_HREF = "/debt-planner";

const CATEGORY_ORDER: DebtCategory[] = ["creditCards", "loans", "emis", "people"];

/** Existing sections each debt type is paid from. */
export const DEBT_CATEGORY_HREF: Record<DebtCategory, string> = {
  creditCards: "/credit-cards",
  loans: "/loans",
  emis: "/emi",
  people: "/people",
};

export type DebtFreeState =
  | { kind: "date"; label: string }
  | { kind: "noDebt" }
  | { kind: "unavailable"; reason: string };

export interface DebtPlanSummary {
  total: number;
  debtCount: number;
  periodLabel: string;
  required: number;
  overdue: number;
  budget: number;
  /** Budget above required payments this cycle (0 when short). */
  extra: number;
  /** Set when the budget can't cover this cycle's required payments. */
  shortfall: number | null;
  debtFree: DebtFreeState;
  breakdown: { category: DebtCategory; label: string; amount: number; href: string }[];
  priority: { name: string; kindLabel: string; outstanding: number; reason: "extra" | "due" } | null;
}

export function debtFreeState(plan: PayoffPlan): DebtFreeState {
  switch (plan.status) {
    case "debtFree":
      // Only a real engine projection — never a guessed date.
      return plan.debtFree ? { kind: "date", label: plan.debtFree.label } : { kind: "unavailable", reason: "Payoff date unavailable" };
    case "noDebt":
      return { kind: "noDebt" };
    case "shortfall":
      return { kind: "unavailable", reason: "Payoff date unavailable · budget too low" };
    case "stalled":
      return { kind: "unavailable", reason: "Payoff date unavailable" };
    case "horizon":
      return { kind: "unavailable", reason: "Payoff date unavailable · beyond 50 years" };
  }
}

export function buildDebtPlanSummary(
  snapshot: DebtSnapshot,
  required: ReturnType<typeof requiredThisPeriod>,
  plan: PayoffPlan,
  budget: number,
): DebtPlanSummary {
  const first = plan.months[0];
  const shortfall = plan.shortfall && plan.shortfall.period.index === 0 ? plan.shortfall.amount : null;
  // Same "extra payoff capacity" the planner's Monthly plan panel shows.
  const extra = shortfall != null ? 0 : first ? first.extra + first.lumpSum + first.unallocated : 0;

  const byId = new Map(snapshot.positions.map((p) => [p.id, p]));
  const extraTarget = first?.lines.find((l) => l.kind === "extra")?.debtId;
  const dueTarget = Object.entries(required.byDebt).sort((a, b) => b[1] - a[1])[0]?.[0];
  const target = extraTarget ? byId.get(extraTarget) : dueTarget ? byId.get(dueTarget) : undefined;

  return {
    total: snapshot.total,
    debtCount: snapshot.positions.length,
    periodLabel: required.period.label,
    required: required.total,
    overdue: required.overdue,
    budget,
    extra,
    shortfall,
    debtFree: debtFreeState(plan),
    breakdown: CATEGORY_ORDER.filter((c) => snapshot.byCategory[c] > 0).map((c) => ({
      category: c,
      label: DEBT_CATEGORY_LABEL[c],
      amount: snapshot.byCategory[c],
      href: DEBT_CATEGORY_HREF[c],
    })),
    priority: target
      ? { name: target.name, kindLabel: target.kindLabel, outstanding: target.outstanding, reason: extraTarget ? "extra" : "due" }
      : null,
  };
}
