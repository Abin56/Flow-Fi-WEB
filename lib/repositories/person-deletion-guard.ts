/**
 * What stops a person being permanently deleted. Deleting removes their ledger for good, and leaves any money record
 * that names them (a bank movement, an expense share, an EMI / Loan share) with nobody it can be reverted through. So
 * it is allowed only when nothing live depends on them. Read-only; the queries are repeated on every attempt of the
 * delete's transaction. Entries that were already reverted / deleted don't block — they move no balance.
 */

import { collection, getDocs, query, where, type DocumentReference } from "firebase/firestore";
import { repayerIds } from "@/lib/repositories/repayment-link-guard";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { formatCurrencyExact } from "@/lib/format";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";

export class PersonDeletionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonDeletionBlockedError";
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function personDeletionBlockers(params: {
  /** `users/{uid}`. */
  userDoc: DocumentReference;
  personId: string;
  /** As read fresh. */
  person: { openingBalance?: number; currentBalance?: number };
}): Promise<string[]> {
  const { userDoc, personId, person } = params;
  const personDoc = (name: string) => collection(userDoc, FirestoreCollections.people, personId, name);
  const live = (docs: { data: () => Record<string, unknown> }[]) => docs.map((d) => d.data()).filter((d) => d.deletedAt == null);

  const [ledger, applications, funds, emis, loans, expenses, linked, funded] = await Promise.all([
    getDocs(personDoc(FirestoreCollections.ledger)),
    getDocs(personDoc(FirestoreCollections.advanceApplications)),
    getDocs(personDoc(FirestoreCollections.purposeFunds)),
    getDocs(collection(userDoc, FirestoreCollections.emis)),
    getDocs(collection(userDoc, FirestoreCollections.loans)),
    getDocs(collection(userDoc, FirestoreCollections.expenses)),
    getDocs(query(collection(userDoc, FirestoreCollections.transactions), where("linkedPersonId", "==", personId))),
    getDocs(query(collection(userDoc, FirestoreCollections.transactions), where("fundedByPersonId", "==", personId))),
  ]);

  const reasons: string[] = [];
  const outstanding = Math.abs(person.currentBalance ?? 0) > PAYMENT_EPSILON ? person.currentBalance! : (person.openingBalance ?? 0);
  if (Math.abs(outstanding) > PAYMENT_EPSILON) reasons.push(`a balance of ${formatCurrencyExact(Math.abs(outstanding))} on record`);
  const entries = live(ledger.docs).length;
  if (entries > 0) reasons.push(plural(entries, "ledger entry", "ledger entries"));
  if (live(applications.docs).length > 0) reasons.push("applied advance");
  if (live(funds.docs).length > 0) reasons.push("money kept for a purpose");
  const transactions = new Set([...linked.docs, ...funded.docs].filter((d) => d.data().deletedAt == null).map((d) => d.id)).size;
  if (transactions > 0) reasons.push(plural(transactions, "transaction"));
  const shared = live(expenses.docs).filter((e) => ((e.participants as { personId?: string | null }[] | undefined) ?? []).some((p) => p.personId === personId)).length;
  if (shared > 0) reasons.push(plural(shared, "shared expense"));
  // A share they repay, or a Loan they are the other side of.
  const agreements = [
    ...live(emis.docs).filter((e) => repayerIds(e as OwnershipSource).includes(personId)),
    ...live(loans.docs).filter((l) => l.personId === personId || repayerIds(l as OwnershipSource).includes(personId)),
  ].length;
  if (agreements > 0) reasons.push(plural(agreements, "linked EMI / Loan", "linked EMIs / Loans"));
  return reasons;
}
