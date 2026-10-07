/**
 * Record Payment — the one allocation rule for a real payment between me and a Person. Pure: no React,
 * no Firebase I/O. The Record Payment workspace shows exactly what `allocatePayment` returns, and
 * `PersonPaymentRepository.recordPayment` writes exactly those lines — the UI never does its own sums.
 *
 * Rules (the approved semantics):
 *  - One payment has one direction: they paid me (settles what they owe me) or I paid them (settles
 *    what I owe them). Only obligations on that side can be selected.
 *  - Automatic allocation fills the selected obligations oldest first (date, then when recorded, then
 *    key) — the existing split-expense "oldest-due-first" rule, extended to every obligation type.
 *  - Manual allocation lets the user set each line; a line can never exceed what is outstanding on it,
 *    and the lines can never exceed the payment.
 *  - Whatever the payment exceeds the allocation by is `extra` — never silently classified. It must be
 *    resolved explicitly (advance / another obligation / income) before the payment can be recorded.
 *  - An advance is applied to later obligations the same way: oldest first, never beyond what is left.
 */

export type PaymentDirection = "theyPaid" | "iPaid";
/** Which side an obligation sits on — "theyOwe": they owe me; "iOwe": I owe them. */
export type ObligationSide = "theyOwe" | "iOwe";

export interface PaymentObligation {
  /** Statement row key — `ledger:{id}`, `emi-inst:{id}`. */
  key: string;
  title: string;
  date: Date;
  createdAt: Date;
  /** The obligation's original amount. */
  amount: number;
  /** What is still open on it right now (engine `remainingNow`). */
  outstanding: number;
  side: ObligationSide;
}

export interface AllocationLine {
  key: string;
  amount: number;
  outstanding: number;
  remainingAfter: number;
}

export type PaymentOutcome = "none" | "full" | "partial" | "over";

export interface PaymentAllocation {
  lines: AllocationLine[];
  /** Sum of what is outstanding on the selected obligations. */
  selectedTotal: number;
  /** Sum of `lines`. */
  allocated: number;
  /** Payment beyond the allocation — must be resolved explicitly. */
  extra: number;
  /** What stays open on the selected obligations after this payment. */
  unpaid: number;
  outcome: PaymentOutcome;
  /** Why this allocation can't be recorded as entered (null when it can). */
  error: string | null;
}

export const PAYMENT_EPSILON = 0.005;
export const round2 = (v: number) => Math.round(v * 100) / 100;

export function sideForDirection(direction: PaymentDirection): ObligationSide {
  return direction === "theyPaid" ? "theyOwe" : "iOwe";
}

/** Oldest first: date, then when it was recorded, then key — deterministic. */
export function compareOldestFirst(a: Pick<PaymentObligation, "date" | "createdAt" | "key">, b: Pick<PaymentObligation, "date" | "createdAt" | "key">): number {
  return a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key);
}

/**
 * Allocates `amount` across the selected obligations.
 * @param manual per-key amounts when the user allocates by hand (null/undefined = automatic).
 */
export function allocatePayment(params: {
  obligations: readonly PaymentObligation[];
  selectedKeys: readonly string[];
  amount: number;
  manual?: Readonly<Record<string, number>> | null;
}): PaymentAllocation {
  const { obligations, amount, manual } = params;
  const selected = new Set(params.selectedKeys);
  const chosen = obligations.filter((o) => selected.has(o.key) && o.outstanding > PAYMENT_EPSILON).sort(compareOldestFirst);
  const selectedTotal = round2(chosen.reduce((s, o) => s + o.outstanding, 0));
  const pay = Number.isFinite(amount) && amount > 0 ? round2(amount) : 0;

  let error: string | null = null;
  const sides = new Set(chosen.map((o) => o.side));
  if (sides.size > 1) error = "A payment can only settle one side — what they owe you, or what you owe them.";

  const lines: AllocationLine[] = [];
  if (manual) {
    for (const o of chosen) {
      const raw = manual[o.key];
      const value = raw == null || !Number.isFinite(raw) ? 0 : round2(raw);
      if (value < 0) error ??= "Amounts can't be negative.";
      if (value > o.outstanding + PAYMENT_EPSILON) error ??= `${o.title}: more than the ${o.outstanding.toFixed(2)} outstanding.`;
      if (value > PAYMENT_EPSILON) lines.push({ key: o.key, amount: value, outstanding: o.outstanding, remainingAfter: round2(Math.max(0, o.outstanding - value)) });
    }
  } else {
    let left = pay;
    for (const o of chosen) {
      if (left <= PAYMENT_EPSILON) break;
      const portion = round2(Math.min(o.outstanding, left));
      lines.push({ key: o.key, amount: portion, outstanding: o.outstanding, remainingAfter: round2(o.outstanding - portion) });
      left = round2(left - portion);
    }
  }

  const allocated = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (allocated > pay + PAYMENT_EPSILON) error ??= "The allocation is more than the payment.";
  const extra = round2(Math.max(0, pay - allocated));
  const unpaid = round2(Math.max(0, selectedTotal - allocated));
  const outcome: PaymentOutcome =
    pay <= PAYMENT_EPSILON ? "none" : extra > PAYMENT_EPSILON ? "over" : unpaid > PAYMENT_EPSILON ? "partial" : "full";
  return { lines, selectedTotal, allocated, extra, unpaid, outcome, error };
}

/**
 * "Use only ₹X of this payment to settle the balance." Never a new allocation rule: `allocatePayment`
 * spreads `settle` across the selected obligations in its own oldest-first order, and those lines are
 * then recorded as a manual allocation of the full `amount` — so the rest (`amount − settle`) becomes
 * the payment's extra, decided through advance / income / purpose like any extra. What stays open on
 * the obligations is still owed (each obligation keeps its own partial remaining).
 *
 * Returns the per-key manual lines, or an error when `settle` is out of range (never silently capped).
 */
export function settleCapLines(params: {
  obligations: readonly PaymentObligation[];
  selectedKeys: readonly string[];
  amount: number;
  settle: number;
}): { manual: Record<string, number>; error: string | null } {
  const { obligations, selectedKeys, amount, settle } = params;
  const pay = Number.isFinite(amount) && amount > 0 ? round2(amount) : 0;
  const cap = Number.isFinite(settle) ? round2(settle) : NaN;
  const due = allocatePayment({ obligations, selectedKeys, amount: Number.MAX_SAFE_INTEGER }).selectedTotal;
  let error: string | null = null;
  if (!Number.isFinite(cap)) error = "Enter how much should settle the balance.";
  else if (cap < 0) error = "The amount to settle can't be negative.";
  else if (cap > pay + PAYMENT_EPSILON) error = `Only ${pay.toFixed(2)} was received — you can't settle more than that.`;
  else if (cap > due + PAYMENT_EPSILON) error = `Only ${due.toFixed(2)} is due on the selected items — use Keep as advance for money beyond it.`;
  if (error) return { manual: {}, error };
  const lines = allocatePayment({ obligations, selectedKeys, amount: cap }).lines;
  return { manual: Object.fromEntries(lines.map((l) => [l.key, l.amount])), error: null };
}

// ---------------------------------------------------------------------------------------------------
// Extra amount
// ---------------------------------------------------------------------------------------------------

/**
 * What the user said the extra amount is. Only options FlowFi can actually record:
 *  - "advance": held against this person's future obligations (a `sourceKind: "advance"` entry);
 *  - "income": separate income (a normal Income transaction) — only for money they paid me.
 * "Apply to another obligation" is not a resolution of its own: selecting that obligation makes it part
 * of the allocation, so the extra shrinks.
 */
export type ExtraResolution =
  | { kind: "advance" }
  | { kind: "income"; categoryId: string; description: string }
  /**
   * "Keep for a purpose" — the money stays in the account (still not income, still not an advance),
   * remembered as what it must be used for. Whatever the purposes don't cover needs its own explicit
   * `remainder` (advance or income) — never an unexplained rest. Only for money they paid me.
   */
  | {
      kind: "purpose";
      purposes: readonly { title: string; amount: number }[];
      remainder: { kind: "advance" } | { kind: "income"; categoryId: string; description: string } | null;
    };

/** Why this payment can't be recorded yet (null when it can). */
export function paymentBlocker(params: {
  direction: PaymentDirection;
  amount: number;
  allocation: PaymentAllocation;
  resolution: ExtraResolution | null;
  accountId: string | null;
}): string | null {
  const { direction, amount, allocation, resolution, accountId } = params;
  if (!(amount > 0)) return "Enter the amount.";
  if (allocation.error) return allocation.error;
  if (!accountId) return direction === "theyPaid" ? "Choose the account it was received into." : "Choose the account it was paid from.";
  if (allocation.extra > PAYMENT_EPSILON) {
    if (resolution == null) return "Choose what the extra amount is for.";
    if (resolution.kind === "income") {
      if (direction !== "theyPaid") return "Only money received can be recorded as income.";
      if (!resolution.categoryId) return "Choose an income category.";
    }
    if (resolution.kind === "purpose") {
      if (direction !== "theyPaid") return "Only money received can be kept for a purpose.";
      if (resolution.purposes.length === 0) return "Add at least one purpose.";
      for (const [i, p] of resolution.purposes.entries()) {
        if (!p.title.trim()) return `Purpose ${i + 1}: say what this money is for.`;
        if (!(p.amount > 0)) return `Purpose ${i + 1}: enter the amount.`;
      }
      const assigned = round2(resolution.purposes.reduce((s, p) => s + p.amount, 0));
      if (assigned > allocation.extra + PAYMENT_EPSILON) return "The purposes add up to more than the extra amount.";
      if (allocation.extra - assigned > PAYMENT_EPSILON) {
        if (resolution.remainder == null) return "Decide the rest — assign it to a purpose, or keep it as advance or income.";
        if (resolution.remainder.kind === "income" && !resolution.remainder.categoryId) return "Choose an income category for the rest.";
      }
    }
  }
  if (allocation.lines.length === 0 && !(allocation.extra > PAYMENT_EPSILON && (resolution?.kind === "advance" || resolution?.kind === "purpose")))
    return "Select what this payment is for.";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------------------------------

export interface AdvanceSource {
  /** The advance ledger entry id. */
  entryId: string;
  date: Date;
  createdAt: Date;
  /** Amount of the advance entry. */
  amount: number;
  /** Which side's obligations it can settle — their advance settles what they owe me. */
  side: ObligationSide;
}

export interface AdvanceUse {
  advanceEntryId: string;
  amount: number;
}

/** What is left of each advance after the active applications drawn from it (oldest advance first). */
export function advanceRemaining(
  advances: readonly AdvanceSource[],
  applications: readonly { advanceEntryId: string; amount: number; deletedAt: Date | null }[],
): (AdvanceSource & { remaining: number })[] {
  const used = new Map<string, number>();
  for (const a of applications) if (a.deletedAt == null) used.set(a.advanceEntryId, round2((used.get(a.advanceEntryId) ?? 0) + a.amount));
  return [...advances]
    .sort((a, b) => compareOldestFirst({ ...a, key: a.entryId }, { ...b, key: b.entryId }))
    .map((a) => ({ ...a, remaining: round2(Math.max(0, a.amount - (used.get(a.entryId) ?? 0))) }));
}

/**
 * Draws `amount` of advance for `side`, oldest advance first. Throws when not enough is available —
 * an advance can never be applied beyond what was actually received.
 */
export function drawAdvance(available: readonly (AdvanceSource & { remaining: number })[], side: ObligationSide, amount: number): AdvanceUse[] {
  let left = round2(amount);
  const uses: AdvanceUse[] = [];
  for (const a of available) {
    if (left <= PAYMENT_EPSILON) break;
    if (a.side !== side || a.remaining <= PAYMENT_EPSILON) continue;
    const take = round2(Math.min(a.remaining, left));
    uses.push({ advanceEntryId: a.entryId, amount: take });
    left = round2(left - take);
  }
  if (left > PAYMENT_EPSILON) throw new Error("Not enough advance available.");
  return uses;
}

/** How much advance could settle these obligations right now: min(available, outstanding). */
export function applicableAdvance(availableForSide: number, obligations: readonly PaymentObligation[], side: ObligationSide): number {
  const open = round2(obligations.filter((o) => o.side === side).reduce((s, o) => s + o.outstanding, 0));
  return round2(Math.max(0, Math.min(availableForSide, open)));
}

/**
 * Applying advance to obligations the user picked — the same allocation rule as a payment (oldest
 * first, or the user's per-line amounts), with the advance as the "payment". Each line then draws from
 * the advance entries oldest first, so every application keeps its link to the receipt it came from.
 * Nothing is applied until the user asks — changing cycles never consumes advance.
 */
export function planAdvanceApplication(params: {
  available: readonly (AdvanceSource & { remaining: number })[];
  obligations: readonly PaymentObligation[];
  side: ObligationSide;
  selectedKeys: readonly string[];
  manual?: Readonly<Record<string, number>> | null;
}): { allocation: PaymentAllocation; availableTotal: number; targets: { obligationKey: string; uses: AdvanceUse[] }[]; error: string | null } {
  const { side } = params;
  const availableTotal = round2(params.available.filter((a) => a.side === side).reduce((s, a) => s + a.remaining, 0));
  const obligations = params.obligations.filter((o) => o.side === side);
  const allocation = allocatePayment({ obligations, selectedKeys: params.selectedKeys, amount: availableTotal, manual: params.manual });
  let error = allocation.error;
  if (allocation.allocated > availableTotal + PAYMENT_EPSILON) error ??= "That is more than the advance available.";
  const pool = params.available.map((a) => ({ ...a }));
  const targets: { obligationKey: string; uses: AdvanceUse[] }[] = [];
  if (!error) {
    for (const line of allocation.lines) {
      const uses = drawAdvance(pool, side, line.amount);
      for (const u of uses) {
        const src = pool.find((a) => a.entryId === u.advanceEntryId)!;
        src.remaining = round2(src.remaining - u.amount);
      }
      targets.push({ obligationKey: line.key, uses });
    }
  }
  return { allocation, availableTotal, targets, error };
}

/**
 * Where every rupee of one receipt went. `received` always equals the sum of the buckets — the
 * workspace, the history drill-down and the tests all read this one reconciliation.
 */
export interface PaymentReconciliation {
  received: number;
  allocated: number;
  advance: number;
  income: number;
  /** Kept for purposes — in the account, but neither income nor an advance. */
  purpose: number;
  unallocated: number;
  balanced: boolean;
}

export function reconcilePayment(parts: { received: number; allocated: number; advance?: number; income?: number; purpose?: number }): PaymentReconciliation {
  const received = round2(parts.received);
  const allocated = round2(parts.allocated);
  const advance = round2(parts.advance ?? 0);
  const income = round2(parts.income ?? 0);
  const purpose = round2(parts.purpose ?? 0);
  const unallocated = round2(received - allocated - advance - income - purpose);
  return { received, allocated, advance, income, purpose, unallocated, balanced: Math.abs(unallocated) <= PAYMENT_EPSILON };
}
