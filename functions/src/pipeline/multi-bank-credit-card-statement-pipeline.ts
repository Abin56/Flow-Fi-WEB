/**
 * Multi-Bank Credit Card Statement Pipeline — the registry-of-handlers seam
 * `hdfc-credit-card-statement-pipeline.ts`'s own module comment named as
 * "not yet built" when only one bank template existed. Same
 * open → classify → extract → Statement Intelligence → staging shell as
 * that HDFC-only pipeline (this file supersedes it as what's actually
 * wired into the trigger/retry-parsing entry points), except the "which
 * bank template matches this PDF" step now tries each registered
 * extractor's `isMatch` in order instead of assuming HDFC unconditionally.
 * A statement that matches none of them is `needs_review` with reason
 * `unrecognized_statement_template` — same as HDFC's own prior behavior
 * for a non-HDFC PDF, just now correctly framed as "no bank template
 * recognizes this yet" rather than "not HDFC".
 */

import { PdfDocumentError, type PdfDocumentHandle, type PdfDocumentProvider } from "../pdf/pdf-document-provider";
import type { FailureReason } from "../domain/financial-document-status";
import type { BillingSummary, CardInfo, ExtractionDiagnostics, StatementInfo, WorkspaceTransaction } from "../workspace/statement-workspace-model";
import type { PdfPageText } from "../pdf/pdf-document-provider";
import { fetchExistingStatementsForComparison, fetchExistingTransactionsForComparison } from "../duplicate/duplicate-lookup-repository";
import { writeStagingDocuments } from "../staging/staging-writer";
import { runStatementIntelligencePipeline } from "./statement-intelligence-pipeline";
import { isHdfcStatement, extractHdfcStatement } from "../parsing/hdfc/hdfc-statement-extractor";
import { isSbiStatement, extractSbiStatement } from "../parsing/sbi/sbi-statement-extractor";
import { isGenericStatementMatch, extractGenericStatement } from "../parsing/generic/generic-statement-extractor";
import { detectPossibleBankName } from "../parsing/generic/bank-name-guesser";
import type { DocumentPipeline, DocumentPipelineContext, DocumentPipelineResult } from "./document-pipeline";
import type { Firestore } from "firebase-admin/firestore";

export interface BankStatementExtractionResult {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  diagnostics: ExtractionDiagnostics;
}

export interface BankStatementExtractor {
  bankId: string;
  isMatch(pages: PdfPageText[]): boolean;
  extract(pages: PdfPageText[], context: { accountId?: string }): BankStatementExtractionResult;
}

/**
 * Every bank template this parser currently understands, tried in this order. Adding a new dedicated
 * (bank-specific) extractor means adding one entry BEFORE `generic` here — nothing else in this file (or
 * the trigger/retry-parsing callers) needs to change. `generic` is deliberately last: it's a low-precision
 * best-effort fallback (see its own module comment), so any real bank-specific match must always win first.
 */
export const BANK_STATEMENT_EXTRACTORS: BankStatementExtractor[] = [
  { bankId: "hdfc", isMatch: isHdfcStatement, extract: extractHdfcStatement },
  { bankId: "sbi", isMatch: isSbiStatement, extract: extractSbiStatement },
  { bankId: "generic", isMatch: isGenericStatementMatch, extract: extractGenericStatement },
];

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

export class MultiBankCreditCardStatementPipeline implements DocumentPipeline {
  constructor(
    private readonly provider: PdfDocumentProvider,
    private readonly db: Firestore,
    private readonly extractors: BankStatementExtractor[] = BANK_STATEMENT_EXTRACTORS,
  ) {}

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

  async runWithHandle(handle: PdfDocumentHandle, context: DocumentPipelineContext): Promise<DocumentPipelineResult> {
    try {
      const pageCount = handle.pageCount;
      const pages = await handle.getAllPageText();

      const extractor = this.extractors.find((candidate) => candidate.isMatch(pages));
      if (!extractor) {
        // Reached only when even the generic fallback (last in `this.extractors`) couldn't find a plausible
        // transaction table — a genuine "nothing usable here" dead end. The bank guess is a cheap breadcrumb
        // for prioritizing the next dedicated extractor to build, not a real detection (see its own module comment).
        return { outcome: "needs_review", reason: "unrecognized_statement_template", detectedBankGuess: detectPossibleBankName(pages) };
      }

      const extraction = extractor.extract(pages, { accountId: context.accountId });

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
