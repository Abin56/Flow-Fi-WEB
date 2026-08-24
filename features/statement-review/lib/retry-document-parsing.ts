/**
 * Client wrapper for `retryDocumentParsingCallable` (functions/src/index.ts)
 * — the PDF Analyzer's unlock-then-parse callable. Used from both the
 * upload dialog (the synchronous, upload-time attempt) and the manual
 * retry dialog. For `{kind:"saved"}`, nothing crosses this boundary except
 * that one word — the password itself is looked up, decrypted, and
 * discarded entirely server-side.
 */

import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/client";

export type RetryCredential = { kind: "manual"; password: string } | { kind: "saved" };

export type RetryDocumentParsingResponse =
  | { outcome: "parsed" }
  | { outcome: "needs_review" }
  | { outcome: "failed"; failureReason: string; message?: string }
  | { outcome: "incorrect_password"; attemptsRemaining: number; usedSavedPassword: boolean }
  | { outcome: "rate_limited"; retryAfter: string }
  | { outcome: "no_saved_password" };

export async function retryDocumentParsing(
  documentId: string,
  credential: RetryCredential,
): Promise<RetryDocumentParsingResponse> {
  const callable = httpsCallable<{ documentId: string; credential: RetryCredential }, RetryDocumentParsingResponse>(
    functions,
    "retryDocumentParsingCallable",
  );
  const result = await callable({ documentId, credential });
  return result.data;
}

/** Client wrapper for `saveCardPasswordCallable` — saves (encrypted, server-side) a card's actual statement password. The password is never returned, never logged, and this file never holds it beyond the single call. */
export async function saveCardPassword(accountId: string, password: string): Promise<void> {
  const callable = httpsCallable<{ accountId: string; password: string }, { outcome: "saved" }>(
    functions,
    "saveCardPasswordCallable",
  );
  await callable({ accountId, password });
}
