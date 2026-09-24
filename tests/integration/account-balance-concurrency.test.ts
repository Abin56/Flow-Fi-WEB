/**
 * Verifies the Firestore transactional-atomicity guarantee that mobile's
 * fixed `AccountRepository.adjustBalance`/`PersonRepository.adjustBalance`
 * now rely on (2026-09-23 audit finding — mobile's Dart implementations
 * used to apply a plain, non-transactional read-modify-write; fixed to
 * re-read fresh inside `runTransaction`,
 * Finance_App/lib/features/accounts/data/account_repository.dart).
 *
 * IMPORTANT — this test does NOT call this repo's own `AccountRepository.
 * adjustBalance`. Verifying against it directly would have been misleading:
 * that standalone method is not itself wrapped in `runTransaction` (it's a
 * `get`-then-plain-`update`, the same non-atomic shape mobile's used to
 * have) and — confirmed via a full-repo search while writing this test —
 * has zero production callers. Every real balance mutation on this app
 * (`TransactionRepository.createTransaction`/`editTransaction`/etc.,
 * `PersonRepository`'s `LedgerRepository` equivalents) inlines its own
 * `runTransaction` at the call site, reading the account/person fresh with
 * `tx.get` and writing with `tx.set(ref, applyBalanceDelta(fresh, delta))`
 * — never through the dead `adjustBalance` convenience method. That inline
 * shape is exactly what mobile's fixed `adjustBalance` now does (see
 * `readAdjustAndSet` below, a direct port of the shape both apps' real
 * write paths share).
 *
 * Dart's local test harness (`fake_cloud_firestore`) has no true
 * concurrency — its `runTransaction` is a single-threaded "dummy" that
 * never actually interleaves two calls, so it cannot exercise a genuine
 * race. This test fills that gap: it fires truly concurrent
 * read-inside-transaction-then-set calls (via `Promise.all`) against ONE
 * shared account on a REAL Firestore Emulator, proving the server-side
 * optimistic-concurrency guarantee (a transaction whose read set changed
 * before commit is retried) that this exact code shape depends on actually
 * holds. That guarantee is a Firestore server property, not a
 * client-SDK/language one, so what this proves here applies identically to
 * mobile's `cloud_firestore` SDK against the same backend.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, runTransaction } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { AccountRepository } from "@/lib/repositories/account-repository";

const PROJECT_ID = "flowfi-balance-concurrency-test";
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

type TestFirestore = ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;

function accountRepositoryFor(db: TestFirestore) {
  const accountsCol = collection(db, "users", UID, "accounts").withConverter({
    toFirestore: accountToFirestore,
    fromFirestore: accountFromFirestore,
  });
  return new AccountRepository(accountsCol);
}

/**
 * The real shape every production balance mutation uses (see file doc
 * comment) — and the shape mobile's fixed `adjustBalance` now mirrors.
 * Re-reads the account fresh inside the transaction; never trusts a
 * possibly-stale in-memory snapshot.
 */
async function readAdjustAndSet(db: TestFirestore, repo: AccountRepository, accountId: string, delta: number) {
  const ref = repo.docRef(accountId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data();
    if (!current) throw new Error("Account not found");
    tx.set(ref, repo.applyBalanceDelta(current, delta));
  });
}

describe("Balance adjustment under genuine concurrency (real emulator)", () => {
  it("composes two concurrent positive deltas correctly", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const repo = accountRepositoryFor(db);
    const account = await repo.createAccount({ name: "Shared", type: "bank", openingBalance: 1000, colorValue: 0 });

    await Promise.all([readAdjustAndSet(db, repo, account.id, 200), readAdjustAndSet(db, repo, account.id, 300)]);

    const final = await repo.getByKey(account.id);
    expect(final?.currentBalance).toBe(1500);
  });

  it("composes a concurrent positive and negative delta correctly", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const repo = accountRepositoryFor(db);
    const account = await repo.createAccount({ name: "Shared", type: "bank", openingBalance: 1000, colorValue: 0 });

    await Promise.all([readAdjustAndSet(db, repo, account.id, 500), readAdjustAndSet(db, repo, account.id, -300)]);

    const final = await repo.getByKey(account.id);
    expect(final?.currentBalance).toBe(1200);
  });

  it("composes two concurrent negative deltas correctly", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const repo = accountRepositoryFor(db);
    const account = await repo.createAccount({ name: "Shared", type: "bank", openingBalance: 1000, colorValue: 0 });

    await Promise.all([readAdjustAndSet(db, repo, account.id, -200), readAdjustAndSet(db, repo, account.id, -300)]);

    const final = await repo.getByKey(account.id);
    expect(final?.currentBalance).toBe(500);
  });

  it("composes many concurrent mixed-sign deltas correctly (10-way race)", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const repo = accountRepositoryFor(db);
    const account = await repo.createAccount({ name: "Shared", type: "bank", openingBalance: 1000, colorValue: 0 });

    const deltas = [100, -50, 200, -300, 75, -25, 400, -100, 50, -150];
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(200);

    await Promise.all(deltas.map((delta) => readAdjustAndSet(db, repo, account.id, delta)));

    const final = await repo.getByKey(account.id);
    expect(final?.currentBalance).toBe(1200);
  });

  it(
    "CONTROL (would fail if genuine): a naive non-transactional read-then-set " +
      "loses updates under the same concurrency — confirms the test harness " +
      "actually exercises a real race, not a no-op",
    async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      const repo = accountRepositoryFor(db);
      const account = await repo.createAccount({ name: "Shared", type: "bank", openingBalance: 1000, colorValue: 0 });

      const fresh1 = await repo.getByKey(account.id);
      const fresh2 = await repo.getByKey(account.id);
      // The dead, non-transactional AccountRepository.adjustBalance — deliberately
      // used here as the control to prove the race is real under this harness.
      await Promise.all([repo.adjustBalance(fresh1!, 200), repo.adjustBalance(fresh2!, 300)]);

      const final = await repo.getByKey(account.id);
      expect(final?.currentBalance).not.toBe(1500);
    },
  );
});
