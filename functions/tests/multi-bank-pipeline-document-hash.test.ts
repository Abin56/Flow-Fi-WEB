/**
 * Duplicate detection through the REAL pipeline (Firestore Emulator), against the REAL persisted schema:
 *
 *  - a credit-card PROFILE id that differs from its underlying Account id (the real shape — `createCard`
 *    generates them independently), with `transactions` carrying the Account id;
 *  - soft deletes marked by `deletedAt`;
 *  - an "already imported statement" represented the way the app actually persists one: a
 *    `documentImports/{id}` staging doc whose `records` carry `committedTransactionId`, plus
 *    `financialDocuments/{id}.fileHash` — NOT a `creditCards/{id}/statements` doc with PDF fields (those docs
 *    are FlowFi-derived and carry `periodStart`/`periodEnd`/`totalAmount` only).
 *
 * An earlier version of this file seeded `statements` docs with an invented `documentHash` field, which is why
 * the statement-level check silently never fired in production.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MultiBankCreditCardStatementPipeline } from "../src/pipeline/multi-bank-credit-card-statement-pipeline";
import type { PdfDocumentHandle, PdfDocumentProvider, PdfPageText } from "../src/pdf/pdf-document-provider";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid-pipeline-dup";
const CARD_ID = "card-profile-111"; // the creditCards/{id} profile id
const ACCOUNT_ID = "account-for-card-999"; // the underlying accounts/{id} — DIFFERENT from CARD_ID
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

const userRef = () => db.collection("users").doc(UID);

async function wipeCollection(path: string[]): Promise<void> {
  const snap = await userRef().collection(path[0]!).get();
  await Promise.all(
    snap.docs.map(async (d) => {
      if (path[0] === "documentImports") {
        const records = await d.ref.collection("records").get();
        await Promise.all(records.docs.map((r) => r.ref.delete()));
      }
      await d.ref.delete();
    }),
  );
}

afterEach(async () => {
  for (const name of ["documentImports", "financialDocuments", "transactions", "creditCards"]) await wipeCollection([name]);
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

function fakeProviderFor(pages: PdfPageText[]): PdfDocumentProvider {
  const handle: PdfDocumentHandle = {
    pageCount: pages.length,
    getPageText: async (pageNumber: number) => pages.find((p) => p.pageNumber === pageNumber)!,
    getAllPageText: async () => pages,
    destroy: async () => {},
  };
  return { open: async () => handle };
}

async function seedCardProfile(): Promise<void> {
  await userRef().collection("creditCards").doc(CARD_ID).set({ accountId: ACCOUNT_ID });
}

async function runPipeline(documentId: string, fileHash: string) {
  const pages = loadRealStatementPages(hdfcFreedomItems as never);
  const pipeline = new MultiBankCreditCardStatementPipeline(fakeProviderFor(pages), db);
  const result = await pipeline.run(new Uint8Array(), { uid: UID, documentId, accountId: CARD_ID, fileHash });
  const records = await userRef().collection("documentImports").doc(documentId).collection("records").get();
  return { result, records };
}

/** Marks a staged document as truly imported: a committed record + its financialDocuments hash. */
async function markImported(documentId: string, fileHash: string): Promise<void> {
  const records = await userRef().collection("documentImports").doc(documentId).collection("records").get();
  await records.docs[0]!.ref.update({ committedTransactionId: "txn-created-by-that-import" });
  await userRef().collection("financialDocuments").doc(documentId).set({ fileHash, accountId: CARD_ID });
}

describe("statement-level duplicate detection (real persisted schema)", () => {
  it("flags every row when a previously IMPORTED statement has the same billing period and closing balance (re-exported PDF, different bytes)", async () => {
    await seedCardProfile();
    const first = await runPipeline("doc-first", HASH_A);
    expect(first.result.outcome).toBe("parsed");
    await markImported("doc-first", HASH_A);

    const second = await runPipeline("doc-second", HASH_B);
    expect(second.records.size).toBeGreaterThan(0);
    for (const doc of second.records.docs) {
      expect(doc.get("duplicateCandidateOf")).toBe("doc-first");
      expect(doc.get("needsReview")).toBe(true);
    }
  });

  it("does NOT flag rows when the earlier statement was only staged and never imported", async () => {
    await seedCardProfile();
    await runPipeline("doc-first", HASH_A);
    // no committedTransactionId on any record → not an imported statement

    const second = await runPipeline("doc-second", HASH_B);
    expect(second.records.docs.some((d) => d.get("duplicateCandidateOf") != null)).toBe(false);
  });

  it("does NOT flag rows when the imported statement belongs to a different card", async () => {
    await seedCardProfile();
    await runPipeline("doc-first", HASH_A);
    await markImported("doc-first", HASH_A);
    await userRef().collection("documentImports").doc("doc-first").update({ accountId: "some-other-card" });

    const second = await runPipeline("doc-second", HASH_B);
    expect(second.records.docs.some((d) => d.get("duplicateCandidateOf") != null)).toBe(false);
  });

  it("re-running the SAME document never flags it as a duplicate of itself", async () => {
    await seedCardProfile();
    await runPipeline("doc-first", HASH_A);
    await markImported("doc-first", HASH_A);

    const again = await runPipeline("doc-first", HASH_A);
    expect(again.records.docs.some((d) => d.get("duplicateCandidateOf") != null)).toBe(false);
  });
});

describe("row-level duplicates against existing transactions (card id ≠ account id)", () => {
  async function stagedRowToDuplicate() {
    await seedCardProfile();
    const probe = await runPipeline("doc-probe", HASH_A);
    const row = probe.records.docs.find((d) => d.get("direction") === "debit" && d.get("amount") > 0)!;
    // Reset: only the extracted facts are needed; wipe the probe so the real run starts clean.
    const facts = {
      description: (row.get("counterpartyNormalized") ?? row.get("counterpartyRaw")) as string,
      amount: row.get("amount") as number,
      dateTime: row.get("date") as Timestamp,
      rowId: row.id,
    };
    await wipeCollection(["documentImports"]);
    return facts;
  }

  it("flags a row that matches an existing MANUAL transaction on the card's underlying account", async () => {
    const facts = await stagedRowToDuplicate();
    await userRef().collection("transactions").doc("manual-1").set({
      accountId: ACCOUNT_ID,
      description: facts.description,
      amount: facts.amount,
      dateTime: facts.dateTime,
      type: "expense",
      source: null,
    });

    const run = await runPipeline("doc-real", HASH_B);
    expect(run.records.docs.find((d) => d.id === facts.rowId)!.get("duplicateCandidateOf")).toBe("manual-1");
  });

  it("flags a row that matches an existing SMS-imported transaction", async () => {
    const facts = await stagedRowToDuplicate();
    await userRef().collection("transactions").doc("txn_sms_abc12345").set({
      accountId: ACCOUNT_ID,
      description: facts.description,
      amount: facts.amount,
      dateTime: facts.dateTime,
      type: "expense",
      source: "sms",
    });

    const run = await runPipeline("doc-real", HASH_B);
    expect(run.records.docs.find((d) => d.id === facts.rowId)!.get("duplicateCandidateOf")).toBe("txn_sms_abc12345");
  });

  it("does NOT flag a row whose only match is a soft-deleted transaction (deletedAt)", async () => {
    const facts = await stagedRowToDuplicate();
    await userRef().collection("transactions").doc("deleted-1").set({
      accountId: ACCOUNT_ID,
      description: facts.description,
      amount: facts.amount,
      dateTime: facts.dateTime,
      type: "expense",
      deletedAt: Timestamp.now(),
    });

    const run = await runPipeline("doc-real", HASH_B);
    expect(run.records.docs.find((d) => d.id === facts.rowId)!.get("duplicateCandidateOf")).toBeNull();
  });

  it("does NOT flag a row that only matches a transaction on a different account", async () => {
    const facts = await stagedRowToDuplicate();
    await userRef().collection("transactions").doc("other-1").set({
      accountId: "unrelated-account",
      description: facts.description,
      amount: facts.amount,
      dateTime: facts.dateTime,
      type: "expense",
    });

    const run = await runPipeline("doc-real", HASH_B);
    expect(run.records.docs.find((d) => d.id === facts.rowId)!.get("duplicateCandidateOf")).toBeNull();
  });
});
