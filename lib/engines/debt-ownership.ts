/**
 * Debt ownership — who a liability economically belongs to, separate from who the lender/card issuer
 * holds liable (always me). Pure: no UI, no Firebase.
 *
 * ONE lender obligation, ONE schedule. People allocations are sub-obligations beneath it:
 *  - A Loan/EMI's `ownershipShares` fix each party's share of the PRINCIPAL at creation (`personId: null`
 *    = me). Every installment is split by those same weights, paise-exact, so the parts always add back
 *    to the installment. A re-amortized tail (prepayment, rate change) keeps the weights, so the new
 *    installment amounts split deterministically; paid installments never change, so their historical
 *    shares never change either.
 *  - Legacy documents have no `ownershipShares`. They resolve from the existing fields only:
 *    `beneficiaryPersonId` + the explicit `beneficiaryRepaysInstallments` opt-in → 100% that person;
 *    anything else (incl. the bare "who is this for" association, which by contract creates no
 *    receivable) → 100% me. Nothing is inferred from names or descriptions.
 *
 * All arithmetic is in integer paise; remainders go by largest fractional part, ties by row order.
 */

export interface OwnershipShare {
  /** null = me (the account owner). */
  personId: string | null;
  /** This party's share of the principal, in rupees (2 dp). */
  amount: number;
}

export type AllocationMode = "equal" | "custom" | "percentage";

export const toPaise = (v: number) => Math.round(v * 100);
export const fromPaise = (p: number) => p / 100;

/** Split `totalPaise` by `weights` (any non-negative numbers) — exact, deterministic. */
export function splitPaise(totalPaise: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(w, 0), 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? totalPaise : 0));
  const raw = weights.map((w) => (totalPaise * Math.max(w, 0)) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let left = totalPaise - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .filter(({ i }) => weights[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) floors[order[k].i] += 1;
  return floors;
}

/** Split an amount (₹) by ownership shares — the parts sum exactly to `amount`. */
export function splitByOwnership(amount: number, shares: readonly OwnershipShare[]): OwnershipShare[] {
  const parts = splitPaise(toPaise(amount), shares.map((s) => toPaise(s.amount)));
  return shares.map((s, i) => ({ personId: s.personId, amount: fromPaise(parts[i]) }));
}

export interface AllocationRow {
  personId: string | null;
  /** ₹ for "custom", % for "percentage", ignored for "equal". */
  value: number;
}

export interface AllocationResult {
  shares: OwnershipShare[];
  allocated: number;
  remaining: number;
  /** Why this allocation cannot be saved, or null. */
  error: string | null;
}

/** Build shares for a principal from the form's rows. Save only when `error == null`. */
export function allocateOwnership(principal: number, mode: AllocationMode, rows: readonly AllocationRow[]): AllocationResult {
  const totalPaise = toPaise(principal);
  let paise: number[];
  if (mode === "equal") paise = splitPaise(totalPaise, rows.map(() => 1));
  else if (mode === "percentage") {
    const pctSum = rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0);
    // Percentages must reach exactly 100 (to 1e-6); the paise then split exactly by them.
    paise = Math.abs(pctSum - 100) < 1e-6 ? splitPaise(totalPaise, rows.map((r) => r.value)) : rows.map((r) => Math.round((totalPaise * (r.value || 0)) / 100));
  } else paise = rows.map((r) => toPaise(Number.isFinite(r.value) ? r.value : 0));

  const shares = rows.map((r, i) => ({ personId: r.personId, amount: fromPaise(paise[i]) }));
  const allocatedPaise = paise.reduce((s, p) => s + p, 0);
  return {
    shares,
    allocated: fromPaise(allocatedPaise),
    remaining: fromPaise(totalPaise - allocatedPaise),
    error: validateOwnership(principal, shares),
  };
}

/** Null when shares reconcile exactly to the principal and name each party once. */
export function validateOwnership(principal: number, shares: readonly OwnershipShare[]): string | null {
  if (shares.length === 0) return "Add at least one person";
  const ids = shares.map((s) => s.personId ?? "__me__");
  if (new Set(ids).size !== ids.length) return "Each person can appear only once";
  if (shares.some((s) => s.personId === "")) return "Choose a person for every row";
  if (shares.some((s) => !(s.amount > 0))) return "Every share must be more than ₹0";
  const diff = toPaise(principal) - shares.reduce((s, x) => s + toPaise(x.amount), 0);
  if (diff > 0) return `₹${fromPaise(diff).toLocaleString("en-IN")} still to allocate`;
  if (diff < 0) return `Allocated ₹${fromPaise(-diff).toLocaleString("en-IN")} more than the loan amount`;
  return null;
}

export interface OwnershipSource {
  ownershipShares?: readonly OwnershipShare[] | null;
  beneficiaryPersonId?: string | null;
  beneficiaryRepaysInstallments?: boolean;
}

/** True when the source carries an explicit multi-party allocation. */
export function hasOwnershipShares(source: OwnershipSource): boolean {
  return (source.ownershipShares?.length ?? 0) > 0;
}

/**
 * The authoritative ownership weights for a Loan/EMI of `principal`. Explicit shares win; legacy docs
 * resolve from the beneficiary opt-in only (see file header).
 */
export function resolveOwnership(source: OwnershipSource, principal: number): OwnershipShare[] {
  if (hasOwnershipShares(source)) return source.ownershipShares!.map((s) => ({ personId: s.personId, amount: s.amount }));
  if (source.beneficiaryPersonId && source.beneficiaryRepaysInstallments === true) return [{ personId: source.beneficiaryPersonId, amount: principal }];
  return [{ personId: null, amount: principal }];
}

/** True when `personId` repays me a share of this source's installments. */
export function personSharesInstallments(source: OwnershipSource & { deletedAt: Date | null }, personId: string): boolean {
  if (source.deletedAt != null) return false;
  if (hasOwnershipShares(source)) return source.ownershipShares!.some((s) => s.personId === personId && s.amount > 0);
  return source.beneficiaryPersonId === personId && source.beneficiaryRepaysInstallments === true;
}

/** `personId`'s part of one installment amount under this source's ownership (0 if none). */
export function personInstallmentShare(source: OwnershipSource, installmentAmount: number, personId: string): number {
  if (!hasOwnershipShares(source)) {
    return source.beneficiaryPersonId === personId && source.beneficiaryRepaysInstallments === true ? installmentAmount : 0;
  }
  const split = splitByOwnership(installmentAmount, source.ownershipShares!);
  return split.find((s) => s.personId === personId)?.amount ?? 0;
}

/** Firestore shape (read) — tolerant of absent / malformed data (legacy docs). */
export function ownershipSharesFromData(value: unknown): OwnershipShare[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const shares: OwnershipShare[] = [];
  for (const v of value) {
    if (v == null || typeof v !== "object") return null;
    const { personId, amount } = v as Record<string, unknown>;
    if (typeof amount !== "number" || !(personId == null || typeof personId === "string")) return null;
    shares.push({ personId: (personId as string | null) ?? null, amount });
  }
  return shares;
}

// ─────────────────────────── liability breakdown ───────────────────────────

export interface OwnershipPart {
  personId: string;
  name: string;
  amount: number;
}

/** How one liability divides between me and the people it was for. `mine + othersTotal + unallocated === total`. */
export interface DebtOwnership {
  total: number;
  mine: number;
  others: OwnershipPart[];
  othersTotal: number;
  /** Part whose owner FlowFi cannot determine from authoritative links. */
  unallocated: number;
}

export function mineOnly(total: number): DebtOwnership {
  return { total, mine: total, others: [], othersTotal: 0, unallocated: 0 };
}

/** Merge per-person parts (same person summed), sorted by amount desc then name. */
export function mergeParts(parts: readonly OwnershipPart[]): OwnershipPart[] {
  const map = new Map<string, OwnershipPart>();
  for (const p of parts) {
    if (p.amount <= 0) continue;
    const prev = map.get(p.personId);
    map.set(p.personId, { personId: p.personId, name: p.name, amount: fromPaise(toPaise((prev?.amount ?? 0) + p.amount)) });
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

/**
 * Build a breakdown of `total` from people's parts; if they exceed `total` they are scaled down
 * (paise-exact) so the parts never exceed the liability.
 */
export function ownershipFromParts(total: number, parts: readonly OwnershipPart[]): DebtOwnership {
  let others = mergeParts(parts);
  const totalPaise = toPaise(total);
  const othersPaise = others.reduce((s, p) => s + toPaise(p.amount), 0);
  if (othersPaise > totalPaise) {
    const scaled = splitPaise(totalPaise, others.map((p) => toPaise(p.amount)));
    others = others.map((p, i) => ({ ...p, amount: fromPaise(scaled[i]) })).filter((p) => p.amount > 0);
  }
  const othersTotal = fromPaise(others.reduce((s, p) => s + toPaise(p.amount), 0));
  return { total, mine: fromPaise(totalPaise - toPaise(othersTotal)), others, othersTotal, unallocated: 0 };
}

/** Split a principal-based liability by ownership weights. */
export function ownershipFromShares(total: number, shares: readonly OwnershipShare[], nameOf: (personId: string) => string): DebtOwnership {
  const split = splitByOwnership(total, shares);
  return ownershipFromParts(
    total,
    split.filter((s) => s.personId != null).map((s) => ({ personId: s.personId!, name: nameOf(s.personId!), amount: s.amount })),
  );
}

/**
 * Split a required payment (what the lender/issuer expects now) in the same proportion as the debt's
 * ownership. The payment itself is unchanged — this only says how much of it is economically mine.
 */
export function splitPaymentByOwnership(amount: number, ownership: DebtOwnership): { mine: number; others: number } {
  if (ownership.total <= 0 || ownership.othersTotal <= 0) return { mine: amount, others: 0 };
  const [others, mine] = splitPaise(toPaise(amount), [toPaise(ownership.othersTotal), toPaise(ownership.total - ownership.othersTotal)]);
  return { mine: fromPaise(mine), others: fromPaise(others) };
}

/**
 * Repository guard: the shares to persist, or throw — an allocation that doesn't reconcile exactly to the
 * principal is never written.
 */
export function checkedOwnership(principal: number, shares: readonly OwnershipShare[]): OwnershipShare[] {
  const error = validateOwnership(principal, shares);
  if (error != null) throw new Error(`Invalid loan allocation: ${error}`);
  return shares.map((s) => ({ personId: s.personId, amount: fromPaise(toPaise(s.amount)) }));
}
