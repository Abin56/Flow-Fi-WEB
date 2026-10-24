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

import { candidateImportKey, importedTransactionId } from "@/features/transaction-candidates/lib/candidate-import-key";
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
    // Phase F2 (2026-10-24): ignoreCandidate now reports tombstoneMismatched rather than
    // returning void, so the UI can tell a genuine dismiss apart from a lost race (see
    // the "concurrency" describe block below) — false here, since both calls agree.
    await expect(s.dismissOne(c)).resolves.toEqual({ tombstoneMismatched: false }); // candidate already gone; tombstone already exists — both idempotent no-ops
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
  });

  it("candidate already deleted out-of-band (e.g. Android's own sync removed it first): dismiss still records the tombstone cleanly", async () => {
    const s = setup();
    const c = smsCandidate();
    await s.seedCandidate(c);
    await deleteDoc(doc(s.candidatesRef, c.id)); // the owner can always delete their own candidate directly
    expect(await s.candidateExists(c.id)).toBe(false);

    await expect(s.dismissOne(c)).resolves.toEqual({ tombstoneMismatched: false });
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
  });
});

describe("concurrency: import vs. dismiss racing for the same candidate (two tabs / double actions)", () => {
  // Phase F2 (2026-10-24): money + "imported" tombstone + candidate delete are ONE Firestore transaction, and Dismiss
  // is a transaction on the same tombstone document, so Firestore serializes the two. These tests assert the strict
  // invariant — a Transaction exists IF AND ONLY IF the tombstone says "imported" — not just "at most one".
  // Two independent `setup()` calls are two independent Firestore clients (two tabs / two devices).
  it("import (tab A) vs dismiss (tab B), raced 16 times with staggered starts: a Transaction exists exactly when the tombstone says 'imported', and both sides report what really happened", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const wins = { imported: 0, dismissed: 0 };

    for (let i = 0; i < 16; i++) {
      await testEnv.clearFirestore();
      const tabA = setup();
      const tabB = setup();
      await tabA.seedAccount();
      const c = smsCandidate();
      await tabA.seedCandidate(c);

      // Stagger the Dismiss start (0..120ms) so the race lands on every interleaving, not just "Dismiss is faster".
      const [importResult, dismissResult] = await Promise.all([tabA.importOne(c), sleep(i * 8).then(() => tabB.dismissOne(c))]);

      const tombstone = await tabA.tombstone(c.id);
      const transactions = await tabA.transactions();
      expect(await tabA.candidateExists(c.id)).toBe(false);

      if (tombstone?.outcome === "imported") {
        wins.imported++;
        expect(importResult.status).toBe("success");
        expect((importResult as { tombstoneMismatched?: boolean }).tombstoneMismatched).toBe(false);
        expect(transactions).toHaveLength(1);
        expect(tombstone.transactionId).toBe(transactions[0].id);
        expect(await tabA.balance()).toBe(OPENING - 500);
        expect(dismissResult).toEqual({ tombstoneMismatched: true }); // the Dismiss is told it lost
      } else {
        wins.dismissed++;
        expect(tombstone).toMatchObject({ outcome: "dismissed", transactionId: null });
        expect(importResult).toEqual({ status: "already_dismissed" }); // never a silent "Imported"
        expect(transactions).toHaveLength(0);
        expect(await tabA.balance()).toBe(OPENING); // no money moved
        expect(dismissResult).toEqual({ tombstoneMismatched: false });
      }
    }

    // Both orderings are legal; the point is that every run was consistent. (Logged, not asserted, to avoid a flaky test.)
    console.info(`F2 import-vs-dismiss race: imported won ${wins.imported}, dismissed won ${wins.dismissed}`);
    consoleError.mockRestore();
  }, 90_000);

  it("dismiss committed first, then an import is attempted from another tab: nothing is written and no money moves", async () => {
    const tabA = setup();
    const tabB = setup();
    await tabA.seedAccount();
    const c = smsCandidate();
    await tabA.seedCandidate(c);

    await tabB.dismissOne(c);
    const result = await tabA.importOne(c, { skipDuplicateCheck: true });

    expect(result).toEqual({ status: "already_dismissed" });
    expect(await tabA.transactions()).toHaveLength(0);
    expect(await tabA.balance()).toBe(OPENING);
    expect(await tabA.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
  });

  it("import committed first, then a Dismiss (e.g. the Undo window of another tab expiring): reports 'imported', never rewrites the tombstone, creates nothing", async () => {
    const tabA = setup();
    const tabB = setup();
    await tabA.seedAccount();
    const c = smsCandidate();
    await tabA.seedCandidate(c);

    const imported = await tabA.importOne(c);
    expect(imported.status).toBe("success");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tabB.dismissOne(c)).resolves.toEqual({ tombstoneMismatched: true });
    consoleError.mockRestore();

    expect(await tabA.tombstone(c.id)).toMatchObject({ outcome: "imported" });
    expect(await tabA.transactions()).toHaveLength(1);
    expect(await tabA.balance()).toBe(OPENING - 500);
  });

  it("the same candidate imported from two tabs at once (bypassing the in-tab guard): exactly one Transaction, one balance effect, one 'imported' tombstone", async () => {
    const tabA = setup();
    const tabB = setup();
    await tabA.seedAccount();
    const c = smsCandidate();
    await tabA.seedCandidate(c);
    const key = await candidateImportKey(c.id);
    const createParams = {
      type: "expense" as const,
      amount: c.amount,
      dateTime: c.transactionDate,
      accountId: "acc-1",
      categoryId: "cat-1",
      description: "Swiggy",
      notes: "",
      source: "sms" as const,
      idempotencyKey: key,
    };
    const raceFrom = (tab: ReturnType<typeof setup>) =>
      tab.candidateRepository.importAtomically(c.id, true, (tx) => tab.transactionRepository.createTransactionInTransaction(tx, createParams));

    const results = await Promise.all([raceFrom(tabA), raceFrom(tabB), raceFrom(tabA), raceFrom(tabB)]);

    expect(results.every((r) => r.status === "imported")).toBe(true);
    const transactions = await tabA.transactions();
    expect(transactions).toHaveLength(1);
    expect(transactions[0].id).toBe(importedTransactionId(key));
    expect(await tabA.balance()).toBe(OPENING - 500);
    expect(await tabA.tombstone(c.id)).toMatchObject({ outcome: "imported", transactionId: transactions[0].id });
    expect(await tabA.candidateExists(c.id)).toBe(false);
  });

  it("an import with a person/split step that fails: the tombstone is already 'imported' (so a Dismiss can't contradict it), the candidate stays in the queue", async () => {
    const tabA = setup();
    const tabB = setup();
    await tabA.seedAccount();
    const c = smsCandidate();
    await tabA.seedCandidate(c);

    // `expenseRepository` is `{}` in this harness, so the split step throws — the same observable as a real split failure.
    const result = await tabA.importOne(c, {
      personAssignment: { kind: "split", splitType: "equal", participantInputs: [] } as never,
    });
    expect(result).toMatchObject({ status: "imported_not_deleted", failedStep: "person_split" });
    expect(await tabA.candidateExists(c.id)).toBe(true);
    const transactions = await tabA.transactions();
    expect(transactions).toHaveLength(1);
    expect(await tabA.tombstone(c.id)).toMatchObject({ outcome: "imported", transactionId: transactions[0].id });

    // Another tab dismissing it now is told the truth, creates nothing, and cannot rewrite the tombstone.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tabB.dismissOne(c)).resolves.toEqual({ tombstoneMismatched: true });
    consoleError.mockRestore();
    expect(await tabA.tombstone(c.id)).toMatchObject({ outcome: "imported" });
    expect(await tabA.transactions()).toHaveLength(1);
    expect(await tabA.candidateExists(c.id)).toBe(false);
  });

  it("if dismiss wins the race, the transaction import had already created (if any) is never silently lost — it's reported, not hidden", async () => {
    // markHandled cannot repair a tombstone's outcome once written (rules forbid update), so if
    // dismiss's tombstone commits first, import's own later markHandled call for the SAME attempt
    // sees a mismatched tombstone. We force that specific ordering here (rather than relying on
    // timing) to pin exactly what happens. Phase F2 (2026-10-24): markHandled now RETURNS this
    // mismatch (`{ outcome, mismatched }`) instead of only logging it — import-candidate.ts's callers
    // use this to show the user "Imported, but flagged as dismissed elsewhere" rather than a blanket
    // success toast. See sms-transaction-candidate-repository.test.ts for focused coverage of the
    // return value itself; this test keeps pinning the Firestore-level immutability guarantee.
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
    await expect(s.candidateRepository.markHandled(c.id, "imported", "txn-hypothetical-1")).resolves.toEqual({
      outcome: "dismissed",
      mismatched: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("tombstone outcome mismatch"),
      expect.objectContaining({ candidateId: c.id, requestedOutcome: "imported", existingOutcome: "dismissed" }),
    );
    // The tombstone itself is untouched — immutability holds even though we "lost" information about
    // the import attempt. The audit-trail outcome stays "dismissed" permanently (rules forbid
    // rewriting it) — but the caller is no longer left to assume success blindly: it now knows this
    // specific attempt's outcome ("imported") lost the race.
    expect(await s.tombstone(c.id)).toMatchObject({ outcome: "dismissed" });
    consoleError.mockRestore();
  });
});

describe("offline / retry", () => {
  it("not independently testable against this harness: the Firestore Testing SDK has no offline/network-partition simulation. Correctness here instead rests on markHandled's idempotent-retry behavior, pinned directly above (same-outcome retry, already-deleted-candidate retry) and in lib/repositories/sms-transaction-candidate-repository.test.ts (commit-failure propagation).", () => {
    expect(true).toBe(true);
  });
});
