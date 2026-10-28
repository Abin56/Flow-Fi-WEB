/**
 * Balance Control's "correct the credit limit" write path — ONE Firestore transaction that (a) appends a
 * `CreditLimitCorrection` audit record and (b) updates `creditLimit` on the target (a standalone card, or the
 * shared facility when the card draws from one) through the SAME audited edit path `editCard`/`editSharedLimit`
 * already use (`applyCardEdits`/`applySharedLimitEdits`), so `editHistory` and this correction's own history
 * both reflect the change — nothing here invents a second, divergent way to change a limit.
 *
 * Deliberately NOT part of `credit-card-save.ts`: that module is the Add/Edit Card dialog's concern (the user
 * directly setting a field); this is a reconciliation action (the user reporting what the bank now says, with
 * a reason and an effective date) and needs its own audit shape — see `lib/models/credit-limit-correction.ts`.
 *
 * Safety:
 *  - `creditLimit` is never derived (it is a bank-set fact FlowFi mirrors), so overwriting it carries none of
 *    the "don't overwrite a derived value" risk `totalOutstanding`/`availableCredit` would. Those stay
 *    completely untouched — they are recomputed live from this new `creditLimit` the next time anything reads
 *    `creditCardStanding`, exactly as a plain Add/Edit Card limit change already does today.
 *  - Idempotent: the correction's id is fixed by the caller before the transaction opens. A retry (double
 *    submit, lost response) sees the correction doc already exists and writes nothing again.
 *  - Conflict-safe: the target's `creditLimit` is read FRESH inside the transaction and compared against the
 *    `previousLimit` the caller expected. If another tab/device changed it meanwhile, the correction is
 *    rejected rather than silently applied on top of a value the user never saw.
 *  - Shared-limit parity: correcting a shared facility's limit is one write to the one `SharedCreditLimit`
 *    document — every member card reads it live, so there is no separate per-card limit to fall out of sync.
 */

import { doc, getDocs, orderBy, query, runTransaction, type Transaction as FirestoreTransaction } from "firebase/firestore";
import type { CreditLimitCorrection, CreditLimitCorrectionReason } from "@/lib/models/credit-limit-correction";
import type { CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import { safeDocs } from "@/lib/firestore/safe-docs";
import type { CreditCardRepository, SharedCreditLimitRepository } from "./credit-card-repository";

export class LimitCorrectionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`The limit changed to ₹${actual.toLocaleString("en-IN")} elsewhere (expected ₹${expected.toLocaleString("en-IN")}). Reload and try again.`);
    this.name = "LimitCorrectionConflictError";
  }
}

export type LimitCorrectionTarget = { kind: "card"; cardId: string } | { kind: "sharedLimit"; sharedLimitId: string };

export interface RecordLimitCorrectionParams {
  /** Fixed by the caller before the transaction opens — makes a retry a no-op instead of a duplicate. */
  id: string;
  target: LimitCorrectionTarget;
  /** The limit the caller's UI last displayed — checked against the fresh document, not trusted blindly. */
  previousLimit: number;
  newLimit: number;
  effectiveDate: Date;
  reason: CreditLimitCorrectionReason;
  note: string;
}

export type RecordLimitCorrectionResult = { status: "applied"; correction: CreditLimitCorrection } | { status: "alreadyApplied" };

function validateNewLimit(newLimit: number): void {
  if (!Number.isFinite(newLimit) || newLimit <= 0) throw new Error("Enter the bank's actual limit — it must be greater than ₹0.");
}

export class CreditLimitCorrectionRepository {
  constructor(
    private readonly cards: CreditCardRepository,
    private readonly sharedLimits: SharedCreditLimitRepository,
  ) {}

  private correctionsCollection(target: LimitCorrectionTarget) {
    return target.kind === "card" ? this.cards.limitCorrections(target.cardId) : this.sharedLimits.limitCorrections(target.sharedLimitId);
  }

  private targetDocRef(target: LimitCorrectionTarget) {
    return target.kind === "card" ? this.cards.docRef(target.cardId) : this.sharedLimits.docRef(target.sharedLimitId);
  }

  /** Append-only history for one target, newest first — never filtered to active-only (a reversed entry must stay visible, struck through). */
  async historyFor(target: LimitCorrectionTarget): Promise<CreditLimitCorrection[]> {
    const snap = await getDocs(query(this.correctionsCollection(target), orderBy("createdAt", "desc")));
    return safeDocs(snap.docs);
  }

  async record(params: RecordLimitCorrectionParams): Promise<RecordLimitCorrectionResult> {
    validateNewLimit(params.newLimit);
    const correctionsCol = this.correctionsCollection(params.target);
    const correctionRef = doc(correctionsCol, params.id);
    const targetRef = this.targetDocRef(params.target);

    return runTransaction(correctionsCol.firestore, async (tx: FirestoreTransaction) => {
      const alreadyApplied = await tx.get(correctionRef);
      if (alreadyApplied.exists()) return { status: "alreadyApplied" } as const;

      const freshSnap = await tx.get(targetRef as never);
      if (!freshSnap.exists()) throw new Error("This card or shared limit no longer exists.");
      const fresh = freshSnap.data() as CreditCardProfile | SharedCreditLimit;
      if (fresh.deletedAt != null) throw new Error("This card or shared limit was deleted.");
      if (fresh.creditLimit !== params.previousLimit) throw new LimitCorrectionConflictError(params.previousLimit, fresh.creditLimit);

      const updated =
        params.target.kind === "card"
          ? this.cards.applyCardEdits(fresh as CreditCardProfile, { creditLimit: params.newLimit })
          : this.sharedLimits.applySharedLimitEdits(fresh as SharedCreditLimit, { creditLimit: params.newLimit });
      tx.set(targetRef as never, updated as never);

      const correction: CreditLimitCorrection = {
        id: params.id,
        cardId: params.target.kind === "card" ? params.target.cardId : null,
        sharedLimitId: params.target.kind === "sharedLimit" ? params.target.sharedLimitId : null,
        previousLimit: params.previousLimit,
        newLimit: params.newLimit,
        effectiveDate: params.effectiveDate,
        reason: params.reason,
        note: params.note.trim(),
        createdAt: new Date(),
        reversedAt: null,
        reversalId: null,
      };
      tx.set(correctionRef, correction);

      return { status: "applied", correction } as const;
    });
  }

  /** Undoes exactly one correction: restores `previousLimit` (re-checked fresh — refuses if the limit moved again since) and marks the record reversed. Idempotent on `reversalId`. */
  async reverse(target: LimitCorrectionTarget, correction: CreditLimitCorrection, reversalId: string): Promise<{ status: "reversed" | "alreadyReversed" }> {
    if (correction.reversedAt != null) return { status: "alreadyReversed" };
    const correctionsCol = this.correctionsCollection(target);
    const correctionRef = doc(correctionsCol, correction.id);
    const targetRef = this.targetDocRef(target);

    return runTransaction(correctionsCol.firestore, async (tx: FirestoreTransaction) => {
      const freshCorrectionSnap = await tx.get(correctionRef);
      if (!freshCorrectionSnap.exists()) throw new Error("This correction no longer exists.");
      const freshCorrection = freshCorrectionSnap.data() as CreditLimitCorrection;
      if (freshCorrection.reversedAt != null) return { status: "alreadyReversed" } as const;

      const freshSnap = await tx.get(targetRef as never);
      if (!freshSnap.exists()) throw new Error("This card or shared limit no longer exists.");
      const fresh = freshSnap.data() as CreditCardProfile | SharedCreditLimit;
      if (fresh.creditLimit !== freshCorrection.newLimit) {
        throw new LimitCorrectionConflictError(freshCorrection.newLimit, fresh.creditLimit);
      }

      const restored =
        target.kind === "card"
          ? this.cards.applyCardEdits(fresh as CreditCardProfile, { creditLimit: freshCorrection.previousLimit })
          : this.sharedLimits.applySharedLimitEdits(fresh as SharedCreditLimit, { creditLimit: freshCorrection.previousLimit });
      tx.set(targetRef as never, restored as never);
      tx.set(correctionRef, { ...freshCorrection, reversedAt: new Date(), reversalId });

      return { status: "reversed" } as const;
    });
  }
}
