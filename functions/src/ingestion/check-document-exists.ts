/**
 * users/{uid}/financialDocuments/{documentId} check-and-create — Architecture
 * v1.0 §13.1 (document-level dedupe), reconciled path per docs/adr/ADR-002.
 * Backlog M1-T5 (short-circuit) + M1-T6 (the race-condition fix RFC §28.9
 * flagged as Critical risk #1, and the Milestone 1 exit criteria for
 * "load-bearing for the whole backlog").
 *
 * Why this doesn't need to recompute the hash server-side (yet): at this
 * pre-upload stage, the file hasn't reached Storage — the client is asking
 * "would this hash already exist?" before spending upload bandwidth. The
 * hash is only *authoritative* once verified against the actually-stored
 * bytes, which happens later in the pipeline (Architecture §16 Document
 * Detection runs against the real uploaded file) — this function's job is
 * strictly the fast pre-upload short-circuit + the concurrency-safe
 * document-identity guarantee, not final duplicate adjudication.
 *
 * THE FIX (M1-T6): two near-simultaneous calls with the same
 * (accountId, fileHash) — e.g. a client retry after a dropped response, or
 * the same file opened on two devices — must never create two
 * financialDocuments records. The deterministic document ID
 * (`${accountId}_${fileHash}`) plus a Firestore transaction is what
 * guarantees this: Firestore transactions detect read/write contention on
 * the same document and automatically retry the losing transaction, so the
 * second caller's retry sees the first caller's committed write and takes
 * the "already exists" branch instead of creating a duplicate. See
 * functions/tests/check-document-exists.test.ts for the concurrency test
 * that proves this against a real Firestore Emulator, not just by
 * inspection.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";

export interface CheckDocumentExistsInput {
  uid: string;
  accountId: string;
  documentType: string;
  fileHash: string;
}

export interface CheckDocumentExistsResult {
  documentId: string;
  alreadyExists: boolean;
  status: string;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const FILE_HASH_PATTERN = /^[a-f0-9]{64}$/; // sha256Hex's output shape

export function deterministicDocumentId(accountId: string, fileHash: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`Invalid accountId: expected a UUID-safe identifier, got "${accountId}"`);
  }
  if (!FILE_HASH_PATTERN.test(fileHash)) {
    throw new Error("Invalid fileHash: expected a 64-character lowercase hex SHA-256 digest");
  }
  return `${accountId}_${fileHash}`;
}

export async function checkDocumentExists(
  db: Firestore,
  input: CheckDocumentExistsInput,
): Promise<CheckDocumentExistsResult> {
  const documentId = deterministicDocumentId(input.accountId, input.fileHash);
  const docRef = db.collection("users").doc(input.uid).collection("financialDocuments").doc(documentId);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(docRef);
    if (snapshot.exists) {
      return {
        documentId,
        alreadyExists: true,
        status: (snapshot.get("status") as string) ?? "unknown",
      };
    }

    tx.set(docRef, {
      userId: input.uid,
      documentType: input.documentType,
      accountId: input.accountId,
      fileHash: input.fileHash,
      storagePath: null,
      uploadedAt: FieldValue.serverTimestamp(),
      period: null,
      documentDate: null,
      dueDate: null,
      documentNumber: null,
      status: "uploaded",
      detectedSource: null,
      parserConfidence: null,
      registryVersion: null,
      currentImportId: null,
      statementId: null,
      comparisonWithPrevious: null,
      aiSummary: null,
    });

    return { documentId, alreadyExists: false, status: "uploaded" };
  });
}
