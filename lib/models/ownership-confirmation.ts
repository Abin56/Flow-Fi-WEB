/**
 * "This EMI is mine" — an explicit, user-made confirmation that a legacy Loan / EMI (one with no ownership data) is
 * personally theirs. Pure and additive: it is read only by the My EMI Commitments classification
 * (`classifyOwnership`) and never by `resolveOwnership`, the People engines, My Money or the Debt Planner, so it
 * changes no financial figure. Written only when present, so every existing document is untouched.
 *
 * KNOWN RISK (Android parity is out of scope): an older Flutter build saves the whole document and does not know
 * this field, so such a save can drop it. That fails safe — the record simply returns to "Confirm who owes this EMI".
 */

import { Timestamp, type DocumentData } from "firebase/firestore";

export interface OwnershipConfirmation {
  at: Date;
}

/** Tolerant read: anything that is not `{ at: Timestamp }` is "not confirmed". */
export function ownershipConfirmationFromData(value: unknown): OwnershipConfirmation | null {
  if (value == null || typeof value !== "object") return null;
  const at = (value as { at?: unknown }).at;
  return at instanceof Timestamp ? { at: at.toDate() } : null;
}

/** Spread into the document — empty unless confirmed, so no empty key is ever written. */
export function ownershipConfirmationToData(value: OwnershipConfirmation | null | undefined): DocumentData {
  return value == null ? {} : { ownershipConfirmedMine: { at: Timestamp.fromDate(value.at) } };
}

export interface ConfirmableRecord {
  deletedAt: Date | null;
  isClosed: boolean;
  /** Loans only — a loan I gave is a receivable, never my EMI. */
  direction?: "taken" | "given";
  ownershipShares?: readonly unknown[] | null;
  beneficiaryRepaysInstallments?: boolean;
}

/**
 * Why this record cannot be confirmed as mine, or null. A beneficiary WITHOUT the repay opt-in is allowed: the model
 * defines that as a pure association — the liability stays mine.
 */
export function ownershipConfirmationBlocker(record: ConfirmableRecord): string | null {
  if (record.deletedAt != null) return "This record is in the trash.";
  if (record.isClosed) return "This record is closed.";
  if (record.direction === "given") return "A loan you gave is money owed to you, not your EMI.";
  if ((record.ownershipShares?.length ?? 0) > 0) return "This record already has an explicit ownership split.";
  if (record.beneficiaryRepaysInstallments === true) return "Someone else repays this record, so it is not marked as yours.";
  return null;
}
