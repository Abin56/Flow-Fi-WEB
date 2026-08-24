/**
 * Page-scoped factory for `LedgerRepository` — kept out of
 * `lib/repositories/repository-factory.ts` since that shared factory is
 * one-repository-per-collection and `LedgerEntry`s live in a per-person
 * `users/{uid}/people/{personId}/ledger` subcollection (see
 * `PersonRepository`'s doc comment in `lib/repositories/person-repository.ts`),
 * the same shape `features/bills/lib/bill-occurrence-factory.ts` already
 * established for `BillOccurrence`s under `bills/{billId}/occurrences`.
 */

import { collection, type FirestoreDataConverter } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, type LedgerEntry } from "@/lib/models/person";
import { LedgerRepository, type PersonRepository } from "@/lib/repositories/person-repository";

const ledgerEntryConverter: FirestoreDataConverter<LedgerEntry> = {
  toFirestore: ledgerEntryToFirestore,
  fromFirestore: ledgerEntryFromFirestore,
};

export function createLedgerRepository(
  uid: string,
  personId: string,
  personRepository: PersonRepository,
): LedgerRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.people,
    personId,
    FirestoreCollections.ledger,
  ).withConverter(ledgerEntryConverter);
  return new LedgerRepository(ref, personRepository);
}
