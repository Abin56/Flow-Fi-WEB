/**
 * Real Firestore Emulator test for the read-only Duplicate Detection
 * lookup layer (Statement Intelligence Layer, module 2). Seeds real
 * documents, then confirms the fetch functions read them back correctly
 * and touch nothing (no writes from these functions themselves).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { fetchExistingStatementsForComparison, fetchExistingTransactionsForComparison } from "../src/duplicate/duplicate-lookup-repository";

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
  const stmtSnap = await db.collection("users").doc(UID).collection("creditCards").doc(CARD_ID).collection("statements").get();
  await Promise.all(stmtSnap.docs.map((d) => d.ref.delete()));
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

describe("fetchExistingStatementsForComparison", () => {
  it("reads back a real statement record", async () => {
    await db.collection("users").doc(UID).collection("creditCards").doc(CARD_ID).collection("statements").doc("stmt-1").set({
      documentHash: "abc123",
      billingPeriodStart: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 1))),
      billingPeriodEnd: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 30))),
      closingBalance: 5000,
    });

    const results = await fetchExistingStatementsForComparison(db, UID, CARD_ID);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("stmt-1");
    expect(results[0]!.documentHash).toBe("abc123");
    expect(results[0]!.closingBalance).toBe(5000);
    expect(results[0]!.cardId).toBe(CARD_ID);
  });

  it("returns an empty array for a card with no statements", async () => {
    const results = await fetchExistingStatementsForComparison(db, UID, "card-with-no-statements");
    expect(results).toHaveLength(0);
  });
});
