/**
 * Cloud Functions entry point — Architecture v1.0 §5, docs/adr/ADR-001,
 * ADR-003. Every export here is a thin `onCall` wrapper around a plain,
 * directly-testable function in src/ingestion/* — see each module's tests
 * in functions/tests/ for the actual behavioral verification. This file
 * intentionally has no logic of its own beyond auth-guarding and shaping
 * request/response, so it never needs its own test suite distinct from
 * the modules it wraps.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getDb } from "./firestore";
import { attemptUnlock } from "./ingestion/decrypt-document";
import { checkDocumentExists } from "./ingestion/check-document-exists";
import { ingestDocument } from "./ingestion/ingest-document";
import { retryDocumentParsing, type RetryCredential } from "./ingestion/retry-document-parsing";
import { saveCardPassword, SaveCardPasswordStepError } from "./ingestion/save-card-password";
import { PdfDocumentError } from "./pdf/pdf-document-provider";
import { PdfjsDocumentProvider } from "./pdf/pdfjs-document-provider";
import { PDF_ANALYZER_VAULT_KEY } from "./pdf-analyzer/password-vault";
import { assertOwnedStoragePath, readStorageObjectBytes, StoragePathOwnershipError } from "./storage";

/**
 * Every callable below wraps its work in this so an unexpected error never
 * reaches the client as the bare, contextless string "internal" (the
 * Firebase Functions v2 default for any uncaught non-HttpsError exception).
 * The real error is always logged server-side first — the client-facing
 * HttpsError carries a code+message a UI can show a user, not a stack trace.
 */
function toClientError(fnName: string, error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;

  logger.error(`${fnName}: unhandled error`, { error: error instanceof Error ? error.stack : error });

  if (error instanceof StoragePathOwnershipError) {
    return new HttpsError("permission-denied", "You don't have access to this file.");
  }

  if (error instanceof PdfDocumentError) {
    switch (error.code) {
      case "INVALID_PASSWORD":
      case "PDF_ENCRYPTED":
        return new HttpsError("invalid-argument", "This document is password-protected or the password was incorrect.");
      case "PDF_CORRUPTED":
      case "PDF_EMPTY":
        return new HttpsError("invalid-argument", "This file appears damaged — try re-downloading it from your bank.");
      case "PDF_UNSUPPORTED":
        return new HttpsError("invalid-argument", "This PDF format isn't supported yet.");
      case "INTERNAL_ERROR":
        return new HttpsError("internal", "We couldn't open this document. Please try again.");
    }
  }

  return new HttpsError("internal", "Something went wrong on our end. Please try again.");
}

// Document Analyzer worker (backlog M2-T2, docs/adr/ADR-004) — a Firestore
// trigger, not a callable. Re-exported here (not just left in
// triggers/document-analyzer-trigger.ts) because Firebase Functions
// discovers deployable functions from this entry file's exports.
export { onFinancialDocumentUpdated } from "./triggers/document-analyzer-trigger";

export const checkDocumentExistsCallable = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const { accountId, documentType, fileHash } = request.data as {
    accountId?: unknown;
    documentType?: unknown;
    fileHash?: unknown;
  };

  if (typeof accountId !== "string" || typeof documentType !== "string" || typeof fileHash !== "string") {
    throw new HttpsError("invalid-argument", "accountId, documentType, and fileHash are required strings.");
  }

  try {
    return await checkDocumentExists(getDb(), {
      uid: request.auth.uid,
      accountId,
      documentType,
      fileHash,
    });
  } catch (e) {
    // deterministicDocumentId() is the only realistic thrower here, and it
    // always throws a plain Error for a malformed accountId/fileHash shape —
    // a genuine invalid-argument, not an unexpected/internal failure.
    if (e instanceof Error) {
      throw new HttpsError("invalid-argument", e.message);
    }
    throw toClientError("checkDocumentExistsCallable", e);
  }
});

const pdfProvider = new PdfjsDocumentProvider();

/**
 * Architecture §4.1 Screen 3. Takes a Storage path (the file the client
 * already uploaded — Architecture §24: never send raw PDF bytes over a
 * second, separate callable payload) plus the password, and returns
 * whether it unlocked. The password itself never appears in the response
 * — only a status and, on success, the page count — and this function
 * does not log its `request.data` (which would include the password) the
 * way a generic request-logging middleware might; see
 * functions/tests/decrypt-document.test.ts for the assertion that no
 * password value is ever logged or persisted anywhere in this path.
 */
export const decryptDocumentCallable = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const { documentId, storagePath, password } = request.data as {
    documentId?: unknown;
    storagePath?: unknown;
    password?: unknown;
  };

  if (typeof documentId !== "string" || typeof storagePath !== "string" || typeof password !== "string") {
    throw new HttpsError("invalid-argument", "documentId, storagePath, and password are required strings.");
  }

  try {
    assertOwnedStoragePath(storagePath, request.auth.uid);
    const bytes = await readStorageObjectBytes(storagePath);

    return await attemptUnlock(getDb(), pdfProvider, {
      uid: request.auth.uid,
      documentId,
      password,
      bytes,
    });
  } catch (e) {
    throw toClientError("decryptDocumentCallable", e);
  }
});

/**
 * Architecture §28.7's fast hand-off contract (backlog M2-T1,
 * docs/adr/ADR-004): called once the client has finished uploading the
 * PDF to Storage (after checkDocumentExistsCallable and, if needed,
 * decryptDocumentCallable). Flips the document to "parsing" and returns
 * immediately — it does not parse anything itself, and does not await
 * the Document Analyzer worker (backlog M2-T2, onFinancialDocumentUpdated
 * below) that reacts to that status change. See
 * functions/tests/ingest-document.test.ts's hand-off-latency test for the
 * proof, not just this comment's claim.
 */
export const ingestDocumentCallable = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const { documentId, storagePath } = request.data as {
    documentId?: unknown;
    storagePath?: unknown;
  };

  if (typeof documentId !== "string" || typeof storagePath !== "string") {
    throw new HttpsError("invalid-argument", "documentId and storagePath are required strings.");
  }

  let result;
  try {
    assertOwnedStoragePath(storagePath, request.auth.uid);
    result = await ingestDocument(getDb(), { uid: request.auth.uid, documentId, storagePath });
  } catch (e) {
    throw toClientError("ingestDocumentCallable", e);
  }

  if (result.outcome === "not_found") {
    throw new HttpsError("not-found", "No such document.");
  }

  return result;
});

function parseCredential(raw: unknown): RetryCredential | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind } = raw as { kind?: unknown };
  if (kind === "manual") {
    const { password } = raw as { password?: unknown };
    return typeof password === "string" ? { kind: "manual", password } : null;
  }
  if (kind === "saved") {
    return { kind: "saved" };
  }
  return null;
}

/**
 * PDF Analyzer's unlock-then-parse callable — see
 * functions/src/ingestion/retry-document-parsing.ts for the full
 * orchestration. Called two ways by the frontend: synchronously during
 * upload (while the document is still `"parsing"`, if the card has a
 * saved password) and from the manual "Enter Password" retry dialog once
 * a document has settled at `"awaiting_password"`. For `credential.kind
 * === "saved"`, nothing crosses this boundary except that one word — the
 * password itself is looked up, decrypted, and discarded entirely
 * server-side.
 */
export const retryDocumentParsingCallable = onCall({ secrets: [PDF_ANALYZER_VAULT_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const { documentId, credential: rawCredential } = request.data as { documentId?: unknown; credential?: unknown };

  if (typeof documentId !== "string") {
    throw new HttpsError("invalid-argument", "documentId is required.");
  }

  const credential = parseCredential(rawCredential);
  if (!credential) {
    throw new HttpsError("invalid-argument", 'credential must be { kind: "manual", password } or { kind: "saved" }.');
  }

  let result;
  try {
    result = await retryDocumentParsing(getDb(), pdfProvider, { uid: request.auth.uid, documentId, credential });
  } catch (e) {
    throw toClientError("retryDocumentParsingCallable", e);
  }

  if (result.outcome === "not_found") {
    throw new HttpsError("not-found", "No such document, or it isn't waiting on a password right now.");
  }

  return result;
});

/**
 * PDF Analyzer — saves a card's actual statement password, encrypted. See
 * `functions/src/ingestion/save-card-password.ts` for the full
 * orchestration and `functions/src/pdf-analyzer/password-vault.ts` for the
 * encryption itself. The password is never returned in the response and
 * never logged — Settings is write-only for this value.
 */
export const saveCardPasswordCallable = onCall({ secrets: [PDF_ANALYZER_VAULT_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const { accountId, password } = request.data as { accountId?: unknown; password?: unknown };

  if (typeof accountId !== "string" || !accountId || typeof password !== "string" || !password) {
    throw new HttpsError("invalid-argument", "accountId and password are required, non-empty strings.");
  }

  try {
    await saveCardPassword(getDb(), { uid: request.auth.uid, accountId, password });
  } catch (e) {
    if (e instanceof SaveCardPasswordStepError) {
      // The step tag is logged server-side for diagnosis but never sent to
      // the client — which internal step failed is not information a user
      // needs, and it's more than a generic error should reveal.
      logger.error(`saveCardPasswordCallable: failed at step "${e.step}"`, {
        step: e.step,
        message: e.message,
        cause: e.cause instanceof Error ? e.cause.stack : e.cause,
      });
      throw new HttpsError("internal", "Could not save the password. Please try again later.");
    }
    throw toClientError("saveCardPasswordCallable", e);
  }

  return { outcome: "saved" as const };
});
