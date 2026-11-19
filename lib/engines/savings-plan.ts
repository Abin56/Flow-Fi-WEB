/**
 * Savings planning — pure, derived views for the monthly plan, the "how much can I really save" capacity and the
 * monthly allocation. No React, no Firebase, nothing written. Built on `savings-goals.ts` (saved money stays derived
 * from entries) and on figures other engines already own (Month Cycle window, Reports period figures, My Money
 * obligations) that the caller passes in — this module never re-derives income, spending or a due amount.
 *
 * Honesty rules baked in:
 *  - A monthly target or a suggestion is a PLAN. Only an entry (set-aside or real transfer) is saved money.
 *  - Commitments are split into what is still DUE (counts against what you can save) and what is already PAID
 *    (already left your accounts — shown, never subtracted twice).
 *  - Income that has not arrived is never assumed: FlowFi has no income schedule, so only received income is shown.
 *  - A lock is an app-level reservation (FlowFi asks for an emergency release before a withdrawal) — not a bank freeze.
 */

import { isGoalLockedNow, round2, SAVINGS_EPSILON, toDateKey, type GoalView, type SavingsPosition } from "@/lib/engines/savings-goals";

export interface CycleWindow {
  start: Date;
  end: Date;
}

/** The stored key of a Month Cycle — its start date (local calendar day). */
export const cycleKeyOf = (cycle: CycleWindow): string => toDateKey(cycle.start);

const inCycle = (d: Date, c: CycleWindow) => d.getTime() >= c.start.getTime() && d.getTime() <= c.end.getTime();
const compactInr = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

// ---------------------------------------------------------------------------------------------------------
// One goal × one cycle

/**
 * - none     — no monthly plan for this cycle (no target, plan started later, goal finished)
 * - skipped  — the user skipped this cycle on purpose
 * - done     — the cycle's target is met
 * - partial  — some money went in, not the whole target
 * - due      — current cycle, nothing in yet
 * - missed   — a past cycle with nothing in
 */
export type PlanCycleStatus = "none" | "skipped" | "done" | "partial" | "due" | "missed";

export interface GoalCyclePlan {
  goalId: string;
  cycleKey: string;
  /** This cycle's planned amount (0 when none / skipped). Capped at what the goal still needs. */
  target: number;
  /** Money put in during this cycle (active "in" entries dated inside it). */
  contributed: number;
  /** Money taken out during this cycle (active "out" entries). */
  withdrawn: number;
  /** target − contributed, ≥ 0. */
  remaining: number;
  status: PlanCycleStatus;
}

export function goalCyclePlan(view: GoalView, cycle: CycleWindow, now: Date): GoalCyclePlan {
  const key = cycleKeyOf(cycle);
  let contributed = 0;
  let withdrawn = 0;
  for (const e of view.entries) {
    if (!e.active || !inCycle(e.entry.date, cycle)) continue;
    if (e.entry.direction === "in") contributed += e.entry.amount;
    else withdrawn += e.entry.amount;
  }
  contributed = round2(contributed);
  withdrawn = round2(withdrawn);
  const base = { goalId: view.goal.id, cycleKey: key, contributed, withdrawn };

  const monthly = view.goal.monthlyTarget ?? 0;
  const planStart = view.goal.planSince ?? view.goal.createdAt;
  const finished = view.goal.isCompleted || view.goal.isArchived;
  const isPast = cycle.end.getTime() < now.getTime();
  // A plan started mid-cycle still applies to that cycle; cycles that ended before it are not judged.
  if (monthly <= 0 || cycle.end.getTime() < planStart.getTime() || (finished && !isPast)) {
    return { ...base, target: 0, remaining: 0, status: "none" };
  }
  if (view.goal.skippedCycles.includes(key)) return { ...base, target: 0, remaining: 0, status: "skipped" };

  // The current cycle never asks for more than the goal still needs (counting what already went in this cycle).
  const isCurrent = inCycle(now, cycle);
  const cap = isCurrent ? round2(view.remaining + contributed) : monthly;
  const target = round2(Math.max(0, Math.min(monthly, cap)));
  if (target <= SAVINGS_EPSILON) return { ...base, target: 0, remaining: 0, status: contributed > 0 ? "done" : "none" };
  const remaining = round2(Math.max(0, target - contributed));
  const status: PlanCycleStatus = remaining <= SAVINGS_EPSILON ? "done" : contributed > SAVINGS_EPSILON ? "partial" : isPast ? "missed" : "due";
  return { ...base, target, remaining, status };
}

/** The plan's track record over `cycles` (oldest first). */
export function goalPlanHistory(view: GoalView, cycles: readonly CycleWindow[], now: Date): GoalCyclePlan[] {
  return cycles.map((c) => goalCyclePlan(view, c, now));
}

// ---------------------------------------------------------------------------------------------------------
// All goals × the current cycle

export interface MonthlyPlanSummary {
  cycleKey: string;
  /** Σ this cycle's planned amounts. */
  planned: number;
  /** Money in toward planned goals, each capped at its target (so one big deposit can't hide another goal). */
  onPlan: number;
  /** planned − onPlan. */
  remaining: number;
  /** Every "in" entry this cycle across open goals (uncapped). */
  savedThisCycle: number;
  withdrawnThisCycle: number;
  /** Sum of monthly targets of every open goal with a plan (the recurring commitment, before skips / caps). */
  monthlyCommitment: number;
  goals: GoalCyclePlan[];
  counts: Record<PlanCycleStatus, number>;
}

export function monthlyPlanSummary(position: SavingsPosition, cycle: CycleWindow, now: Date): MonthlyPlanSummary {
  const goals = position.open.map((v) => goalCyclePlan(v, cycle, now));
  const counts: Record<PlanCycleStatus, number> = { none: 0, skipped: 0, done: 0, partial: 0, due: 0, missed: 0 };
  let planned = 0;
  let onPlan = 0;
  let saved = 0;
  let withdrawn = 0;
  for (const g of goals) {
    counts[g.status]++;
    planned += g.target;
    onPlan += Math.min(g.target, g.contributed);
    saved += g.contributed;
    withdrawn += g.withdrawn;
  }
  const monthlyCommitment = position.open.reduce((s, v) => s + (v.goal.monthlyTarget ?? 0), 0);
  return {
    cycleKey: cycleKeyOf(cycle),
    planned: round2(planned),
    onPlan: round2(onPlan),
    remaining: round2(Math.max(0, planned - onPlan)),
    savedThisCycle: round2(saved),
    withdrawnThisCycle: round2(withdrawn),
    monthlyCommitment: round2(monthlyCommitment),
    goals,
    counts,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Capacity — how much can realistically be set aside right now

export interface DueBreakdown {
  /** Σ remaining of counted obligations still owed this cycle (My Money "To pay"), incl. overdue carried in. */
  total: number;
  overdue: number;
  card: number;
  loan: number;
  emi: number;
  bill: number;
  count: number;
}

export interface CapacityInput {
  /** Accounts that can hold savings (non-card, live) with their recorded balance. */
  accounts: readonly { id: string; currentBalance: number }[];
  /** Goal money already reserved per account (`SavingsPosition.reservedByAccount`). */
  reservedByAccount: ReadonlyMap<string, number>;
  due: DueBreakdown;
  /** Everyday spending expected for the rest of the cycle (see `estimateSpendingBuffer`) — user-adjustable. */
  spendingBuffer: number;
}

export interface Capacity {
  /** Σ recorded balances of savings-capable accounts. */
  inAccounts: number;
  /** Already set aside for goals (still inside those balances). */
  reserved: number;
  /** Σ per-account free money (balance − reserved, never below 0 per account). */
  free: number;
  due: number;
  buffer: number;
  /** free − due − buffer, never below 0: what can be set aside now without touching commitments. */
  safeToSave: number;
  /** How far free money falls short of what is due + the buffer (0 when it doesn't). */
  shortBy: number;
}

export function savingsCapacity(input: CapacityInput): Capacity {
  let inAccounts = 0;
  let reserved = 0;
  let free = 0;
  for (const a of input.accounts) {
    const r = input.reservedByAccount.get(a.id) ?? 0;
    inAccounts += a.currentBalance;
    reserved += r;
    free += Math.max(0, a.currentBalance - r);
  }
  const due = Math.max(0, input.due.total);
  const buffer = Math.max(0, input.spendingBuffer);
  const after = free - due - buffer;
  return {
    inAccounts: round2(inAccounts),
    reserved: round2(reserved),
    free: round2(free),
    due: round2(due),
    buffer: round2(buffer),
    safeToSave: round2(Math.max(0, after)),
    shortBy: round2(Math.max(0, -after)),
  };
}

/**
 * Everyday spending still expected this cycle: the typical cycle's My Spend (mean of recent complete cycles that had
 * any activity) minus what was already spent this cycle, never below 0. No history → 0 (nothing is invented).
 */
export function estimateSpendingBuffer(pastCycleSpend: readonly number[], spentThisCycle: number): { typical: number | null; buffer: number } {
  const real = pastCycleSpend.filter((v) => v > SAVINGS_EPSILON);
  if (real.length === 0) return { typical: null, buffer: 0 };
  const typical = round2(real.reduce((s, v) => s + v, 0) / real.length);
  return { typical, buffer: round2(Math.max(0, typical - Math.max(0, spentThisCycle))) };
}

/**
 * Typical monthly surplus (income − outflow, Month Cycle meaning) over recent complete cycles that had income.
 * Null when there is no such cycle — a plan is then judged only against this cycle's money.
 */
export function typicalSurplus(pastCycles: readonly { income: number; outflow: number }[]): { surplus: number; income: number; outflow: number; cycles: number } | null {
  const real = pastCycles.filter((c) => c.income > SAVINGS_EPSILON);
  if (real.length === 0) return null;
  const income = real.reduce((s, c) => s + c.income, 0) / real.length;
  const outflow = real.reduce((s, c) => s + c.outflow, 0) / real.length;
  return { surplus: round2(income - outflow), income: round2(income), outflow: round2(outflow), cycles: real.length };
}

// ---------------------------------------------------------------------------------------------------------
// Allocation — distribute money across goals for this cycle

export interface AllocationSuggestion {
  goalId: string;
  amount: number;
  reason: "plan" | "deadline" | "none";
}

/**
 * Suggests this cycle's split of `available` across open goals — a starting point the user edits, never applied
 * automatically. Order: overdue / soonest deadline first, then the rest by plan. Each goal asks for what its plan
 * still needs this cycle (or, with no plan, what its deadline needs per month). Money left over stays unallocated.
 */
export function suggestAllocation(position: Pick<SavingsPosition, "open">, plan: MonthlyPlanSummary, available: number): AllocationSuggestion[] {
  const byId = new Map(plan.goals.map((g) => [g.goalId, g]));
  const asks = position.open
    .filter((v) => v.remaining > SAVINGS_EPSILON)
    .map((v) => {
      const p = byId.get(v.goal.id);
      if (p && p.status !== "none" && p.status !== "skipped") return { v, ask: p.remaining, reason: "plan" as const };
      if (p?.status === "skipped") return { v, ask: 0, reason: "none" as const };
      if (v.requiredPerMonth != null) return { v, ask: Math.min(v.requiredPerMonth, v.remaining), reason: "deadline" as const };
      return { v, ask: 0, reason: "none" as const };
    })
    .sort((a, b) => (a.v.daysLeft ?? Number.POSITIVE_INFINITY) - (b.v.daysLeft ?? Number.POSITIVE_INFINITY));
  let left = Math.max(0, available);
  return asks.map(({ v, ask, reason }) => {
    const amount = round2(Math.max(0, Math.min(ask, left)));
    left = round2(left - amount);
    return { goalId: v.goal.id, amount: Math.floor(amount), reason: amount > 0 ? reason : ask > 0 ? reason : "none" };
  });
}

export interface AllocationCheck {
  total: number;
  /** Blocks the write. */
  error: string | null;
  /** Shown, never blocks — the user decides. */
  warning: string | null;
}

export function checkAllocation(
  rows: readonly { goalId: string; amount: number; goalRemaining: number; goalName: string }[],
  opts: { mode: "earmark" | "transfer"; sourceFree: number | null; sameAccount: boolean; safeToSave: number; dueLabel?: string },
): AllocationCheck {
  const total = round2(rows.reduce((s, r) => s + (Number.isFinite(r.amount) && r.amount > 0 ? r.amount : 0), 0));
  for (const r of rows) {
    if (!Number.isFinite(r.amount) || r.amount < 0) return { total, error: `Enter a valid amount for ${r.goalName}.`, warning: null };
    if (Math.abs(round2(r.amount) - r.amount) > 1e-9) return { total, error: `Use at most 2 decimal places for ${r.goalName}.`, warning: null };
  }
  if (total <= SAVINGS_EPSILON) return { total, error: "Enter an amount for at least one goal.", warning: null };
  if (opts.sourceFree == null) return { total, error: opts.mode === "transfer" ? "Choose both accounts." : "Choose the account the money is in.", warning: null };
  if (opts.mode === "transfer" && opts.sameAccount) return { total, error: "Choose two different accounts.", warning: null };
  if (total > opts.sourceFree + SAVINGS_EPSILON) {
    return { total, error: opts.sourceFree > 0 ? `Only ${compactInr(opts.sourceFree)} of this account is free — lower the amounts or pick another account.` : "This account has no free money.", warning: null };
  }
  const over = rows.find((r) => r.amount > r.goalRemaining + SAVINGS_EPSILON);
  let warning: string | null = over ? `${over.goalName} only needs ${compactInr(over.goalRemaining)} more — the extra will count past its target.` : null;
  if (total > opts.safeToSave + SAVINGS_EPSILON) {
    const dip = round2(total - opts.safeToSave);
    warning = `${compactInr(dip)} of this is money your commitments${opts.dueLabel ? ` ${opts.dueLabel}` : ""} or everyday spending still need. You can still go ahead.`;
  }
  return { total, error: null, warning };
}

// ---------------------------------------------------------------------------------------------------------
// Deposit-style funds + locks

/** Whole monthly deposits from `from` up to `maturity` (at least 1). */
export function depositCount(from: Date, maturity: Date): number {
  const months = (maturity.getFullYear() - from.getFullYear()) * 12 + (maturity.getMonth() - from.getMonth()) - (maturity.getDate() < from.getDate() ? 1 : 0);
  return Math.max(1, months);
}

export function depositTarget(monthly: number, from: Date, maturity: Date): number {
  return round2(monthly * depositCount(from, maturity));
}

export interface LockState {
  /** In force today — a withdrawal needs an emergency release. */
  active: boolean;
  until: Date | null;
  /** Was locked with an end date that has now passed — the money is available again. */
  matured: boolean;
}

export function lockState(view: Pick<GoalView, "goal">, now: Date): LockState {
  const { locked, lockedUntil } = view.goal;
  const active = isGoalLockedNow(view.goal, now);
  return { active, until: locked ? lockedUntil : null, matured: locked && !active && lockedUntil != null };
}

/** Money in goals that is locked today, per account — shown beside "reserved" so the two are never confused. */
export function lockedByAccount(position: SavingsPosition, now: Date): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of position.open) {
    if (!isGoalLockedNow(v.goal, now)) continue;
    for (const [acc, amt] of v.heldByAccount) {
      if (!acc) continue;
      out.set(acc, round2((out.get(acc) ?? 0) + amt));
    }
  }
  return out;
}
