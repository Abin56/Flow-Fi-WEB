/**
 * Page-scoped factory for `ExpenseRepository` — kept out of
 * `lib/repositories/repository-factory.ts` for the same reason
 * `features/bills/lib/bill-occurrence-factory.ts` and
 * `features/people/lib/ledger-factory.ts` are: `ExpenseRepository` composes
 * several per-parent subcollection repositories (`PaymentScheduleRepository`,
 * a per-schedule `InstallmentRepository`, a per-person `LedgerRepository`)
 * that don't fit the shared factory's one-repository-per-collection shape.
 */

import { collection, type FirestoreDataConverter } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { expenseFromFirestore, expenseToFirestore, type Expense } from "@/lib/models/expense";
import {
  installmentFromFirestore,
  installmentToFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
  type InstallmentPayment,
  type PaymentSchedule,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, type LedgerEntry } from "@/lib/models/person";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";

const expenseConverter: FirestoreDataConverter<Expense> = {
  toFirestore: expenseToFirestore,
  fromFirestore: expenseFromFirestore,
};

const paymentScheduleConverter: FirestoreDataConverter<PaymentSchedule> = {
  toFirestore: paymentScheduleToFirestore,
  fromFirestore: paymentScheduleFromFirestore,
};

const installmentConverter: FirestoreDataConverter<Installment> = {
  toFirestore: installmentToFirestore,
  fromFirestore: installmentFromFirestore,
};

const installmentPaymentConverter: FirestoreDataConverter<InstallmentPayment> = {
  toFirestore: installmentPaymentToFirestore,
  fromFirestore: installmentPaymentFromFirestore,
};

const ledgerEntryConverter: FirestoreDataConverter<LedgerEntry> = {
  toFirestore: ledgerEntryToFirestore,
  fromFirestore: ledgerEntryFromFirestore,
};

export function createExpenseRepository(
  uid: string,
  transactionRepository: TransactionRepository,
  personRepository: PersonRepository,
): ExpenseRepository {
  const expensesRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.expenses).withConverter(
    expenseConverter,
  );
  const paymentScheduleRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.paymentSchedules,
  ).withConverter(paymentScheduleConverter);
  const paymentScheduleRepository = new PaymentScheduleRepository(paymentScheduleRef);

  const installmentRepositoryFor = (scheduleId: string): InstallmentRepository => {
    const installmentsRef = collection(
      db,
      FirestoreCollections.users,
      uid,
      FirestoreCollections.paymentSchedules,
      scheduleId,
      FirestoreCollections.installments,
    ).withConverter(installmentConverter);
    return new InstallmentRepository(installmentsRef);
  };

  const ledgerRepositoryFor = (personId: string): LedgerRepository => {
    const ledgerRef = collection(
      db,
      FirestoreCollections.users,
      uid,
      FirestoreCollections.people,
      personId,
      FirestoreCollections.ledger,
    ).withConverter(ledgerEntryConverter);
    return new LedgerRepository(ledgerRef, personRepository);
  };

  return new ExpenseRepository(
    expensesRef,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
  );
}

export function createInstallmentPaymentRepositoryForSchedule(
  uid: string,
  scheduleId: string,
  installmentId: string,
): InstallmentPaymentRepository {
  const installmentsRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.paymentSchedules,
    scheduleId,
    FirestoreCollections.installments,
  ).withConverter(installmentConverter);
  const installmentRepository = new InstallmentRepository(installmentsRef);
  const paymentsRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.paymentSchedules,
    scheduleId,
    FirestoreCollections.installments,
    installmentId,
    FirestoreCollections.payments,
  ).withConverter(installmentPaymentConverter);
  return new InstallmentPaymentRepository(paymentsRef, installmentRepository);
}
