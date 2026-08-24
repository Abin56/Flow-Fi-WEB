/**
 * HDFC Credit Card Statement Pipeline — the real `DocumentPipeline`
 * implementation this milestone's End-to-end Pipeline task promotes from
 * `PdfDocumentPipeline`'s honest "open and confirm readable" stand-in
 * (see pdf-document-pipeline.ts's own module comment) to a genuine
 * extraction → Statement Intelligence → staging chain, for the one bank
 * template that actually exists (HDFC — docs/parser-pipeline-design.md's
 * "no module branches on documentType or bank name" rule is upheld: this
 * class *is* the registry-of-handlers seam for one entry, not a branch
 * inside a shared function).
 *
 * `DocumentPipelineContext` (uid/documentId/accountId) is required here
 * (unlike the base interface's optional typing, kept optional there only
 * so `PdfDocumentPipeline`'s existing 1-arg callers keep compiling) — this
 * pipeline cannot run Duplicate Detection or write staging documents
 * without it, so a missing context is treated as `needs_review`, not a
 * silent partial run.
 *
 * A document whose template isn't recognized as HDFC (`isHdfcStatement`
 * returns false) is `needs_review`, not `failed` — no Document Classifier
 * exists yet (architecture.md §12, still a later milestone) to say what
 * bank it actually is, and guessing would be worse than asking a human.
 */

import { PdfDocumentError, type PdfDocumentHandle, type PdfDocumentProvider } from "../pdf/pdf-document-provider";
import type { FailureReason } from "../domain/financial-document-status";
import { fetchExistingStatementsForComparison, fetchExistingTransactionsForComparison } from "../duplicate/duplicate-lookup-repository";
import { extractHdfcStatement, isHdfcStatement } from "../parsing/hdfc/hdfc-statement-extractor";
import { writeStagingDocuments } from "../staging/staging-writer";
import { runStatementIntelligencePipeline } from "./statement-intelligence-pipeline";
import type { DocumentPipeline, DocumentPipelineContext, DocumentPipelineResult } from "./document-pipeline";
import type { Firestore } from "firebase-admin/firestore";

function mapErrorToFailureReason(error: PdfDocumentError): FailureReason {
  switch (error.code) {
    case "INVALID_PASSWORD":
    case "PDF_ENCRYPTED":
      return "password_required";
    case "PDF_UNSUPPORTED":
      return "unsupported_document";
    case "PDF_CORRUPTED":
    case "PDF_EMPTY":
    case "INTERNAL_ERROR":
      return "parsing_failed";
  }
}

export class HdfcCreditCardStatementPipeline implements DocumentPipeline {
  constructor(
    private readonly provider: PdfDocumentProvider,
    private readonly db: Firestore,
  ) {}

  /**
   * `run()` split into `openAndClassify` (bytes → handle, or a password/
   * corruption/etc. classification) + `runWithHandle` (everything past a
   * successfully opened handle) so a caller that already has a handle
   * opened with a password — the PDF Analyzer's retry flow, see
   * `functions/src/ingestion/retry-document-parsing.ts` — can run
   * extraction-through-staging without this class re-opening the PDF or
   * duplicating any of that logic. `run()` itself is unchanged behavior: a
   * thin wrapper calling both in sequence.
   */
  async run(bytes: Uint8Array, context?: DocumentPipelineContext): Promise<DocumentPipelineResult> {
    if (!context) {
      return { outcome: "needs_review", reason: "missing_pipeline_context" };
    }

    const opened = await this.openAndClassify(bytes);
    if (!opened.ok) {
      return opened.result;
    }

    return this.runWithHandle(opened.handle, context);
  }

  /** Opens `bytes` (no password) and classifies any `PdfDocumentError` into the same result shape `run()` has always returned for an open failure. */
  async openAndClassify(
    bytes: Uint8Array,
  ): Promise<{ ok: true; handle: PdfDocumentHandle } | { ok: false; result: DocumentPipelineResult }> {
    try {
      const handle = await this.provider.open(bytes);
      return { ok: true, handle };
    } catch (error) {
      if (error instanceof PdfDocumentError) {
        return {
          ok: false,
          result: { outcome: "failed", failureReason: mapErrorToFailureReason(error), message: error.message },
        };
      }
      return {
        ok: false,
        result: {
          outcome: "failed",
          failureReason: "parsing_failed",
          message: error instanceof Error ? error.message : "Unexpected error.",
        },
      };
    }
  }

  /** Everything past a successfully opened handle — extraction, Statement Intelligence, staging. Unchanged from `run()`'s prior body. */
  async runWithHandle(handle: PdfDocumentHandle, context: DocumentPipelineContext): Promise<DocumentPipelineResult> {
    try {
      const pageCount = handle.pageCount;
      const pages = await handle.getAllPageText();

      if (!isHdfcStatement(pages)) {
        return { outcome: "needs_review", reason: "unrecognized_statement_template" };
      }

      const extraction = extractHdfcStatement(pages, { accountId: context.accountId });

      if (!extraction.diagnostics.transactionTableFound) {
        return { outcome: "needs_review", reason: "no_transaction_table_detected" };
      }

      const billingStart = extraction.statementInfo.billingPeriodStart.value;
      const billingEnd = extraction.statementInfo.billingPeriodEnd.value;
      const [existingTransactions, existingStatements] = await Promise.all([
        billingStart && billingEnd
          ? fetchExistingTransactionsForComparison(this.db, context.uid, context.accountId, billingStart, billingEnd)
          : Promise.resolve([]),
        fetchExistingStatementsForComparison(this.db, context.uid, context.accountId),
      ]);

      const workspace = runStatementIntelligencePipeline({
        statementInfo: extraction.statementInfo,
        cardInfo: extraction.cardInfo,
        billingSummary: extraction.billingSummary,
        transactions: extraction.transactions,
        diagnostics: extraction.diagnostics,
        accountId: context.accountId,
        duplicateContext: {
          statementMeta: {
            documentHash: context.fileHash ?? null,
            billingPeriodStart: billingStart,
            billingPeriodEnd: billingEnd,
            cardId: context.accountId,
            closingBalance: extraction.billingSummary.closingBalance.value,
          },
          existingStatements,
          existingTransactions,
        },
      });

      await writeStagingDocuments(this.db, {
        uid: context.uid,
        documentId: context.documentId,
        accountId: context.accountId,
        workspace,
      });

      if (!workspace.validationPanel.report.passed) {
        return { outcome: "needs_review", reason: "validation_failed" };
      }

      return { outcome: "parsed", pageCount };
    } catch (error) {
      return { outcome: "failed", failureReason: "parsing_failed", message: error instanceof Error ? error.message : "Unexpected error." };
    } finally {
      await handle.destroy();
    }
  }
}
