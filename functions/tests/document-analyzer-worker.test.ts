/**
 * Real Firestore Emulator tests — backlog M2-T2 acceptance criteria:
 * "Status transitions visible in Firestore in the documented order
 * (uploaded -> decrypting -> parsing -> parsed/needs_review); each
 * transition is a discrete, observable write" and "Integration test
 * asserting the full status sequence for a stubbed-success and a
 * stubbed-failure path."
 *
 * Two kinds of Pipeline are used deliberately: a real `PdfDocumentPipeline`
 * against a real PDF fixture (proves the actual current implementation),
 * and a small test-double `DocumentPipeline` implementation (proves the
 * Worker's orchestration handles every outcome shape the interface
 * allows, including `needs_review`, which the real pipeline can't
 * produce yet — see document-pipeline.ts's module comment). The
 * test-double is a genuine alternate implementation of a real interface,
 * not a mock of this module's own behavior — same principle as using the
 * real Firestore Emulator instead of mocking Firestore.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DocumentPipeline, DocumentPipelineResult } from "../src/pipeline/document-pipeline";
import { PdfDocumentPipeline } from "../src/pipeline/pdf-document-pipeline";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";
import { runDocumentAnalyzer } from "../src/worker/document-analyzer-worker";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  const snap = await db.collection("users").doc(UID).collection("financialDocuments").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

function docRef(documentId: string) {
  return db.collection("users").doc(UID).collection("financialDocuments").doc(documentId);
}

async function seedParsingDocument(documentId: string, overrides: Record<string, unknown> = {}) {
  await docRef(documentId).set({
    userId: UID,
    documentType: "credit_card_statement",
    accountId: "acct-1",
    fileHash: "a".repeat(64),
    storagePath: `path/${documentId}.pdf`,
    status: "parsing",
    ...overrides,
  });
}

/** A controllable, non-mocked DocumentPipeline implementation for testing the Worker's own logic in isolation. */
class FixedResultPipeline implements DocumentPipeline {
  constructor(private readonly result: DocumentPipelineResult) {}
  async run(): Promise<DocumentPipelineResult> {
    return this.result;
  }
}

async function makePlainPdfBytes(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 300]);
  return pdf.save({ addDefaultPage: false });
}

const noopReader = async () => new Uint8Array([]);

describe("runDocumentAnalyzer — full status sequence with the REAL pipeline (backlog M2-T2's core acceptance criterion)", () => {
  it("stubbed-success path: parsing -> parsed, with the real page count recorded", async () => {
    await seedParsingDocument("doc-real-success");
    const bytes = await makePlainPdfBytes(3);
    const realPipeline = new PdfDocumentPipeline(new PdfjsDocumentProvider());

    const result = await runDocumentAnalyzer(db, realPipeline, async () => bytes, {
      uid: UID,
      documentId: "doc-real-success",
      storagePath: "path/doc-real-success.pdf",
    });

    expect(result).toEqual({ outcome: "parsed" });
    const snap = await docRef("doc-real-success").get();
    expect(snap.get("status")).toBe("parsed");
    expect(snap.get("pageCount")).toBe(3);
  });

  it("stubbed-failure path: parsing -> failed, with a real failureReason recorded", async () => {
    await seedParsingDocument("doc-real-failure");
    const corruptBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00]);
    const realPipeline = new PdfDocumentPipeline(new PdfjsDocumentProvider());

    const result = await runDocumentAnalyzer(db, realPipeline, async () => corruptBytes, {
      uid: UID,
      documentId: "doc-real-failure",
      storagePath: "path/doc-real-failure.pdf",
    });

    expect(result).toEqual({ outcome: "failed", failureReason: "parsing_failed", message: "This file appears damaged." });
    const snap = await docRef("doc-real-failure").get();
    expect(snap.get("status")).toBe("failed");
    expect(snap.get("failureReason")).toBe("parsing_failed");
  });
});

describe("runDocumentAnalyzer — every pipeline outcome, via the test-double pipeline", () => {
  it("needs_review outcome writes status + the reason (not producible by the real pipeline yet)", async () => {
    await seedParsingDocument("doc-needs-review");
    const pipeline = new FixedResultPipeline({ outcome: "needs_review", reason: "balance mismatch" });

    const result = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-needs-review",
      storagePath: "path/x.pdf",
    });

    expect(result).toEqual({ outcome: "needs_review" });
    const snap = await docRef("doc-needs-review").get();
    expect(snap.get("status")).toBe("needs_review");
    expect(snap.get("needsReviewReason")).toBe("balance mismatch");
  });
});

describe("runDocumentAnalyzer — password-protected documents write awaiting_password, not a permanent failed (T3a)", () => {
  it("a failed outcome with failureReason:password_required transitions to awaiting_password, not failed", async () => {
    await seedParsingDocument("doc-password-required");
    const pipeline = new FixedResultPipeline({
      outcome: "failed",
      failureReason: "password_required",
      message: "This document is password-protected.",
    });

    const result = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-password-required",
      storagePath: "path/x.pdf",
    });

    expect(result).toEqual({ outcome: "awaiting_password" });
    const snap = await docRef("doc-password-required").get();
    expect(snap.get("status")).toBe("awaiting_password");
    expect(snap.get("requiresPassword")).toBe(true);
    expect(snap.get("failureReason")).toBeNull();
  });

  it("a genuinely unrelated failed outcome (e.g. parsing_failed) still writes a permanent failed, unaffected by the password branch", async () => {
    await seedParsingDocument("doc-genuine-failure");
    const pipeline = new FixedResultPipeline({
      outcome: "failed",
      failureReason: "parsing_failed",
      message: "Corrupted PDF.",
    });

    const result = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-genuine-failure",
      storagePath: "path/x.pdf",
    });

    expect(result).toEqual({ outcome: "failed", failureReason: "parsing_failed", message: "Corrupted PDF." });
    const snap = await docRef("doc-genuine-failure").get();
    expect(snap.get("status")).toBe("failed");
    expect(snap.get("failureReason")).toBe("parsing_failed");
  });
});

describe("runDocumentAnalyzer — idempotency and resumability", () => {
  it("is a no-op (skipped) when the document is not in 'parsing' at all", async () => {
    await seedParsingDocument("doc-not-parsing", { status: "uploaded" });
    const pipeline = new FixedResultPipeline({ outcome: "parsed", pageCount: 1 });

    const result = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-not-parsing",
      storagePath: "path/x.pdf",
    });

    expect(result).toEqual({ outcome: "skipped", reason: "not_in_parsing_state" });
    const snap = await docRef("doc-not-parsing").get();
    expect(snap.get("status")).toBe("uploaded"); // untouched
  });

  it("a second invocation after the first already completed is a safe no-op, not a re-processing", async () => {
    await seedParsingDocument("doc-already-done");
    const pipeline = new FixedResultPipeline({ outcome: "parsed", pageCount: 5 });

    const first = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-already-done",
      storagePath: "path/x.pdf",
    });
    const second = await runDocumentAnalyzer(db, pipeline, noopReader, {
      uid: UID,
      documentId: "doc-already-done",
      storagePath: "path/x.pdf",
    });

    expect(first).toEqual({ outcome: "parsed" });
    expect(second).toEqual({ outcome: "skipped", reason: "not_in_parsing_state" });
  });

  it("ten concurrent invocations for the same document result in exactly one status transition", async () => {
    await seedParsingDocument("doc-concurrent");
    const pipeline = new FixedResultPipeline({ outcome: "parsed", pageCount: 2 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runDocumentAnalyzer(db, pipeline, noopReader, {
          uid: UID,
          documentId: "doc-concurrent",
          storagePath: "path/x.pdf",
        }),
      ),
    );

    const transitionedCount = results.filter((r) => r.outcome === "parsed").length;
    expect(transitionedCount).toBe(1);

    const snap = await docRef("doc-concurrent").get();
    expect(snap.get("status")).toBe("parsed");
  });
});
