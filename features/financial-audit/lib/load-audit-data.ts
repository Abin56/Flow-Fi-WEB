/**
 * READ-ONLY loader for the Financial Audit. Only `getDocs` on the signed-in owner's `users/{uid}/…` paths —
 * under the existing security rules, no admin access, no writes. Includes soft-deleted documents (the audit
 * needs them to spot half-reversed actions). A document that fails to convert is counted in `skipped`, never
 * thrown, so one bad legacy record can't hide the rest.
 */

import {
  collection,
  getDocs,
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import type { AuditInput } from "@/lib/engines/financial-audit";
import { FirestoreCollections as C } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { creditCardProfileFromFirestore, creditCardProfileToFirestore } from "@/lib/models/credit-card";
import { emiFromFirestore, emiPaymentBreakdownFromFirestore, emiPaymentBreakdownToFirestore, emiToFirestore, type EmiPaymentBreakdown } from "@/lib/models/emi";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  type Installment,
  type InstallmentPayment,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";

export interface LoadedAuditData {
  input: AuditInput;
  /** Read-only extras for the legacy Case A card-EMI inspection (`legacy-card-emi-inspection.ts`). */
  cardEmi: { cards: CreditCardProfile[]; breakdowns: EmiPaymentBreakdown[] };
  /** Documents that could not be read/converted (kind → count). */
  skipped: Record<string, number>;
  counts: Record<string, number>;
}

function converter<T>(from: (s: QueryDocumentSnapshot<DocumentData>) => T, to: (v: T) => DocumentData): FirestoreDataConverter<T> {
  return { fromFirestore: (s) => from(s as QueryDocumentSnapshot<DocumentData>), toFirestore: (v) => to(v as T) };
}

export async function loadAuditData(db: Firestore, uid: string): Promise<LoadedAuditData> {
  const skipped: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const read = async <T>(kind: string, ref: CollectionReference<T>): Promise<T[]> => {
    const snap = await getDocs(ref);
    const out: T[] = [];
    for (const d of snap.docs) {
      try {
        out.push(d.data());
      } catch {
        skipped[kind] = (skipped[kind] ?? 0) + 1;
      }
    }
    counts[kind] = (counts[kind] ?? 0) + out.length;
    return out;
  };
  const user = (...path: string[]) => collection(db, C.users, uid, ...path);

  const [accounts, transactions, people, loans, emis, expenses, cards] = await Promise.all([
    read("accounts", user(C.accounts).withConverter(converter(accountFromFirestore, accountToFirestore))),
    read("transactions", user(C.transactions).withConverter(converter(transactionFromFirestore, transactionToFirestore))),
    read("people", user(C.people).withConverter(converter(personFromFirestore, personToFirestore))),
    read("loans", user(C.loans).withConverter(converter(loanFromFirestore, loanToFirestore))),
    read("emis", user(C.emis).withConverter(converter(emiFromFirestore, emiToFirestore))),
    read("expenses", user(C.expenses).withConverter(converter(expenseFromFirestore, expenseToFirestore))),
    read("creditCards", user(C.creditCards).withConverter(converter(creditCardProfileFromFirestore, creditCardProfileToFirestore))),
  ]);

  const ledgerEntryConverter = converter(ledgerEntryFromFirestore, ledgerEntryToFirestore);
  const fundConverter = converter(purposeFundFromFirestore, purposeFundToFirestore);
  const perPerson = await Promise.all(
    people.map(async (p) => ({
      ledger: await read("ledgerEntries", user(C.people, p.id, C.ledger).withConverter(ledgerEntryConverter)),
      funds: await read("purposeFunds", user(C.people, p.id, C.purposeFunds).withConverter(fundConverter)),
    })),
  );

  // Loan and EMI schedules need payments; split-expense schedules only need their installments.
  const paymentScheduleIds = new Set([...loans.map((l) => l.scheduleId), ...emis.map((e) => e.scheduleId)].filter(Boolean));
  const scheduleIds = new Set([...paymentScheduleIds, ...expenses.flatMap((e) => (e.scheduleId ? [e.scheduleId] : []))]);
  const installmentConverter = converter(installmentFromFirestore, installmentToFirestore);
  const paymentConverter = converter(installmentPaymentFromFirestore, installmentPaymentToFirestore);
  const installments: Installment[] = [];
  const payments: InstallmentPayment[] = [];
  await Promise.all(
    [...scheduleIds].map(async (scheduleId) => {
      const list = await read("installments", user(C.paymentSchedules, scheduleId, C.installments).withConverter(installmentConverter));
      installments.push(...list);
      if (!paymentScheduleIds.has(scheduleId)) return;
      await Promise.all(
        list.map(async (i) => {
          payments.push(...(await read("installmentPayments", user(C.paymentSchedules, scheduleId, C.installments, i.id, C.payments).withConverter(paymentConverter))));
        }),
      );
    }),
  );

  // Payment breakdowns (principal / interest split) of the card-linked EMIs only — read, never written.
  const breakdownConverter = converter(emiPaymentBreakdownFromFirestore, emiPaymentBreakdownToFirestore);
  const breakdowns = (
    await Promise.all(emis.filter((e) => e.linkedCreditCardId != null).map((e) => read("emiPaymentBreakdowns", user(C.emis, e.id, C.paymentBreakdowns).withConverter(breakdownConverter))))
  ).flat();

  return {
    skipped,
    counts,
    cardEmi: { cards, breakdowns },
    input: {
      accounts,
      transactions,
      creditCardAccountIds: new Set(cards.filter((c) => c.deletedAt == null).map((c) => c.accountId)),
      people,
      ledgerEntries: perPerson.flatMap((p) => p.ledger),
      purposeFunds: perPerson.flatMap((p) => p.funds),
      loans,
      emis,
      expenses,
      installments,
      payments,
    },
  };
}
