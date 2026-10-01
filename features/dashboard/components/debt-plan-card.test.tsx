import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDebtSnapshot } from "@/lib/engines/debt-position";
import { requiredThisPeriod, simulatePayoff } from "@/lib/engines/debt-payoff";
import { cardInput, flatSchedule, loanInput, NOW, personInput } from "@/lib/engines/debt-planner.fixtures";
import { buildDebtPlanSummary, DEBT_PLANNER_HREF } from "@/features/dashboard/lib/debt-plan-summary";

/**
 * Dashboard "Debt plan" — a projection of the Debt Planner engines' outputs, rendered read-only, linking to
 * /debt-planner. It must never re-derive debt or touch money.
 */

const plannerData = vi.hoisted(() => ({ current: null as unknown }));

// The real hook module pulls in Firebase; the double feeds the widget the planner's own engine output.
vi.mock("@/features/debt-planner/hooks/use-debt-planner-data", async () => {
  const { simulatePayoff } = await import("@/lib/engines/debt-payoff");
  return {
    useDebtPlannerData: () => plannerData.current,
    useDebtPlan: (snapshot: { positions: never[] }, settings: { monthlyBudget: number; strategy: "avalanche"; customOrder: string[] }, monthCycleStartDay: number, now: Date) => ({
      plan: simulatePayoff({ positions: snapshot.positions, ...settings, monthCycleStartDay, now }),
    }),
  };
});
// The widget must not read the Dashboard's own Net Worth / liability figures.
vi.mock("@/features/dashboard/hooks/use-dashboard-data", () => ({
  useDashboardData: () => {
    throw new Error("Debt plan widget must not read Dashboard debt");
  },
}));

const { DebtPlanCard, DebtPlanCardView } = await import("./debt-plan-card");

// ₹25,000 loan, 10 × ₹2,500 from 5 Oct 2026; ₹8,000 card; ₹3,000 owed to a person.
function fixture() {
  return buildDebtSnapshot({
    loans: [loanInput({ id: "zero", name: "Bike loan", installments: flatSchedule("zero", 25000, 10, new Date(2026, 9, 5)) })],
    emis: [],
    cards: [cardInput({ id: "c1", name: "HDFC card", outstanding: 8000 })],
    people: [personInput({ personId: "p1", name: "Ravi", directBalance: -3000 })],
    now: NOW,
  });
}

function summaryFor(budget: number, snapshot = fixture()) {
  const required = requiredThisPeriod(snapshot.positions, 1, NOW);
  const plan = simulatePayoff({ positions: snapshot.positions, monthlyBudget: budget, strategy: "avalanche", monthCycleStartDay: 1, now: NOW });
  return { snapshot, required, plan, summary: buildDebtPlanSummary(snapshot, required, plan, budget) };
}

const html = (budget: number, snapshot?: ReturnType<typeof fixture>) => renderToStaticMarkup(<DebtPlanCardView summary={summaryFor(budget, snapshot).summary} />);

beforeEach(() => {
  plannerData.current = null;
});

describe("Dashboard debt plan summary — source of truth", () => {
  it("takes total, breakdown and required straight from the planner engine outputs", () => {
    const { snapshot, required, summary } = summaryFor(20000);
    expect(summary.total).toBe(snapshot.total);
    expect(summary.required).toBe(required.total);
    expect(Object.fromEntries(summary.breakdown.map((b) => [b.category, b.amount]))).toEqual(
      Object.fromEntries(Object.entries(snapshot.byCategory).filter(([, v]) => v > 0)),
    );
  });

  it("does not recompute debt: a snapshot total that differs from its positions is shown as-is", () => {
    const snapshot = { ...fixture(), total: 123456 };
    const { summary } = summaryFor(20000, snapshot);
    expect(summary.total).toBe(123456);
    expect(html(20000, snapshot)).toContain("₹1,23,456");
  });

  it("the container renders useDebtPlannerData's snapshot, not Dashboard figures", () => {
    const snapshot = fixture();
    const required = requiredThisPeriod(snapshot.positions, 1, NOW);
    plannerData.current = { snapshot, required, monthCycleStartDay: 1, now: NOW, isLoading: false };
    const out = renderToStaticMarkup(<DebtPlanCard />);
    expect(out).toContain(`data-testid="debt-plan-total">₹${snapshot.total.toLocaleString("en-IN")}<`);
  });
});

describe("Dashboard debt plan card — rendering", () => {
  it("renders the total and required this cycle", () => {
    const { snapshot, required } = summaryFor(20000);
    const out = html(20000);
    expect(out).toContain(`data-testid="debt-plan-total">₹${snapshot.total.toLocaleString("en-IN")}<`);
    expect(out).toContain(`data-testid="debt-plan-required">₹${required.total.toLocaleString("en-IN")}<`);
  });

  it("shows a shortfall warning when the budget is below required payments", () => {
    const { summary } = summaryFor(100);
    expect(summary.shortfall).toBeGreaterThan(0);
    const out = html(100);
    expect(out).toContain(`₹${summary.shortfall!.toLocaleString("en-IN")} short this cycle`);
    expect(out).toContain("text-expense");
  });

  it("shows a positive zero-debt state instead of empty metrics", () => {
    const empty = buildDebtSnapshot({ loans: [], emis: [], cards: [], people: [], now: NOW });
    const out = html(0, empty);
    expect(out).toContain("debt-free");
    expect(out).not.toContain("debt-plan-required");
  });

  it("never invents a payoff date when the plan has none", () => {
    const { summary } = summaryFor(100);
    expect(summary.debtFree.kind).toBe("unavailable");
    const out = html(100);
    expect(out).toContain("Payoff date unavailable");
    expect(out).not.toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Nov|Dec) 20\d\d\b/);
  });

  it("shows the engine's date when the plan reaches debt-free", () => {
    const { plan, summary } = summaryFor(50000);
    expect(plan.status).toBe("debtFree");
    expect(summary.debtFree).toEqual({ kind: "date", label: plan.debtFree!.label });
  });

  it("CTA links to /debt-planner", () => {
    expect(DEBT_PLANNER_HREF).toBe("/debt-planner");
    expect(html(20000)).toMatch(/<a data-testid="debt-plan-cta"[^>]*href="\/debt-planner"/);
  });

  it("rendering causes no financial mutation and offers no payment action", () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    const out = html(20000, snapshot);
    expect(snapshot).toEqual(before);
    expect(out).not.toContain("<button");
    expect(out).not.toContain("<form");
    expect(out).not.toMatch(/>(Pay|Settle|Record)\b/);
  });
});
