import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav-items";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("Dashboard / drawer cleanup", () => {
  const dashboard = read("app/(app)/dashboard/page.tsx");

  it("I. the Debt Plan summary card is absent from the Dashboard", () => {
    expect(dashboard).not.toMatch(/DebtPlanCard|debt-plan-card/);
  });

  it("J. the Debt Planner page, engine and drawer entry remain", () => {
    expect(existsSync(resolve(root, "app/(app)/debt-planner/page.tsx"))).toBe(true);
    expect(existsSync(resolve(root, "lib/engines/debt-payoff.ts"))).toBe(true);
    expect(NAV_ITEMS.some((i) => i.href === "/debt-planner")).toBe(true);
  });

  it("K. the Budgets section is absent from the Dashboard", () => {
    expect(dashboard).not.toMatch(/BudgetsOverviewCard|budgets-overview-card/);
    expect(read("features/dashboard/hooks/use-dashboard-data.ts")).not.toMatch(/useBudgets|budgetsOverview/);
  });

  it("L. the Budgets drawer item is absent", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/budgets" || i.label === "Budgets")).toBe(false);
  });

  it("the Budgets Command Palette entry is absent", () => {
    expect(read("components/command-palette/command-palette.tsx")).not.toMatch(/href: "\/budgets"|label: "Budgets"/);
  });

  it("M. the Budget domain is untouched (route, engine, repository, model, hook)", () => {
    for (const p of [
      "app/(app)/budgets/page.tsx",
      "lib/engines/budget-insight.ts",
      "lib/models/budget.ts",
      "hooks/use-budgets.ts",
      "lib/repositories/budget-repository.ts",
    ]) {
      expect(existsSync(resolve(root, p)), p).toBe(true);
    }
  });
});
