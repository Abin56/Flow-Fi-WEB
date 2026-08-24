/**
 * PDF Analyzer — orchestration module behind `retryDocumentParsingCallable`
 * (functions/src/index.ts). Plain, directly testable, no `firebase-functions`
 * imports — same "thin onCall wrapper around a plain function" convention
 * `ingestDocument`/`attemptUnlock` already use.
 *
 * Two entry points into the same unlock-then-parse logic:
 *   - `credential.kind === "manual"` — a password the user typed directly
 *     into `enter-password-dialog.tsx`.
 *   - `credential.kind === "saved"` — no inputs at all; this module loads
 *     the card's encrypted saved password (`saved-password-store.ts`),
 *     decrypts it, and attempts to unlock with it. The frontend never sees
 *     or handles the password itself.
 *
 * Runs against a document in either `"parsing"` (the upload-time attempt,
 * made before the async worker's own `openAndClassify` has had a chance to
 * write `awaiting_password`) or `"awaiting_password"` (the manual retry
 * path). Both share one transaction-guarded status check, so a concurrent
 * race between the upload-time attempt and the worker's own encrypted-PDF
 * detection can never double-process — whichever commits first wins, the
 * other's transaction re-read sees the moved-on status and is a safe no-op.
 */

import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { PdfDocumentError, type PdfDocumentProvider } from "../pdf/pdf-document-provider";
import { MultiBankCreditCardStatementPipeline } from "../pipeline/multi-bank-credit-card-statement-pipeline";
import { applyPipelineResultToDocument, type DocumentAnalyzerResult } from "../worker/document-analyzer-worker";
import { tryUnlock } from "../pdf-analyzer/pdf-unlock-service";
import { decrypt } from "../pdf-analyzer/password-vault";
import { getSavedPasswordCiphertext } from "../pdf-analyzer/saved-password-store";
import { checkAndRecordAttempt, resetRateLimit, type RateLimitConfig } from "./rate-limit";
import { readStorageObjectBytes } from "../storage";

const RATE_LIMIT_NAMESPACE = "statementPassword";

/** Same policy, same namespace as `decrypt-document.ts`'s `PASSWORD_RATE_LIMIT_CONFIG` — one shared counter per document, regardless of which callable is attempting it. */
export const RETRY_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxAttempts: 3,
  windowMs: 15 * 60 * 1000,
};

function rateLimitKey(uid: string, documentId: string): string {
  return `${uid}_${documentId}`;
}

export type RetryCredential = { kind: "manual"; password: string } | { kind: "saved" };

export interface RetryDocumentParsingInput {
  uid: string;
  documentId: string;
  credential: RetryCredential;
}

export type RetryDocumentParsingResult =
  | (DocumentAnalyzerResult & { outcome: "parsed" | "needs_review" | "failed" })
  | { outcome: "incorrect_password"; attemptsRemaining: number; usedSavedPassword: boolean }
  | { outcome: "rate_limited"; retryAfter: Date }
  | { outcome: "no_saved_password" }
  | { outcome: "not_found" };

const RETRYABLE_STATUSES = new Set(["parsing", "awaiting_password"]);

export async function retryDocumentParsing(
  db: Firestore,
  provider: PdfDocumentProvider,
  input: RetryDocumentParsingInput,
): Promise<RetryDocumentParsingResult> {
  const ref = db.collection("users").doc(input.uid).collection("financialDocuments").doc(input.documentId);
  const snapshot = await ref.get();

  if (!snapshot.exists || !RETRYABLE_STATUSES.has(snapshot.get("status") as string)) {
    return { outcome: "not_found" };
  }

  const accountId = snapshot.get("accountId") as string | undefined;
  const storagePath = snapshot.get("storagePath") as string | undefined;
  if (!accountId || !storagePath) {
    return { outcome: "not_found" };
  }

  let password: string;
  let usedSavedPassword = false;
  if (input.credential.kind === "manual") {
    password = input.credential.password;
  } else {
    const savedCiphertext = await getSavedPasswordCiphertext(db, input.uid, accountId);
    logger.info("retryDocumentParsing: saved password lookup", {
      uid: input.uid,
      documentId: input.documentId,
      accountId,
      ciphertextFound: !!savedCiphertext,
    });
    if (!savedCiphertext) {
      return { outcome: "no_saved_password" };
    }
    try {
      password = decrypt(savedCiphertext);
      logger.info("retryDocumentParsing: saved password decrypt", {
        uid: input.uid,
        documentId: input.documentId,
        accountId,
        decryptOk: true,
      });
    } catch {
      // Corrupt/tampered ciphertext — never throw the raw crypto error, just treat as "nothing usable."
      logger.info("retryDocumentParsing: saved password decrypt", {
        uid: input.uid,
        documentId: input.documentId,
        accountId,
        decryptOk: false,
      });
      return { outcome: "no_saved_password" };
    }
    usedSavedPassword = true;
  }

  const key = rateLimitKey(input.uid, input.documentId);
  const rateLimitCheck = await checkAndRecordAttempt(db, RATE_LIMIT_NAMESPACE, key, RETRY_RATE_LIMIT_CONFIG);
  if (!rateLimitCheck.allowed) {
    return { outcome: "rate_limited", retryAfter: rateLimitCheck.retryAfter! };
  }

  const bytes = await readStorageObjectBytes(storagePath);
  const unlock = await tryUnlock(provider, bytes, password);

  if (usedSavedPassword) {
    logger.info("retryDocumentParsing: saved password unlock attempt", {
      uid: input.uid,
      documentId: input.documentId,
      accountId,
      ok: unlock.ok,
    });
  }

  if (!unlock.ok) {
    if (unlock.code === "INVALID_PASSWORD" || unlock.code === "PDF_ENCRYPTED") {
      return { outcome: "incorrect_password", attemptsRemaining: rateLimitCheck.attemptsRemaining, usedSavedPassword };
    }
    // PDF_CORRUPTED / PDF_UNSUPPORTED / PDF_EMPTY / INTERNAL_ERROR are not password problems — same rethrow discipline attemptUnlock uses.
    throw new PdfDocumentError(unlock.code, `Unlock failed: ${unlock.code}`);
  }

  await resetRateLimit(db, RATE_LIMIT_NAMESPACE, key);

  const pipeline = new MultiBankCreditCardStatementPipeline(provider, db);
  const pipelineResult = await pipeline.runWithHandle(unlock.handle, {
    uid: input.uid,
    documentId: input.documentId,
    accountId,
    fileHash: (snapshot.get("fileHash") as string | undefined) ?? null,
  });

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // Mirrors the worker's own re-check (document-analyzer-worker.ts) — the module doc
    // comment above claims this guard already existed here; it didn't, so a concurrent
    // status change between the pipeline run above and this write could be silently
    // overwritten. Re-verifying the status here, not just existence, closes that gap.
    if (!snap.exists || !RETRYABLE_STATUSES.has(snap.get("status") as string)) {
      return { outcome: "skipped" as const, reason: "status_changed_concurrently" as const };
    }
    return applyPipelineResultToDocument(tx, ref, pipelineResult);
  });

  if (result.outcome === "skipped") {
    return { outcome: "not_found" };
  }

  logger.info("retryDocumentParsing: unlocked and parsed", {
    uid: input.uid,
    documentId: input.documentId,
    outcome: result.outcome,
  });

  return result as RetryDocumentParsingResult;
}
