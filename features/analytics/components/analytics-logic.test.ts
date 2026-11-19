import { describe, expect, it } from "vitest";
import type { PeriodDetail } from "@/lib/engines/period-report";
import { resolveReportPeriod } from "@/lib/engines/report-period";
import { levelFor, quantileSteps } from "./analytics-charts";
import { buildInsights } from "@/features/analytics/lib/insights";

describe("daily heatmap scale", () => {
  it("REGRESSION: one very large day no longer flattens every other day into the same colour", () => {
    const days = [12_043, 46, 44, 43, 42, 41, 40, 0, 0];
    const steps = quantileSteps(days);
    const levels = days.map((v) => levelFor(v, steps));
    expect(levels[0]).toBe(4); // the big day
    expect(new Set(levels.slice(1, 7)).size).toBeGreaterThan(1); // small days still differ (a linear scale gave them all level 1)
    expect(levels.slice(7)).toEqual([0, 0]); // no spend = no colour
  });

  it("no spending at all → no steps, every day level 0", () => {
    expect(quantileSteps([0, 0])).toEqual([]);
    expect(levelFor(50, [])).toBe(0);
  });
});

const NOW = new Date(2026, 10, 19, 12);
const detail = (month: number, cats: [string, number][], extra: Partial<PeriodDetail> = {}) =>
  ({
    period: resolveReportPeriod({ kind: "month", year: 2026, month }, 1, NOW),
    income: 0,
    outflow: 0,
    net: 0,
    savingsRate: null,
    mySpend: cats.reduce((s, [, v]) => s + v, 0),
    spendByCategory: new Map(cats.map(([id, amount]) => [id, { amount, count: 1 }])),
    spendRows: [],
    ...extra,
  }) as unknown as PeriodDetail;

describe("buildInsights", () => {
  it("compares with the previous period only when it has records (no 'up from ₹0' for a month before your first record)", () => {
    const focused = detail(10, [["food", 5_000]]);
    expect(buildInsights([], focused, null, (id) => id).some((i) => i.id === "category" || i.id === "pace")).toBe(false);
    const withPrev = buildInsights([], focused, detail(9, [["food", 1_000]]), (id) => id);
    expect(withPrev.find((i) => i.id === "category")?.title).toBe("food up ₹4,000");
  });
});
