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

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
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
