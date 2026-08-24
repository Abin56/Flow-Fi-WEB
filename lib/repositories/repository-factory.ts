/**
 * Mirrors the `users/{uid}/{collection}` scoping pattern every Flutter
 * `*_providers.dart` file builds via `firestoreProvider` +
 * `currentUserIdProvider` (see `lib/core/providers/firebase_providers.dart`).
 * Each function below returns a repository whose Firestore collection is
 * already scoped to the signed-in user and wired to the exact converter
 * pair from the matching model file.
 */

import { collection, collectionGroup, type FirestoreDataConverter, type Query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { billFromFirestore, billToFirestore, type Bill } from "@/lib/models/bill";
import { budgetFromFirestore, budgetToFirestore, type Budget } from "@/lib/models/budget";
import { categoryFromFirestore, categoryToFirestore, type Category } from "@/lib/models/category";
import { savingsGoalFromFirestore, savingsGoalToFirestore, type SavingsGoal } from "@/lib/models/savings-goal";
import {
  creditCardProfileFromFirestore,
  creditCardProfileToFirestore,
  sharedCreditLimitFromFirestore,
  sharedCreditLimitToFirestore,
  statementFromFirestore,
  statementToFirestore,
  statementPaymentFromFirestore,
  statementPaymentToFirestore,
  type CreditCardProfile,
  type SharedCreditLimit,
  type Statement,
  type StatementPayment,
} from "@/lib/models/credit-card";
import {
  emiFromFirestore,
  emiToFirestore,
  emiPaymentBreakdownFromFirestore,
  emiPaymentBreakdownToFirestore,
  type Emi,
  type EmiPaymentBreakdown,
} from "@/lib/models/emi";
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
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, type LedgerEntry, type Person } from "@/lib/models/person";
import { expenseFromFirestore, expenseToFirestore, type Expense } from "@/lib/models/expense";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { stagedRecordFromFirestore, stagedRecordToFirestore, type StagedRecord } from "@/lib/models/document-import";
import {
  smsTransactionCandidateFromFirestore,
  smsTransactionCandidateToFirestore,
  type SmsTransactionCandidate,
} from "@/lib/models/sms-transaction-candidate";
import { AccountRepository } from "./account-repository";
import { BillRepository } from "./bill-repository";
import { BudgetRepository } from "./budget-repository";
import { CategoryRepository } from "./category-repository";
import {
  CreditCardRepository,
  SharedCreditLimitRepository,
  StatementPaymentRepository,
  StatementRepository,
} from "./credit-card-repository";
import { DocumentImportRecordRepository } from "./document-import-record-repository";
import { SmsTransactionCandidateRepository } from "./sms-transaction-candidate-repository";
import { EmiPaymentBreakdownRepository, EmiRepository } from "./emi-repository";
import { ExpenseRepository } from "./expense-repository";
import { LoanRepository } from "./loan-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { SavingsRepository } from "./savings-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import { TransactionRepository } from "./transaction-repository";

const accountConverter: FirestoreDataConverter<Account> = {
  toFirestore: accountToFirestore,
  fromFirestore: accountFromFirestore,
};

const transactionConverter: FirestoreDataConverter<Transaction> = {
  toFirestore: transactionToFirestore,
  fromFirestore: transactionFromFirestore,
};

const budgetConverter: FirestoreDataConverter<Budget> = {
  toFirestore: budgetToFirestore,
  fromFirestore: budgetFromFirestore,
};

const billConverter: FirestoreDataConverter<Bill> = {
  toFirestore: billToFirestore,
  fromFirestore: billFromFirestore,
};

const categoryConverter: FirestoreDataConverter<Category> = {
  toFirestore: categoryToFirestore,
  fromFirestore: categoryFromFirestore,
};

export function createAccountRepository(uid: string): AccountRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.accounts).withConverter(
    accountConverter,
  );
  return new AccountRepository(ref);
}

export function createTransactionRepository(uid: string, accountRepository: AccountRepository): TransactionRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.transactions).withConverter(
    transactionConverter,
  );
  return new TransactionRepository(ref, accountRepository);
}

export function createBudgetRepository(uid: string): BudgetRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.budgets).withConverter(
    budgetConverter,
  );
  return new BudgetRepository(ref);
}

/**
 * `Bill` templates only — `BillOccurrence`s live in a per-bill
 * `occurrences` subcollection (`BillOccurrenceRepository` needs a raw
 * legacy-document reference per bill to construct), which doesn't fit this
 * uid-scoped factory's one-repository-per-collection shape. The dashboard's
 * upcoming-bills list reads `Bill.nextDueDate` directly instead (see
 * `hooks/use-bills.ts`).
 */
export function createBillRepository(uid: string): BillRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.bills).withConverter(
    billConverter,
  );
  return new BillRepository(ref);
}

export function createCategoryRepository(uid: string): CategoryRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.categories).withConverter(
    categoryConverter,
  );
  return new CategoryRepository(ref);
}

const savingsGoalConverter: FirestoreDataConverter<SavingsGoal> = {
  toFirestore: savingsGoalToFirestore,
  fromFirestore: savingsGoalFromFirestore,
};

export function createSavingsRepository(uid: string): SavingsRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.savingsGoals).withConverter(
    savingsGoalConverter,
  );
  return new SavingsRepository(ref);
}

const personConverter: FirestoreDataConverter<Person> = {
  toFirestore: personToFirestore,
  fromFirestore: personFromFirestore,
};

/**
 * `Person` records (`users/{uid}/people`) — the Lending feature's
 * creditor/debtor contacts. `LoanRepository` requires every `Loan` to carry
 * a `personId`; the Loans page (bank/institutional loans, not
 * person-to-person lending) reuses this same collection to represent "who
 * the money is owed to" so it doesn't need a second, parallel entity type —
 * see the doc comment on `createLoanRepository` for how the two are
 * reconciled.
 */
export function createPersonRepository(uid: string): PersonRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.people).withConverter(
    personConverter,
  );
  return new PersonRepository(ref);
}

const creditCardConverter: FirestoreDataConverter<CreditCardProfile> = {
  toFirestore: creditCardProfileToFirestore,
  fromFirestore: creditCardProfileFromFirestore,
};

const sharedCreditLimitConverter: FirestoreDataConverter<SharedCreditLimit> = {
  toFirestore: sharedCreditLimitToFirestore,
  fromFirestore: sharedCreditLimitFromFirestore,
};

const statementConverter: FirestoreDataConverter<Statement> = {
  toFirestore: statementToFirestore,
  fromFirestore: statementFromFirestore,
};

const statementPaymentConverter: FirestoreDataConverter<StatementPayment> = {
  toFirestore: statementPaymentToFirestore,
  fromFirestore: statementPaymentFromFirestore,
};

const emiConverter: FirestoreDataConverter<Emi> = {
  toFirestore: emiToFirestore,
  fromFirestore: emiFromFirestore,
};

export function createSharedCreditLimitRepository(uid: string): SharedCreditLimitRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.sharedCreditLimits).withConverter(
    sharedCreditLimitConverter,
  );
  return new SharedCreditLimitRepository(ref);
}

export function createCreditCardRepository(
  uid: string,
  sharedCreditLimitRepository?: SharedCreditLimitRepository,
): CreditCardRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.creditCards).withConverter(
    creditCardConverter,
  );
  return new CreditCardRepository(ref, sharedCreditLimitRepository);
}

/**
 * `Statement`s live in a per-card `creditCards/{cardId}/statements`
 * subcollection (see `FirestoreCollections.statements`), so — unlike the
 * flat, uid-scoped repositories above — this factory needs the owning
 * card's id too.
 */
export function createStatementRepository(uid: string, cardId: string): StatementRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.creditCards,
    cardId,
    FirestoreCollections.statements,
  ).withConverter(statementConverter);
  return new StatementRepository(ref);
}

export function createStatementPaymentRepository(
  uid: string,
  cardId: string,
  statementId: string,
  statementRepository: StatementRepository,
  transactionRepository: TransactionRepository,
): StatementPaymentRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.creditCards,
    cardId,
    FirestoreCollections.statements,
    statementId,
    FirestoreCollections.statementPayments,
  ).withConverter(statementPaymentConverter);
  return new StatementPaymentRepository(ref, statementRepository, transactionRepository);
}

/**
 * A live query across every card's `statements` subcollection at once (a
 * Firestore `collectionGroup` query), scoped to this user by filtering on
 * `Statement.cardId` membership client-side against the caller's own active
 * cards — collection-group queries can't be scoped to a uid path prefix
 * directly. Used by `hooks/use-credit-cards.ts` so the workspace doesn't
 * need to open one `watchAll` per card.
 */
export function createStatementsCollectionGroupQuery(): Query<Statement> {
  return collectionGroup(db, FirestoreCollections.statements).withConverter(statementConverter) as Query<Statement>;
}

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

/**
 * `EmiRepository` needs a `PaymentScheduleRepository` plus a per-schedule
 * `InstallmentRepository` factory (installments live in a
 * `paymentSchedules/{scheduleId}/installments` subcollection) — mirrors the
 * dependency shape `EmiRepository`'s own constructor doc comment describes.
 * Only read access (`getAll`/`watchAll`) is exercised by this pass's
 * Credit Cards composition (linked-EMI-principal lookups), but the full
 * repository is returned so future write flows (create/edit EMI) can reuse
 * this same factory.
 */
export function createEmiRepository(uid: string): EmiRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.emis).withConverter(emiConverter);
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

  return new EmiRepository(ref, paymentScheduleRepository, installmentRepositoryFor);
}

const emiPaymentBreakdownConverter: FirestoreDataConverter<EmiPaymentBreakdown> = {
  toFirestore: emiPaymentBreakdownToFirestore,
  fromFirestore: emiPaymentBreakdownFromFirestore,
};

export function createEmiPaymentBreakdownRepository(uid: string, emiId: string): EmiPaymentBreakdownRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.emis,
    emiId,
    FirestoreCollections.paymentBreakdowns,
  ).withConverter(emiPaymentBreakdownConverter);
  return new EmiPaymentBreakdownRepository(ref);
}

/**
 * A live query across every EMI's `paymentBreakdowns` subcollection at once
 * — the same cross-parent `collectionGroup` shape as
 * `createStatementsCollectionGroupQuery`, used so
 * `UtilizationEmi.principalPaid` (a card's available-credit calculation)
 * doesn't require opening one `watchAll` per EMI.
 */
export function createEmiPaymentBreakdownsCollectionGroupQuery(): Query<EmiPaymentBreakdown> {
  return collectionGroup(db, FirestoreCollections.paymentBreakdowns).withConverter(
    emiPaymentBreakdownConverter,
  ) as Query<EmiPaymentBreakdown>;
}

const loanConverter: FirestoreDataConverter<Loan> = {
  toFirestore: loanToFirestore,
  fromFirestore: loanFromFirestore,
};

/**
 * Same dependency shape as `createEmiRepository` (a `PaymentScheduleRepository`
 * plus a per-schedule `InstallmentRepository` factory) — `LoanRepository`
 * composes those two ported, feature-agnostic repositories with the
 * `calculate` interest engine to generate/re-amortize a loan's installments.
 */
export function createLoanRepository(uid: string): LoanRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.loans).withConverter(
    loanConverter,
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

  return new LoanRepository(ref, paymentScheduleRepository, installmentRepositoryFor);
}

/**
 * Scoped `InstallmentRepository` for a loan's own schedule — used by the
 * Loans page to record payments against a specific installment without
 * constructing a whole `LoanRepository`.
 */
export function createInstallmentRepositoryFor(uid: string, scheduleId: string): InstallmentRepository {
  const installmentsRef = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.paymentSchedules,
    scheduleId,
    FirestoreCollections.installments,
  ).withConverter(installmentConverter);
  return new InstallmentRepository(installmentsRef);
}

export function createInstallmentPaymentRepositoryFor(
  uid: string,
  scheduleId: string,
  installmentId: string,
  installmentRepository: InstallmentRepository,
): InstallmentPaymentRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.paymentSchedules,
    scheduleId,
    FirestoreCollections.installments,
    installmentId,
    FirestoreCollections.payments,
  ).withConverter(installmentPaymentConverter);
  return new InstallmentPaymentRepository(ref, installmentRepository);
}

const stagedRecordConverter: FirestoreDataConverter<StagedRecord> = {
  toFirestore: stagedRecordToFirestore,
  fromFirestore: stagedRecordFromFirestore,
};

/**
 * `StagedRecord`s live in a per-import `documentImports/{importId}/records`
 * subcollection — Transaction Studio's write layer (architecture §4a).
 * `importId === documentId` by construction (staging-writer.ts's module
 * comment: one financial document produces at most one staging import).
 */
export function createDocumentImportRecordRepository(uid: string, importId: string): DocumentImportRecordRepository {
  const ref = collection(
    db,
    FirestoreCollections.users,
    uid,
    FirestoreCollections.documentImports,
    importId,
    FirestoreCollections.documentImportRecords,
  ).withConverter(stagedRecordConverter);
  return new DocumentImportRecordRepository(ref);
}

const smsTransactionCandidateConverter: FirestoreDataConverter<SmsTransactionCandidate> = {
  toFirestore: smsTransactionCandidateToFirestore,
  fromFirestore: smsTransactionCandidateFromFirestore,
};

/**
 * Flat `users/{uid}/smsTransactionCandidates` collection — no parent
 * document, unlike `documentImports`/`records`. Android-owned (see
 * `lib/models/sms-transaction-candidate.ts`'s module doc); the web app only
 * reads and deletes.
 */
export function createSmsTransactionCandidateRepository(uid: string): SmsTransactionCandidateRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.smsTransactionCandidates).withConverter(
    smsTransactionCandidateConverter,
  );
  return new SmsTransactionCandidateRepository(ref);
}

/** Flat, uid-scoped `paymentSchedules` collection — shared by Loan/EMI/Bill/split-Expense (`ownerType` discriminates), same physical collection `createEmiRepository`/`createLoanRepository` already build a scoped instance of inline. Exposed standalone for callers (like the Transaction Studio commit orchestrator) that need one without also constructing a whole Emi/Loan repository. */
export function createPaymentScheduleRepository(uid: string): PaymentScheduleRepository {
  const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.paymentSchedules).withConverter(
    paymentScheduleConverter,
  );
  return new PaymentScheduleRepository(ref);
}

const ledgerEntryConverter: FirestoreDataConverter<LedgerEntry> = {
  toFirestore: ledgerEntryToFirestore,
  fromFirestore: ledgerEntryFromFirestore,
};

/** `LedgerEntry`s live in a per-person `people/{personId}/ledger` subcollection. */
export function createLedgerRepositoryFor(uid: string, personId: string, personRepository: PersonRepository): LedgerRepository {
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

const expenseConverter: FirestoreDataConverter<Expense> = {
  toFirestore: expenseToFirestore,
  fromFirestore: expenseFromFirestore,
};

/**
 * `ExpenseRepository` composes `TransactionRepository` (the balance-carrying
 * leg), `PaymentScheduleRepository`/`InstallmentRepository` (per-participant
 * settlement tracking), and `PersonRepository`/`LedgerRepository` (the
 * receivable/payable ledger) — this factory wires all of it, matching how
 * mobile's split-expense flow is composed, so Transaction Studio's commit
 * orchestrator (architecture §7) can call the exact same `createExpense`/
 * `assignToPerson` logic mobile uses.
 */
export function createExpenseRepository(uid: string, accountRepository: AccountRepository): ExpenseRepository {
  const expenseRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.expenses).withConverter(expenseConverter);
  const transactionRepository = createTransactionRepository(uid, accountRepository);
  const paymentScheduleRepository = createPaymentScheduleRepository(uid);
  const personRepository = createPersonRepository(uid);
  return new ExpenseRepository(
    expenseRef,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId),
    (personId) => createLedgerRepositoryFor(uid, personId, personRepository),
  );
}
