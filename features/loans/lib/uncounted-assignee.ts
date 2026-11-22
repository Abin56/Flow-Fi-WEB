/**
 * An EMI / Loan can be linked to a person ("who was this for") WITHOUT the explicit "they repay me each installment"
 * opt-in. Such a link is association only (`debt-ownership.ts`): no installment becomes a People obligation, so
 * paying the lender — now or as an "already paid" past payment — shows nothing in their People Ledger and asks
 * nothing about them. That is intended, but it was invisible in the payment flow. This only DETECTS the state so
 * the dialog can say so; it never changes a share, an obligation or a write.
 */
import { hasOwnershipShares, type OwnershipSource } from "@/lib/engines/debt-ownership";

export function uncountedAssigneeId(source: OwnershipSource | null): string | null {
  if (source == null || !source.beneficiaryPersonId) return null;
  if (hasOwnershipShares(source)) return null; // a split agreement carries its people in `ownershipShares`
  return source.beneficiaryRepaysInstallments === true ? null : source.beneficiaryPersonId;
}
