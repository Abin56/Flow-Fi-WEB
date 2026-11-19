/**
 * Savings goals — pure, derived views over `SavingsGoal` + `SavingsContribution` documents plus the live
 * Transaction list. No React, no Firebase I/O. The Savings page and the Dashboard signal both read these
 * functions; nothing else sums goal money.
 *
 * Accounting contract (see `lib/models/savings-contribution.ts`):
 *  - Saved money = `openingAmount` + Σ(active "in" entries) − Σ(active "out" entries), never below 0.
 *  - An entry is ACTIVE when it is not deleted and — for a real transfer — BOTH of its transaction legs are
 *    still live. Deleting/reversing a transfer anywhere simply stops that entry counting; nothing stored drifts.
 *  - An earmark never moves money. A transfer moves money between two of my own accounts, so it is neither
 *    income nor expense and never changes Net Worth (the transfer legs already carry `transferId`).
 *  - `goal.currentAmount` is only a cache for the mobile app; the web never trusts it for display.
 */

import type { Account } from "@/lib/models/account";
import type { SavingsContribution } from "@/lib/models/savings-contribution";
import type { SavingsGoal } from "@/lib/models/savings-goal";

export const SAVINGS_EPSILON = 0.005;
const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.4375;

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Local calendar-date key (YYYY-MM-DD) — never `toISOString`, which shifts the day across time zones. */
export function toDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local-midnight Date for a YYYY-MM-DD key; null for anything that is not a real calendar date. */
export function fromDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

// ---------------------------------------------------------------------------------------------------------
// Entries

export interface EntryView {
  entry: SavingsContribution;
  /** Counts toward the goal. */
  active: boolean;
  /** A transfer whose legs were deleted/reversed elsewhere — kept visible, counts for nothing. */
  reversed: boolean;
  /** +amount for money in, −amount for money out; 0 when not active. */
  effect: number;
}

/** `activeTxIds == null` means the transaction list has not loaded yet — transfers are then trusted. */
export function entryView(entry: SavingsContribution, activeTxIds: ReadonlySet<string> | null): EntryView {
  let reversed = false;
  if (entry.mode === "transfer") {
    reversed = entry.transactionIds.length === 0 || (activeTxIds != null && !entry.transactionIds.every((id) => activeTxIds.has(id)));
  }
  const active = entry.deletedAt == null && !reversed;
  const effect = active ? (entry.direction === "in" ? entry.amount : -entry.amount) : 0;
  return { entry, active, reversed, effect: round2(effect) };
}

/** Key for the opening/unlinked bucket in `heldByAccount` — money that is not tied to an account. */
export const UNLINKED = "";

// ---------------------------------------------------------------------------------------------------------
// One goal

export type GoalStatus = "active" | "completed" | "slipped" | "overdue";
export type PaceStatus = "reached" | "ahead" | "on-track" | "behind" | "no-deadline" | "no-pace";

export interface GoalView {
  goal: SavingsGoal;
  /** Non-deleted entries, newest first (reversed ones included, flagged). */
  entries: EntryView[];
  saved: number;
  target: number;
  remaining: number;
  /** Uncapped saved / target (for "112% of target"). */
  ratio: number;
  /** Capped 0–1 for bars and rings. */
  progress: number;
  reached: boolean;
  status: GoalStatus;
  daysLeft: number | null;
  /** Needed per month to hit the due date, from now. */
  requiredPerMonth: number | null;
  /** Net saved per month over the recent window. */
  pacePerMonth: number;
  projectedDate: Date | null;
  pace: PaceStatus;
  /** Money held per account (`UNLINKED` = opening money tied to no account). Never negative. */
  heldByAccount: Map<string, number>;
  totalIn: number;
  totalOut: number;
  reversedCount: number;
}

export function buildGoalView(
  goal: SavingsGoal,
  contributions: readonly SavingsContribution[],
  activeTxIds: ReadonlySet<string> | null,
  now: Date,
): GoalView {
  const entries = contributions
    .filter((c) => c.goalId === goal.id && c.deletedAt == null)
    .map((c) => entryView(c, activeTxIds))
    .sort((a, b) => b.entry.date.getTime() - a.entry.date.getTime() || b.entry.createdAt.getTime() - a.entry.createdAt.getTime());

  const opening = Math.max(0, goal.openingAmount);
  let net = opening;
  let totalIn = 0;
  let totalOut = 0;
  const raw = new Map<string, number>();
  if (opening > 0) raw.set(UNLINKED, opening);
  for (const v of entries) {
    if (!v.active) continue;
    net += v.effect;
    if (v.effect > 0) totalIn += v.effect;
    else totalOut -= v.effect;
    const key = v.entry.accountId ?? UNLINKED;
    raw.set(key, round2((raw.get(key) ?? 0) + v.effect));
  }
  const saved = round2(Math.max(0, net));
  const heldByAccount = new Map<string, number>();
  for (const [k, v] of raw) if (v > SAVINGS_EPSILON) heldByAccount.set(k, round2(v));

  const target = goal.targetAmount;
  const remaining = round2(Math.max(0, target - saved));
  const ratio = target > 0 ? saved / target : 0;
  const reached = saved >= target - SAVINGS_EPSILON && target > 0;

  const daysLeft = goal.dueDate ? Math.round((startOfDay(goal.dueDate) - startOfDay(now)) / DAY_MS) : null;
  const status: GoalStatus = goal.isCompleted
    ? !goal.closedEarly && !reached
      ? "slipped"
      : "completed"
    : daysLeft != null && daysLeft < 0 && !reached
      ? "overdue"
      : "active";

  // Recent pace: net active money over the last 90 days (or since the goal's first entry, if younger), per month.
  const windowStart = now.getTime() - 90 * DAY_MS;
  const firstEntryAt = entries.reduce((min, v) => Math.min(min, v.entry.date.getTime()), goal.createdAt.getTime());
  const spanDays = Math.min(90, Math.max(MONTH_DAYS, (now.getTime() - Math.max(firstEntryAt, windowStart)) / DAY_MS));
  const recentNet = entries.filter((v) => v.active && v.entry.date.getTime() >= windowStart && v.entry.date.getTime() <= now.getTime() + DAY_MS).reduce((s, v) => s + v.effect, 0);
  const pacePerMonth = round2(Math.max(0, recentNet) / (spanDays / MONTH_DAYS));

  let requiredPerMonth: number | null = null;
  if (daysLeft != null && remaining > SAVINGS_EPSILON && !goal.isCompleted) {
    requiredPerMonth = daysLeft <= 0 ? remaining : round2(remaining / Math.max(daysLeft / MONTH_DAYS, 1));
  }
  const projectedDate = remaining > SAVINGS_EPSILON && pacePerMonth > SAVINGS_EPSILON ? new Date(now.getTime() + (remaining / pacePerMonth) * MONTH_DAYS * DAY_MS) : null;

  let pace: PaceStatus;
  if (reached || goal.isCompleted) pace = "reached";
  else if (requiredPerMonth == null) pace = pacePerMonth > SAVINGS_EPSILON ? "no-deadline" : "no-pace";
  else if (pacePerMonth >= requiredPerMonth * 1.25) pace = "ahead";
  else if (pacePerMonth >= requiredPerMonth) pace = "on-track";
  else pace = "behind";

  return {
    goal,
    entries,
    saved,
    target,
    remaining,
    ratio,
    progress: Math.min(1, Math.max(0, ratio)),
    reached,
    status,
    daysLeft,
    requiredPerMonth,
    pacePerMonth,
    projectedDate,
    pace,
    heldByAccount,
    totalIn: round2(totalIn),
    totalOut: round2(totalOut),
    reversedCount: entries.filter((v) => v.reversed).length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// All goals

export interface SavingsInsight {
  id: string;
  tone: "good" | "warn" | "bad" | "info";
  text: string;
}

export interface SavingsPosition {
  views: GoalView[];
  /** Goals not archived, not completed. */
  open: GoalView[];
  completed: GoalView[];
  archived: GoalView[];
  totals: { saved: number; target: number; remaining: number; openCount: number; completedCount: number; overdueCount: number; progress: number };
  /** Goal money sitting in each account (reserved — still part of that account's balance). */
  reservedByAccount: Map<string, number>;
  insights: SavingsInsight[];
}

const compactInr = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function buildSavingsPosition(
  goals: readonly SavingsGoal[],
  contributions: readonly SavingsContribution[],
  activeTxIds: ReadonlySet<string> | null,
  now: Date,
): SavingsPosition {
  const live = goals.filter((g) => g.deletedAt == null);
  const views = live.map((g) => buildGoalView(g, contributions, activeTxIds, now));
  const archived = views.filter((v) => v.goal.isArchived);
  const unarchived = views.filter((v) => !v.goal.isArchived);
  const completed = unarchived.filter((v) => v.status === "completed");
  const open = unarchived.filter((v) => v.status !== "completed");

  // Totals cover the goals still on the page (not archived). Saved money of a slipped/overdue goal still counts.
  const saved = round2(unarchived.reduce((s, v) => s + v.saved, 0));
  const target = round2(unarchived.reduce((s, v) => s + v.target, 0));
  const remaining = round2(open.reduce((s, v) => s + v.remaining, 0));

  const reservedByAccount = new Map<string, number>();
  for (const v of unarchived.concat(archived.filter((a) => !a.goal.isCompleted))) {
    for (const [acc, amt] of v.heldByAccount) {
      if (acc === UNLINKED) continue;
      reservedByAccount.set(acc, round2((reservedByAccount.get(acc) ?? 0) + amt));
    }
  }

  const insights: SavingsInsight[] = [];
  const overdue = open.filter((v) => v.status === "overdue");
  if (overdue.length > 0) insights.push({ id: "overdue", tone: "bad", text: overdue.length === 1 ? `${overdue[0].goal.name} is past its due date with ${compactInr(overdue[0].remaining)} to go.` : `${overdue.length} goals are past their due date.` });
  const behind = open.filter((v) => v.pace === "behind" && v.status !== "overdue" && v.requiredPerMonth != null);
  if (behind.length > 0) {
    const worst = behind.slice().sort((a, b) => (b.requiredPerMonth ?? 0) - (a.requiredPerMonth ?? 0))[0];
    insights.push({ id: "behind", tone: "warn", text: `${worst.goal.name} needs ${compactInr(worst.requiredPerMonth ?? 0)}/month to hit its date — you're saving ${compactInr(worst.pacePerMonth)}/month.` });
  }
  const slipped = unarchived.filter((v) => v.status === "slipped");
  if (slipped.length > 0) insights.push({ id: "slipped", tone: "warn", text: `${slipped[0].goal.name} was completed but has since dropped below its target — reopen it to keep saving.` });
  const reversed = views.reduce((s, v) => s + v.reversedCount, 0);
  if (reversed > 0) insights.push({ id: "reversed", tone: "info", text: `${reversed} transfer${reversed === 1 ? " was" : "s were"} reversed in Transactions and no longer count toward goals.` });
  const closest = open.filter((v) => v.saved > 0 && v.remaining > 0).sort((a, b) => b.progress - a.progress)[0];
  if (closest && closest.progress >= 0.5 && closest.status !== "overdue") insights.push({ id: "closest", tone: "good", text: `${closest.goal.name} is ${Math.round(closest.progress * 100)}% there — ${compactInr(closest.remaining)} to go.` });
  const ahead = open.filter((v) => v.pace === "ahead");
  if (ahead.length > 0 && insights.length < 3) insights.push({ id: "ahead", tone: "good", text: `${ahead[0].goal.name} is ahead of schedule.` });

  return {
    views,
    open,
    completed,
    archived,
    totals: {
      saved,
      target,
      remaining,
      openCount: open.length,
      completedCount: completed.length,
      overdueCount: overdue.length,
      progress: target > 0 ? Math.min(1, saved / target) : 0,
    },
    reservedByAccount,
    insights: insights.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Validation (shared by the dialogs and the repository so the same rule guards the UI and the write)

/** Accounts that can hold or fund goal money — a credit card is a liability, never savings. */
export function isSavingsAccount(account: Pick<Account, "type" | "deletedAt">): boolean {
  return account.deletedAt == null && account.type !== "card";
}

/** Money in an account not already set aside for goals. */
export function freeInAccount(account: Pick<Account, "currentBalance">, reserved: number): number {
  return round2(Math.max(0, account.currentBalance - reserved));
}

export function validateGoalInput(input: { name: string; target: number; dueDate: Date | null }, now: Date, isNew: boolean): string | null {
  if (!input.name.trim()) return "Give the goal a name.";
  if (input.name.trim().length > 60) return "Keep the name under 60 characters.";
  if (!(input.target > 0) || !Number.isFinite(input.target)) return "Enter a target greater than 0.";
  if (Math.abs(round2(input.target) - input.target) > 1e-9) return "Use at most 2 decimal places.";
  if (input.target > 1_000_000_000) return "That target is too large.";
  if (isNew && input.dueDate != null && startOfDay(input.dueDate) < startOfDay(now)) return "The due date can't be in the past.";
  return null;
}

export type MoneyEntryPlan =
  | { direction: "in"; mode: "earmark"; accountFree: number }
  | { direction: "in"; mode: "transfer"; sourceFree: number; sameAccount: boolean }
  | { direction: "out"; mode: "earmark" | "transfer"; heldAtAccount: number; saved: number };

/** `null` = fine to record. Every message says what to change. */
export function validateMoneyEntry(amount: number, plan: MoneyEntryPlan): string | null {
  if (!(amount > 0) || !Number.isFinite(amount)) return "Enter an amount greater than 0.";
  if (Math.abs(round2(amount) - amount) > 1e-9) return "Use at most 2 decimal places.";
  if (plan.direction === "in" && plan.mode === "earmark" && amount > plan.accountFree + SAVINGS_EPSILON) {
    return plan.accountFree > 0 ? `Only ${compactInr(plan.accountFree)} of this account is free — the rest is already set aside for goals.` : "This account has no free money to set aside.";
  }
  if (plan.direction === "in" && plan.mode === "transfer") {
    if (plan.sameAccount) return "Choose two different accounts.";
    if (amount > plan.sourceFree + SAVINGS_EPSILON) return plan.sourceFree > 0 ? `Only ${compactInr(plan.sourceFree)} is free to move from this account.` : "This account has no free money to move.";
  }
  if (plan.direction === "out") {
    if (amount > plan.saved + SAVINGS_EPSILON) return `This goal only has ${compactInr(plan.saved)}.`;
    if (amount > plan.heldAtAccount + SAVINGS_EPSILON) return `Only ${compactInr(plan.heldAtAccount)} of this goal is held there.`;
  }
  return null;
}

/**
 * Whether an entry can be removed without leaving the goal (or one account's share of it) negative — e.g. a
 * deposit that a later withdrawal already took from. `null` = removable.
 */
export function removeEntryBlocker(view: GoalView, entryId: string): string | null {
  const target = view.entries.find((v) => v.entry.id === entryId);
  if (!target) return "This entry no longer exists.";
  if (!target.active || target.entry.direction === "out") return null;
  const key = target.entry.accountId ?? UNLINKED;
  const held = view.heldByAccount.get(key) ?? 0;
  if (held - target.entry.amount < -SAVINGS_EPSILON || view.saved - target.entry.amount < -SAVINGS_EPSILON) {
    return "A later withdrawal already used this money — remove that withdrawal first.";
  }
  return null;
}
