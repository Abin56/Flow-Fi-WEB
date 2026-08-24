/**
 * End-to-end regression test: a statement row that has already been parsed
 * and staged (the "upload" half — proven separately, against real PDF
 * fixtures, by `functions/tests/hdfc-credit-card-statement-pipeline.test.ts`
 * and `functions/tests/staging-writer.test.ts`) goes through the exact
 * client-side "Approve & Import" path — `commitReviewImport` — and lands as
 * a REAL `Transaction` document with a REAL, correctly-updated account
 * balance, all under the REAL `firestore.rules` (not disabled), against a
 * live Firestore Emulator.
 *
 * This closes a real coverage gap the production-hardening pass found:
 * `features/transaction-studio/lib/commit-review-import.test.ts` (the
 * existing test for this same orchestrator) exercises `commitReviewImport`
 * against fully mocked/stub repositories — real Firestore writes, the
 * atomic balance update inside `TransactionRepository.createTransaction`,
 * and the security rules gating the write path were never actually
 * exercised together anywhere. This test uses the real `AccountRepository`/
 * `TransactionRepository`/`DocumentImportRecordRepository` classes, backed
 * by the emulator, with zero mocking of the data layer.
 *
 * Run via `npm run test:integration` (wraps this in `firebase
 * emulators:exec` so a real emulator backs every assertion).
 */

import { readFileSync } from "node:fs";
import {
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, setDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { commitReviewImport, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryFromFirestore, categoryToFirestore, type Category } from "@/lib/models/category";
import { stagedRecordFromFirestore, stagedRecordToFirestore, type StagedRecord } from "@/lib/models/document-import";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { DocumentImportRecordRepository } from "@/lib/repositories/document-import-record-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-e2e-test";
const UID = "e2e-owner-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
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

/** A staged record exactly as the real parsing pipeline + reviewer would leave it:
 *  parsed from a real statement row, category resolved, Action chosen as "normal_expense",
 *  ready for Approve & Import. Mirrors commit-review-import.test.ts's own `row()` fixture. */
function stagedRecord(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "staged-1",
    recordType: "transaction",
    rawText: "AMAZON PAY INDIA PVT LTD",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMAZON PAY INDIA PVT LTD",
    counterpartyNormalized: "Amazon",
    amount: 1499,
    direction: "debit",
    referenceNumber: "REF12345",
    currency: "INR",
    category: "Shopping",
    subcategory: null,
    confidenceScores: {},
    sourcePage: 2,
    sourceLineIndex: 5,
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
    ...overrides,
  };
}

describe("end-to-end: parsed statement row -> reviewed -> approved -> real transaction + real balance", () => {
  it("commitReviewImport writes a real Transaction, updates the real account balance, and marks the staged record committed — all under real security rules", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();

    // --- Seed the state a real upload+parse would have already produced ---
    const accountsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.accounts).withConverter(accountConverter);
    const seededAccount = account();
    await assertSucceeds(setDoc(doc(accountsRef, seededAccount.id), seededAccount));

    const categoriesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.categories).withConverter(categoryConverter);
    const seededCategory = category();
    await assertSucceeds(setDoc(doc(categoriesRef, seededCategory.id), seededCategory));

    const importId = "import-1";
    const recordsRef = collection(
      db,
      FirestoreCollections.users,
      UID,
      FirestoreCollections.documentImports,
      importId,
      FirestoreCollections.documentImportRecords,
    ).withConverter(stagedRecordConverter);
    const seededRecord = stagedRecord();
    await assertSucceeds(setDoc(doc(recordsRef, seededRecord.id), seededRecord));

    // --- The real repositories a real "Approve & Import" click uses — zero mocking ---
    const accountRepository = new AccountRepository(accountsRef);
    const transactionsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.transactions).withConverter(transactionConverter);
    const transactionRepository = new TransactionRepository(transactionsRef, accountRepository);
    const recordRepository = new DocumentImportRecordRepository(recordsRef);

    const repositories: CommitRepositories = {
      transactionRepository,
      // Not exercised by a "normal_expense" row — commitOneRow's normal_expense
      // branch only ever calls transactionRepository.createTransaction.
      expenseRepository: {} as never,
      emiRepository: {} as never,
      loanRepository: {} as never,
      installmentRepositoryFor: () => {
        throw new Error("should not be called for a normal_expense row");
      },
    };

    // --- The actual "Approve & Import" call, exactly as transaction-studio.tsx makes it ---
    const result = await commitReviewImport({
      rows: [seededRecord],
      accountId: seededAccount.id,
      categories: [seededCategory],
      people: [],
      accounts: [seededAccount],
      emis: [],
      loans: [],
      bills: [],
      repositories,
      onRowCommitted: (recordId, transactionId) =>
        recordRepository.updateFields(recordId, { committedTransactionId: transactionId }, UID),
    });

    // --- The commit itself succeeded (proves the real security rules allowed every write) ---
    expect(result.committedCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    const committedResult = result.results[0];
    expect(committedResult.outcome).toBe("committed");
    expect(committedResult.transactionId).toBeTruthy();

    // --- A real Transaction document actually exists, with the right shape ---
    const transactionSnap = await assertSucceeds(getDoc(doc(transactionsRef, committedResult.transactionId!)));
    expect(transactionSnap.exists()).toBe(true);
    const transaction = transactionSnap.data()!;
    expect(transaction.type).toBe("expense");
    expect(transaction.amount).toBe(1499);
    expect(transaction.accountId).toBe(seededAccount.id);
    expect(transaction.categoryId).toBe(seededCategory.id);
    expect(transaction.description).toBe("Amazon");
    expect(transaction.deletedAt).toBeNull();

    // --- The account's real balance was atomically updated by exactly the transaction amount ---
    const accountSnap = await assertSucceeds(getDoc(doc(accountsRef, seededAccount.id)));
    expect(accountSnap.data()!.currentBalance).toBe(10000 - 1499);

    // --- The staged record was marked committed, closing the loop back to the review grid ---
    const recordSnap = await assertSucceeds(getDoc(doc(recordsRef, seededRecord.id)));
    expect(recordSnap.data()!.committedTransactionId).toBe(committedResult.transactionId);
  });

  it("a second Approve & Import click for the same already-committed row is a safe no-op, not a duplicate transaction", async () => {
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

    const repositories: CommitRepositories = {
      transactionRepository,
      expenseRepository: {} as never,
      emiRepository: {} as never,
      loanRepository: {} as never,
      installmentRepositoryFor: () => {
        throw new Error("should not be called for a normal_expense row");
      },
    };

    // Row already carries a committedTransactionId, as it would after a first successful commit.
    const alreadyCommittedRecord = stagedRecord({ committedTransactionId: "already-committed-txn-id" });

    const result = await commitReviewImport({
      rows: [alreadyCommittedRecord],
      accountId: seededAccount.id,
      categories: [seededCategory],
      people: [],
      accounts: [seededAccount],
      emis: [],
      loans: [],
      bills: [],
      repositories,
      onRowCommitted: () => {
        throw new Error("must not commit a row that's already committed");
      },
    });

    expect(result.committedCount).toBe(1);
    expect(result.results[0].outcome).toBe("committed");
    expect(result.results[0].transactionId).toBe("already-committed-txn-id");

    // The account balance must be untouched — no second withdrawal for the same statement row.
    const accountSnap = await assertSucceeds(getDoc(doc(accountsRef, seededAccount.id)));
    expect(accountSnap.data()!.currentBalance).toBe(10000);
  });
});
