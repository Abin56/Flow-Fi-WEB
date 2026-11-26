/**
 * The People side of a PAIRED undo (a lender payment and the receipts recorded with it), packaged so the lender
 * reversal can run it inside its own transaction. The revert itself is People's `prepareRevert` — the same one
 * "Revert payment" uses, including the refusal when the payment's advance was already used.
 */

import type { TxSession } from "@/lib/firestore/tx-session";
import { createCategoryRepository, createPersonPaymentRepository, createPersonRepository } from "@/lib/repositories/repository-factory";

export interface PairedReceiptRevert {
  /** `{personId}|{paymentId}` of each: gone by the time the transaction commits. */
  keys: ReadonlySet<string>;
  /** Reverts every receipt through the session. Writes nothing by itself — the owner of the transaction flushes. */
  apply: (session: TxSession) => Promise<void>;
}

export async function preparePairedReceiptRevert(uid: string, receipts: readonly { personId: string; paymentId: string }[]): Promise<PairedReceiptRevert> {
  const category = await createCategoryRepository(uid).getOrCreatePersonalLoanCategory();
  const steps: ((session: TxSession) => Promise<void>)[] = [];
  for (const r of receipts) {
    const person = await createPersonRepository(uid).getByKey(r.personId);
    if (person == null) throw new Error("A person on this payment no longer exists — nothing was changed.");
    steps.push(await createPersonPaymentRepository(uid, r.personId, category.id).prepareRevert(person, r.paymentId, { blockIfAdvanceUsed: true }));
  }
  return {
    keys: new Set(receipts.map((r) => `${r.personId}|${r.paymentId}`)),
    apply: async (session) => {
      for (const step of steps) await step(session);
    },
  };
}
