/**
 * Real Firestore Emulator tests — backlog M2-T1 acceptance criteria:
 * "Function returns within budget even when the downstream worker is
 * artificially slowed in test; actual parsing never runs inline in this
 * function." Plus the idempotency/resumability behavior docs/adr/ADR-004
 * relies on for the Firestore-triggered hand-off design.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ingestDocument } from "../src/ingestion/ingest-document";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const OTHER_UID = "other-uid";

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

async function seedUploadedDocument(documentId: string, overrides: Record<string, unknown> = {}) {
  await docRef(documentId).set({
    userId: UID,
    documentType: "credit_card_statement",
    accountId: "acct-1",
    fileHash: "a".repeat(64),
    storagePath: null,
    status: "uploaded",
    ...overrides,
  });
}

describe("ingestDocument — happy path", () => {
  it("flips status from uploaded to parsing and records the storage path", async () => {
    await seedUploadedDocument("doc-1");
    const result = await ingestDocument(db, { uid: UID, documentId: "doc-1", storagePath: "users/owner-uid/documents/credit_card_statement/doc-1.pdf" });

    expect(result).toEqual({ outcome: "accepted", status: "parsing" });

    const snap = await docRef("doc-1").get();
    expect(snap.get("status")).toBe("parsing");
    expect(snap.get("storagePath")).toBe("users/owner-uid/documents/credit_card_statement/doc-1.pdf");
  });
});

describe("ingestDocument — idempotency and resumability (docs/adr/ADR-004)", () => {
  it("a second call for the same document is a safe no-op, not a re-trigger or an error", async () => {
    await seedUploadedDocument("doc-2");
    const first = await ingestDocument(db, { uid: UID, documentId: "doc-2", storagePath: "path/a.pdf" });
    const second = await ingestDocument(db, { uid: UID, documentId: "doc-2", storagePath: "path/a.pdf" });

    expect(first.outcome).toBe("accepted");
    expect(second).toEqual({ outcome: "already_in_progress", status: "parsing" });

    // Confirm the second call didn't touch storagePath again / overwrite anything.
    const snap = await docRef("doc-2").get();
    expect(snap.get("storagePath")).toBe("path/a.pdf");
  });

  it("does not re-trigger for a document already further along the pipeline (parsed/needs_review/imported/failed)", async () => {
    for (const status of ["parsed", "needs_review", "imported", "failed"]) {
      const id = `doc-status-${status}`;
      await seedUploadedDocument(id, { status });
      const result = await ingestDocument(db, { uid: UID, documentId: id, storagePath: "path/x.pdf" });
      expect(result).toEqual({ outcome: "already_in_progress", status });
    }
  });

  it("ten concurrent calls for the same document result in exactly one accepted transition (same transactional discipline as M1-T6)", async () => {
    await seedUploadedDocument("doc-concurrent");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ingestDocument(db, { uid: UID, documentId: "doc-concurrent", storagePath: "path/c.pdf" })),
    );
    const acceptedCount = results.filter((r) => r.outcome === "accepted").length;
    expect(acceptedCount).toBe(1);
  });
});

describe("ingestDocument — security", () => {
  it("rejects a documentId that doesn't exist", async () => {
    const result = await ingestDocument(db, { uid: UID, documentId: "does-not-exist", storagePath: "path/x.pdf" });
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("a different uid cannot reach another user's document at all (not_found, not a distinct forbidden case)", async () => {
    // Real finding (see functions/src/ingestion/ingest-document.ts's module
    // comment): ingestDocument queries users/{uid}/financialDocuments/{id}
    // using the CALLER's own uid, which is always the verified
    // request.auth.uid from index.ts — never client-supplied. There is no
    // way to even construct a query that reaches another user's document,
    // so a wrong uid always lands on "not_found" for its own (empty)
    // subtree, never a separate "forbidden" branch. An earlier version of
    // this test asserted `forbidden`, which was wrong — this codebase's
    // per-user-subcollection convention (ADR-002) makes that outcome
    // structurally unreachable, proven by this test failing against the
    // original (correct) implementation until the test itself was fixed.
    await seedUploadedDocument("doc-owned-by-owner");
    const result = await ingestDocument(db, { uid: OTHER_UID, documentId: "doc-owned-by-owner", storagePath: "path/x.pdf" });
    expect(result).toEqual({ outcome: "not_found" });

    // And confirms the real owner's document was untouched by the attempt.
    const snap = await docRef("doc-owned-by-owner").get();
    expect(snap.get("status")).toBe("uploaded");
  });
});

describe("ingestDocument — fast hand-off contract (backlog M2-T1's core acceptance criterion)", () => {
  it("resolves well before a simulated slow downstream worker finishes reacting to the status change", async () => {
    await seedUploadedDocument("doc-handoff");

    const WORKER_SIMULATED_DELAY_MS = 3000;
    let workerFinishedAt: number | null = null;

    // Stands in for the not-yet-built M2-T2 Firestore trigger: watches for
    // the same status transition ingestDocument performs, and — once it
    // sees it — simulates a slow parsing job. This is a real Firestore
    // Emulator listener, not a mock of ingestDocument's own behavior.
    const workerDonePromise = new Promise<void>((resolve) => {
      const unsubscribe = docRef("doc-handoff").onSnapshot((snap) => {
        if (snap.get("status") === "parsing") {
          unsubscribe();
          setTimeout(() => {
            workerFinishedAt = Date.now();
            resolve();
          }, WORKER_SIMULATED_DELAY_MS);
        }
      });
    });

    const callStartedAt = Date.now();
    const result = await ingestDocument(db, { uid: UID, documentId: "doc-handoff", storagePath: "path/handoff.pdf" });
    const callResolvedAt = Date.now();

    expect(result.outcome).toBe("accepted");
    // The callable itself must return in well under a second against the
    // emulator — nowhere close to the worker's simulated 3s delay.
    expect(callResolvedAt - callStartedAt).toBeLessThan(1000);

    // And, separately, prove ingestDocument's returned promise did NOT
    // wait for the simulated worker at all — the worker must still be
    // pending when ingestDocument has already resolved.
    expect(workerFinishedAt).toBeNull();

    await workerDonePromise; // let the simulated worker finish so it doesn't leak into the next test
  }, 10000);
});
