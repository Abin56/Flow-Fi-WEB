/**
 * Page-scoped factory for `BillOccurrence`/`PaymentRecord` repositories —
 * kept out of `lib/repositories/repository-factory.ts` deliberately, since
 * that shared file is under active concurrent edit by another session
 * building the Credit Cards page right now. This mirrors the exact same
 * `users/{uid}/bills/{billId}/occurrences` and `.../payments` subcollection
 * wiring `createBillRepository`'s doc comment describes — once the shared
 * factory settles, these functions can be folded in there instead of
 * duplicated.
 */

import { collection, doc, type FirestoreDataConverter } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import {
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  paymentRecordFromFirestore,
  paymentRecordToFirestore,
  type BillOccurrence,
  type PaymentRecord,
} from "@/lib/models/bill";
import { BillOccurrenceRepository, PaymentRepository, type BillRepository } from "@/lib/repositories/bill-repository";

const occurrenceConverter: FirestoreDataConverter<BillOccurrence> = {
  toFirestore: billOccurrenceToFirestore,
  fromFirestore: billOccurrenceFromFirestore,
};

const paymentConverter: FirestoreDataConverter<PaymentRecord> = {
  toFirestore: paymentRecordToFirestore,
  fromFirestore: paymentRecordFromFirestore,
};

export function createBillOccurrenceRepository(
  uid: string,
  billId: string,
  billRepository: BillRepository,
): BillOccurrenceRepository {
  const occurrencesRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.bills,
    billId,
    FirestoreCollections.billOccurrences,
  ).withConverter(occurrenceConverter);

  const legacyBillDoc = doc(db, FirestoreCollections.users, uid, FirestoreCollections.bills, billId);
  const legacyPaymentsCollection = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.bills,
    billId,
    FirestoreCollections.payments,
  );

  return new BillOccurrenceRepository(occurrencesRef, billRepository, legacyBillDoc, legacyPaymentsCollection);
}

export function createPaymentRepository(
  uid: string,
  billId: string,
  billOccurrenceRepository: BillOccurrenceRepository,
): PaymentRepository {
  const paymentsRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.bills,
    billId,
    FirestoreCollections.payments,
  ).withConverter(paymentConverter);

  return new PaymentRepository(paymentsRef, billOccurrenceRepository);
}
