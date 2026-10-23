/**
 * The ONE place a whole-document Loan / EMI write decides `ownershipConfirmedMine`.
 *
 * Every ordinary editor (rename, notes, beneficiary / payer, close / reopen, terms, dates, default flags) writes the
 * caller's copy of the document — which may predate a confirmation made or removed since it was loaded. If that copy
 * decided the field, a stale edit would silently erase a fresh confirmation, or bring back one the user removed.
 *
 * So the field is taken from the STORED document, read in the same transaction as the write. Everything else is
 * written exactly as the caller supplied it: this does not merge, re-validate or "resolve" any other field.
 *
 * Only explicit operations set or remove a confirmation (`confirmOwnershipMine` / `clearOwnershipConfirmation`), plus
 * the one rule here: an edit that changes who the record is "for" or who repays it (`clearConfirmation`) removes it.
 */

import { type CollectionReference, doc, runTransaction } from "firebase/firestore";
import { recordEdit, type SoftDeletableEntity } from "@/lib/firestore/soft-deletable";
import type { OwnershipConfirmation } from "@/lib/models/ownership-confirmation";

type Confirmable = SoftDeletableEntity & { id: string; ownershipConfirmedMine?: OwnershipConfirmation | null };

/** Writes `entity` whole, except `ownershipConfirmedMine`, which comes from the stored document. Returns what was written. */
export async function writeKeepingStoredConfirmation<T extends Confirmable>(collection: CollectionReference<T>, entity: T, clearConfirmation: boolean): Promise<T> {
  const ref = doc(collection, entity.id);
  return runTransaction(collection.firestore, async (tx) => {
    const snap = await tx.get(ref);
    // A missing document has nothing stored to protect: write the caller's copy as `setDoc` always did.
    const stored = snap.exists() ? (snap.data().ownershipConfirmedMine ?? null) : (entity.ownershipConfirmedMine ?? null);
    let next: T = { ...entity, ownershipConfirmedMine: stored };
    if (clearConfirmation && stored != null) next = recordEdit({ ...next, ownershipConfirmedMine: null }, "ownershipConfirmedMine", "confirmed mine", "none");
    tx.set(ref, next);
    return next;
  });
}
