/**
 * PaymentDeferralRepository — the only writer of `people/{personId}/paymentDeferrals` (see
 * `lib/models/person-payment-deferral.ts`). Each Postpone / Undo is ONE `runTransaction` that re-reads,
 * at commit time, everything the decision depends on:
 *  - the Person (must exist, not deleted);
 *  - for a ledger obligation (`ledger:{id}`), its ledger entry (must exist, not deleted, this person's) —
 *    and its own date is used, never the UI's copy;
 *  - the deferral doc (its `revision` must still be the one the UI showed; `lastRequestId` makes a retry
 *    of the same request a no-op);
 *  - the obligation's follow-up reminder, re-dated in the same commit when needed.
 * Firestore retries the transaction if any of those docs change before commit, so two tabs can never both
 * win, and a stale UI can never overwrite newer timing. Nothing here touches the ledger, a balance, an
 * account, a transaction or an installment — reads only, for validation.
 */

import { doc, runTransaction, type DocumentData, type Firestore, type QueryDocumentSnapshot } from "firebase/firestore";
import { planDeferralWrite, type DeferralRequest } from "@/lib/engines/person-payment-deferral";
import { followUpDocId, personFollowUpFromFirestore, personFollowUpToFirestore } from "@/lib/models/person-follow-up";
import { deferralDocId, paymentDeferralFromData, paymentDeferralToFirestore, type PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";

export type PaymentDeferralErrorCode = "conflict" | "invalid";

export class PaymentDeferralError extends Error {
  constructor(
    readonly code: PaymentDeferralErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentDeferralError";
  }
}

export interface PaymentDeferralResult {
  outcome: "written" | "noop";
  deferral: PersonPaymentDeferral | null;
}

export class PaymentDeferralRepository {
  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
  ) {}

  private personRef(personId: string) {
    return doc(this.db, "users", this.uid, "people", personId);
  }

  docRef(personId: string, obligationKey: string) {
    return doc(this.personRef(personId), "paymentDeferrals", deferralDocId(obligationKey));
  }

  private followUpRef(personId: string, obligationKey: string) {
    return doc(this.personRef(personId), "followUps", followUpDocId(obligationKey));
  }

  async apply(request: DeferralRequest): Promise<PaymentDeferralResult> {
    const { personId, obligationKey } = request;
    return runTransaction(this.db, async (tx) => {
      const person = await tx.get(this.personRef(personId));
      if (!person.exists() || person.data().deletedAt != null) throw new PaymentDeferralError("invalid", "This person no longer exists.");

      let req = request;
      if (obligationKey.startsWith("ledger:") && req.action === "postpone") {
        const entry = await tx.get(doc(this.personRef(personId), "ledger", obligationKey.slice("ledger:".length)));
        const data = entry.exists() ? entry.data() : null;
        if (data == null || data.deletedAt != null || (data.personId != null && data.personId !== personId)) {
          throw new PaymentDeferralError("invalid", "This transaction was deleted or changed. Refresh and try again.");
        }
        const date = data.date?.toDate?.() as Date | undefined;
        if (date) req = { ...req, obligationDate: date };
      }

      const deferralRef = this.docRef(personId, obligationKey);
      const followUpRef = this.followUpRef(personId, obligationKey);
      const [deferralSnap, followUpSnap] = [await tx.get(deferralRef), await tx.get(followUpRef)];
      const current = deferralSnap.exists() ? paymentDeferralFromData(deferralSnap.id, deferralSnap.data()) : null;
      const followUp = followUpSnap.exists() ? personFollowUpFromFirestore(followUpSnap as QueryDocumentSnapshot<DocumentData>) : null;

      const plan = planDeferralWrite(current, followUp, req);
      if (plan.kind === "conflict" || plan.kind === "invalid") throw new PaymentDeferralError(plan.kind, plan.message);
      if (plan.kind === "noop") return { outcome: "noop", deferral: plan.deferral };

      tx.set(deferralRef, paymentDeferralToFirestore(plan.deferral));
      if (plan.followUp?.op === "set") tx.set(followUpRef, personFollowUpToFirestore(plan.followUp.value));
      else if (plan.followUp?.op === "delete") tx.delete(followUpRef);
      return { outcome: "written", deferral: plan.deferral };
    });
  }
}
