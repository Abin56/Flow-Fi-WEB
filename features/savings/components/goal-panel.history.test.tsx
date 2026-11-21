// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoalView } from "@/lib/engines/savings-goals";
import type { SavingsContribution } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { GoalPanel, type GoalPanelProps } from "./goal-panel";

/** Goal details: History is grouped by month with each month's net, and the tab strip drives a labelled tab panel. Display only. */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const NOW = new Date(2026, 10, 19, 12);
const goal: SavingsGoal = {
  id: "g1", name: "Laptop", targetAmount: 80_000, currentAmount: 0, dueDate: null, notes: "", isCompleted: false, isArchived: false,
  createdAt: new Date(2026, 7, 1), openingAmount: 0, icon: null, accent: null, closedEarly: false, completedAt: null, kind: "goal",
  monthlyTarget: null, planAccountId: null, planSince: null, skippedCycles: [], locked: false, lockedUntil: null, deletedAt: null,
  lastEditedAt: null, editHistory: [],
};
let n = 0;
const entry = (amount: number, date: Date, direction: "in" | "out" = "in"): SavingsContribution => ({
  id: `e${++n}`, goalId: "g1", direction, mode: "earmark", amount, date, accountId: "bank", counterAccountId: null, transactionIds: [], note: "",
  createdAt: date, emergency: false, allocationId: null, deletedAt: null, lastEditedAt: null, editHistory: [],
});

function panel(tab: GoalPanelProps["tab"]) {
  const view = buildGoalView(goal, [entry(5000, new Date(2026, 9, 3)), entry(2000, new Date(2026, 10, 2)), entry(500, new Date(2026, 10, 10), "out")], null, NOW);
  const noop = vi.fn();
  render(
    <GoalPanel
      view={view} tab={tab} onTab={noop} plan={null} history={[]} cycleLabel="This month" accounts={[]} reservedByAccount={new Map()}
      onClose={noop} onRecord={vi.fn()} onEditGoal={vi.fn()} onSetPlan={vi.fn()} onSkip={vi.fn()} onLock={vi.fn()} onEditEntry={vi.fn()}
      onRemoveEntry={noop} onComplete={noop} onReopen={noop} onArchive={noop} onUnarchive={noop} onDelete={noop}
    />,
  );
}

afterEach(cleanup);

describe("GoalPanel", () => {
  it("History groups entries by month and shows each month's net", () => {
    panel("history");
    const months = screen.getAllByTestId("savings-history-month");
    expect(months.map((m) => m.textContent)).toEqual(["November 2026+₹1,500", "October 2026+₹5,000"]); // 2,000 in − 500 out
    expect(screen.getAllByTestId("savings-entry")).toHaveLength(3);
  });

  it("the selected tab is linked to the visible tab panel", () => {
    panel("history");
    const selected = screen.getByRole("tab", { selected: true });
    const region = screen.getByRole("tabpanel");
    expect(region.getAttribute("aria-labelledby")).toBe(selected.id);
    expect(selected.getAttribute("aria-controls")).toBe(region.id);
    expect(within(region).getAllByTestId("savings-entry").length).toBe(3);
    fireEvent.click(screen.getByRole("tab", { name: /Edit/ })); // onTab is the parent's job — the strip stays a plain button group
  });
});
