/**
 * SMS candidate tombstone lifecycle — against the REAL `SmsTransactionCandidateRepository.markHandled`,
 * the real `importCandidate`/`ignoreCandidate` orchestration, and the real `firestore.rules`, on a live
 * Firestore Emulator (synthetic data only; nothing here touches production). Run via
 * `npm run test:integration`.
 *
 * See `Finance_App/docs/sms-background-cloud-sync-architecture.md` (Phase B) for the design this pins:
 * import/dismiss now write a durable `smsCandidateTombstones/{id}` atomically with the candidate
 * delete, and the rules' `!exists(tombstone)` guard on candidate `create` is what makes a resurrected
 * candidate (simulating Android re-uploading a handled SMS) a server-side denial, not just a client
 * convention.
 *
 * `tests/integration/sms-candidate-import-idempotency.test.ts` already pins exact-once Transaction
 * creation (double-click, 8-way repository race, retries) — this file is specifically about the
 * tombstone/handled-state half of the lifecycle and does not re-prove that.
 */

import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, type FirestoreDataConverter } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ignoreCandidate, importCandidate } from "@/features/transaction-candidates/lib/import-candidate";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { smsTransactionCandidateFromFirestore, smsTransactionCandidateToFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-sms-candidate-lifecycle-test";
const UID = "sms-lifecycle-owner-uid";
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
  const tombstonesRef = collection(db, FirestoreCollections.users, UID, FirestoreCollections.smsCandidateTombstones);
  const accountRepository = new AccountRepository(accountsRef);
  const transactionRepository = new TransactionRepository(transactionsRef, accountRepository);
  const candidateRepository = new SmsTransactionCandidateRepository(candidatesRef, tombstonesRef);
  const expenseRepository = {} as never;

  return {
    transactionRepository,
    candidateRepository,
    expenseRepository,
    candidatesRef,
    tombstonesRef,
    accountsRef,
    seedAccount: (a = account()) => assertSucceeds(setDoc(doc(accountsRef, a.id), a)),
    seedCandidate: (c: SmsTransactionCandidate) => assertSucceeds(setDoc(doc(candidatesRef, c.id), c)),
    candidateExists: async (id: string) => (await getDoc(doc(candidatesRef, id))).exists(),
    tombstone: async (id: string) => (await getDoc(doc(tombstonesRef, id))).data(),
    transactions: async () => (await getDocs(transactionsRef)).docs.map((d) => d.data()),
    balance: async (id = "acc-1") => (await getDoc(doc(accountsRef, id))).data()!.currentBalance,
    importOne: (c: SmsTransactionCandidate, extra: Partial<Parameters<typeof importCandidate>[0]> = {}) =>
      importCandidate({ candidate: c, accountId: "acc-1", matchedCard: null, categoryId: "cat-1", ...extra }, transactionRepository, candidateRepository, expenseRepository),
    dismissOne: (c: SmsTransactionCandidate) => ignoreCandidate(c, candidateRepository),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("import lifecycle: tombstone + candidate removal", () => {
  it("import writes an 'imported' tombstone (with the transaction id) atomically with the candidate delete", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);

    const result = await s.importOne(c);
    expect(result.status).toBe("success");
    expect(await s.candidateExists(c.id)).toBe(false);
    const tombstone = await s.tombstone(c.id);
    expect(tombstone).toMatchObject({ outcome: "imported" });
    expect(tombstone?.transactionId).toBe((result as { transactionId: string }).transactionId);
  });

  it("resurrection denied: once imported, Android cannot re-create the same candidate id (server-side rule, not just a UI warning)", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);

    // Simulates Android's `SmsCandidateCloudSync.sync()` re-uploading the same still-locally-pending SMS.
    await assertFails(setDoc(doc(s.candidatesRef, c.id), c));
    expect(await s.candidateExists(c.id)).toBe(false);
  });

  it("already-imported settle path (resurrected candidate re-imported after bypassing the duplicate warning) also records the tombstone, idempotently", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.importOne(c);
    const firstTombstone = await s.tombstone(c.id);

    // Force a resurrection the same way the rules-protected real pipeline can't: directly, with rules
    // disabled, standing in for "a tombstone-unaware Android build (pre-Phase-C) re-uploaded anyway."
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", UID, "smsTransactionCandidates", c.id), c);
    });
    expect(await s.candidateExists(c.id)).toBe(true);

    await sleep(20);
    const again = await s.importOne(c, { skipDuplicateCheck: true });
    expect(again.status).toBe("already_imported");
    expect(await s.candidateExists(c.id)).toBe(false); // removed again
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "imported" }); // unchanged — never rewritten
    expect((await s.tombstone(c.id))?.handledAt).toEqual(firstTombstone?.handledAt);
  });
});

describe("dismiss lifecycle: tombstone + candidate removal, no Transaction ever created", () => {
  it("dismiss writes a 'dismissed' tombstone (null transactionId) atomically with the candidate delete", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);

    await s.dismissOne(c);
    expect(await s.candidateExists(c.id)).toBe(false);
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed", transactionId: null });
    expect(await s.transactions()).toHaveLength(0); // dismiss never creates a Transaction
  });

  it("resurrection denied after dismiss too", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await s.dismissOne(c);

    await assertFails(setDoc(doc(s.candidatesRef, c.id), c));
  });

  it("repeated dismiss clicks on the same candidate (no account needed — never touches money) converge without error", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);

    await s.dismissOne(c);
    await expect(s.dismissOne(c)).resolves.toBeUndefined(); // candidate already gone; tombstone already exists — both idempotent no-ops
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
  });

  it("candidate already deleted out-of-band (e.g. Android's own sync removed it first): dismiss still records the tombstone cleanly", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await deleteDoc(doc(s.candidatesRef, c.id)); // the owner can always delete their own candidate directly
    expect(await s.candidateExists(c.id)).toBe(false);

    await expect(s.dismissOne(c)).resolves.toBeUndefined();
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
  });
});

describe("concurrency: import vs. dismiss racing for the same candidate (two tabs / double actions)", () => {
  it("exactly one outcome wins; the loser fails loudly (never silently corrupts state) or converges as a safe no-op", async () => {
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const [importOutcome, dismissOutcome] = await Promise.allSettled([s.importOne(c), s.dismissOne(c)]);

    // The candidate is always gone afterwards, and exactly one tombstone outcome is recorded —
    // never both, never neither.
    expect(await s.candidateExists(c.id)).toBe(false);
    const tombstone = await s.tombstone(c.id);
    expect(["imported", "dismissed"]).toContain(tombstone?.outcome);

    // Whichever call "lost" either rejected outright (its batch commit denied/raced) or resolved having
    // converged to a no-op — both are safe; what's NOT acceptable is a second, different-outcome
    // tombstone, which the assertion above already rules out.
    const settled = [importOutcome, dismissOutcome];
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected.length).toBeLessThanOrEqual(1);

    // If import actually won AND a transaction exists, it must be exactly one — dismiss losing a race
    // must never leave a stray second transaction or a double balance effect.
    const transactions = await s.transactions();
    expect(transactions.length).toBeLessThanOrEqual(1);
    if (transactions.length === 1) {
      expect(await s.balance()).toBe(OPENING - 500);
    } else {
      expect(await s.balance()).toBe(OPENING); // dismiss won; no money moved
    }

    consoleError.mockRestore();
  });

  it("if dismiss wins the race, the transaction import had already created (if any) is never silently lost — it's reported, not hidden", async () => {
    // This is the one residual, narrow gap the architecture doc flags: markHandled cannot repair a
    // tombstone's outcome once written (rules forbid update), so if dismiss's tombstone commits first,
    // import's own later markHandled call for the SAME attempt will see a mismatched tombstone. We
    // force that specific ordering here (rather than relying on timing) to pin exactly what happens.
    const s = setup();
    await s.seedAccount();
    const c = smsCandidate();
    await s.seedCandidate(c);

    // Dismiss commits its tombstone first.
    await s.dismissOne(c);
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });

    // Android/Web still attempts the import's own markHandled after a Transaction was already created
    // in-memory by an earlier, now-overtaken step (simulated directly, since the candidate doc is gone
    // and importCandidate's own duplicate-free path can't be driven through this exact interleaving
    // from the outside).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(s.candidateRepository.markHandled(c.id, "imported", "txn-hypothetical-1")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("tombstone outcome mismatch"),
      expect.objectContaining({ candidateId: c.id, requestedOutcome: "imported", existingOutcome: "dismissed" }),
    );
    // The tombstone itself is untouched — immutability holds even though we "lost" information about
    // the import attempt. This is the accepted, documented residual risk (architecture doc, Unresolved
    // Decisions): not a silent financial error (no Transaction was actually created in this scenario),
    // but a real audit-trail gap if a genuine import transaction existed. Flagged in the Phase B report.
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
    consoleError.mockRestore();
  });
});

describe("offline / retry", () => {
  it("not independently testable against this harness: the Firestore Testing SDK has no offline/network-partition simulation. Correctness here instead rests on markHandled's idempotent-retry behavior, pinned directly above (same-outcome retry, already-deleted-candidate retry) and in lib/repositories/sms-transaction-candidate-repository.test.ts (commit-failure propagation).", () => {
    expect(true).toBe(true);
  });
});
