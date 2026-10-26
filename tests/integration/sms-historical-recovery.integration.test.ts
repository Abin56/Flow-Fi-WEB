/**
 * Android historical SMS recovery → Web Transaction Inbox, on a live Firestore Emulator with the real
 * `firestore.rules` (synthetic data only). Run via `npm run test:integration`.
 *
 * Android's one-time recovery (`Finance_App/lib/features/sms_inbox/presentation/sms_historical_recovery.dart`)
 * binds unowned local candidates to the signed-in uid and uploads them through the existing tombstone-aware
 * `SmsCandidateCloudSync`. This pins what that upload means server-side: the documents land under
 * `users/{uid}/smsTransactionCandidates` in a shape the Web reads, a repeat run overwrites rather than
 * duplicates, Import/Dismiss tombstones still block re-creation, and another account can neither read nor
 * write them.
 */

import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, orderBy, query, runTransaction, setDoc, Timestamp, type Firestore, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ignoreCandidate, importCandidate } from "@/features/transaction-candidates/lib/import-candidate";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { smsTransactionCandidateFromFirestore } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-sms-historical-recovery-test";
const UID_A = "recovery-owner-a";
const UID_B = "recovery-other-b";

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
// Candidate writes need the server-written pairing switch (firestore.rules backstop, 2026-10-25).
beforeEach(async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", UID_A, "smsSyncConfig", "backgroundUpload"), { enabled: true, deviceId: "dev-1", source: "pairing" });
    await setDoc(doc(ctx.firestore(), "users", UID_B, "smsSyncConfig", "backgroundUpload"), { enabled: true, deviceId: "dev-1", source: "pairing" });
  });
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

/** Exactly the map `SmsTransactionCandidateCloud.toFirestore()` writes (Dart Timestamps, enum names). */
function androidPayload(i: number) {
  return {
    smsItemId: `local-row-${i}`,
    amount: 100 + i,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: Timestamp.fromDate(new Date(Date.UTC(2026, 6, 15, 10, i))),
    merchant: `shop${i}`,
    bankName: "HDFC",
    rawLastFour: "5623",
    accountId: null,
    cardId: null,
    referenceNumber: `12345678900${i}`,
    confidenceLevel: "low",
    confidenceScore: 0.2,
    needsReview: true,
    needsReviewReasons: [],
    source: "sms",
    createdAt: Timestamp.fromDate(new Date(Date.UTC(2026, 6, 15))),
    deletedAt: null,
  };
}
const cloudId = (i: number) => `v2-recovered-${i}`;

const candidatesOf = (db: Firestore, uid: string) => collection(db, FirestoreCollections.users, uid, FirestoreCollections.smsTransactionCandidates);
const tombstonesOf = (db: Firestore, uid: string) => collection(db, FirestoreCollections.users, uid, FirestoreCollections.smsCandidateTombstones);

/** Mirrors Android's `_uploadUnlessHandled`: tombstone read + candidate write in ONE transaction. Returns whether it wrote. */
async function androidUpload(db: Firestore, uid: string, id: string, data: ReturnType<typeof androidPayload>) {
  return runTransaction(db, async (tx) => {
    const tombstone = await tx.get(doc(tombstonesOf(db, uid), id));
    if (tombstone.exists()) return false;
    tx.set(doc(candidatesOf(db, uid), id), data);
    return true;
  });
}

/** What the Web Transaction Inbox hook reads: `orderBy(transactionDate desc)` + the model converter. */
async function webInbox(db: Firestore, uid: string) {
  const snap = await getDocs(query(candidatesOf(db, uid), orderBy("transactionDate", "desc")));
  const read = snap.docs.map((d) => {
    try {
      return smsTransactionCandidateFromFirestore(d);
    } catch {
      return null;
    }
  });
  return { readable: read.filter((c) => c != null), unreadable: read.filter((c) => c == null).length };
}

async function recoverAll(db: Firestore, uid: string, count: number) {
  let uploaded = 0;
  for (let i = 1; i <= count; i++) if (await androidUpload(db, uid, cloudId(i), androidPayload(i))) uploaded++;
  return uploaded;
}

function webRepos(db: Firestore, uid: string) {
  const accountConverter: FirestoreDataConverter<Account> = { toFirestore: accountToFirestore, fromFirestore: accountFromFirestore };
  const transactionConverter: FirestoreDataConverter<Transaction> = { toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore };
  const accountsRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.accounts).withConverter(accountConverter);
  const transactionsRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.transactions).withConverter(transactionConverter);
  const accountRepository = new AccountRepository(accountsRef);
  return {
    accountsRef,
    transactionsRef,
    transactionRepository: new TransactionRepository(transactionsRef, accountRepository),
    candidateRepository: new SmsTransactionCandidateRepository(candidatesOf(db, uid), tombstonesOf(db, uid)),
  };
}

const account: Account = {
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
  accountNumberLast4: "5623",
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
};

describe("recovered candidates reach the Web Transaction Inbox", () => {
  it("uploads land under users/{uid}/smsTransactionCandidates and every one is readable by the Web", async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore() as unknown as Firestore;
    expect(await recoverAll(db, UID_A, 5)).toBe(5);

    const inbox = await webInbox(db, UID_A);
    expect(inbox.unreadable).toBe(0);
    expect(inbox.readable).toHaveLength(5);
    expect(inbox.readable[0]).toMatchObject({ id: cloudId(5), amount: 105, direction: "debit", source: "sms" });
  });

  it("repeat recovery overwrites the same documents (update allowed) and never duplicates", async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore() as unknown as Firestore;
    await recoverAll(db, UID_A, 3);
    expect(await recoverAll(db, UID_A, 3)).toBe(3);
    expect((await getDocs(candidatesOf(db, UID_A))).size).toBe(3);
  });
});

describe("Import and Dismiss keep tombstone protection after recovery", () => {
  it("imported and dismissed candidates are tombstoned, the Android transaction skips them, and a raw re-create is denied", async () => {
    const db = testEnv.authenticatedContext(UID_A).firestore() as unknown as Firestore;
    const repos = webRepos(db, UID_A);
    await assertSucceeds(setDoc(doc(repos.accountsRef, account.id), account));
    await recoverAll(db, UID_A, 3);

    const [c1, c2] = (await webInbox(db, UID_A)).readable.filter((c) => c!.id !== cloudId(3));
    const imported = await importCandidate(
      { candidate: c1!, accountId: "acc-1", matchedCard: null, categoryId: "cat-1" },
      repos.transactionRepository,
      repos.candidateRepository,
      {} as never,
    );
    expect(imported.status).toBe("success");
    await ignoreCandidate(c2!, repos.candidateRepository);

    expect((await getDoc(doc(tombstonesOf(db, UID_A), c1!.id))).data()).toMatchObject({ outcome: "imported" });
    expect((await getDoc(doc(tombstonesOf(db, UID_A), c2!.id))).data()).toMatchObject({ outcome: "dismissed" });

    // Running recovery again: only the untouched candidate is (re)written.
    expect(await recoverAll(db, UID_A, 3)).toBe(1);
    expect((await webInbox(db, UID_A)).readable.map((c) => c!.id)).toEqual([cloudId(3)]);

    // Backstop: a tombstone-unaware write is refused by the rules.
    const n1 = Number(c1!.id.split("-").pop());
    await assertFails(setDoc(doc(candidatesOf(db, UID_A), c1!.id), androidPayload(n1)));
    expect((await getDocs(repos.transactionsRef)).size).toBe(1); // exactly one Transaction, from the import
  });
});

describe("another account cannot claim or see the recovered candidates", () => {
  it("account B can neither read, write, overwrite nor tombstone account A's candidates", async () => {
    const dbA = testEnv.authenticatedContext(UID_A).firestore() as unknown as Firestore;
    await recoverAll(dbA, UID_A, 2);

    const dbB = testEnv.authenticatedContext(UID_B).firestore() as unknown as Firestore;
    await assertFails(getDocs(candidatesOf(dbB, UID_A)));
    await assertFails(getDoc(doc(candidatesOf(dbB, UID_A), cloudId(1))));
    await assertFails(setDoc(doc(candidatesOf(dbB, UID_A), cloudId(1)), androidPayload(1)));
    await assertFails(setDoc(doc(candidatesOf(dbB, UID_A), cloudId(9)), androidPayload(9)));
    await assertFails(setDoc(doc(tombstonesOf(dbB, UID_A), cloudId(1)), { outcome: "dismissed" }));

    // B's own inbox stays empty; A's is untouched.
    expect((await webInbox(dbB, UID_B)).readable).toHaveLength(0);
    expect((await webInbox(dbA, UID_A)).readable).toHaveLength(2);
  });

  it("signed-out upload is denied", async () => {
    const anon = testEnv.unauthenticatedContext().firestore() as unknown as Firestore;
    await assertFails(setDoc(doc(candidatesOf(anon, UID_A), cloudId(1)), androidPayload(1)));
  });
});
