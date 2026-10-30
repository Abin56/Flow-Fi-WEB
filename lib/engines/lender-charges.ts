/**
 * Lender charges — the pure rules. No Firebase, no UI, no writes: this is what the (not yet enabled) write path
 * and the read-only previews are built from, so the numbers shown before saving are the numbers saved.
 *
 * Invariants it encodes (approved policy):
 *  - Outstanding principal is never changed by a charge; unpaid charges are a separate figure; total lender payoff
 *    shows both, and accrued-but-unbilled interest stays out of both.
 *  - Billing recognises the expense once and moves no cash; settlement moves cash and the liability, never a
 *    second expense; partial settlements are tracked per payment.
 *  - A charge is "paid" only as far as its non-reversed settlements say so.
 *  - An unpaid charge can be reversed; a charge with any live payment cannot (reverse the payment first).
 */

import { recordEdit } from "@/lib/firestore/soft-deletable";
import { LENDER_CHARGE_TYPES, type LenderCharge, type LenderChargeAgreementKind, type LenderChargeType } from "@/lib/models/lender-charge";

export const round2 = (n: number) => Math.round(n * 100) / 100;
const CENT = 0.005;

// ---------------------------------------------------------------- status / amounts

const isLive = (c: Pick<LenderCharge, "deletedAt" | "reversedAt">) => c.deletedAt == null && c.reversedAt == null;

/** What has actually been paid against the charge (reversed payments do not count). */
export function settledAmount(c: Pick<LenderCharge, "settlements">): number {
  return round2(c.settlements.filter((s) => s.reversedAt == null).reduce((sum, s) => sum + s.amount, 0));
}

/** What is still owed on the charge — 0 for a reversed or deleted charge. */
export function unpaidAmount(c: Pick<LenderCharge, "amount" | "settlements" | "deletedAt" | "reversedAt">): number {
  if (!isLive(c)) return 0;
  return round2(Math.max(0, c.amount - settledAmount(c)));
}

export type LenderChargeStatus = "unpaid" | "partlyPaid" | "paid" | "reversed";

export function chargeStatus(c: Pick<LenderCharge, "amount" | "settlements" | "deletedAt" | "reversedAt">): LenderChargeStatus {
  if (c.reversedAt != null || c.deletedAt != null) return "reversed";
  const paid = settledAmount(c);
  if (paid <= CENT) return "unpaid";
  return c.amount - paid <= CENT ? "paid" : "partlyPaid";
}

// ---------------------------------------------------------------- payoff

export interface LenderPayoff {
  /** Outstanding principal — passed through untouched. */
  principal: number;
  /** Billed, still-unpaid lender charges (live charges only). */
  unpaidCharges: number;
  /** principal + unpaidCharges. */
  totalPayoff: number;
  /** Interest the lender has accrued but not billed. Shown separately; never part of the total. */
  accruedUnbilledInterest: number;
  unpaidByType: Partial<Record<LenderChargeType, number>>;
}

export function lenderPayoff(params: { principal: number; charges: readonly LenderCharge[]; accruedUnbilledInterest?: number }): LenderPayoff {
  const unpaidByType: Partial<Record<LenderChargeType, number>> = {};
  let unpaid = 0;
  for (const c of params.charges) {
    const u = unpaidAmount(c);
    if (u <= 0) continue;
    unpaid += u;
    unpaidByType[c.type] = round2((unpaidByType[c.type] ?? 0) + u);
  }
  const principal = round2(params.principal);
  const unpaidCharges = round2(unpaid);
  return { principal, unpaidCharges, totalPayoff: round2(principal + unpaidCharges), accruedUnbilledInterest: round2(params.accruedUnbilledInterest ?? 0), unpaidByType };
}

// ---------------------------------------------------------------- input validation

export interface LenderChargeInput {
  agreementKind: LenderChargeAgreementKind;
  agreementId: string;
  type: LenderChargeType;
  amount: number;
  billedDate: Date;
  lenderReference: string;
  reason: string;
}

export function validateLenderChargeInput(input: LenderChargeInput, now: Date = new Date()): string[] {
  const errors: string[] = [];
  if (!LENDER_CHARGE_TYPES.includes(input.type)) errors.push("Choose what kind of charge this is.");
  if (!Number.isFinite(input.amount) || input.amount <= 0) errors.push("Enter the billed amount (more than 0).");
  else if (Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 1e-6) errors.push("The amount can have at most 2 decimals.");
  if (!(input.billedDate instanceof Date) || Number.isNaN(input.billedDate.getTime())) errors.push("Enter the date the lender billed it.");
  else if (input.billedDate.getTime() > endOfDay(now).getTime()) errors.push("The billed date can't be in the future — an unbilled charge is not recorded.");
  if (input.reason.trim().length === 0) errors.push("Say why this charge is being recorded.");
  if (input.agreementId.trim().length === 0) errors.push("Choose the loan or EMI it belongs to.");
  return errors;
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

// ---------------------------------------------------------------- duplicate protection

/** Lower-case alphanumerics only, so "INV-001", "inv 001" and "Inv/001" are the same reference. */
export function normalizeReference(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Everything that makes two recordings "the same bill" — no generation, no randomness. */
export function chargeFingerprint(input: Pick<LenderChargeInput, "agreementKind" | "agreementId" | "type" | "amount" | "billedDate" | "lenderReference">): string {
  return [input.agreementKind, input.agreementId, input.type, Math.round(input.amount * 100), ymd(input.billedDate), normalizeReference(input.lenderReference)].join("_");
}

const sameFingerprintOf = (c: LenderCharge) => chargeFingerprint(c);

export type DuplicateVerdict = "none" | "duplicate" | "possibleDuplicate" | "referenceConflict";

export interface DuplicateCheck {
  verdict: DuplicateVerdict;
  /** Live charges the candidate duplicates / resembles. */
  matches: LenderCharge[];
  /**
   * Which recording of this exact bill this would be: 1 the first time, 2 if an earlier identical one was reversed.
   * The write path puts it in the idempotency key, so re-billing after a reversal is possible but a retry is not
   * a second charge.
   */
  generation: number;
}

const DAY = 86_400_000;

/**
 * - `duplicate`: a live charge has the identical fingerprint — blocked, not overridable.
 * - `referenceConflict`: the same lender reference is already recorded with a different type or amount — blocked
 *   until the user reconciles it (one reference is one bill).
 * - `possibleDuplicate`: same agreement and type, same amount within 3 days, where either side has no reference —
 *   needs the user's explicit "this is a separate charge".
 * Reversed charges never block; they only raise the generation.
 */
export function checkDuplicateCharge(candidate: LenderChargeInput, existing: readonly LenderCharge[]): DuplicateCheck {
  const sameAgreement = existing.filter((c) => c.agreementKind === candidate.agreementKind && c.agreementId === candidate.agreementId && c.deletedAt == null);
  const fp = chargeFingerprint(candidate);
  const ref = normalizeReference(candidate.lenderReference);

  const identical = sameAgreement.filter((c) => sameFingerprintOf(c) === fp);
  const reversedIdentical = identical.filter((c) => c.reversedAt != null).length;
  const liveIdentical = identical.filter((c) => c.reversedAt == null);
  const generation = reversedIdentical + 1;
  if (liveIdentical.length > 0) return { verdict: "duplicate", matches: liveIdentical, generation };

  const live = sameAgreement.filter((c) => c.reversedAt == null);
  if (ref !== "") {
    const sameRef = live.filter((c) => normalizeReference(c.lenderReference) === ref && (c.type !== candidate.type || Math.round(c.amount * 100) !== Math.round(candidate.amount * 100)));
    if (sameRef.length > 0) return { verdict: "referenceConflict", matches: sameRef, generation };
  }
  const near = live.filter(
    (c) =>
      c.type === candidate.type &&
      Math.abs(c.amount - candidate.amount) < CENT &&
      Math.abs(c.billedDate.getTime() - candidate.billedDate.getTime()) <= 3 * DAY &&
      (ref === "" || normalizeReference(c.lenderReference) === ""),
  );
  if (near.length > 0) return { verdict: "possibleDuplicate", matches: near, generation };
  return { verdict: "none", matches: [], generation };
}

/** The deterministic id the write path uses for this recording. */
export function chargeIdempotencyKey(input: Parameters<typeof chargeFingerprint>[0], generation: number): string {
  return `lc_${chargeFingerprint(input)}_g${generation}`;
}

// ---------------------------------------------------------------- billing preview (read-only)

export interface BillingPreview {
  errors: string[];
  duplicate: DuplicateCheck;
  /** Always identical before and after — a charge never touches principal. */
  principal: { before: number; after: number };
  unpaidCharges: { before: number; after: number };
  payoff: { before: number; after: number };
  /** Expense recognised by this billing, in the month of `billedDate`. */
  expense: { amount: number; month: Date };
  /** Net Worth moves by the full amount at billing (liability up, no cash). */
  netWorthDelta: number;
  /** No cash moves when a charge is recorded. */
  cashDelta: 0;
  /** No transaction is created by recording. */
  createsTransaction: false;
  /** `blocked` = cannot be recorded as it stands. */
  blocked: boolean;
}

export function previewBilling(params: { input: LenderChargeInput; principal: number; existing: readonly LenderCharge[]; accruedUnbilledInterest?: number; now?: Date }): BillingPreview {
  const { input, existing } = params;
  const errors = validateLenderChargeInput(input, params.now);
  const duplicate = checkDuplicateCharge(input, existing);
  if (duplicate.verdict === "duplicate") errors.push("This charge is already recorded (same type, amount, date and reference).");
  if (duplicate.verdict === "referenceConflict") errors.push("That lender reference is already recorded with a different type or amount. One reference is one bill — reconcile it first.");
  const agreementCharges = existing.filter((c) => c.agreementKind === input.agreementKind && c.agreementId === input.agreementId);
  const before = lenderPayoff({ principal: params.principal, charges: agreementCharges, accruedUnbilledInterest: params.accruedUnbilledInterest });
  const amount = Number.isFinite(input.amount) && input.amount > 0 ? round2(input.amount) : 0;
  const after = round2(before.unpaidCharges + amount);
  return {
    errors,
    duplicate,
    principal: { before: before.principal, after: before.principal },
    unpaidCharges: { before: before.unpaidCharges, after },
    payoff: { before: before.totalPayoff, after: round2(before.principal + after) },
    expense: { amount, month: new Date(input.billedDate.getFullYear(), input.billedDate.getMonth(), 1) },
    netWorthDelta: -amount,
    cashDelta: 0,
    createsTransaction: false,
    blocked: errors.length > 0,
  };
}

// ---------------------------------------------------------------- settlement

export interface SettlementPreview {
  errors: string[];
  unpaidBefore: number;
  unpaidAfter: number;
  /** Cash leaves the funding account by exactly the payment. */
  accountDelta: number;
  /** The liability falls by the payment. */
  liabilityDelta: number;
  /** Always 0: the expense was recognised at billing. */
  expenseRecognised: 0;
  /** Always 0: cash and liability fall together. */
  netWorthDelta: 0;
  statusAfter: LenderChargeStatus;
}

export function previewSettlement(charge: LenderCharge, amount: number): SettlementPreview {
  const errors: string[] = [];
  const unpaidBefore = unpaidAmount(charge);
  if (charge.reversedAt != null || charge.deletedAt != null) errors.push("This charge was reversed, so it can't be paid.");
  else if (unpaidBefore <= CENT) errors.push("This charge is already fully paid.");
  if (!Number.isFinite(amount) || amount <= 0) errors.push("Enter the amount being paid (more than 0).");
  else if (amount - unpaidBefore > CENT && unpaidBefore > CENT) errors.push(`Only ₹${unpaidBefore.toLocaleString("en-IN")} is still owed on this charge.`);
  const pay = errors.length === 0 ? round2(amount) : 0;
  const unpaidAfter = round2(unpaidBefore - pay);
  return {
    errors, unpaidBefore, unpaidAfter, accountDelta: -pay, liabilityDelta: -pay, expenseRecognised: 0, netWorthDelta: 0,
    statusAfter: errors.length > 0 ? chargeStatus(charge) : unpaidAfter <= CENT ? "paid" : "partlyPaid",
  };
}

export interface ChargeAllocation {
  chargeId: string;
  amount: number;
}

/** Spreads one payment across an agreement's unpaid charges, oldest billed first. What is left over is not a charge. */
export function allocateToCharges(charges: readonly LenderCharge[], amount: number): { allocations: ChargeAllocation[]; remainder: number } {
  const ordered = charges.filter((c) => unpaidAmount(c) > CENT).sort((a, b) => a.billedDate.getTime() - b.billedDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  let left = round2(amount);
  const allocations: ChargeAllocation[] = [];
  for (const c of ordered) {
    if (left <= CENT) break;
    const part = round2(Math.min(left, unpaidAmount(c)));
    allocations.push({ chargeId: c.id, amount: part });
    left = round2(left - part);
  }
  return { allocations, remainder: left };
}

// ---------------------------------------------------------------- reversal

export function chargeReversalBlocker(c: Pick<LenderCharge, "reversedAt" | "deletedAt" | "settlements">): string | null {
  if (c.reversedAt != null || c.deletedAt != null) return "This charge is already reversed.";
  const live = c.settlements.filter((s) => s.reversedAt == null);
  if (live.length > 0) return "A payment has been applied to this charge. Reverse that payment first; the charge can then be reversed.";
  return null;
}

/** The charge as reversed — audit history kept and extended, never removed. Throws when reversal is not allowed. */
export function reversedCharge(c: LenderCharge, reason: string, at: Date): LenderCharge {
  const blocker = chargeReversalBlocker(c);
  if (blocker != null) throw new Error(blocker);
  if (reason.trim().length === 0) throw new Error("Say why this charge is being reversed.");
  return { ...recordEdit(c, "reversed", "billed", `reversed: ${reason.trim()}`), reversedAt: at, reversalReason: reason.trim() };
}
