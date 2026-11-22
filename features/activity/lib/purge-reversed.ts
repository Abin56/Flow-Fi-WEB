/**
 * Removes the leftovers of People repayments that were already reverted (or whose Loan/EMI was deleted): the cash-leg
 * Transaction (soft-deleted by the revert) and the ledger entries that pointed at it. A reversal already took the money out of
 * every balance, so these rows carry no effect — removing them only clears the history. Every record is re-read and is touched
 * only while it is STILL marked deleted; a live record is never removed here.
 */

import { collection, doc, getDoc, getDocs, query, where, writeBatch, type Firestore } from "firebase/firestore";
import type { ActivityItem } from "@/features/activity/lib/activity-classify";

/** Reversed People-payment legs among the activity rows — the only rows this clean-up offers. */
export function reversedPersonLegs(items: readonly ActivityItem[]): ActivityItem[] {
  return items.filter((i) => i.state === "reversedOrReplaced" && i.anchor.isPersonLedgerMovement && i.anchor.linkedPersonId != null && i.anchor.deletedAt != null);
}

export async function purgeReversedPersonLegs(db: Firestore, uid: string, items: readonly ActivityItem[]): Promise<number> {
  let removed = 0;
  for (const item of reversedPersonLegs(items)) {
    const personId = item.anchor.linkedPersonId!;
    const txRef = doc(db, "users", uid, "transactions", item.anchor.id);
    const snap = await getDoc(txRef);
    if (!snap.exists() || (snap.data() as { deletedAt?: unknown }).deletedAt == null) continue; // live again — leave it
    const ledger = collection(db, "users", uid, "people", personId, "ledger");
    const entries = await getDocs(query(ledger, where("transactionRef", "==", item.anchor.id)));
    const batch = writeBatch(db);
    for (const e of entries.docs) {
      if ((e.data() as { deletedAt?: unknown }).deletedAt != null) batch.delete(e.ref);
    }
    batch.delete(txRef);
    await batch.commit();
    removed++;
  }
  return removed;
}
