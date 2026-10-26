/**
 * Statement Review Phase 2 — REAL repositories, REAL security rules, live Firestore Emulator:
 * the network drops after the money write but before the staging acknowledgment, and Approve & Import is run
 * again. The account balance and the transactions collection must reflect the money exactly ONCE.
 */

import { readFileSync } from "node:fs";
import { assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, getDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { commitReviewImport, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryFromFirestore, categoryToFirestore, type Category } from "@/lib/models/category";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "replay-owner-uid";
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-replay-test",
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

const account = (): Account => ({
  id: "acc-1",
  name: "HDFC Card",
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
  bankAccountSubtype: null,
  minimumBalance: null,
  interestRatePercent: null,
  maturityDate: null,
  tenureMonths: null,
  cardSubtype: null,
  cardProvider: null,
  linkedAccountId: null,
  reloadable: null,
  currency: null,
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
});
const category = (): Category => ({
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
});
function staged(id: string, overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id,
    recordType: "transaction",
    rawText: "AMAZON",
    date: new Date("2026-07-15T06:30:00.000Z"),
    counterpartyRaw: "AMAZON",
    counterpartyNormalized: "Amazon",
    amount: 1499,
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
    modifiers: DEFAULT_RECORD_MODIFIERS,
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

async function setup() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.accounts).withConverter(accountConverter);
  const categoriesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.categories).withConverter(categoryConverter);
  const transactionsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.transactions).withConverter(transactionConverter);
  await assertSucceeds(setDoc(doc(accountsRef, "acc-1"), account()));
  await assertSucceeds(setDoc(doc(categoriesRef, "cat-shopping"), category()));
  const accountRepository = new AccountRepository(accountsRef);
  const repositories: CommitRepositories = {
    transactionRepository: new TransactionRepository(transactionsRef, accountRepository),
    expenseRepository: {} as never,
    emiRepository: {} as never,
    loanRepository: {} as never,
    installmentRepositoryFor: () => {
      throw new Error("not used");
    },
  };
  const balance = async () => (await getDoc(doc(accountsRef, "acc-1"))).data()!.currentBalance;
  const liveTransactions = async () => (await getDocs(transactionsRef)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  return { repositories, balance, liveTransactions };
}

const params = (repositories: CommitRepositories, rows: StagedRecord[], documentId: string, onRowCommitted: (r: string, t: string) => Promise<void>) => ({
  documentId,
  rows,
  accountId: "acc-1",
  categories: [category()],
  people: [],
  accounts: [account()],
  emis: [],
  loans: [],
  bills: [],
  repositories,
  onRowCommitted,
  linkRetryDelayMs: 0,
});

const interrupted = async () => {
  throw new Error("network interrupted");
};

describe("statement import replay safety (real Firestore + real balance maths)", () => {
  it("network interruption after the money write: re-running Approve & Import debits the account exactly once", async () => {
    const { repositories, balance, liveTransactions } = await setup();
    const doc1 = "card-1_" + "a".repeat(64);
    const row = staged("1");

    const first = await commitReviewImport(params(repositories, [row], doc1, interrupted));
    expect(first.failedCount).toBe(1);
    expect(await balance()).toBe(10000 - 1499);
    expect(await liveTransactions()).toHaveLength(1);

    const linked: string[] = [];
    const second = await commitReviewImport(
      params(repositories, [row], doc1, async (_r, t) => {
        linked.push(t);
      }),
    );
    expect(second.committedCount).toBe(1);
    expect(linked).toEqual([first.results[0].transactionId]);
    expect(await balance()).toBe(10000 - 1499); // unchanged
    expect(await liveTransactions()).toHaveLength(1);
  });

  it("a refund (credit) row replays to exactly one credit", async () => {
    const { repositories, balance, liveTransactions } = await setup();
    const doc1 = "card-1_" + "a".repeat(64);
    const refund = staged("7", { direction: "credit", amount: 300, ...actionToAxesPatch("refund") });
    await commitReviewImport(params(repositories, [refund], doc1, interrupted));
    await commitReviewImport(params(repositories, [refund], doc1, async () => {}));
    expect(await balance()).toBe(10000 + 300);
    expect(await liveTransactions()).toHaveLength(1);
  });

  it("row 1 of two different statements are two different transactions (keys are statement-scoped)", async () => {
    const { repositories, balance, liveTransactions } = await setup();
    await commitReviewImport(params(repositories, [staged("1")], "card-1_" + "a".repeat(64), async () => {}));
    await commitReviewImport(params(repositories, [staged("1")], "card-1_" + "b".repeat(64), async () => {}));
    expect(await liveTransactions()).toHaveLength(2);
    expect(await balance()).toBe(10000 - 2 * 1499);
  });

  it("a batch interrupted mid-way resumes without repeating the rows that already landed", async () => {
    const { repositories, balance, liveTransactions } = await setup();
    const doc1 = "card-1_" + "a".repeat(64);
    const rows = [staged("1"), staged("2", { amount: 200 }), staged("3", { amount: 50 })];
    let acks = 0;
    // Row 1 is acknowledged; the connection is lost for rows 2 and 3 (their money already landed).
    await commitReviewImport(
      params(repositories, rows, doc1, async () => {
        if (++acks > 1) throw new Error("network interrupted");
      }),
    );
    expect(await liveTransactions()).toHaveLength(3);

    const resumed = await commitReviewImport(
      params(repositories, [{ ...rows[0]!, committedTransactionId: "known" }, rows[1]!, rows[2]!], doc1, async () => {}),
    );
    expect(resumed.committedCount).toBe(3);
    expect(await liveTransactions()).toHaveLength(3);
    expect(await balance()).toBe(10000 - 1499 - 200 - 50);
  });
});
