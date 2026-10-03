/**
 * People settlement gate at the WRITE layer — the authoritative enforcement of the rule the lender-payment
 * dialog shows (`docs/shared-debt-ownership-audit.md`, `lib/engines/linked-people-readiness.ts`):
 *
 *   a lender payment must not settle an installment that is already DUE while a person's linked share of
 *   that installment still has money to come in.
 *
 * It runs INSIDE the payment's Firestore transaction, after the allocation is computed from fresh
 * installments and before any write, and decides from current documents only — never from what the
 * dialog captured:
 *
 *  - the Loan / EMI document is re-read in the transaction (ownership shares, opt-in, closed / trashed);
 *  - each sharing person's document is read in the transaction, so a People payment or revert that
 *    commits while this payment is in flight conflicts with it and Firestore re-runs this check;
 *  - their ledger entries and advance applications are then read fresh and fed to the SAME engines the
 *    People Ledger and the dialog use (`buildPersonCycleStatement` → `linkedPeopleForInstallments` →
 *    `peopleSettlementGate`), so the two layers can never disagree.
 *
 * Which installments: `peopleGateInstallmentIds` over the installments this payment's own allocation
 * touches. Lent Loans and agreements with no person sharing installments are never gated.
 */

import { collection, doc, getDocs, query, where, type Firestore, type Transaction as FirestoreTransaction } from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { personSharesInstallments } from "@/lib/engines/debt-ownership";
import { buildPersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import {
  linkedPeopleForInstallments,
  peopleGateInstallmentIds,
  peopleSettlementGate,
  PeopleSettlementPendingError,
  type UnsettledPeopleAcknowledgement,
} from "@/lib/engines/linked-people-readiness";
import { emiFromFirestore, emiToFirestore, type Emi } from "@/lib/models/emi";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
} from "@/lib/models/person";

const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

export async function assertLinkedPeopleSettled(params: {
  firestore: Firestore;
  uid: string;
  tx: FirestoreTransaction;
  source: { kind: "loan" | "emi"; id: string };
  /** Every installment of the schedule, as read in this transaction. */
  installments: readonly Installment[];
  /** The installments this payment's allocation settles or reaches. */
  touched: readonly Pick<Installment, "id" | "dueDate">[];
  paymentDate: Date;
  acknowledgement?: UnsettledPeopleAcknowledgement | null;
}): Promise<void> {
  const { firestore, uid, tx, source } = params;
  if (params.acknowledgement?.acknowledgedUnsettledPeople === true && params.acknowledgement.reason.trim() !== "") return;
  const installmentIds = peopleGateInstallmentIds(params.touched, params.paymentDate);
  if (installmentIds.length === 0) return;

  const userDoc = doc(firestore, FirestoreCollections.users, uid);
  let loan: Loan | null = null;
  let emi: Emi | null = null;
  if (source.kind === "loan") {
    const snap = await tx.get(doc(collection(userDoc, FirestoreCollections.loans).withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }), source.id));
    if (!snap.exists()) return;
    loan = snap.data();
    if (loan.direction !== "taken") return;
  } else {
    const snap = await tx.get(doc(collection(userDoc, FirestoreCollections.emis).withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }), source.id));
    if (!snap.exists()) return;
    emi = snap.data();
  }
  const owner = (loan ?? emi)!;
  const candidates = new Set<string>();
  for (const s of owner.ownershipShares ?? []) if (s.personId != null) candidates.add(s.personId);
  if (owner.beneficiaryPersonId) candidates.add(owner.beneficiaryPersonId);
  const personIds = [...candidates].filter((id) => personSharesInstallments(owner, id));
  if (personIds.length === 0) return;

  const peopleRef = collection(userDoc, FirestoreCollections.people).withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore });
  const statements = [];
  for (const personId of personIds) {
    // In-transaction read FIRST: a People payment / revert committing after this point fails our commit.
    const personSnap = await tx.get(doc(peopleRef, personId));
    if (!personSnap.exists()) continue;
    const person = personSnap.data();
    const personDoc = doc(peopleRef, personId);
    const [ledger, applications] = await Promise.all([
      getDocs(collection(personDoc, FirestoreCollections.ledger).withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore })),
      getDocs(
        query(
          collection(personDoc, FirestoreCollections.advanceApplications).withConverter({
            toFirestore: advanceApplicationToFirestore,
            fromFirestore: advanceApplicationFromFirestore,
          }),
          where("deletedAt", "==", null),
        ),
      ),
    ]);
    statements.push(
      buildPersonCycleStatement({
        person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
        ledgerEntries: ledger.docs.map((d) => d.data()),
        loanIds: new Set(loan ? [loan.id] : []),
        emis: emi ? [emi] : [],
        loans: loan ? [loan] : [],
        installments: [...params.installments],
        advanceApplications: applications.docs.map((d) => d.data()),
        cycle: ALL_TIME,
      }),
    );
  }
  const gate = peopleSettlementGate(linkedPeopleForInstallments({ statements, installmentIds, sourceKind: source.kind, lenderDue: 0 }));
  if (gate.blocked) throw new PeopleSettlementPendingError(gate);
}
