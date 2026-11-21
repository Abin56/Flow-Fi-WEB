// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoalView } from "@/lib/engines/savings-goals";
import type { SavingsGoal } from "@/lib/models/savings-goal";
import { GoalPanel, type GoalPanelProps } from "./goal-panel";

/**
 * Editing a goal's Target Amount must update the goal's own header (saved/target/remaining/progress) the
 * moment the new `view` prop arrives — exactly what happens in the real app once the live Firestore listener
 * picks up the write (no page reload, no local cache to invalidate). This renders the REAL `GoalPanel` with
 * the REAL `buildGoalView` engine, submits the real `GoalEditor` form inside the Edit tab, and asserts the
 * header reflects the edit. `onEditGoal` stands in for the repository write — `rerender` with the resulting
 * goal is what the live listener does for real.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const NOW = new Date(2026, 10, 19, 12);
const baseGoal: SavingsGoal = {
  id: "g1",
  name: "Laptop",
  targetAmount: 80_000,
  currentAmount: 20_000,
  dueDate: null,
  notes: "",
  isCompleted: false,
  isArchived: false,
  createdAt: new Date(2026, 7, 1),
  openingAmount: 20_000,
  icon: null,
  accent: null,
  closedEarly: false,
  completedAt: null,
  kind: "goal",
  monthlyTarget: null,
  planAccountId: null,
  planSince: null,
  skippedCycles: [],
  locked: false,
  lockedUntil: null,
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
};

function renderPanel(goal: SavingsGoal, onEditGoal: GoalPanelProps["onEditGoal"]) {
  const view = buildGoalView(goal, [], null, NOW);
  const noop = vi.fn();
  return render(
    <GoalPanel
      view={view}
      tab="edit"
      onTab={noop}
      plan={null}
      history={[]}
      cycleLabel="This month"
      accounts={[]}
      reservedByAccount={new Map()}
      onClose={noop}
      onRecord={vi.fn()}
      onEditGoal={onEditGoal}
      onSetPlan={vi.fn()}
      onSkip={vi.fn()}
      onLock={vi.fn()}
      onEditEntry={vi.fn()}
      onRemoveEntry={noop}
      onComplete={noop}
      onReopen={noop}
      onArchive={noop}
      onUnarchive={noop}
      onDelete={noop}
    />,
  );
}

afterEach(cleanup);

describe("Editing a goal's target amount refreshes the header", () => {
  it("submitting a new target through the real Edit form, then re-rendering with the updated goal (what the live listener does), updates saved/target/remaining/progress with no reload", async () => {
    let stored = baseGoal;
    const onEditGoal: GoalPanelProps["onEditGoal"] = vi.fn(async (_view, values) => {
      stored = { ...stored, targetAmount: values.targetAmount };
    });
    const { rerender } = renderPanel(stored, onEditGoal);

    // Before: 20,000 of 80,000 saved → 60,000 left, 25%.
    expect(screen.getByText("₹60,000")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();

    const targetInput = screen.getByLabelText("Target amount");
    fireEvent.change(targetInput, { target: { value: "50000" } });
    fireEvent.click(screen.getByTestId("goal-submit"));
    expect(onEditGoal).toHaveBeenCalled();
    await Promise.resolve();

    // The live listener would now push the updated document back down as a new `view` prop.
    const nextView = buildGoalView(stored, [], null, NOW);
    rerender(
      <GoalPanel
        view={nextView}
        tab="edit"
        onTab={vi.fn()}
        plan={null}
        history={[]}
        cycleLabel="This month"
        accounts={[]}
        reservedByAccount={new Map()}
        onClose={vi.fn()}
        onRecord={vi.fn()}
        onEditGoal={onEditGoal}
        onSetPlan={vi.fn()}
        onSkip={vi.fn()}
        onLock={vi.fn()}
        onEditEntry={vi.fn()}
        onRemoveEntry={vi.fn()}
        onComplete={vi.fn()}
        onReopen={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // After: 20,000 of 50,000 saved → 30,000 left, 40%. Previously recorded contributions (saved) untouched.
    expect(screen.getByText("₹30,000")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(nextView.saved).toBe(20_000);
  });
});
