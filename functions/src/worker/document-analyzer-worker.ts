/**
 * Worker layer — Architecture v1.0 §6 (Document Analyzer), backlog M2-T2.
 * Owns the state machine (docs/state-machine.md transitions T6/T7/T8) and
 * nothing else: it does not know how PDF bytes get turned into a
 * `DocumentPipelineResult` (that's the Pipeline layer's job, injected as
 * a dependency), and it does not know how it was invoked — a Firestore
 * trigger, a manual retry, a future stale-job watchdog (backlog M2-T3)
 * could all call this same function identically. No Cloud-Functions-
 * specific imports here.
 *
 * Idempotent and resumable by construction, same discipline as
 * check-document-exists.ts (M1-T6) and ingest-document.ts (M2-T1):
 *   1. A cheap pre-check skips any Storage read / pipeline run entirely
 *      if the document is no longer in "parsing" (e.g. a duplicate
 *      trigger delivery arriving after the first invocation already
 *      finished).
 *   2. The actual state transition is written inside a transaction that
 *      re-checks status == "parsing" at write time — so even if two
 *      invocations both pass the pre-check and both run the pipeline
 *      (redundant work, but not incorrect), only the first to commit its
 *      write actually changes the document; the second detects the
 *      status has already moved on and skips its write.
 * This does not solve a worker that crashes mid-run and never gets
 * re-invoked at all — a document stuck at "parsing" forever — that is
 * explicitly backlog M2-T3's stale-job watchdog, not this task.
 */

import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import type { DocumentPipeline, DocumentPipelineResult } from "../pipeline/document-pipeline";

export interface DocumentAnalyzerInput {
  uid: string;
  documentId: string;
  storagePath: string;
}

export type DocumentAnalyzerResult =
  | { outcome: "parsed" }
  | { outcome: "needs_review" }
  | { outcome: "awaiting_password" }
  | { outcome: "failed"; failureReason: string; message?: string }
  | { outcome: "skipped"; reason: "not_in_parsing_state" | "status_changed_concurrently" };

export type StorageReader = (storagePath: string) => Promise<Uint8Array>;

/**
 * Applies a `DocumentPipelineResult`'s parsed/needs_review/failed outcome to
 * `ref`'s Firestore fields, inside an already-open transaction. Extracted
 * so both this worker (the async `parsing` trigger path) and
 * `retryDocumentParsingCallable` (`functions/src/ingestion/retry-document-parsing.ts`,
 * the PDF Analyzer's synchronous unlock-then-parse path) write the exact
 * same shape for the exact same outcomes, rather than the callable
 * duplicating this switch.
 *
 * A `failed` outcome whose `failureReason` is `"password_required"` is
 * special-cased to `awaiting_password` instead of a genuine permanent
 * `failed` write — docs/state-machine.md T3a. This is the ONLY outcome for
 * a password-protected PDF that reaches this function at all: by the time
 * an upload-time PDF Analyzer attempt (§4.3a) has run, either it already
 * unlocked the document (never reaching this "failed" branch) or it found
 * no usable rule/inputs — in both remaining cases `awaiting_password` is
 * the correct resting state, recoverable via `retryDocumentParsingCallable`.
 */
export function applyPipelineResultToDocument(
  tx: Transaction,
  ref: DocumentReference,
  result: DocumentPipelineResult,
  bank: string | null = null,
): DocumentAnalyzerResult {
  switch (result.outcome) {
    case "parsed":
      tx.update(ref, { status: "parsed", pageCount: result.pageCount });
      return { outcome: "parsed" };
    case "needs_review":
      tx.update(ref, { status: "needs_review", needsReviewReason: result.reason, detectedBankGuess: result.detectedBankGuess ?? null });
      return { outcome: "needs_review" };
    case "failed":
      if (result.failureReason === "password_required") {
        tx.update(ref, {
          status: "awaiting_password",
          requiresPassword: true,
          bank,
          failureReason: null,
          failureMessage: null,
        });
        return { outcome: "awaiting_password" };
      }
      tx.update(ref, {
        status: "failed",
        failureReason: result.failureReason,
        failureMessage: result.message,
      });
      return { outcome: "failed", failureReason: result.failureReason, message: result.message };
  }
}

export async function runDocumentAnalyzer(
  db: Firestore,
  pipeline: DocumentPipeline,
  readBytes: StorageReader,
  input: DocumentAnalyzerInput,
): Promise<DocumentAnalyzerResult> {
  const ref = db.collection("users").doc(input.uid).collection("financialDocuments").doc(input.documentId);

  const preCheck = await ref.get();
  if (!preCheck.exists || preCheck.get("status") !== "parsing") {
    logger.info("documentAnalyzerWorker: skipped, not in 'parsing' state", {
      uid: input.uid,
      documentId: input.documentId,
    });
    return { outcome: "skipped", reason: "not_in_parsing_state" };
  }

  const bytes = await readBytes(input.storagePath);
  const accountId = preCheck.get("accountId") as string | undefined;
  const fileHash = (preCheck.get("fileHash") as string | undefined) ?? null;
  const pipelineResult = await pipeline.run(
    bytes,
    accountId ? { uid: input.uid, documentId: input.documentId, accountId, fileHash } : undefined,
  );

  // Only needed for the awaiting_password write's `bank` hint — cheap to
  // read unconditionally rather than special-case it on pipelineResult
  // shape, and harmless (unused) for every other outcome.
  const cardSnap = accountId
    ? await db.collection("users").doc(input.uid).collection("creditCards").doc(accountId).get()
    : null;
  const bank = (cardSnap?.get("issuer") as string | undefined) ?? null;

  const result = await db.runTransaction(async (tx): Promise<DocumentAnalyzerResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") !== "parsing") {
      return { outcome: "skipped", reason: "status_changed_concurrently" };
    }

    return applyPipelineResultToDocument(tx, ref, pipelineResult, bank);
  });

  switch (result.outcome) {
    case "parsed":
    case "needs_review":
    case "awaiting_password":
      logger.info(`documentAnalyzerWorker: transitioned to '${result.outcome}'`, {
        uid: input.uid,
        documentId: input.documentId,
      });
      break;
    case "failed":
      logger.warn("documentAnalyzerWorker: transitioned to 'failed'", {
        uid: input.uid,
        documentId: input.documentId,
        failureReason: result.failureReason,
      });
      break;
    case "skipped":
      logger.info(`documentAnalyzerWorker: skipped at write time (${result.reason})`, {
        uid: input.uid,
        documentId: input.documentId,
      });
      break;
  }

  return result;
}
