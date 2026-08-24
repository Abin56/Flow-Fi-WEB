import { describe, expect, it } from "vitest";
import { computeBudgetInsight } from "@/lib/engines/budget-insight";
import { statusFor } from "./budget-status";

/**
 * Regression test for the audit finding: the Budgets table's status badge
 * used to be computed from a *rounded* display percent against locally
 * re-invented 80/100 thresholds, instead of the engine's own
 * `isOverBudget`/`alertLevel`. A budget spent at 100.0-100.49% of its limit
 * rounds down to "100%" and used to show "At Risk" instead of the correct
 * "Over Budget" — understating severity exactly at the boundary that
 * matters most. `statusFor` now takes the engine's `BudgetInsightResult`
 * directly, so this can't happen regardless of display rounding.
 */
function insightFor(limit: number, spent: number) {
  return computeBudgetInsight({
    limit,
    spent,
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-08-31T00:00:00Z"),
  });
}

describe("budgets-workspace statusFor", () => {
  it("shows On Track well under the limit", () => {
    expect(statusFor(insightFor(1000, 200)).label).toBe("On Track");
  });

  it("shows At Risk at 90%+ but not yet over", () => {
    expect(statusFor(insightFor(1000, 950)).label).toBe("At Risk");
  });

  it("shows Over Budget exactly at the limit's boundary — spending 0.4% over still reads Over Budget, not At Risk", () => {
    // 1004/1000 = 100.4% — rounds to a *displayed* 100%, but isOverBudget is
    // true (remaining < 0). This is the exact case the bug used to get wrong.
    const insight = insightFor(1000, 1004);
    expect(insight.isOverBudget).toBe(true);
    expect(statusFor(insight).label).toBe("Over Budget");
  });

  it("shows At Risk (not Over Budget) when spend exactly equals the limit", () => {
    const insight = insightFor(1000, 1000);
    expect(insight.isOverBudget).toBe(false);
    expect(statusFor(insight).label).toBe("At Risk"); // at100 alert level, but not over
  });

  it("never reads At Risk for a budget the engine considers over, at any spend level", () => {
    for (const spent of [1000.01, 1050, 2000, 5000]) {
      const insight = insightFor(1000, spent);
      expect(statusFor(insight).label).toBe("Over Budget");
    }
  });
});
