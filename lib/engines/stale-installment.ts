/**
 * Stale-target guard for Loan / EMI installment payments.
 *
 * A payment dialog shows the user ONE reviewed allocation ("Installment #1 · Pay ₹4,000"). If another tab
 * (or a retry with a new key) changed that installment before the confirm reaches Firestore, the write must
 * be refused — never silently re-aimed at the next unpaid installment, never turned into extra principal.
 * The check runs inside the payment transaction, against the freshly re-read installments.
 */

export const STALE_INSTALLMENT_MESSAGE =
  "This installment has changed since you opened it. Refresh and select the installment again.";

export const isStaleInstallmentError = (e: unknown): boolean => e instanceof StaleInstallmentError || (e instanceof Error && e.name === "StaleInstallmentError");

export class StaleInstallmentError extends Error {
  constructor(message: string = STALE_INSTALLMENT_MESSAGE) {
    super(message);
    this.name = "StaleInstallmentError";
  }
}

/**
 * The installments the fresh allocation touches (in order) must be exactly the ones the user reviewed —
 * and a Loan payment must not have grown extra principal the user never saw.
 */
export function assertReviewedAllocation(params: {
  actualInstallmentIds: string[];
  expectedInstallmentIds: string[] | null | undefined;
  actualOverflow?: number;
  expectedOverflow?: number | null;
  /** Per-installment amounts, parallel to the ids (optional — lump-sum settlements pin them). */
  actualAmounts?: number[];
  expectedAmounts?: number[] | null;
}): void {
  const { actualInstallmentIds, expectedInstallmentIds } = params;
  if (expectedInstallmentIds == null) return;
  const sameIds =
    actualInstallmentIds.length === expectedInstallmentIds.length && actualInstallmentIds.every((id, i) => id === expectedInstallmentIds[i]);
  const sameOverflow = params.expectedOverflow == null || Math.abs((params.actualOverflow ?? 0) - params.expectedOverflow) < 0.005;
  const sameAmounts =
    params.expectedAmounts == null ||
    (params.actualAmounts != null &&
      params.actualAmounts.length === params.expectedAmounts.length &&
      params.actualAmounts.every((a, i) => Math.abs(a - params.expectedAmounts![i]) < 0.005));
  if (!sameIds || !sameOverflow || !sameAmounts) throw new StaleInstallmentError();
}

/** The user-reviewed split of a lump-sum settlement: exactly these installments, these amounts, this much extra principal. */
export interface ReviewedLumpSum {
  installments: { installmentId: string; amount: number }[];
  /** Extra principal beyond the installments the user saw (default 0). */
  extraPrincipal?: number;
}

/**
 * Validates a reviewed lump-sum split against the amount being paid and returns the allocation the write must
 * reproduce, or throws before anything is read or written. Pure.
 */
export function expectedAllocationForLumpSum(reviewed: ReviewedLumpSum | null | undefined, amount: number): { installmentIds: string[]; overflow: number; amounts: number[] } {
  if (!reviewed || reviewed.installments.length === 0) throw new Error("A lump-sum settlement needs a reviewed allocation (the exact installments and amounts) — nothing was recorded.");
  const ids = reviewed.installments.map((i) => i.installmentId);
  if (new Set(ids).size !== ids.length) throw new Error("The reviewed allocation lists an installment twice — nothing was recorded.");
  if (reviewed.installments.some((i) => !Number.isFinite(i.amount) || i.amount <= 0)) throw new Error("Every reviewed installment amount must be greater than 0 — nothing was recorded.");
  const extra = reviewed.extraPrincipal ?? 0;
  if (!Number.isFinite(extra) || extra < 0) throw new Error("The reviewed extra principal can't be negative — nothing was recorded.");
  const total = reviewed.installments.reduce((t, i) => t + i.amount, 0) + extra;
  if (Math.abs(total - amount) >= 0.005) throw new Error("The reviewed allocation doesn't add up to the amount being paid — nothing was recorded.");
  return { installmentIds: ids, overflow: extra, amounts: reviewed.installments.map((i) => i.amount) };
}
