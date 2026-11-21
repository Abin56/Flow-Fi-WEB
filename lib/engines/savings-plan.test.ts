/**
 * Savings planning — expectations worked out by hand from raw goals + entries. Covers: monthly plan status per cycle
 * (done / partial / due / missed / skipped / none, plan start, cap at what the goal still needs), the monthly summary,
 * capacity (free money − still-due commitments − buffer; reserved money never counted twice), the spending buffer and
 * surplus estimates, allocation suggestions + checks, deposit math and the app-level lock.
 */

import { describe, expect, it } from "vitest";
import { buildGoalView, buildSavingsPosition, isGoalLockedNow, validateMoneyEntry, LOCKED_WITHDRAWAL_MESSAGE } from "@/lib/engines/savings-goals";
import {
  checkAllocation,
  cycleKeyOf,
  depositCount,
  depositTarget,
  goalCyclePlan,
  goalPlanHistory,
  lockedByAccount,
  lockState,
  monthlyPlanSummary,
  savingsCapacity,
  suggestAllocation,
  typicalSurplus,
  type DueBreakdown,
} from "@/lib/engines/savings-plan";
import type { SavingsContribution } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";

const NOW = new Date(2026, 10, 19, 12); // 19 Nov 2026
const at = (m: number, d: number) => new Date(2026, m, d, 12);
const NOV = { start: new Date(2026, 10, 1), end: new Date(2026, 10, 30, 23, 59, 59, 999) };
const OCT = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59, 999) };
const SEP = { start: new Date(2026, 8, 1), end: new Date(2026, 8, 30, 23, 59, 59, 999) };

function goal(p: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: "g1",
    name: "Bicycle",
    targetAmount: 20_000,
    currentAmount: 0,
    dueDate: null,
    notes: "",
    isCompleted: false,
    isArchived: false,
    createdAt: at(7, 1),
    openingAmount: 0,
    icon: null,
    accent: null,
    closedEarly: false,
    completedAt: null,
    kind: "goal",
    monthlyTarget: 2_000,
    planAccountId: null,
    planSince: at(8, 1),
    skippedCycles: [],
    locked: false,
    lockedUntil: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...p,
  };
}

let seq = 0;
function entry(p: Partial<SavingsContribution> & { amount: number }): SavingsContribution {
  seq += 1;
  return {
    id: `e${seq}`,
    goalId: "g1",
    direction: "in",
    mode: "earmark",
    date: at(10, 5),
    accountId: "bank",
    counterAccountId: null,
    transactionIds: [],
    note: "",
    createdAt: at(10, 5),
    emergency: false,
    allocationId: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...p,
  };
}

const view = (g: SavingsGoal, e: SavingsContribution[] = []) => buildGoalView(g, e, null, NOW);
const position = (goals: SavingsGoal[], e: SavingsContribution[] = []) => buildSavingsPosition(goals, e, null, NOW);

describe("monthly plan status for one goal and one cycle", () => {
  it("done / partial / due for the current cycle; missed for a past cycle with nothing in", () => {
    expect(goalCyclePlan(view(goal(), [entry({ amount: 2_000 })]), NOV, NOW)).toMatchObject({ target: 2_000, contributed: 2_000, remaining: 0, status: "done" });
    expect(goalCyclePlan(view(goal(), [entry({ amount: 500 })]), NOV, NOW)).toMatchObject({ remaining: 1_500, status: "partial" });
    expect(goalCyclePlan(view(goal()), NOV, NOW)).toMatchObject({ remaining: 2_000, status: "due" });
    expect(goalCyclePlan(view(goal()), OCT, NOW).status).toBe("missed");
  });

  it("counts only entries dated inside the cycle, and only active ones; withdrawals tracked apart", () => {
    const e = [
      entry({ amount: 1_000, date: at(9, 30) }), // October — not November
      entry({ amount: 700 }),
      entry({ amount: 300, deletedAt: at(10, 6) }), // removed
      entry({ amount: 200, direction: "out" }),
      entry({ amount: 400, mode: "transfer", transactionIds: ["a", "b"] }),
    ];
    const v = buildGoalView(goal(), e, new Set(["x"]), NOW); // transfer legs not live → reversed, not counted
    const p = goalCyclePlan(v, NOV, NOW);
    expect(p.contributed).toBe(700);
    expect(p.withdrawn).toBe(200);
    expect(p.status).toBe("partial");
  });

  it("a skipped cycle is never missed; cycles before the plan started are not judged", () => {
    expect(goalCyclePlan(view(goal({ skippedCycles: [cycleKeyOf(OCT)] })), OCT, NOW).status).toBe("skipped");
    expect(goalCyclePlan(view(goal({ planSince: at(10, 10) })), OCT, NOW).status).toBe("none");
    // A plan set mid-cycle applies to that cycle.
    expect(goalCyclePlan(view(goal({ planSince: at(10, 10) })), NOV, NOW).status).toBe("due");
    expect(goalCyclePlan(view(goal({ monthlyTarget: null })), NOV, NOW).status).toBe("none");
  });

  it("this cycle never asks for more than the goal still needs", () => {
    // 20,000 target, 19,500 saved before November → only 500 asked.
    const v = view(goal(), [entry({ amount: 19_500, date: at(9, 3) })]);
    expect(goalCyclePlan(v, NOV, NOW)).toMatchObject({ target: 500, remaining: 500, status: "due" });
    // 19,500 earlier + 500 this cycle → done, target 500.
    const v2 = view(goal(), [entry({ amount: 19_500, date: at(9, 3) }), entry({ amount: 500 })]);
    expect(goalCyclePlan(v2, NOV, NOW)).toMatchObject({ target: 500, status: "done" });
  });

  it("history lists each cycle oldest first", () => {
    const v = view(goal(), [entry({ amount: 2_000, date: at(8, 10) }), entry({ amount: 900 })]);
    expect(goalPlanHistory(v, [SEP, OCT, NOV], NOW).map((h) => h.status)).toEqual(["done", "missed", "partial"]);
  });
});

describe("monthly plan summary across goals", () => {
  it("adds planned amounts, caps each goal's progress at its own target, counts statuses", () => {
    const a = goal({ id: "a", monthlyTarget: 2_000 });
    const b = goal({ id: "b", name: "Vehicle", monthlyTarget: 5_000, targetAmount: 200_000 });
    const c = goal({ id: "c", name: "Emergency", monthlyTarget: null });
    const s = monthlyPlanSummary(
      position([a, b, c], [entry({ goalId: "a", amount: 3_000 }), entry({ goalId: "b", amount: 1_000 }), entry({ goalId: "c", amount: 4_000 })]),
      NOV,
      NOW,
    );
    expect(s.planned).toBe(7_000);
    expect(s.onPlan).toBe(3_000); // a capped at 2,000 + b 1,000
    expect(s.remaining).toBe(4_000);
    expect(s.savedThisCycle).toBe(8_000);
    expect(s.monthlyCommitment).toBe(7_000);
    expect(s.counts).toMatchObject({ done: 1, partial: 1, none: 1 });
  });
});

describe("capacity — what can be set aside without touching commitments", () => {
  const due = (total: number): DueBreakdown => ({ total, overdue: 0, card: 0, loan: total, emi: 0, bill: 0, count: 1 });

  it("free money = balance − reserved per account (never below 0), then − due (no forecast spending)", () => {
    const c = savingsCapacity({
      accounts: [
        { id: "bank", currentBalance: 50_000 },
        { id: "cash", currentBalance: 2_000 },
      ],
      reservedByAccount: new Map([
        ["bank", 10_000],
        ["cash", 3_000], // more reserved than held → 0 free, never negative
      ]),
      due: due(15_000),
    });
    expect(c).toEqual({ inAccounts: 52_000, reserved: 13_000, free: 40_000, due: 15_000, safeToSave: 25_000, shortBy: 0 });
  });

  it("reports a shortfall instead of a negative safe amount", () => {
    const c = savingsCapacity({ accounts: [{ id: "bank", currentBalance: 8_000 }], reservedByAccount: new Map(), due: due(10_000) });
    expect(c.safeToSave).toBe(0);
    expect(c.shortBy).toBe(2_000);
  });

  it("never deducts a guess at everyday spending: safe to save is exactly free − due", () => {
    const c = savingsCapacity({ accounts: [{ id: "bank", currentBalance: 34_500 }], reservedByAccount: new Map(), due: due(500) });
    expect(c.safeToSave).toBe(34_000);
    expect(c).not.toHaveProperty("buffer");
  });

  it("typical surplus ignores cycles with no income", () => {
    expect(typicalSurplus([{ income: 40_000, outflow: 25_000 }, { income: 0, outflow: 3_000 }, { income: 50_000, outflow: 35_000 }])).toEqual({ surplus: 15_000, income: 45_000, outflow: 30_000, cycles: 2 });
    expect(typicalSurplus([{ income: 0, outflow: 100 }])).toBeNull();
  });
});

describe("allocation", () => {
  it("suggests plan remainders, deadline needs, soonest deadline first, capped by what's available", () => {
    const a = goal({ id: "a", name: "Bicycle", monthlyTarget: 2_000 });
    const b = goal({ id: "b", name: "Vehicle", monthlyTarget: 5_000, targetAmount: 300_000, dueDate: at(11, 19) }); // due in 30 days
    const c = goal({ id: "c", name: "Trip", monthlyTarget: null, targetAmount: 6_000, dueDate: new Date(2027, 1, 19, 12) }); // ~3 months
    const d = goal({ id: "d", name: "Someday", monthlyTarget: null });
    const pos = position([a, b, c, d], [entry({ goalId: "a", amount: 500 })]);
    const plan = monthlyPlanSummary(pos, NOV, NOW);
    const s = suggestAllocation(pos, plan, 100_000);
    const by = Object.fromEntries(s.map((x) => [x.goalId, x]));
    expect(by.a).toMatchObject({ amount: 1_500, reason: "plan" });
    expect(by.b).toMatchObject({ amount: 5_000, reason: "plan" });
    expect(by.c.reason).toBe("deadline");
    expect(by.c.amount).toBeGreaterThan(1_900);
    expect(by.d).toMatchObject({ amount: 0, reason: "none" });
    expect(s[0].goalId).toBe("b"); // soonest deadline first
    // Not enough money: the soonest goal is served first, the rest gets what's left, nothing beyond `available`.
    const tight = suggestAllocation(pos, plan, 6_000);
    expect(tight.reduce((t, x) => t + x.amount, 0)).toBeLessThanOrEqual(6_000);
    expect(tight.find((x) => x.goalId === "b")!.amount).toBe(5_000);
  });

  it("a skipped goal gets no suggestion", () => {
    const pos = position([goal({ skippedCycles: [cycleKeyOf(NOV)] })]);
    expect(suggestAllocation(pos, monthlyPlanSummary(pos, NOV, NOW), 50_000)[0].amount).toBe(0);
  });

  it("blocks more than the account's free money; warns (never blocks) past the safe amount", () => {
    const rows = [
      { goalId: "a", amount: 2_000, goalRemaining: 20_000, goalName: "Bicycle" },
      { goalId: "b", amount: 5_000, goalRemaining: 100_000, goalName: "Vehicle" },
    ];
    expect(checkAllocation(rows, { mode: "earmark", sourceFree: 6_000, sameAccount: false, safeToSave: 10_000 }).error).toMatch(/Only ₹6,000/);
    const ok = checkAllocation(rows, { mode: "earmark", sourceFree: 50_000, sameAccount: false, safeToSave: 10_000 });
    expect(ok).toEqual({ total: 7_000, error: null, warning: null });
    const warn = checkAllocation(rows, { mode: "earmark", sourceFree: 50_000, sameAccount: false, safeToSave: 4_000 });
    expect(warn.error).toBeNull();
    expect(warn.warning).toMatch(/₹3,000/);
    expect(checkAllocation(rows, { mode: "transfer", sourceFree: null, sameAccount: false, safeToSave: 0 }).error).toMatch(/both accounts/);
    expect(checkAllocation(rows, { mode: "transfer", sourceFree: 9_000, sameAccount: true, safeToSave: 0 }).error).toMatch(/different/);
    expect(checkAllocation([{ ...rows[0], amount: 0 }], { mode: "earmark", sourceFree: 9_000, sameAccount: false, safeToSave: 0 }).error).toMatch(/at least one/);
    expect(checkAllocation([{ ...rows[0], amount: 1.234 }], { mode: "earmark", sourceFree: 9_000, sameAccount: false, safeToSave: 0 }).error).toMatch(/decimal/);
  });
});

describe("deposit-style funds and locks", () => {
  it("counts whole monthly deposits to maturity", () => {
    expect(depositCount(at(10, 19), new Date(2027, 10, 19))).toBe(12);
    expect(depositCount(at(10, 19), new Date(2027, 10, 18))).toBe(11);
    expect(depositCount(at(10, 19), at(10, 25))).toBe(1);
    expect(depositTarget(5_000, at(10, 19), new Date(2027, 4, 19))).toBe(30_000);
  });

  it("a lock is in force until its end date (exclusive), forever without one, and matures after", () => {
    expect(isGoalLockedNow({ locked: true, lockedUntil: at(11, 1) }, NOW)).toBe(true);
    expect(isGoalLockedNow({ locked: true, lockedUntil: at(10, 19) }, NOW)).toBe(false);
    expect(isGoalLockedNow({ locked: true, lockedUntil: null }, NOW)).toBe(true);
    expect(isGoalLockedNow({ locked: false, lockedUntil: at(11, 1) }, NOW)).toBe(false);
    expect(lockState(view(goal({ locked: true, lockedUntil: at(10, 1) })), NOW)).toEqual({ active: false, until: at(10, 1), matured: true });
  });

  it("a withdrawal from a locked goal needs an emergency release", () => {
    expect(validateMoneyEntry(100, { direction: "out", mode: "earmark", heldAtAccount: 500, saved: 500, locked: true })).toBe(LOCKED_WITHDRAWAL_MESSAGE);
    expect(validateMoneyEntry(100, { direction: "out", mode: "earmark", heldAtAccount: 500, saved: 500, locked: true, emergency: true })).toBeNull();
  });

  it("locked money per account covers only goals locked today", () => {
    const locked = goal({ id: "a", locked: true, lockedUntil: null });
    const open = goal({ id: "b" });
    const pos = position([locked, open], [entry({ goalId: "a", amount: 3_000 }), entry({ goalId: "b", amount: 1_000 })]);
    expect(lockedByAccount(pos, NOW)).toEqual(new Map([["bank", 3_000]]));
    expect(pos.reservedByAccount.get("bank")).toBe(4_000);
  });
});
