/**
 * Pipeline layer — Architecture v1.0 §2 (Universal Parsing Pipeline),
 * backlog M2-T2. This is the seam between the Worker (which owns the
 * state machine, docs/state-machine.md) and the actual
 * Parser/Classification stages. The Worker calls `DocumentPipeline.run()`
 * and reacts only to its result shape — it does not know, and must never
 * be given a reason to know, whether the pipeline behind that interface
 * is a real multi-stage extraction process or (as today, backlog M2-T2's
 * explicit scope) a minimal stand-in.
 *
 * Current implementation status (see docs/parity-matrix.md and this
 * task's completion report): Parser (Architecture §10) and Classification
 * (Architecture §12) do not exist yet — they arrive in Milestones 3/4/6.
 * `PdfDocumentPipeline` (pdf-document-pipeline.ts) is a genuine,
 * honestly-scoped stage — it opens the document and confirms it's
 * readable, reusing the already-real `PdfDocumentProvider` (M1-T7) — NOT
 * a placeholder that fakes a "parsed" result unconditionally. It cannot
 * produce `needs_review` yet (no extracted fields exist to validate), and
 * per docs/state-machine.md §4's scoping decision, it does not attempt
 * encrypted documents.
 */

import type { FailureReason } from "../domain/financial-document-status";

export interface DocumentPipelineOutcomeParsed {
  outcome: "parsed";
  pageCount: number;
}

export interface DocumentPipelineOutcomeNeedsReview {
  outcome: "needs_review";
  reason: string;
  /** Best-effort "which bank does this probably belong to" guess (`bank-name-guesser.ts`), set only for `reason: "unrecognized_statement_template"` — a cheap breadcrumb for product prioritization, not a real detection. `undefined`/absent for every other needs_review reason, and whenever nothing in the known-issuer list matched. */
  detectedBankGuess?: string | null;
}

export interface DocumentPipelineOutcomeFailed {
  outcome: "failed";
  failureReason: FailureReason;
  message: string;
}

export type DocumentPipelineResult =
  | DocumentPipelineOutcomeParsed
  | DocumentPipelineOutcomeNeedsReview
  | DocumentPipelineOutcomeFailed;

/**
 * Additive, optional (see `DocumentPipeline.run`'s own comment) — carries
 * what a real Statement Intelligence pipeline needs beyond raw bytes (the
 * account this statement belongs to, for Account Suggestion/staging;
 * `uid`/`documentId`, for the Duplicate Detection lookup and the Firestore
 * Staging Writer). `PdfDocumentPipeline` (the M2-T2 stand-in) ignores it
 * entirely — it never reads past its first parameter, so existing callers
 * and test doubles that only implement `run(bytes)` remain valid
 * `DocumentPipeline`s (TypeScript structurally allows an implementation
 * with fewer parameters than its interface).
 */
export interface DocumentPipelineContext {
  uid: string;
  documentId: string;
  accountId: string;
  /**
   * The uploaded file's SHA-256 hex digest, from `financialDocuments.fileHash`
   * (see `check-document-exists.ts`) — threaded through so Duplicate Detection's
   * exact-hash statement-dedup path (`checkStatementDuplicate`) has something
   * real to compare against instead of always seeing `null`. `undefined`/`null`
   * for any caller that hasn't fetched the document snapshot (falls back to the
   * weaker period+balance dedup fallback only).
   */
  fileHash?: string | null;
}

export interface DocumentPipeline {
  run(bytes: Uint8Array, context?: DocumentPipelineContext): Promise<DocumentPipelineResult>;
}
