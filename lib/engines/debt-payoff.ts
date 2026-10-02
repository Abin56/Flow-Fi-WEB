/**
 * Debt Planner payoff engine — a deterministic, in-memory month-by-month simulation over the current
 * `DebtPosition[]` snapshot (`debt-position.ts`). Pure: it never writes, creates a Transaction, settles an
 * installment or changes a balance. Changing the budget, strategy or extra amount only re-runs this.
 *
 * Rules:
 *  - Every month, each debt's REQUIRED payments are paid first — its scheduled installments / statement
 *    minimums due in that period (plus anything already overdue in the first period), and for a card with
 *    a minimum-due % a projected minimum on the balance nothing else covers. No strategy ever skips them.
 *  - If the budget is below what is required, the plan stops there and reports the shortfall — it never
 *    produces an impossible schedule.
 *  - What is left (budget − required, plus a one-off extra in the first period) goes to debts in the
 *    strategy's order, using each source's real extra-payment rule (`ExtraPaymentMode`):
 *      reamortize  → principal prepayment, tail re-planned by `reduceTenurePolicy` + `calculate`, exactly
 *                    as `LoanAdvancePaymentRepository` does (EMI held, tenure shortened);
 *      advanceOnly → pays upcoming installments early, interest portions unchanged (EMI / one-time Loan);
 *      flexible    → reduces the balance (card, person).
 *  - Interest is only what the schedules say (installment interest portions). Card revolving interest is
 *    unknown, so a plan containing a card reports its interest as incomplete instead of estimating it.
 */

import { calculate } from "@/lib/engines/interest-calculator";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { reduceTenurePolicy } from "@/lib/engines/prepayment-reamortization-policy";
import { nextDueDate } from "@/lib/models/payment-schedule";
import { annualRateForOrdering, type DebtPosition, type ScheduledDebtPayment } from "@/lib/engines/debt-position";

// ─────────────────────────── planning periods ───────────────────────────

export interface PlanningPeriod {
  index: number;
  start: Date;
  end: Date;
  /** "Oct 2026" — the month the period ends in. */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodLabel(end: Date): string {
  return `${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
}

/**
 * The Month Cycle period `offset` cycles from the one containing `now` — resolved by the canonical
 * `cycleRangeFor` (`month-cycle-range.ts`), so it is exactly the window Month Cycle and People show.
 * (`CycleAnchor` is not used here: its Dart month-arithmetic quirk misplaces cycles near January.)
 */
export function planningPeriod(startDay: number, now: Date, offset: number): PlanningPeriod {
  const current = cycleRangeFor(startDay, now);
  // Cycle k starts on the (clamped) start day k months after the current cycle's start month.
  const y = current.start.getFullYear();
  const m = current.start.getMonth() + offset;
  const day = startDay <= 1 ? 1 : Math.min(startDay, new Date(y, m + 1, 0).getDate());
  const { start, end } = offset === 0 ? current : cycleRangeFor(startDay, new Date(y, m, day, 12));
  return { index: offset, start, end, label: periodLabel(end) };
}

// ─────────────────────────── inputs / outputs ───────────────────────────

export type PayoffStrategy = "avalanche" | "snowball" | "duePriority" | "custom";

export interface PayoffInput {
  positions: readonly DebtPosition[];
  /** The most the user plans to put toward debt each period — required payments included. */
  monthlyBudget: number;
  strategy: PayoffStrategy;
  /** Debt ids, highest priority first (custom strategy). */
  customOrder?: readonly string[];
  /** A one-off extra amount applied in the first period, on top of the monthly budget. */
  lumpSum?: { amount: number; targetId: string | null };
  monthCycleStartDay: number;
  now: Date;
  /** Safety horizon; 600 periods = 50 years. */
  maxPeriods?: number;
}

export interface PlanLine {
  debtId: string;
  kind: "required" | "extra" | "lumpSum";
  label: string;
  amount: number;
  principal: number;
  interest: number;
  overdue: boolean;
}

export interface PlanMonth {
  period: PlanningPeriod;
  budget: number;
  required: number;
  extra: number;
  lumpSum: number;
  /** Budget left over because every remaining debt was already fully paid. */
  unallocated: number;
  lines: PlanLine[];
  /** Balance per debt at the end of the period. */
  balances: Record<string, number>;
  remainingDebt: number;
  completed: string[];
}

export interface DebtOutcome {
  debtId: string;
  finishIndex: number | null;
  finishLabel: string | null;
  /** Interest paid in the plan, from schedule interest portions only. */
  interestPaid: number;
  /** False for a card: its revolving interest is not modeled. */
  interestKnown: boolean;
  totalPaid: number;
  /** A prepayment could not be re-planned by the Loan policy, so its tail was shortened approximately. */
  approximate: boolean;
}

export type PlanStatus = "noDebt" | "debtFree" | "shortfall" | "stalled" | "horizon";

export interface PayoffPlan {
  status: PlanStatus;
  months: PlanMonth[];
  shortfall: { period: PlanningPeriod; required: number; budget: number; amount: number } | null;
  debtFree: PlanningPeriod | null;
  outcomes: Record<string, DebtOutcome>;
  projectedInterest: { known: number; complete: boolean; unknownFor: string[] };
  totalPaid: number;
  /** Debts in the total but not simulated (e.g. closed with principal left). */
  notProjected: { debtId: string; reason: string }[];
  /** Debts the plan can never reduce (no schedule and no extra budget reaches them). */
  stalled: string[];
}

// ─────────────────────────── simulation state ───────────────────────────

interface SimItem {
  key: string;
  kind: ScheduledDebtPayment["kind"];
  dueDate: Date;
  amount: number;
  principal: number;
  interest: number;
  label: string;
}

interface SimDebt {
  pos: DebtPosition;
  balance: number;
  items: SimItem[];
  interestPaid: number;
  totalPaid: number;
  finishIndex: number | null;
  approximate: boolean;
}

const EPS = 0.005;
const DONE = 0.5;
const round2 = (v: number) => Math.round(v * 100) / 100;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function toSim(pos: DebtPosition): SimDebt {
  return {
    pos,
    balance: pos.outstanding,
    items: pos.schedule.map((s) => ({ ...s })),
    interestPaid: 0,
    totalPaid: 0,
    finishIndex: null,
    approximate: false,
  };
}

function isFinished(d: SimDebt): boolean {
  return d.balance <= DONE && d.items.length === 0;
}

/** Principal of the debt that no scheduled item already covers. */
function unscheduledBalance(d: SimDebt): number {
  return Math.max(round2(d.balance - d.items.reduce((s, i) => s + i.principal, 0)), 0);
}

// ─────────────────────────── required payments ───────────────────────────

interface RequiredPart {
  item: SimItem | null;
  amount: number;
  label: string;
  overdue: boolean;
}

function requiredParts(d: SimDebt, period: PlanningPeriod, today: number): RequiredPart[] {
  const end = dayIndex(period.end);
  const parts: RequiredPart[] = d.items
    .filter((i) => dayIndex(i.dueDate) <= end)
    .map((i) => ({ item: i, amount: i.amount, label: i.label, overdue: dayIndex(i.dueDate) < today }));

  // A card's projected minimum on the balance no statement/installment covers — only from the second
  // period on (the current cycle's spend is not billed yet) and only when the card tracks a minimum %.
  const pct = d.pos.minimumDuePercent;
  if (pct != null && pct > 0 && period.index > 0 && !parts.some((p) => p.item?.kind === "statement")) {
    const unscheduled = unscheduledBalance(d);
    if (unscheduled > EPS) {
      const projected = round2(unscheduled * (pct / 100));
      const amount = projected < 1 ? unscheduled : Math.min(projected, unscheduled);
      parts.push({ item: null, amount: round2(amount), label: `Projected minimum (${pct}%)`, overdue: false });
    }
  }
  return parts;
}

function payRequired(d: SimDebt, part: RequiredPart): { principal: number; interest: number } {
  if (part.item) {
    const it = part.item;
    const principal = Math.min(it.principal, d.balance);
    d.balance = round2(Math.max(d.balance - it.principal, 0));
    d.interestPaid = round2(d.interestPaid + it.interest);
    d.totalPaid = round2(d.totalPaid + it.amount);
    d.items = d.items.filter((x) => x !== it);
    return { principal: round2(principal), interest: it.interest };
  }
  d.balance = round2(Math.max(d.balance - part.amount, 0));
  d.totalPaid = round2(d.totalPaid + part.amount);
  return { principal: part.amount, interest: 0 };
}

// ─────────────────────────── extra payments ───────────────────────────

/**
 * `reduceTenurePolicy.solve`, answered by binary search instead of its linear scan from 1 — same result
 * (the first installment only falls as the tenure grows, so "the smallest count whose first installment
 * is ≤ the target" is the same count either way; `debt-payoff.test.ts` holds the two to parity). The
 * linear scan costs O(count²) per re-plan, too slow to re-run a 30-year loan every simulated month.
 */
export function solveReduceTenure(params: Parameters<typeof reduceTenurePolicy.solve>[0]): ReturnType<typeof reduceTenurePolicy.solve> {
  const { outstandingPrincipalAfter, interest, targetInstallmentAmount, frequency } = params;
  if (outstandingPrincipalAfter <= 0 || targetInstallmentAmount <= 0 || (interest != null && interest.ratePercent < 0)) {
    return reduceTenurePolicy.solve(params);
  }
  const perYear = frequency === "weekly" ? 52 : 12;
  const first = (count: number): number =>
    interest == null || interest.ratePercent === 0
      ? round2(outstandingPrincipalAfter / count)
      : calculate({ principal: outstandingPrincipalAfter, type: interest.type, ratePercent: interest.ratePercent, period: interest.period, installmentCount: count, installmentFrequency: "monthly", installmentsPerYear: perYear }).periods[0].paymentAmount;
  try {
    const MAX = 1200;
    if (first(MAX) > targetInstallmentAmount) return reduceTenurePolicy.solve(params);
    let lo = 1;
    let hi = MAX;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (first(mid) <= targetInstallmentAmount) hi = mid;
      else lo = mid + 1;
    }
    return { kind: "solved", remainingInstallmentCount: lo, installmentAmount: first(lo) };
  } catch {
    return reduceTenurePolicy.solve(params);
  }
}

/** How much extra this debt can absorb right now under its source's payment rule. */
function extraCapacity(d: SimDebt): number {
  if (isFinished(d)) return 0;
  switch (d.pos.extraMode) {
    case "flexible": {
      // A card bill can't prepay a card EMI's future installments — only the rest of the balance.
      const installmentPrincipal = d.items.filter((i) => i.kind === "installment").reduce((s, i) => s + i.principal, 0);
      return Math.max(round2(d.balance - installmentPrincipal), 0);
    }
    case "advanceOnly":
      return round2(d.items.reduce((s, i) => s + i.amount, 0) + unscheduledBalance(d));
    case "reamortize":
      return d.balance;
  }
}

function payFlexible(d: SimDebt, amount: number): { principal: number; interest: number } {
  const use = Math.min(amount, extraCapacity(d));
  let left = use;
  for (const it of d.items.filter((i) => i.kind === "statement")) {
    if (left <= EPS) break;
    const take = Math.min(it.amount, left);
    it.amount = round2(it.amount - take);
    it.principal = round2(Math.max(it.principal - take, 0));
    left -= take;
  }
  d.items = d.items.filter((i) => i.amount > EPS);
  d.balance = round2(Math.max(d.balance - use, 0));
  d.totalPaid = round2(d.totalPaid + use);
  return { principal: round2(use), interest: 0 };
}

function payAdvance(d: SimDebt, amount: number): { principal: number; interest: number } {
  let left = amount;
  let principal = 0;
  let interest = 0;
  for (const it of d.items) {
    if (left <= EPS) break;
    const take = Math.min(it.amount, left);
    const share = it.amount > 0 ? take / it.amount : 1;
    const p = round2(it.principal * share);
    const i = round2(it.interest * share);
    it.amount = round2(it.amount - take);
    it.principal = round2(it.principal - p);
    it.interest = round2(it.interest - i);
    principal += p;
    interest += i;
    left -= take;
  }
  d.items = d.items.filter((i) => i.amount > EPS);
  d.balance = round2(Math.max(d.balance - principal, 0));
  // Principal the schedule doesn't cover (see `unscheduledBalance`) can still be paid directly.
  if (left > EPS && d.items.length === 0 && d.balance > EPS) {
    const direct = Math.min(left, d.balance);
    d.balance = round2(d.balance - direct);
    principal += direct;
    left -= direct;
  }
  const used = round2(amount - Math.max(left, 0));
  d.interestPaid = round2(d.interestPaid + interest);
  d.totalPaid = round2(d.totalPaid + used);
  return { principal: round2(principal), interest: round2(interest) };
}

/**
 * Principal prepayment on an installment Loan: reduce principal, then re-plan the untouched tail with the
 * Loan's own policy (`reduceTenurePolicy`: hold the installment, shorten the tenure) and amortization
 * (`calculate`). If the policy can't solve it, the tail is shortened from the end instead (flagged).
 */
function payReamortize(d: SimDebt, amount: number): { principal: number; interest: number } {
  const use = Math.min(amount, d.balance);
  d.balance = round2(d.balance - use);
  d.totalPaid = round2(d.totalPaid + use);
  const future = d.items;
  if (d.balance <= DONE) {
    d.balance = 0;
    d.items = [];
    return { principal: round2(use), interest: 0 };
  }
  if (future.length === 0) return { principal: round2(use), interest: 0 };

  const interest = d.pos.interest.kind === "schedule" ? d.pos.interest : null;
  const frequency = d.pos.frequency === "weekly" ? "weekly" : "monthly";
  const target = Math.max(future[0].amount, future[1]?.amount ?? 0);
  const outcome = solveReduceTenure({
    outstandingPrincipalAfter: d.balance,
    interest: interest ? { type: interest.type, ratePercent: interest.ratePercent, period: interest.period } : null,
    targetInstallmentAmount: target,
    frequency,
  });

  if (outcome.kind === "solved") {
    const breakdown = calculate({
      principal: d.balance,
      type: interest?.type ?? "flat",
      ratePercent: interest?.ratePercent ?? 0,
      period: interest?.period ?? "yearly",
      installmentCount: outcome.remainingInstallmentCount,
      installmentFrequency: "monthly",
      installmentsPerYear: frequency === "weekly" ? 52 : 12,
    });
    let due = future[0].dueDate;
    d.items = breakdown.periods.map((p, idx) => {
      if (idx > 0) due = nextDueDate(frequency, due);
      return {
        key: `${d.pos.id}:replan:${idx}`,
        kind: "installment" as const,
        dueDate: due,
        amount: p.paymentAmount,
        principal: p.principalPortion,
        interest: p.interestPortion,
        label: `Installment (re-planned) ${idx + 1} of ${breakdown.periods.length}`,
      };
    });
    return { principal: round2(use), interest: 0 };
  }

  // Unsolvable: take the prepaid principal off the last installments (tenure shortens, EMI unchanged).
  d.approximate = true;
  let left = use;
  for (let i = d.items.length - 1; i >= 0 && left > EPS; i--) {
    const it = d.items[i];
    const cut = Math.min(it.principal, left);
    const share = it.principal > 0 ? cut / it.principal : 1;
    it.interest = round2(it.interest * (1 - share));
    it.principal = round2(it.principal - cut);
    it.amount = round2(it.principal + it.interest);
    left -= cut;
  }
  d.items = d.items.filter((i) => i.amount > EPS);
  return { principal: round2(use), interest: 0 };
}

function payExtra(d: SimDebt, amount: number): { used: number; principal: number; interest: number } {
  const cap = extraCapacity(d);
  const take = round2(Math.min(amount, cap));
  if (take <= EPS) return { used: 0, principal: 0, interest: 0 };
  const r = d.pos.extraMode === "flexible" ? payFlexible(d, take) : d.pos.extraMode === "advanceOnly" ? payAdvance(d, take) : payReamortize(d, take);
  return { used: take, ...r };
}

// ─────────────────────────── strategy ordering ───────────────────────────

/** Rate tiers for "highest interest first": known positive rates, then unknown, then 0%. */
function avalancheKey(d: SimDebt): [number, number] {
  const rate = annualRateForOrdering(d.pos.interest);
  if (rate == null) return [1, 0];
  if (rate > 0) return [0, -rate];
  return [2, 0];
}

function nextDueTime(d: SimDebt): number {
  return d.items[0] ? dayIndex(d.items[0].dueDate) : Number.POSITIVE_INFINITY;
}

function strategyOrder(debts: readonly SimDebt[], strategy: PayoffStrategy, customOrder: readonly string[] = []): SimDebt[] {
  const byAvalanche = (a: SimDebt, b: SimDebt) => {
    const ka = avalancheKey(a);
    const kb = avalancheKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.balance - b.balance;
  };
  const list = [...debts];
  switch (strategy) {
    case "avalanche":
      return list.sort(byAvalanche);
    case "snowball":
      return list.sort((a, b) => a.balance - b.balance || byAvalanche(a, b));
    case "duePriority":
      return list.sort((a, b) => nextDueTime(a) - nextDueTime(b) || a.balance - b.balance);
    case "custom": {
      const rank = new Map(customOrder.map((id, i) => [id, i]));
      return list.sort((a, b) => (rank.get(a.pos.id) ?? 1e9) - (rank.get(b.pos.id) ?? 1e9) || byAvalanche(a, b));
    }
  }
}

// ─────────────────────────── the plan ───────────────────────────

/** Required payment per debt in the current period — what "Required this cycle" shows. */
export function requiredThisPeriod(positions: readonly DebtPosition[], monthCycleStartDay: number, now: Date): {
  period: PlanningPeriod;
  total: number;
  overdue: number;
  byDebt: Record<string, number>;
} {
  const period = planningPeriod(monthCycleStartDay, now, 0);
  const today = dayIndex(now);
  const byDebt: Record<string, number> = {};
  let total = 0;
  let overdue = 0;
  for (const pos of positions) {
    if (pos.excludedFromPlan) continue;
    const parts = requiredParts(toSim(pos), period, today);
    const sum = round2(parts.reduce((s, p) => s + p.amount, 0));
    if (sum > 0) byDebt[pos.id] = sum;
    total += sum;
    overdue += parts.filter((p) => p.overdue).reduce((s, p) => s + p.amount, 0);
  }
  return { period, total: round2(total), overdue: round2(overdue), byDebt };
}

export function simulatePayoff(input: PayoffInput): PayoffPlan {
  const { positions, strategy, customOrder = [], monthCycleStartDay, now } = input;
  const budget = Math.max(round2(input.monthlyBudget), 0);
  const maxPeriods = input.maxPeriods ?? 600;
  const today = dayIndex(now);

  const notProjected = positions.filter((p) => p.excludedFromPlan).map((p) => ({ debtId: p.id, reason: p.excludedFromPlan! }));
  const debts = positions.filter((p) => !p.excludedFromPlan).map(toSim);
  const months: PlanMonth[] = [];
  let shortfall: PayoffPlan["shortfall"] = null;
  let status: PlanStatus = debts.length === 0 ? "noDebt" : "horizon";
  let debtFree: PlanningPeriod | null = null;
  let stalled: string[] = [];

  for (let index = 0; index < maxPeriods && debts.length > 0; index++) {
    const period = planningPeriod(monthCycleStartDay, now, index);
    const active = debts.filter((d) => !isFinished(d));
    const lines: PlanLine[] = [];

    // 1. Required payments.
    const plannedRequired = active.map((d) => ({ d, parts: requiredParts(d, period, today) }));
    const required = round2(plannedRequired.reduce((s, r) => s + r.parts.reduce((x, p) => x + p.amount, 0), 0));
    if (required > budget + 0.01) {
      shortfall = { period, required, budget, amount: round2(required - budget) };
      for (const { d, parts } of plannedRequired) {
        for (const p of parts) lines.push({ debtId: d.pos.id, kind: "required", label: p.label, amount: p.amount, principal: 0, interest: 0, overdue: p.overdue });
      }
      months.push({ period, budget, required, extra: 0, lumpSum: 0, unallocated: 0, lines, balances: balancesOf(debts), remainingDebt: remainingOf(debts), completed: [] });
      status = "shortfall";
      break;
    }
    let paidThisPeriod = 0;
    for (const { d, parts } of plannedRequired) {
      for (const p of parts) {
        const r = payRequired(d, p);
        paidThisPeriod += p.amount;
        lines.push({ debtId: d.pos.id, kind: "required", label: p.label, amount: p.amount, principal: r.principal, interest: r.interest, overdue: p.overdue });
      }
    }

    // 2. One-off extra (first period), then the rest of the budget, in strategy order.
    let lumpUsed = 0;
    if (index === 0 && input.lumpSum && input.lumpSum.amount > 0) {
      let left = round2(input.lumpSum.amount);
      const target = input.lumpSum.targetId ? debts.find((d) => d.pos.id === input.lumpSum!.targetId) : undefined;
      const ordered = [...(target ? [target] : []), ...strategyOrder(debts.filter((d) => d !== target && !isFinished(d)), strategy, customOrder)];
      for (const d of ordered) {
        if (left <= EPS) break;
        const r = payExtra(d, left);
        if (r.used <= 0) continue;
        left = round2(left - r.used);
        lumpUsed += r.used;
        lines.push({ debtId: d.pos.id, kind: "lumpSum", label: "Extra payment", amount: r.used, principal: r.principal, interest: r.interest, overdue: false });
      }
    }
    let extraLeft = round2(budget - required);
    let extraUsed = 0;
    if (extraLeft > EPS) {
      for (const d of strategyOrder(debts.filter((x) => !isFinished(x)), strategy, customOrder)) {
        if (extraLeft <= EPS) break;
        const r = payExtra(d, extraLeft);
        if (r.used <= 0) continue;
        extraLeft = round2(extraLeft - r.used);
        extraUsed += r.used;
        lines.push({ debtId: d.pos.id, kind: "extra", label: "Extra toward balance", amount: r.used, principal: r.principal, interest: r.interest, overdue: false });
      }
    }
    paidThisPeriod += lumpUsed + extraUsed;

    // 3. Close out the period.
    const completed: string[] = [];
    for (const d of debts) {
      if (d.finishIndex == null && isFinished(d)) {
        d.balance = 0;
        d.finishIndex = index;
        completed.push(d.pos.id);
      }
    }
    months.push({
      period,
      budget,
      required,
      extra: round2(extraUsed),
      lumpSum: round2(lumpUsed),
      unallocated: round2(Math.max(budget - required - extraUsed, 0)),
      lines,
      balances: balancesOf(debts),
      remainingDebt: remainingOf(debts),
      completed,
    });

    if (debts.every(isFinished)) {
      status = "debtFree";
      debtFree = period;
      break;
    }
    // Nothing could be paid and nothing is scheduled any more: the remaining debts can never shrink.
    if (paidThisPeriod <= EPS && debts.filter((d) => !isFinished(d)).every((d) => d.items.length === 0)) {
      status = "stalled";
      stalled = debts.filter((d) => !isFinished(d)).map((d) => d.pos.id);
      break;
    }
  }

  const outcomes: Record<string, DebtOutcome> = {};
  let known = 0;
  let totalPaid = 0;
  const unknownFor: string[] = [];
  for (const d of debts) {
    const interestKnown = d.pos.interest.kind !== "unknown";
    if (!interestKnown) unknownFor.push(d.pos.id);
    known += d.interestPaid;
    totalPaid += d.totalPaid;
    outcomes[d.pos.id] = {
      debtId: d.pos.id,
      finishIndex: d.finishIndex,
      finishLabel: d.finishIndex != null ? planningPeriod(monthCycleStartDay, now, d.finishIndex).label : null,
      interestPaid: d.interestPaid,
      interestKnown,
      totalPaid: d.totalPaid,
      approximate: d.approximate,
    };
  }

  return {
    status,
    months,
    shortfall,
    debtFree,
    outcomes,
    projectedInterest: { known: round2(known), complete: unknownFor.length === 0, unknownFor },
    totalPaid: round2(totalPaid),
    notProjected,
    stalled,
  };
}

function balancesOf(debts: readonly SimDebt[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of debts) out[d.pos.id] = round2(d.balance);
  return out;
}

function remainingOf(debts: readonly SimDebt[]): number {
  return round2(debts.reduce((s, d) => s + d.balance, 0));
}

// ─────────────────────────── comparisons ───────────────────────────

export interface ExtraPaymentImpact {
  base: PayoffPlan;
  withExtra: PayoffPlan;
  /** Positive = debt-free that many periods sooner. Null when either plan has no debt-free date. */
  periodsEarlier: number | null;
  /** Schedule interest avoided on debts with known terms. */
  knownInterestSaved: number;
  /** True when some affected debt has interest FlowFi can't model (cards). */
  interestIncomplete: boolean;
  /** Where the extra went in the first period. */
  allocation: PlanLine[];
}

export function extraPaymentImpact(input: PayoffInput, extraAmount: number, targetId: string | null): ExtraPaymentImpact {
  const base = simulatePayoff({ ...input, lumpSum: undefined });
  const withExtra = simulatePayoff({ ...input, lumpSum: { amount: extraAmount, targetId } });
  const periodsEarlier =
    base.debtFree && withExtra.debtFree ? base.debtFree.index - withExtra.debtFree.index : null;
  return {
    base,
    withExtra,
    periodsEarlier,
    knownInterestSaved: round2(base.projectedInterest.known - withExtra.projectedInterest.known),
    interestIncomplete: !base.projectedInterest.complete,
    allocation: withExtra.months[0]?.lines.filter((l) => l.kind === "lumpSum") ?? [],
  };
}

export interface BudgetScenario {
  budget: number;
  status: PlanStatus;
  debtFree: PlanningPeriod | null;
  shortfall: number;
  knownInterest: number;
}

export function budgetScenarios(input: PayoffInput, budgets: readonly number[]): BudgetScenario[] {
  return budgets.map((budget) => {
    const plan = simulatePayoff({ ...input, monthlyBudget: budget, lumpSum: undefined });
    return {
      budget,
      status: plan.status,
      debtFree: plan.debtFree,
      shortfall: plan.shortfall?.amount ?? 0,
      knownInterest: plan.projectedInterest.known,
    };
  });
}
