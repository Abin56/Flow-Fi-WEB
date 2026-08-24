/**
 * End-to-end regression test for the manual QA script:
 *
 *   Create a transaction -> create/import an SMS or PDF transaction with the
 *   same amount and same date -> confirm the duplicate warning appears ->
 *   choose Cancel -> confirm nothing is created -> repeat -> choose
 *   Import Anyway -> confirm the new transaction is created.
 *
 * Runs the REAL repositories (`TransactionRepository`,
 * `SmsTransactionCandidateRepository`, `DocumentImportRecordRepository`)
 * against a live Firestore Emulator under the real `firestore.rules` — zero
 * mocking of the data layer, same pattern as
 * `upload-to-approved-transaction.test.ts`. "Cancel" is simulated by simply
 * not calling the write path again (both `importCandidate` and
 * `commitReviewImport` never write anything on their own when a duplicate is
 * only detected, not confirmed past) — there is no separate "cancel" API to
 * call. "Import Anyway" is `skipDuplicateCheck: true` for SMS, and a direct
 * `commitReviewImport` call for PDF (its own duplicate check,
 * `detectFreshDuplicatesForCommit`, is a separate advisory pre-step that
 * `commitReviewImport` itself never re-runs — see that module's doc comment).
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import { commitReviewImport, detectFreshDuplicatesForCommit, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import { importCandidate, type ImportCandidateParams } from "@/features/transaction-candidates/lib/import-candidate";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryFromFirestore, categoryToFirestore, type Category } from "@/lib/models/category";
import { stagedRecordFromFirestore, stagedRecordToFirestore, type StagedRecord } from "@/lib/models/document-import";
import { smsTransactionCandidateFromFirestore, smsTransactionCandidateToFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { DocumentImportRecordRepository } from "@/lib/repositories/document-import-record-repository";
import { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";

const PROJECT_ID = "flowfi-duplicate-warning-e2e-test";
const UID = "e2e-owner-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

const accountConverter: FirestoreDataConverter<Account> = { toFirestore: accountToFirestore, fromFirestore: accountFromFirestore };
const categoryConverter: FirestoreDataConverter<Category> = { toFirestore: categoryToFirestore, fromFirestore: categoryFromFirestore };
const transactionConverter: FirestoreDataConverter<Transaction> = { toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore };
const stagedRecordConverter: FirestoreDataConverter<StagedRecord> = { toFirestore: stagedRecordToFirestore, fromFirestore: stagedRecordFromFirestore };
const smsCandidateConverter: FirestoreDataConverter<SmsTransactionCandidate> = {
  toFirestore: smsTransactionCandidateToFirestore,
  fromFirestore: smsTransactionCandidateFromFirestore,
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "HDFC Savings",
    type: "bank",
    openingBalance: 10000,
    currentBalance: 10000,
    colorValue: 0,
    isDefault: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    bankId: "hdfc",
    accountHolderName: null,
    notes: null,
    accountNumberLast4: "1234",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat-shopping",
    name: "Shopping",
    type: "expense",
    iconKey: "shopping_bag",
    colorValue: 0,
    isDefault: false,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

const DUPLICATE_AMOUNT = 1000;
const DUPLICATE_DATE = new Date("2026-08-04T00:00:00.000Z");

describe("end-to-end: SMS candidate — duplicate warning -> Cancel (repeat) -> Import Anyway", () => {
  it("blocks the write on the first and a repeated attempt, then writes a real second Transaction once 'Import Anyway' is chosen", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    const accountsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.accounts).withConverter(accountConverter);
    const seededAccount = account();
    await assertSucceeds(setDoc(doc(accountsRef, seededAccount.id), seededAccount));

    const transactionsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.transactions).withConverter(transactionConverter);
    const accountRepository = new AccountRepository(accountsRef);
    const transactionRepository = new TransactionRepository(transactionsRef, accountRepository);

    const candidatesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.smsTransactionCandidates).withConverter(smsCandidateConverter);
    const candidateRepository = new SmsTransactionCandidateRepository(candidatesRef);

    // --- Step 1: "Create a transaction" — a real prior Transaction, exactly as manual entry (or any
    // other source) would leave one, amount 1000 on 4 Aug 2026. ---
    const existingTransaction = await transactionRepository.createTransaction({
      type: "expense",
      amount: DUPLICATE_AMOUNT,
      dateTime: DUPLICATE_DATE,
      accountId: seededAccount.id,
      categoryId: "cat-shopping",
      description: "dd",
      source: "manual",
    });

    let transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);

    // --- Step 2: "create/import an SMS transaction with the same amount and same date" — deliberately
    // no merchant/bankName text and no reference number, proving the amount+date-only fallback (not
    // description matching) is what catches this. ---
    const smsCandidate: SmsTransactionCandidate = {
      id: "sms-candidate-1",
      amount: DUPLICATE_AMOUNT,
      direction: "debit",
      eventType: "creditCardPurchase",
      transactionDate: DUPLICATE_DATE,
      merchant: null,
      bankName: null,
      rawLastFour: null,
      accountId: seededAccount.id,
      cardId: null,
      referenceNumber: null,
      confidenceLevel: "high",
      confidenceScore: 0.9,
      needsReview: false,
      needsReviewReasons: [],
      source: "sms",
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      deletedAt: null,
    };
    await assertSucceeds(setDoc(doc(candidatesRef, smsCandidate.id), smsCandidate));

    const existingForCheck: ExistingTransactionForDuplicateCheck[] = [
      { id: existingTransaction.id, description: existingTransaction.description, amount: existingTransaction.amount, dateTime: existingTransaction.dateTime, accountId: existingTransaction.accountId, type: existingTransaction.type },
    ];

    const baseImportParams: ImportCandidateParams = {
      candidate: smsCandidate,
      accountId: seededAccount.id,
      matchedCard: null,
      categoryId: "cat-shopping",
      existingTransactions: existingForCheck,
    };

    // --- Step 3: import attempt #1 — "confirm the duplicate warning appears" ---
    const firstAttempt = await importCandidate(baseImportParams, transactionRepository, candidateRepository, {} as never);
    expect(firstAttempt.status).toBe("duplicate_detected");
    if (firstAttempt.status === "duplicate_detected") expect(firstAttempt.result.bestMatch?.transactionId).toBe(existingTransaction.id);

    // --- Step 4: "choose Cancel -> confirm nothing is created" — no second call was made; verify
    // against real Firestore state, not just the in-memory result. ---
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);
    const candidateAfterCancel = await getDoc(doc(candidatesRef, smsCandidate.id));
    expect(candidateAfterCancel.exists()).toBe(true); // candidate untouched — never deleted for a blocked import

    // --- Step 5: "repeat" — attempting the same import again still blocks, still writes nothing ---
    const secondAttempt = await importCandidate(baseImportParams, transactionRepository, candidateRepository, {} as never);
    expect(secondAttempt.status).toBe("duplicate_detected");
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);

    // --- Step 6: "choose Import Anyway -> confirm the new transaction is created" ---
    const importAnyway = await importCandidate({ ...baseImportParams, skipDuplicateCheck: true }, transactionRepository, candidateRepository, {} as never);
    expect(importAnyway.status).toBe("success");
    if (importAnyway.status !== "success") throw new Error("expected success");

    // A real SECOND Transaction document now exists, distinct from the first.
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(2);
    const newTransactionSnap = await assertSucceeds(getDoc(doc(transactionsRef, importAnyway.transactionId)));
    expect(newTransactionSnap.exists()).toBe(true);
    const newTransaction = newTransactionSnap.data()!;
    expect(newTransaction.id).not.toBe(existingTransaction.id);
    expect(newTransaction.amount).toBe(DUPLICATE_AMOUNT);
    expect(newTransaction.source).toBe("sms");

    // The candidate document was deleted only on the successful "Import Anyway" write.
    const candidateAfterImport = await getDoc(doc(candidatesRef, smsCandidate.id));
    expect(candidateAfterImport.exists()).toBe(false);

    // The account balance reflects BOTH withdrawals now (10000 - 1000 - 1000).
    const accountSnap = await assertSucceeds(getDoc(doc(accountsRef, seededAccount.id)));
    expect(accountSnap.data()!.currentBalance).toBe(10000 - DUPLICATE_AMOUNT - DUPLICATE_AMOUNT);
  });
});

describe("end-to-end: PDF statement row — duplicate warning -> Cancel (repeat) -> Import Anyway", () => {
  it("the advisory pre-check flags it on the first and a repeated attempt with nothing written, then commitReviewImport writes a real second Transaction once 'Import Anyway' is chosen", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    const accountsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.accounts).withConverter(accountConverter);
    const seededAccount = account();
    await assertSucceeds(setDoc(doc(accountsRef, seededAccount.id), seededAccount));

    const categoriesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.categories).withConverter(categoryConverter);
    const seededCategory = category();
    await assertSucceeds(setDoc(doc(categoriesRef, seededCategory.id), seededCategory));

    const accountRepository = new AccountRepository(accountsRef);
    const transactionsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.transactions).withConverter(transactionConverter);
    const transactionRepository = new TransactionRepository(transactionsRef, accountRepository);

    const importId = "import-1";
    const recordsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.documentImports, importId, FirestoreCollections.documentImportRecords).withConverter(
      stagedRecordConverter,
    );
    const recordRepository = new DocumentImportRecordRepository(recordsRef);

    // --- Step 1: "Create a transaction" ---
    const existingTransaction = await transactionRepository.createTransaction({
      type: "expense",
      amount: DUPLICATE_AMOUNT,
      dateTime: DUPLICATE_DATE,
      accountId: seededAccount.id,
      categoryId: seededCategory.id,
      description: "dd",
      source: "manual",
    });

    let transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);

    // --- Step 2: "create/import a PDF transaction with the same amount and same date" — a completely
    // different counterparty text, proving the amount+date-only fallback catches it regardless of
    // description, exactly like the SMS case above. Server pipeline never flagged this row
    // (duplicateOfTransactionId/duplicateCandidateOf both null), matching a fresh statement upload. ---
    const stagedRow: StagedRecord = {
      id: "staged-1",
      recordType: "transaction",
      rawText: "SOME OTHER MERCHANT PVT LTD",
      date: DUPLICATE_DATE,
      counterpartyRaw: "SOME OTHER MERCHANT PVT LTD",
      counterpartyNormalized: "A Completely Different Merchant",
      amount: DUPLICATE_AMOUNT,
      direction: "debit",
      referenceNumber: null,
      currency: "INR",
      category: "Shopping",
      subcategory: null,
      confidenceScores: {},
      sourcePage: 1,
      sourceLineIndex: 0,
      splitParentId: null,
      mergedInto: null,
      userEdited: false,
      lastEditedAt: null,
      lastEditedBy: null,
      tags: [],
      notes: "",
      duplicateOfTransactionId: null,
      include: true,
      ...actionToAxesPatch("normal_expense"),
      committedTransactionId: null,
      excludeFromCalculations: false,
      accountingMonth: null,
      suggestedCategory: null,
      suggestedAccount: null,
      suggestedPerson: null,
      suggestedTags: [],
      expenseType: null,
      transferDetected: false,
      recurringDetected: false,
      subscriptionDetected: false,
      duplicateCandidateOf: null,
      needsReview: false,
    };
    await assertSucceeds(setDoc(doc(recordsRef, stagedRow.id), stagedRow));

    // --- Step 3: the advisory pre-check — "confirm the duplicate warning appears" ---
    const firstWarnings = detectFreshDuplicatesForCommit([stagedRow], [existingTransaction], seededAccount.id);
    expect(firstWarnings).toHaveLength(1);
    expect(firstWarnings[0]?.result.bestMatch?.transactionId).toBe(existingTransaction.id);

    // --- Step 4: "choose Cancel -> confirm nothing is created" — detection is pure/read-only; commit
    // was never called, so nothing should exist beyond the one seeded transaction. ---
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);
    const recordAfterCancel = await getDoc(doc(recordsRef, stagedRow.id));
    expect(recordAfterCancel.data()!.committedTransactionId).toBeNull();

    // --- Step 5: "repeat" — re-running the same advisory check still warns, still writes nothing ---
    const secondWarnings = detectFreshDuplicatesForCommit([stagedRow], [existingTransaction], seededAccount.id);
    expect(secondWarnings).toHaveLength(1);
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(1);

    // --- Step 6: "choose Import Anyway -> confirm the new transaction is created" — commitReviewImport
    // itself never re-runs the duplicate check (it's a separate, advisory pre-step); "Import Anyway"
    // simply proceeds to the real commit, exactly as `handleApprove` does after the user confirms
    // past `DuplicateWarningDialog`. ---
    const repositories: CommitRepositories = {
      transactionRepository,
      expenseRepository: {} as never,
      emiRepository: {} as never,
      loanRepository: {} as never,
      installmentRepositoryFor: () => {
        throw new Error("should not be called for a normal_expense row");
      },
    };
    const commitResult = await commitReviewImport({
      rows: [stagedRow],
      accountId: seededAccount.id,
      categories: [seededCategory],
      people: [],
      accounts: [seededAccount],
      emis: [],
      loans: [],
      bills: [],
      repositories,
      onRowCommitted: (recordId, transactionId) => recordRepository.updateFields(recordId, { committedTransactionId: transactionId }, UID),
    });

    expect(commitResult.committedCount).toBe(1);
    const committed = commitResult.results[0];
    expect(committed.outcome).toBe("committed");
    expect(committed.transactionId).toBeTruthy();
    expect(committed.transactionId).not.toBe(existingTransaction.id);

    // A real SECOND Transaction document now exists, distinct from the first.
    transactionDocs = await getDocs(transactionsRef);
    expect(transactionDocs.size).toBe(2);
    const newTransactionSnap = await assertSucceeds(getDoc(doc(transactionsRef, committed.transactionId!)));
    expect(newTransactionSnap.exists()).toBe(true);
    expect(newTransactionSnap.data()!.amount).toBe(DUPLICATE_AMOUNT);

    // The staged record was marked committed, and the account balance reflects both withdrawals.
    const recordAfterImport = await getDoc(doc(recordsRef, stagedRow.id));
    expect(recordAfterImport.data()!.committedTransactionId).toBe(committed.transactionId);
    const accountSnap = await assertSucceeds(getDoc(doc(accountsRef, seededAccount.id)));
    expect(accountSnap.data()!.currentBalance).toBe(10000 - DUPLICATE_AMOUNT - DUPLICATE_AMOUNT);
  });
});
