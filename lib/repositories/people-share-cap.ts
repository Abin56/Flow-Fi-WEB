/**
 * The WRITE-LAYER limit on settling a person's share of a Loan / EMI installment (`emi-inst:` / `loan-inst:` keys):
 *
 *  1. what a receipt or an applied advance puts on that item can't exceed what is still open on it;
 *  2. what people are credited with as having PAID THE LENDER for an installment can't exceed what is recorded as
 *     paid to the lender that way (`direct-lender-settlement.ts`), added up across everyone sharing it.
 *
 * Nothing else is limited: a general payment, an advance held, purpose money and ledger-entry settlements keep their
 * own rules — none of them is tied to an installment share.
 *
 * It runs INSIDE the People write's transaction, before any write. The open amount is the People statement engine's own
 * `remainingNow` (`buildPersonCycleStatement`) over documents read at write time — no second calculation.
 *
 * How two writes can't both pass (same technique as `people-settlement-gate.ts`). A client transaction can't run a
 * query, so entries are queried with `getDocs` on every attempt, and the transaction also `get`s the documents a
 * competing write would change: a competing receipt / revert changes its person's document (balance); a competing
 * advance application changes its advance entry (the `advanceAppliedAt` lock). Either one fails this commit, and the
 * retry queries again. Documents are only read here — nothing extra is written.
 */

import { collection, doc, getDocs, query, where, type Firestore } from "firebase/firestore";
import { personSharesInstallments } from "@/lib/engines/debt-ownership";
import { directCreditedFor, directLenderPaidFor } from "@/lib/engines/direct-lender-settlement";
import { buildPersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import type { TxSession } from "@/lib/firestore/tx-session";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { emiFromFirestore, emiToFirestore, type Emi } from "@/lib/models/emi";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
  type LedgerEntry,
} from "@/lib/models/person";

const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
const SHARE_KEY = /^(emi|loan)-inst:(.+)$/;

export class ShareOverSettlementError extends Error {
  constructor(message: string) {
    super(`${message} Nothing was saved. Close this and check People before trying again.`);
    this.name = "ShareOverSettlementError";
  }
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function isShareKey(key: string): boolean {
  return SHARE_KEY.test(key);
}

export async function assertShareSettlementWithinOpen(params: {
  firestore: Firestore;
  uid: string;
  session: Pick<TxSession, "get">;
  personId: string;
  /** What this write puts on each share item. Keys that aren't installment shares are ignored. */
  amounts: ReadonlyMap<string, number>;
  /** These amounts are being recorded as paid straight to the lender: limit 2 applies as well. */
  paidToLender: boolean;
  /** The installment document under each candidate schedule — the same lookup the "agreement still exists" check makes. */
  scheduleIds: readonly string[];
  installmentDocRef: (scheduleId: string, installmentId: string) => Parameters<TxSession["get"]>[0];
  /**
   * Edit only: the payment being replaced in this same transaction. Its settlements are left out of what is already
   * settled, and it may always be re-saved up to what it already had on a share — an edit that adds nothing is never
   * refused, even on an old record that is already over.
   */
  replacing?: { paymentId: string; entries: readonly LedgerEntry[] } | null;
}): Promise<void> {
  const { firestore, uid, session, personId, replacing } = params;
  const shares = [...params.amounts].filter(([key, amount]) => isShareKey(key) && amount > PAYMENT_EPSILON);
  if (shares.length === 0) return;

  const userDoc = doc(firestore, FirestoreCollections.users, uid);
  const peopleRef = collection(userDoc, FirestoreCollections.people).withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore });
  const ledgerOf = (id: string) => collection(doc(peopleRef, id), FirestoreCollections.ledger).withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore });
  /** A ledger as it will stand once the replaced payment is gone. Its advance entry stays: applications drawn from it are carried over. */
  const withoutReplaced = (entries: readonly LedgerEntry[]) => (replacing ? entries.filter((e) => !(e.paymentId === replacing.paymentId && e.sourceKind !== "advance")) : [...entries]);

  const personSnap = await session.get(doc(peopleRef, personId));
  if (!personSnap.exists()) throw new Error("Person not found");
  const person = personSnap.data();

  const ledger = (await getDocs(ledgerOf(personId))).docs.map((d) => d.data());
  // Read each advance entry in the transaction BEFORE querying applications, so an apply that commits meanwhile is either
  // seen by the query or fails this commit.
  for (const e of ledger) {
    if (e.deletedAt == null && e.sourceKind === "advance") await session.get(doc(ledgerOf(personId), e.id));
  }
  const applications = (
    await getDocs(
      query(
        collection(doc(peopleRef, personId), FirestoreCollections.advanceApplications).withConverter({ toFirestore: advanceApplicationToFirestore, fromFirestore: advanceApplicationFromFirestore }),
        where("deletedAt", "==", null),
      ),
    )
  ).docs.map((d) => d.data());

  for (const [key, amount] of shares) {
    const installmentId = SHARE_KEY.exec(key)![2];
    let found: { scheduleId: string; installment: Installment } | null = null;
    for (const scheduleId of params.scheduleIds) {
      const snap = await session.get(params.installmentDocRef(scheduleId, installmentId));
      if (snap.exists()) {
        const installment = snap.data() as Installment;
        if (installment.deletedAt == null) {
          found = { scheduleId, installment };
          break;
        }
      }
    }
    if (!found) throw new ShareOverSettlementError("This installment no longer exists.");
    const { installment, scheduleId } = found;

    let loan: Loan | null = null;
    let emi: Emi | null = null;
    if (installment.ownerType === "loan") {
      const snap = await session.get(doc(collection(userDoc, FirestoreCollections.loans).withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }), installment.ownerId));
      loan = snap.exists() ? snap.data() : null;
    } else {
      const snap = await session.get(doc(collection(userDoc, FirestoreCollections.emis).withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }), installment.ownerId));
      emi = snap.exists() ? snap.data() : null;
    }
    const owner = loan ?? emi;
    if (!owner) throw new ShareOverSettlementError("This EMI or Loan no longer exists.");

    const statement = buildPersonCycleStatement({
      person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
      ledgerEntries: withoutReplaced(ledger),
      loanIds: new Set(loan ? [loan.id] : []),
      emis: emi ? [emi] : [],
      loans: loan ? [loan] : [],
      installments: [installment],
      advanceApplications: applications,
      cycle: ALL_TIME,
    });
    const row = statement.rows.find((r) => r.key === key && r.kind === "obligation");
    // A Loan whose counterparty is this person isn't a share of my lender installment: it is settled on the Loan, by its own rules.
    if (row && row.category !== "emi") continue;
    const open = round2(row?.remainingNow ?? 0);
    const hadOnShare = replacing ? round2(replacing.entries.filter((e) => e.obligationRef === key && e.sourceKind !== "advance").reduce((t, e) => t + e.amount, 0)) : 0;
    if (amount > Math.max(open, hadOnShare) + PAYMENT_EPSILON) {
      throw new ShareOverSettlementError(
        row == null
          ? `${person.name} has no share of installment #${installment.sequenceNumber} to settle.`
          : open > PAYMENT_EPSILON
            ? `${person.name} has only ${rupees(open)} still open on installment #${installment.sequenceNumber}, not ${rupees(amount)}.`
            : `${person.name} has nothing left open on installment #${installment.sequenceNumber} — it may already be recorded.`,
      );
    }

    if (!params.paidToLender) continue;
    const payments = (
      await getDocs(
        collection(userDoc, FirestoreCollections.paymentSchedules, scheduleId, FirestoreCollections.installments, installmentId, FirestoreCollections.payments).withConverter({
          toFirestore: installmentPaymentToFirestore,
          fromFirestore: installmentPaymentFromFirestore,
        }),
      )
    ).docs.map((d) => d.data());
    const lenderDirect = directLenderPaidFor(payments, installmentId);
    // Everyone who shares this installment: each one's document is read first (a credit they get meanwhile fails this commit).
    const sharers = new Set<string>([...(owner.ownershipShares ?? []).flatMap((s) => (s.personId != null ? [s.personId] : [])), ...(owner.beneficiaryPersonId ? [owner.beneficiaryPersonId] : [])]);
    let others = 0;
    for (const id of sharers) {
      if (id === personId || !personSharesInstallments(owner, id)) continue;
      const other = await session.get(doc(peopleRef, id));
      if (!other.exists()) continue;
      others = round2(others + directCreditedFor((await getDocs(ledgerOf(id))).docs.map((d) => d.data()), key));
    }
    const credited = round2(others + directCreditedFor(withoutReplaced(ledger), key));
    const hadDirect = replacing ? directCreditedFor(replacing.entries, key) : 0;
    if (amount > hadDirect + PAYMENT_EPSILON && credited + amount > lenderDirect + PAYMENT_EPSILON) {
      throw new ShareOverSettlementError(
        `Installment #${installment.sequenceNumber} has ${rupees(lenderDirect)} recorded as paid directly to the lender and ${rupees(credited)} already credited to people, so ${rupees(amount)} more can't be credited.`,
      );
    }
  }
}
