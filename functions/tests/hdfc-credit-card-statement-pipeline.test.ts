/**
 * HdfcCreditCardStatementPipeline — real Firestore Emulator test (same
 * discipline as document-analyzer-worker.test.ts/staging-writer.test.ts),
 * driven by the real, redacted HDFC Freedom statement fixture. A fake
 * `PdfDocumentProvider` stands in for actual PDF-byte decoding — that's
 * pdfjs-document-provider's own tested responsibility (pdf-document-
 * pipeline.test.ts); this test's job is proving the orchestration
 * (extraction → Statement Intelligence → staging write) end-to-end.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HdfcCreditCardStatementPipeline } from "../src/pipeline/hdfc-credit-card-statement-pipeline";
import type { PdfDocumentHandle, PdfDocumentProvider, PdfPageText } from "../src/pdf/pdf-document-provider";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const DOCUMENT_ID = "doc-hdfc-e2e";
const ACCOUNT_ID = "acct-hdfc-e2e";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const importRef = db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID);
  const records = await importRef.collection("records").get();
  await Promise.all(records.docs.map((d) => d.ref.delete()));
  await importRef.delete();
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

describe("HdfcCreditCardStatementPipeline — real HDFC Freedom statement fixture", () => {
  it("extracts, runs Statement Intelligence, and writes staging documents", async () => {
    const pages = loadRealStatementPages(hdfcFreedomItems as never);
    const pipeline = new HdfcCreditCardStatementPipeline(fakeProviderFor(pages), db);

    const result = await pipeline.run(new Uint8Array(), { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID });

    expect(result.outcome).toBe("parsed");

    const importSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).get();
    expect(importSnap.exists).toBe(true);
    expect(importSnap.get("accountId")).toBe(ACCOUNT_ID);

    const recordsSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).collection("records").get();
    expect(recordsSnap.size).toBeGreaterThan(0);
  });

  it("returns needs_review, not a crash, when no pipeline context is given", async () => {
    const pages = loadRealStatementPages(hdfcFreedomItems as never);
    const pipeline = new HdfcCreditCardStatementPipeline(fakeProviderFor(pages), db);
    const result = await pipeline.run(new Uint8Array());
    expect(result).toEqual({ outcome: "needs_review", reason: "missing_pipeline_context" });
  });

  it("returns needs_review for a document that isn't an HDFC statement", async () => {
    const nonHdfcPages: PdfPageText[] = [{ pageNumber: 1, text: "Some Other Bank Statement", items: [{ str: "Some Other Bank Statement", x: 0, y: 0, width: 100, height: 10 }] }];
    const pipeline = new HdfcCreditCardStatementPipeline(fakeProviderFor(nonHdfcPages), db);
    const result = await pipeline.run(new Uint8Array(), { uid: UID, documentId: "doc-other", accountId: ACCOUNT_ID });
    expect(result).toEqual({ outcome: "needs_review", reason: "unrecognized_statement_template" });
  });

  it("runWithHandle produces the same outcome as run() given an already-open handle (PDF Analyzer retry path)", async () => {
    const pages = loadRealStatementPages(hdfcFreedomItems as never);
    const provider = fakeProviderFor(pages);
    const pipeline = new HdfcCreditCardStatementPipeline(provider, db);

    const handle = await provider.open(new Uint8Array());
    const result = await pipeline.runWithHandle(handle, { uid: UID, documentId: DOCUMENT_ID, accountId: ACCOUNT_ID });

    expect(result.outcome).toBe("parsed");
    const importSnap = await db.collection("users").doc(UID).collection("documentImports").doc(DOCUMENT_ID).get();
    expect(importSnap.exists).toBe(true);
  });

  it("openAndClassify reports the same failed/password shape run() has always returned for an open failure", async () => {
    const throwingProvider: PdfDocumentProvider = {
      open: async () => {
        throw new (await import("../src/pdf/pdf-document-provider")).PdfDocumentError(
          "PDF_ENCRYPTED",
          "This document is password-protected.",
        );
      },
    };
    const pipeline = new HdfcCreditCardStatementPipeline(throwingProvider, db);
    const opened = await pipeline.openAndClassify(new Uint8Array());
    expect(opened).toEqual({
      ok: false,
      result: { outcome: "failed", failureReason: "password_required", message: "This document is password-protected." },
    });
  });
});
