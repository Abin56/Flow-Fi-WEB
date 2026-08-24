/**
 * Proves the `documentHash` fix end-to-end: `MultiBankCreditCardStatementPipeline`
 * (functions/src/pipeline/multi-bank-credit-card-statement-pipeline.ts) used to
 * hardcode `duplicateContext.statementMeta.documentHash: null`, so re-uploading
 * the exact same PDF could never be caught by `checkStatementDuplicate`'s
 * exact-hash path — only the weaker period+balance fallback. This seeds an
 * already-imported statement with a real `documentHash` (as a committed
 * statement doc would carry it) and runs the pipeline with that same hash
 * threaded through `DocumentPipelineContext.fileHash`, proving every resulting
 * staged transaction is now flagged `statement_duplicate`.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MultiBankCreditCardStatementPipeline } from "../src/pipeline/multi-bank-credit-card-statement-pipeline";
import type { PdfDocumentHandle, PdfDocumentProvider, PdfPageText } from "../src/pdf/pdf-document-provider";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const ACCOUNT_ID = "acct-hash-e2e";
const SAME_HASH = "a".repeat(64);
const DIFFERENT_HASH = "b".repeat(64);

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  for (const id of ["doc-hash-dup", "doc-hash-control"]) {
    const importRef = db.collection("users").doc(UID).collection("documentImports").doc(id);
    const records = await importRef.collection("records").get();
    await Promise.all(records.docs.map((d) => d.ref.delete()));
    await importRef.delete();
  }
  const statementsRef = db.collection("users").doc(UID).collection("creditCards").doc(ACCOUNT_ID).collection("statements");
  const statements = await statementsRef.get();
  await Promise.all(statements.docs.map((d) => d.ref.delete()));
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

async function seedAlreadyImportedStatement(documentHash: string): Promise<string> {
  const ref = db.collection("users").doc(UID).collection("creditCards").doc(ACCOUNT_ID).collection("statements").doc();
  await ref.set({ documentHash });
  return ref.id;
}

describe("MultiBankCreditCardStatementPipeline — documentHash duplicate detection", () => {
  it("flags every transaction as statement_duplicate when the same PDF (same fileHash) was already imported", async () => {
    const matchedStatementId = await seedAlreadyImportedStatement(SAME_HASH);

    const pages = loadRealStatementPages(hdfcFreedomItems as never);
    const pipeline = new MultiBankCreditCardStatementPipeline(fakeProviderFor(pages), db);

    const result = await pipeline.run(new Uint8Array(), {
      uid: UID,
      documentId: "doc-hash-dup",
      accountId: ACCOUNT_ID,
      fileHash: SAME_HASH,
    });

    expect(result.outcome).toBe("parsed");

    const recordsSnap = await db
      .collection("users")
      .doc(UID)
      .collection("documentImports")
      .doc("doc-hash-dup")
      .collection("records")
      .get();

    expect(recordsSnap.size).toBeGreaterThan(0);
    for (const doc of recordsSnap.docs) {
      expect(doc.get("duplicateOfTransactionId")).toBe(matchedStatementId);
      expect(doc.get("needsReview")).toBe(true);
    }
  });

  it("control: a different fileHash is not flagged as a statement duplicate", async () => {
    await seedAlreadyImportedStatement(SAME_HASH);

    const pages = loadRealStatementPages(hdfcFreedomItems as never);
    const pipeline = new MultiBankCreditCardStatementPipeline(fakeProviderFor(pages), db);

    const result = await pipeline.run(new Uint8Array(), {
      uid: UID,
      documentId: "doc-hash-control",
      accountId: ACCOUNT_ID,
      fileHash: DIFFERENT_HASH,
    });

    expect(result.outcome).toBe("parsed");

    const recordsSnap = await db
      .collection("users")
      .doc(UID)
      .collection("documentImports")
      .doc("doc-hash-control")
      .collection("records")
      .get();

    expect(recordsSnap.size).toBeGreaterThan(0);
    // None should be matched to the seeded (different-hash) statement — the exact-hash
    // path must not fire, and this fixture's billing period/closing balance won't
    // coincidentally match the seeded statement's (unset) period/balance either.
    const anyMatched = recordsSnap.docs.some((d) => d.get("duplicateOfTransactionId") != null);
    expect(anyMatched).toBe(false);
  });
});
