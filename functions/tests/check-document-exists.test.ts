/**
 * Real Firestore Emulator test — backlog M1-T6 acceptance criterion:
 * "Firing two concurrent create-requests for the same accountId + fileHash
 * (simulated in test) results in exactly one financialDocuments doc, with
 * the second request resolving to the same doc rather than erroring or
 * duplicating." This is RFC §28.9's Critical risk #1 — the test that
 * matters most in Milestone 1.
 *
 * Run via `npm run test` in functions/ (see functions/package.json) with a
 * Firestore Emulator already running on 127.0.0.1:8080 — wired up the same
 * way as the web app's tests/rules suite (see package.json's
 * `test:functions` script at the repo root, which wraps this in
 * `firebase emulators:exec`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  checkDocumentExists,
  deterministicDocumentId,
} from "../src/ingestion/check-document-exists";

const PROJECT_ID = "flowfi-functions-test";
const UID = "owner-uid";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const FILE_HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")

let db: Firestore;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  const app = getApps().length ? getApps()[0]! : initializeApp({ projectId: PROJECT_ID });
  db = getFirestore(app);
});

afterEach(async () => {
  // Best-effort cleanup between tests — delete anything this suite created.
  const snap = await db.collection("users").doc(UID).collection("financialDocuments").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

afterAll(async () => {
  const { getApps: getAllApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getAllApps().map((a) => deleteApp(a)));
});

describe("deterministicDocumentId", () => {
  it("is the same for the same (accountId, fileHash) pair", () => {
    expect(deterministicDocumentId(ACCOUNT_ID, FILE_HASH)).toBe(deterministicDocumentId(ACCOUNT_ID, FILE_HASH));
  });

  it("rejects a malformed fileHash rather than silently accepting it", () => {
    expect(() => deterministicDocumentId(ACCOUNT_ID, "not-a-hash")).toThrow();
  });
});

describe("checkDocumentExists — sequential behavior (M1-T5)", () => {
  it("first call creates the document and reports alreadyExists:false", async () => {
    const result = await checkDocumentExists(db, {
      uid: UID,
      accountId: ACCOUNT_ID,
      documentType: "credit_card_statement",
      fileHash: FILE_HASH,
    });
    expect(result.alreadyExists).toBe(false);
    expect(result.status).toBe("uploaded");

    const snap = await db
      .collection("users")
      .doc(UID)
      .collection("financialDocuments")
      .doc(result.documentId)
      .get();
    expect(snap.exists).toBe(true);
  });

  it("a second call with the same hash short-circuits with alreadyExists:true", async () => {
    const first = await checkDocumentExists(db, {
      uid: UID,
      accountId: ACCOUNT_ID,
      documentType: "credit_card_statement",
      fileHash: FILE_HASH,
    });
    const second = await checkDocumentExists(db, {
      uid: UID,
      accountId: ACCOUNT_ID,
      documentType: "credit_card_statement",
      fileHash: FILE_HASH,
    });
    expect(first.documentId).toBe(second.documentId);
    expect(second.alreadyExists).toBe(true);
  });

  it("a different fileHash for the same account creates a distinct document", async () => {
    const first = await checkDocumentExists(db, {
      uid: UID,
      accountId: ACCOUNT_ID,
      documentType: "credit_card_statement",
      fileHash: FILE_HASH,
    });
    const otherHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")
    const second = await checkDocumentExists(db, {
      uid: UID,
      accountId: ACCOUNT_ID,
      documentType: "credit_card_statement",
      fileHash: otherHash,
    });
    expect(first.documentId).not.toBe(second.documentId);
    expect(second.alreadyExists).toBe(false);
  });
});

describe("checkDocumentExists — CONCURRENT calls (RFC §28.9 Critical risk #1, M1-T6)", () => {
  it("firing two concurrent calls for the same (accountId, fileHash) never creates two documents", async () => {
    const [resultA, resultB] = await Promise.all([
      checkDocumentExists(db, { uid: UID, accountId: ACCOUNT_ID, documentType: "credit_card_statement", fileHash: FILE_HASH }),
      checkDocumentExists(db, { uid: UID, accountId: ACCOUNT_ID, documentType: "credit_card_statement", fileHash: FILE_HASH }),
    ]);

    // Both calls must agree on the same document identity.
    expect(resultA.documentId).toBe(resultB.documentId);

    // Exactly one financialDocuments doc must exist for this account —
    // the whole point of the fix.
    const snap = await db.collection("users").doc(UID).collection("financialDocuments").get();
    expect(snap.size).toBe(1);

    // At least one of the two calls must have observed the other's write —
    // both reporting alreadyExists:false would mean two independent
    // creates raced past each other, which is exactly what M1-T6 exists to
    // prevent.
    const falseCount = [resultA.alreadyExists, resultB.alreadyExists].filter((v) => v === false).length;
    expect(falseCount).toBe(1);
  });

  it("ten-way concurrent calls for the same hash still converge on exactly one document", async () => {
    const calls = Array.from({ length: 10 }, () =>
      checkDocumentExists(db, {
        uid: UID,
        accountId: ACCOUNT_ID,
        documentType: "credit_card_statement",
        fileHash: FILE_HASH,
      }),
    );
    const results = await Promise.all(calls);

    const uniqueDocumentIds = new Set(results.map((r) => r.documentId));
    expect(uniqueDocumentIds.size).toBe(1);

    const snap = await db.collection("users").doc(UID).collection("financialDocuments").get();
    expect(snap.size).toBe(1);

    const creators = results.filter((r) => !r.alreadyExists);
    expect(creators.length).toBe(1);
  });
});

describe("checkDocumentExists — safe recovery of failed / interrupted documents", () => {
  const input = { uid: UID, accountId: ACCOUNT_ID, documentType: "credit_card_statement", fileHash: FILE_HASH };
  const docRef = () => db.collection("users").doc(UID).collection("financialDocuments").doc(deterministicDocumentId(ACCOUNT_ID, FILE_HASH));
  const importRecords = () => db.collection("users").doc(UID).collection("documentImports").doc(deterministicDocumentId(ACCOUNT_ID, FILE_HASH)).collection("records");
  const minutesAgo = (m: number) => Timestamp.fromMillis(Date.now() - m * 60 * 1000);

  beforeEach(async () => {
    await Promise.all((await importRecords().get()).docs.map((r) => r.ref.delete()));
  });

  afterEach(async () => {
    // The parent documentImports doc is never created in these tests, so delete the records directly.
    await Promise.all((await importRecords().get()).docs.map((r) => r.ref.delete()));
  });

  it("a FAILED document is reset to 'uploaded' in place (same document id) so the file can be re-uploaded", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "failed", failureReason: "parsing_failed", failureMessage: "boom", storagePath: "users/x/y.pdf" });

    const result = await checkDocumentExists(db, input);
    expect(result).toMatchObject({ documentId: deterministicDocumentId(ACCOUNT_ID, FILE_HASH), alreadyExists: false, status: "uploaded", recovered: true });
    const after = (await docRef().get()).data()!;
    expect(after.status).toBe("uploaded");
    expect(after.failureReason).toBeNull();
    expect(after.storagePath).toBeNull();
    expect(after.recoveryAttempts).toBe(1);
    expect((await db.collection("users").doc(UID).collection("financialDocuments").get()).size).toBe(1);
  });

  it("an interrupted upload (still 'uploaded' long after creation) is recoverable without any write", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ uploadedAt: minutesAgo(30) });
    const result = await checkDocumentExists(db, input);
    expect(result).toMatchObject({ alreadyExists: false, status: "uploaded", recovered: true });
  });

  it("a freshly created 'uploaded' document (upload in flight) is NOT treated as interrupted", async () => {
    await checkDocumentExists(db, input);
    const result = await checkDocumentExists(db, input);
    expect(result.alreadyExists).toBe(true);
  });

  it("a stale 'parsing' document is reset; a recently started one is left alone", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "parsing", parsingStartedAt: minutesAgo(2) });
    expect((await checkDocumentExists(db, input)).alreadyExists).toBe(true);

    await docRef().update({ parsingStartedAt: minutesAgo(45) });
    const result = await checkDocumentExists(db, input);
    expect(result).toMatchObject({ alreadyExists: false, status: "uploaded", recovered: true });
  });

  it("never recovers a document whose staging already has a committed row (would allow a double import)", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "failed" });
    await importRecords().doc("1").set({ committedTransactionId: "txn-real", userEdited: false });

    const result = await checkDocumentExists(db, input);
    expect(result).toMatchObject({ alreadyExists: true, status: "failed" });
    expect((await docRef().get()).get("status")).toBe("failed");
  });

  it("never recovers a document with user-edited staged rows", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "failed" });
    await importRecords().doc("1").set({ committedTransactionId: null, userEdited: true });
    expect((await checkDocumentExists(db, input)).alreadyExists).toBe(true);
  });

  it("recovery is bounded — after the attempt cap the document stays failed", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "failed", recoveryAttempts: 5 });
    const result = await checkDocumentExists(db, input);
    expect(result).toMatchObject({ alreadyExists: true, status: "failed" });
  });

  it("awaiting_password / parsed / needs_review documents are never reset", async () => {
    await checkDocumentExists(db, input);
    for (const status of ["awaiting_password", "parsed", "needs_review", "imported"]) {
      await docRef().update({ status });
      expect(await checkDocumentExists(db, input)).toMatchObject({ alreadyExists: true, status });
    }
  });

  it("concurrent recovery calls on a failed document converge on exactly one document and one reset", async () => {
    await checkDocumentExists(db, input);
    await docRef().update({ status: "failed" });
    await Promise.all(Array.from({ length: 5 }, () => checkDocumentExists(db, input)));
    expect((await db.collection("users").doc(UID).collection("financialDocuments").get()).size).toBe(1);
    const after = (await docRef().get()).data()!;
    expect(after.status).toBe("uploaded");
    expect(after.recoveryAttempts).toBe(1);
  });
});
