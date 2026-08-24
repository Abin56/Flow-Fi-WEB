/**
 * Password-protected PDF unlock orchestration — Architecture v1.0 §4.1
 * Screen 3, §22, §24 (password used in-memory only, never logged/
 * persisted), backlog M1-T7 + M1-T8. Wires the rate limiter (M1-T8)
 * together with a PdfDocumentProvider (M1-T7) — this is the one place the
 * two meet, and the ONLY place a password value flows through in this
 * package. It is never written to a log line or a Firestore field
 * anywhere in this function — see decrypt-document.test.ts's dedicated
 * assertion for that contract, not just a promise in a comment.
 */

import type { Firestore } from "firebase-admin/firestore";
import { PdfDocumentError, type PdfDocumentProvider } from "../pdf/pdf-document-provider";
import { checkAndRecordAttempt, resetRateLimit, type RateLimitConfig } from "./rate-limit";

const RATE_LIMIT_NAMESPACE = "statementPassword";

/** Architecture §22: 3 attempts, then a 15-minute lockout. */
export const PASSWORD_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxAttempts: 3,
  windowMs: 15 * 60 * 1000,
};

export interface AttemptUnlockInput {
  uid: string;
  documentId: string;
  password: string;
  bytes: Uint8Array;
}

export type AttemptUnlockResult =
  | { status: "unlocked"; pageCount: number }
  | { status: "incorrect_password"; attemptsRemaining: number }
  | { status: "rate_limited"; retryAfter: Date };

function rateLimitKey(uid: string, documentId: string): string {
  return `${uid}_${documentId}`;
}

export async function attemptUnlock(
  db: Firestore,
  provider: PdfDocumentProvider,
  input: AttemptUnlockInput,
): Promise<AttemptUnlockResult> {
  const key = rateLimitKey(input.uid, input.documentId);
  const rateLimitCheck = await checkAndRecordAttempt(db, RATE_LIMIT_NAMESPACE, key, PASSWORD_RATE_LIMIT_CONFIG);

  if (!rateLimitCheck.allowed) {
    return { status: "rate_limited", retryAfter: rateLimitCheck.retryAfter! };
  }

  try {
    const handle = await provider.open(input.bytes, input.password);
    const pageCount = handle.pageCount;
    await handle.destroy();
    // A correct password should not cost the user their remaining
    // attempts on some later, unrelated retry — clear the counter on
    // success (Architecture §22's rate limit exists to stop guessing, not
    // to penalize a document the user already proved they can open).
    await resetRateLimit(db, RATE_LIMIT_NAMESPACE, key);
    return { status: "unlocked", pageCount };
  } catch (error) {
    if (error instanceof PdfDocumentError) {
      if (error.code === "INVALID_PASSWORD" || error.code === "PDF_ENCRYPTED") {
        return { status: "incorrect_password", attemptsRemaining: rateLimitCheck.attemptsRemaining };
      }
      throw error; // PDF_CORRUPTED / PDF_UNSUPPORTED / PDF_EMPTY / INTERNAL_ERROR are not password problems
    }
    throw error;
  }
}
