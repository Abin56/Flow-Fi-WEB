/**
 * Real Firestore Emulator test for the read-only Duplicate Detection
 * lookup layer (Statement Intelligence Layer, module 2). Seeds real
 * documents, then confirms the fetch functions read them back correctly
 * and touch nothing (no writes from these functions themselves).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { fetchExistingStatementsForComparison, fetchExistingTransactionsForComparison, resolveCardAccountId } from "../src/duplicate/duplicate-lookup-repository";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid-duplicate-lookup";
const ACCOUNT_ID = "acct-1";
const CARD_ID = "card-1";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const txSnap = await db.collection("users").doc(UID).collection("transactions").get();
  await Promise.all(txSnap.docs.map((d) => d.ref.delete()));
  for (const name of ["documentImports", "financialDocuments", "creditCards"]) {
    const snap = await db.collection("users").doc(UID).collection(name).get();
    await Promise.all(
      snap.docs.map(async (d) => {
        if (name === "documentImports") await Promise.all((await d.ref.collection("records").get()).docs.map((r) => r.ref.delete()));
        await d.ref.delete();
      }),
    );
  }
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

describe("fetchExistingTransactionsForComparison", () => {
  it("reads back a real transaction within the date window", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-1").set({
      accountId: ACCOUNT_ID,
      description: "AMAZON purchase",
      amount: 899,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
    });

    const results = await fetchExistingTransactionsForComparison(
      db,
      UID,
      ACCOUNT_ID,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 30)),
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("tx-1");
    expect(results[0]!.description).toBe("AMAZON purchase");
    expect(results[0]!.amount).toBe(899);
    expect(results[0]!.dateTime.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19)).toISOString());
  });

  it("excludes transactions for a different account", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-2").set({
      accountId: "some-other-account",
      description: "OTHER ACCOUNT PURCHASE",
      amount: 500,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
    });

    const results = await fetchExistingTransactionsForComparison(
      db,
      UID,
      ACCOUNT_ID,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 30)),
    );
    expect(results).toHaveLength(0);
  });

  it("excludes soft-deleted transactions", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-3").set({
      accountId: ACCOUNT_ID,
      description: "DELETED PURCHASE",
      amount: 500,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
      deleted: true,
    });

    const results = await fetchExistingTransactionsForComparison(
      db,
      UID,
      ACCOUNT_ID,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 30)),
    );
    expect(results).toHaveLength(0);
  });

  it("includes transactions within the padded window even if outside the exact billing period", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-4").set({
      accountId: ACCOUNT_ID,
      description: "EARLY POST",
      amount: 300,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 4, 30))), // 1 day before the window
    });

    const results = await fetchExistingTransactionsForComparison(
      db,
      UID,
      ACCOUNT_ID,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 30)),
      3,
    );
    expect(results).toHaveLength(1);
  });

  it("does not write anything — a repeated read produces the same result", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-5").set({
      accountId: ACCOUNT_ID,
      description: "REPEATABLE",
      amount: 100,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
    });
    const first = await fetchExistingTransactionsForComparison(db, UID, ACCOUNT_ID, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 30)));
    const second = await fetchExistingTransactionsForComparison(db, UID, ACCOUNT_ID, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 30)));
    expect(second).toEqual(first);
  });
});

describe("fetchExistingTransactionsForComparison — soft delete", () => {
  it("excludes a transaction soft-deleted with the real marker, deletedAt", async () => {
    await db.collection("users").doc(UID).collection("transactions").doc("tx-deleted-at").set({
      accountId: ACCOUNT_ID,
      description: "TRASHED PURCHASE",
      amount: 500,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
      deletedAt: Timestamp.now(),
    });
    await db.collection("users").doc(UID).collection("transactions").doc("tx-live").set({
      accountId: ACCOUNT_ID,
      description: "LIVE PURCHASE",
      amount: 500,
      dateTime: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 19))),
      deletedAt: null,
    });
    const results = await fetchExistingTransactionsForComparison(db, UID, ACCOUNT_ID, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 5, 30)));
    expect(results.map((r) => r.id)).toEqual(["tx-live"]);
  });
});

describe("resolveCardAccountId", () => {
  it("maps a credit-card profile id to its underlying Account id", async () => {
    await db.collection("users").doc(UID).collection("creditCards").doc(CARD_ID).set({ accountId: "the-real-account" });
    expect(await resolveCardAccountId(db, UID, CARD_ID)).toBe("the-real-account");
  });

  it("falls back to the given id when the profile is missing", async () => {
    expect(await resolveCardAccountId(db, UID, "no-such-card")).toBe("no-such-card");
  });
});

describe("fetchExistingStatementsForComparison (imported statements)", () => {
  async function seedImport(id: string, opts: { committed: boolean; cardId?: string; hash?: string | null }) {
    const importRef = db.collection("users").doc(UID).collection("documentImports").doc(id);
    await importRef.set({
      accountId: opts.cardId ?? CARD_ID,
      status: "draft",
      metadata: {
        statementInfo: {
          billingPeriodStart: { value: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 1))) },
          billingPeriodEnd: { value: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 30))) },
        },
        billingSummary: { closingBalance: { value: 5000 } },
      },
    });
    await importRef.collection("records").doc("1").set({ committedTransactionId: opts.committed ? "txn-1" : null });
    if (opts.hash !== undefined) await db.collection("users").doc(UID).collection("financialDocuments").doc(id).set({ fileHash: opts.hash });
  }

  it("returns an imported statement with period, closing balance and hash from the persisted import", async () => {
    await seedImport("doc-1", { committed: true, hash: "abc123" });
    const results = await fetchExistingStatementsForComparison(db, UID, CARD_ID);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("doc-1");
    expect(results[0]!.documentHash).toBe("abc123");
    expect(results[0]!.closingBalance).toBe(5000);
    expect(results[0]!.billingPeriodStart!.toISOString()).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(results[0]!.cardId).toBe(CARD_ID);
  });

  it("ignores a staged import with no committed rows", async () => {
    await seedImport("doc-staged", { committed: false, hash: "x" });
    expect(await fetchExistingStatementsForComparison(db, UID, CARD_ID)).toHaveLength(0);
  });

  it("ignores another card's imports and the excluded (current) document", async () => {
    await seedImport("doc-other-card", { committed: true, cardId: "other-card", hash: "x" });
    await seedImport("doc-current", { committed: true, hash: "y" });
    expect(await fetchExistingStatementsForComparison(db, UID, CARD_ID, "doc-current")).toHaveLength(0);
  });

  it("returns an empty array for a card with no imports", async () => {
    expect(await fetchExistingStatementsForComparison(db, UID, "card-with-no-imports")).toHaveLength(0);
  });
});
