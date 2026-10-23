/**
 * SMS candidate import — exact idempotency, in-batch duplicate protection, and partial-failure safety,
 * against the REAL repositories on a live Firestore Emulator under the real `firestore.rules` (synthetic
 * data only; nothing here touches production). Run via `npm run test:integration`.
 *
 * The financial claim being pinned: one SMS candidate id => at most ONE Transaction and ONE account-balance
 * effect, however many clicks / retries / tabs / re-syncs of that candidate happen. That atomicity comes from
 * `TransactionRepository.createTransactionInTransaction` reading the keyed document, reading the account and
 * writing both inside the same `runTransaction` — verified directly below by racing the repository itself
 * (bypassing `importCandidate`'s in-tab guard).
 */

import { readFileSync } from "node:fs";
import { assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { candidateImportKey, importedTransactionId } from "@/features/transaction-candidates/lib/candidate-import-key";
import { bulkImportCandidates, importCandidate } from "@/features/transaction-candidates/lib/import-candidate";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { smsTransactionCandidateFromFirestore, smsTransactionCandidateToFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";

const PROJECT_ID = "flowfi-sms-import-idempotency-test";
const UID = "sms-import-owner-uid";
const OPENING = 10000;

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
const transactionConverter: FirestoreDataConverter<Transaction> = { toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore };
const candidateConverter: FirestoreDataConverter<SmsTransactionCandidate> = {
  toFirestore: smsTransactionCandidateToFirestore,
  fromFirestore: smsTransactionCandidateFromFirestore,
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "HDFC Savings",
    type: "bank",
    openingBalance: OPENING,
    currentBalance: OPENING,
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
    ...overrides,
  };
}

function smsCandidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-cand-0001",
    amount: 500,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date("2026-08-10T10:00:00.000Z"),
    merchant: "Swiggy",
    bankName: "HDFC",
    rawLastFour: "1234",
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accountsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.accounts).withConverter(accountConverter);
  const transactionsRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.transactions).withConverter(transactionConverter);
  const candidatesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.smsTransactionCandidates).withConverter(candidateConverter);
  const accountRepository = new AccountRepository(accountsRef);
  const transactionRepository = new TransactionRepository(transactionsRef, accountRepository);
  const candidateRepository = new SmsTransactionCandidateRepository(candidatesRef);
  const expenseRepository = {} as never;

  return {
    transactionRepository,
    candidateRepository,
    expenseRepository,
    seedAccount: (a = account()) => assertSucceeds(setDoc(doc(accountsRef, a.id), a)),
    seedCandidate: (c: SmsTransactionCandidate) => assertSucceeds(setDoc(doc(candidatesRef, c.id), c)),
    balance: async (id = "acc-1") => (await getDoc(doc(accountsRef, id))).data()!.currentBalance,
    candidateExists: async (id: string) => (await getDoc(doc(candidatesRef, id))).exists(),
    transactions: async () => (await getDocs(transactionsRef)).docs.map((d) => d.data()),
    activeTransactions: async () => (await getDocs(transactionsRef)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null),
    importOne: (c: SmsTransactionCandidate, extra: Partial<Parameters<typeof importCandidate>[0]> = {}) =>
      importCandidate({ candidate: c, accountId: "acc-1", matchedCard: null, categoryId: "cat-1", ...extra }, transactionRepository, candidateRepository, expenseRepository),
    bulk: (cs: SmsTransactionCandidate[], opts: { existing?: ExistingTransactionForDuplicateCheck[]; skip?: boolean } = {}) =>
      bulkImportCandidates(cs, "cat-1", [], transactionRepository, candidateRepository, expenseRepository, opts.existing ?? [], opts.skip ?? false, { accountId: "acc-1", matchedCard: null }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("exact idempotency of one SMS candidate", () => {
  it("repeated import (retry after a lost response): ONE transaction, ONE balance effect, candidate removed", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);

    const first = await s.importOne(c);
    expect(first.status).toBe("success");
    await sleep(20);
    const second = await s.importOne(c);
    expect(second).toMatchObject({ status: "already_imported", changed: false });

    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
    expect(await s.candidateExists(c.id)).toBe(false);
    const key = await candidateImportKey(c.id);
    expect((await s.transactions())[0].id).toBe(importedTransactionId(key));
    expect((await s.transactions())[0].source).toBe("sms");
  });

  it("double-click: two simultaneous importCandidate calls create ONE transaction", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    const [a, b] = await Promise.all([s.importOne(c), s.importOne(c)]);
    expect(a.status).toBe("success");
    expect(b.status).toBe("success"); // joined the same attempt
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
  });

  it("racing the REPOSITORY itself (no in-tab guard — e.g. two browser tabs): 8 concurrent creates with one key => one transaction, one balance effect", async () => {
    const s = setup();
    await s.seedAccount();
    const key = await candidateImportKey("sms-race-0001");
    const params = { type: "expense" as const, amount: 500, dateTime: new Date("2026-08-10T10:00:00.000Z"), accountId: "acc-1", categoryId: "cat-1", description: "Swiggy", source: "sms" as const, idempotencyKey: key };
    const results = await Promise.all(Array.from({ length: 8 }, () => s.transactionRepository.createTransaction(params)));
    expect(new Set(results.map((t) => t.id)).size).toBe(1);
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500); // the atomic check + balance write: no double debit
  });

  it("candidate resurrection (Android re-syncs the same id), even with the duplicate warning bypassed: nothing new is created", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);
    expect(await s.candidateExists(c.id)).toBe(false);

    await s.seedCandidate(c); // Android's full-document overwrite brings it back
    await sleep(20);
    const again = await s.importOne(c, { skipDuplicateCheck: true });
    expect(again.status).toBe("already_imported");
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
    expect(await s.candidateExists(c.id)).toBe(false); // removed again
  });

  it("the existing duplicate guard still runs first on a resurrected candidate, with no writes", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);
    await s.seedCandidate(c);
    const existing = (await s.transactions()).map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type }));
    const blocked = await s.importOne(c, { existingTransactions: existing });
    expect(blocked.status).toBe("duplicate_detected");
    expect(await s.candidateExists(c.id)).toBe(true); // untouched until the user decides
    expect(await s.balance()).toBe(OPENING - 500);
  });

  it("imported transaction edited afterwards (amount changed), then candidate resurrects: reported as changed, still ONE transaction, balance untouched", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);
    const [saved] = await s.transactions();
    await s.transactionRepository.editTransaction(saved, { amount: 650 });
    expect(await s.balance()).toBe(OPENING - 650);

    await s.seedCandidate(c);
    await sleep(20);
    const again = await s.importOne(c, { skipDuplicateCheck: true });
    // Pins the repository's real error text that `isKeyedTransactionChangedError` matches on.
    expect(again).toMatchObject({ status: "already_imported", changed: true, transactionId: saved.id });
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 650);
  });

  it("existing (pre-change) imported transactions: not recognised by key — the heuristic duplicate guard is the only protection, and 'Import anyway' still means anyway", async () => {
    const s = setup();
    await s.seedAccount();
    // A legacy import: source "sms" but a random id (no idempotency key), as every import before this change.
    const legacy = await s.transactionRepository.createTransaction({
      type: "expense", amount: 500, dateTime: new Date("2026-08-10T10:00:00.000Z"), accountId: "acc-1", categoryId: "cat-1", description: "Swiggy", source: "sms",
    });
    expect(legacy.id.startsWith("txn_")).toBe(false);
    const c = smsCandidate();
    await s.seedCandidate(c);
    const existing = [{ id: legacy.id, description: legacy.description, amount: legacy.amount, dateTime: legacy.dateTime, accountId: legacy.accountId, type: legacy.type }];

    const flagged = await s.importOne(c, { existingTransactions: existing });
    expect(flagged.status).toBe("duplicate_detected"); // guard preserved
    expect(await s.transactions()).toHaveLength(1);

    const anyway = await s.importOne(c, { existingTransactions: existing, skipDuplicateCheck: true });
    expect(anyway.status).toBe("success"); // legacy gap: no key to match, so the user's explicit choice creates a 2nd
    expect(await s.transactions()).toHaveLength(2);
  });

  it("if the earlier import was moved to trash, the same candidate can be imported afresh (one live transaction)", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);
    const [saved] = await s.transactions();
    await s.transactionRepository.softDeleteTransaction(saved);
    expect(await s.balance()).toBe(OPENING);

    await s.seedCandidate(c);
    await sleep(20);
    const redo = await s.importOne(c);
    expect(redo.status).toBe("success");
    expect(await s.activeTransactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
  });

  it("a failed create (account missing) leaves the candidate pending; after the account exists a retry imports exactly once", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);
    const failed = await s.importOne(c);
    expect(failed.status).toBe("transaction_create_failed");
    expect(await s.candidateExists(c.id)).toBe(true);
    expect(await s.transactions()).toHaveLength(0);

    await s.seedAccount();
    expect((await s.importOne(c)).status).toBe("success");
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
  });

  it("an unusual Android id (spaces, slashes are impossible in doc ids but other characters aren't) still imports idempotently via the hashed key", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate({ id: "sms item#42.x" });
    await s.seedCandidate(c);
    expect((await s.importOne(c)).status).toBe("success");
    await sleep(20);
    await s.seedCandidate(c);
    expect((await s.importOne(c, { skipDuplicateCheck: true })).status).toBe("already_imported");
    expect(await s.transactions()).toHaveLength(1);
    expect(await s.balance()).toBe(OPENING - 500);
  });
});

describe("bulk import — in-batch duplicates and partial failure", () => {
  const dayA = new Date("2026-08-10T10:00:00.000Z");

  it("two messages for one real payment: the first imports, the second is flagged for review (not written, not dropped); a legitimately repeated purchase on another day imports", async () => {
    const s = setup();
    await s.seedAccount();
    const bankSms = smsCandidate({ id: "sms-bank-0001", merchant: "Swiggy", transactionDate: dayA });
    const upiSms = smsCandidate({ id: "sms-upi-00001", merchant: "UPI-SWIGGY-ORDER-77", transactionDate: dayA });
    const nextWeek = smsCandidate({ id: "sms-next-0001", merchant: "Swiggy", transactionDate: new Date("2026-08-17T10:00:00.000Z") });
    for (const c of [bankSms, upiSms, nextWeek]) await s.seedCandidate(c);

    const results = await s.bulk([bankSms, upiSms, nextWeek]);
    expect(results.map((r) => r.outcome.status)).toEqual(["success", "duplicate_detected", "success"]);
    expect(await s.transactions()).toHaveLength(2);
    expect(await s.balance()).toBe(OPENING - 1000);
    expect(await s.candidateExists(upiSms.id)).toBe(true); // still pending, awaiting the user's decision

    // The user reviews the flagged one and confirms "Import anyway" => a real third transaction.
    const confirmed = await s.bulk([upiSms], { skip: true });
    expect(confirmed[0].outcome.status).toBe("success");
    expect(await s.balance()).toBe(OPENING - 1500);
    expect(await s.candidateExists(upiSms.id)).toBe(false);
  });

  it("partial failure: failed rows stay pending, finished rows are not redone on a full re-run, balances are exact", async () => {
    const s = setup();
    await s.seedAccount();
    const ok1 = smsCandidate({ id: "sms-ok-000001", merchant: "Swiggy", amount: 100, transactionDate: new Date("2026-08-01T10:00:00.000Z") });
    const bad = smsCandidate({ id: "sms-bad-00001", merchant: "Zomato", amount: 200, transactionDate: new Date("2026-08-02T10:00:00.000Z") });
    const ok2 = smsCandidate({ id: "sms-ok-000002", merchant: "Uber", amount: 300, transactionDate: new Date("2026-08-03T10:00:00.000Z") });
    for (const c of [ok1, bad, ok2]) await s.seedCandidate(c);

    // `bad` fails to write: route it to an account that doesn't exist, per-candidate (no forced destination).
    const run1 = await bulkImportCandidates(
      [ok1, { ...bad, accountId: "acc-missing" }, ok2], "cat-1", [], s.transactionRepository, s.candidateRepository, s.expenseRepository, [], false,
    );
    expect(run1.map((r) => r.outcome.status)).toEqual(["success", "transaction_create_failed", "success"]);
    expect(await s.balance()).toBe(OPENING - 400);
    expect(await s.candidateExists(bad.id)).toBe(true);

    await sleep(20);
    const run2 = await s.bulk([ok1, bad, ok2]); // everything again, with a working destination
    expect(run2.map((r) => r.outcome.status)).toEqual(["already_imported", "success", "already_imported"]);
    expect(await s.transactions()).toHaveLength(3);
    expect(await s.balance()).toBe(OPENING - 600);
  });
});
