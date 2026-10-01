/**
 * Which People-ledger entries are OWNED by a Transaction — and therefore must follow that transaction's
 * lifecycle — and which of those have lost their owner (a "ghost": the transaction was deleted through a
 * path that didn't take the People effect with it, e.g. an older build or Transaction Studio's delete).
 *
 * Ownership is read only from the entry's explicit contract, never guessed from amount, date or name:
 *  - `sourceKind: "personFundedExpense"` → owned by its `transactionRef` expense (the person paid it for me).
 *  - a manual / legacy entry whose `transactionRef` is a People cash leg (`isPersonLedgerMovement`) of
 *    this same person → owned by that cash leg ("Money I Borrowed / Gave" with an account movement).
 *
 * Everything else is NOT transaction-owned and is never touched here: standalone entries (no
 * `transactionRef`), Record Payment entries (`paymentId` — reverted as one payment), split/assigned
 * shares (owned by their Expense), EMI/Loan obligations (their `transactionRef` may be a Loan id), advances,
 * and any entry whose referenced document can't be found AND whose `sourceKind` doesn't prove ownership
 * (a missing id might be a Loan, so it proves nothing).
 *
 * Pure: `LedgerRepository.reconcileOrphanedTransactionEntries` re-runs the same rule on FRESH reads inside
 * its own Firestore transaction before writing, so a stale client stream can never remove a live entry.
 */

import type { LedgerEntry } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export type TransactionOwnership =
  /** Not owned by a transaction (or ownership can't be proven) — leave it alone. */
  | "notOwned"
  /** Owned, and its transaction is live. */
  | "ownedLive"
  /** Owned, and its transaction is deleted or gone — the entry must not count. */
  | "ownedGone";

type OwnerFields = Pick<Transaction, "id" | "deletedAt" | "isPersonLedgerMovement" | "linkedPersonId"> & {
  fundedByPersonId?: string | null;
};

/**
 * `owner`: the document `entry.transactionRef` points at, active or trashed — `null` when it doesn't exist.
 * `undefined` means "not known" (not loaded), which never proves anything.
 */
export function transactionOwnership(entry: LedgerEntry, owner: OwnerFields | null | undefined): TransactionOwnership {
  if (entry.deletedAt != null || entry.transactionRef == null || entry.paymentId != null) return "notOwned";
  if (owner === undefined) return "notOwned";
  if (entry.sourceKind === "personFundedExpense") {
    if (owner == null || owner.deletedAt != null) return "ownedGone";
    return "ownedLive";
  }
  if (entry.sourceKind != null && entry.sourceKind !== "manual") return "notOwned";
  // Manual / legacy: owned only when the reference provably is this person's own cash leg.
  if (owner == null || !owner.isPersonLedgerMovement || owner.linkedPersonId !== entry.personId) return "notOwned";
  return owner.deletedAt != null ? "ownedGone" : "ownedLive";
}

export interface OrphanReconciliationPlan {
  /** Ghost entries safe to remove (soft-delete, balance reversed, kept in trash for audit/restore). */
  reconcile: LedgerEntry[];
  /**
   * Ghost entries left in place because real money is recorded against them (an active settlement
   * that is not itself a ghost) — removing them would orphan that payment. Reported, never auto-fixed.
   */
  blocked: LedgerEntry[];
}

/**
 * `entries`: one person's ledger (trashed entries are ignored). `ownerOf`: the referenced transaction
 * (active or trashed), `null` when known not to exist, `undefined` when unknown.
 */
export function planOrphanReconciliation(
  entries: readonly LedgerEntry[],
  ownerOf: (transactionRef: string) => OwnerFields | null | undefined,
): OrphanReconciliationPlan {
  const active = entries.filter((e) => e.deletedAt == null);
  const ghosts = new Set(active.filter((e) => transactionOwnership(e, ownerOf(e.transactionRef ?? "")) === "ownedGone").map((e) => e.id));
  const reconcile: LedgerEntry[] = [];
  const blocked: LedgerEntry[] = [];
  for (const e of active) {
    if (!ghosts.has(e.id)) continue;
    const livePayments = active.some((d) => d.parentEntryId === e.id && !ghosts.has(d.id));
    (livePayments ? blocked : reconcile).push(e);
  }
  return { reconcile, blocked };
}
