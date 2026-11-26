/**
 * The WRITE-LAYER lock on taking back a lender payment that People are credited against. Removing or rewriting a
 * payment may not leave people credited with more "paid directly to the lender" than is still recorded as paid that way.
 * Both sides are read with the existing recognition rules (`direct-lender-settlement.ts`); nothing here writes, and no
 * People record is ever removed — the receipt has to be reverted in People first.
 *
 * Only a write that LOWERS the direct amount on an installment is checked, so ordinary payments, and records that were
 * already inconsistent before this write touched them, behave as before.
 *
 * Against a credit saved at the same moment: each person's document is read in the transaction before their ledger is
 * queried (a credit changes it, so this commit fails and the retry queries again); the other way round, the credit
 * reads the installment document, which every reversal and correction rewrites. Everyone is checked, not only current
 * sharers, so a credit held by someone no longer on the agreement still counts.
 */

import { collection, doc, getDocs, type Firestore, type Transaction } from "firebase/firestore";
import { directCreditedFor, directLenderPaidFor, isDirectLenderPayment } from "@/lib/engines/direct-lender-settlement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { formatCurrencyExact } from "@/lib/format";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type InstallmentPayment } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, type LedgerEntry } from "@/lib/models/person";

export interface StrandedDirectCredit {
  installmentId: string;
  sequenceNumber: number | null;
  /** Direct lender payments that would remain on the installment. */
  lenderDirectAfter: number;
  /** What people are credited with as paid directly for it. */
  credited: number;
  payers: { name: string; amount: number }[];
}

export function strandedCreditMessage(s: StrandedDirectCredit): string {
  const payers = s.payers.map((p) => `${p.name} ${formatCurrencyExact(p.amount)}`).join(", ");
  const installment = s.sequenceNumber == null ? "this installment" : `installment #${s.sequenceNumber}`;
  return `People shows ${payers} as paid directly to the lender for ${installment}. Revert that payment in People first, then try again.`;
}

/** The first installment this write would leave over-credited, or null. */
export async function findStrandedDirectCredit(params: {
  firestore: Firestore;
  uid: string;
  /** The writing transaction; null for a read-only look ahead. */
  tx: Transaction | null;
  ownerType: "loan" | "emi";
  scheduleId: string;
  /** The payments this write takes away, as read fresh. */
  removed: readonly InstallmentPayment[];
  /** The payments it writes in their place (an edit). */
  added?: readonly InstallmentPayment[];
  sequenceNumberOf: (installmentId: string) => number | null;
  /** `{personId}|{paymentId}` of People payments that are being reverted together with it (look-ahead only). */
  ignore?: ReadonlySet<string>;
}): Promise<StrandedDirectCredit | null> {
  const { firestore, uid, tx, ownerType, scheduleId } = params;
  const direct = params.removed.filter(isDirectLenderPayment);
  if (direct.length === 0) return null;
  const userDoc = doc(firestore, FirestoreCollections.users, uid);
  const removedIds = new Set(params.removed.map((p) => p.id));

  const lowered: { installmentId: string; after: number }[] = [];
  for (const installmentId of new Set(direct.map((p) => p.installmentId))) {
    const snap = await getDocs(
      collection(userDoc, FirestoreCollections.paymentSchedules, scheduleId, FirestoreCollections.installments, installmentId, FirestoreCollections.payments).withConverter({
        toFirestore: installmentPaymentToFirestore,
        fromFirestore: installmentPaymentFromFirestore,
      }),
    );
    const current = snap.docs.map((d) => d.data());
    const before = directLenderPaidFor(current, installmentId);
    const after = directLenderPaidFor([...current.filter((p) => !removedIds.has(p.id)), ...(params.added ?? [])], installmentId);
    if (after < before - PAYMENT_EPSILON) lowered.push({ installmentId, after });
  }
  if (lowered.length === 0) return null;

  const peopleRef = collection(userDoc, FirestoreCollections.people);
  const people = await getDocs(peopleRef);
  const ledgers: { name: string; entries: LedgerEntry[] }[] = [];
  for (const person of people.docs) {
    if (person.data().deletedAt != null) continue;
    if (tx) await tx.get(doc(peopleRef, person.id));
    const ledger = await getDocs(
      collection(userDoc, FirestoreCollections.people, person.id, FirestoreCollections.ledger).withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }),
    );
    ledgers.push({
      name: (person.data().name as string | undefined) ?? "Someone",
      entries: ledger.docs.map((d) => d.data()).filter((e) => !params.ignore?.has(`${person.id}|${e.paymentId}`)),
    });
  }

  for (const { installmentId, after } of lowered) {
    const key = `${ownerType}-inst:${installmentId}`;
    const payers = ledgers.map((l) => ({ name: l.name, amount: directCreditedFor(l.entries, key) })).filter((p) => p.amount > PAYMENT_EPSILON);
    const credited = round2(payers.reduce((t, p) => t + p.amount, 0));
    if (credited > after + PAYMENT_EPSILON) {
      return { installmentId, sequenceNumber: params.sequenceNumberOf(installmentId), lenderDirectAfter: after, credited, payers };
    }
  }
  return null;
}
