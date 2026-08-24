/**
 * SBI Card Statement Extractor — composes the metadata extractor and
 * transaction extractor into the single "PDF pages in, extracted sections
 * out" seam the End-to-end Pipeline needs, matching
 * `../hdfc/hdfc-statement-extractor.ts`'s shape exactly so both banks can
 * share one pipeline dispatch (`pipeline/multi-bank-credit-card-statement-pipeline.ts`).
 */

import type { BillingSummary, CardInfo, ExtractionDiagnostics, StatementInfo, WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import type { PdfPageText } from "../../pdf/pdf-document-provider";
import { extractSbiMetadata, isSbiStatement } from "./sbi-metadata-extractor";
import { extractSbiTransactions } from "./sbi-transaction-extractor";

export { isSbiStatement };

export interface SbiStatementExtractionResult {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  diagnostics: ExtractionDiagnostics;
}

export function extractSbiStatement(pages: PdfPageText[], context: { accountId?: string } = {}): SbiStatementExtractionResult {
  const { statementInfo, cardInfo, billingSummary } = extractSbiMetadata(pages);
  const { transactions, transactionTableFound } = extractSbiTransactions(pages, context);

  const diagnostics: ExtractionDiagnostics = {
    detectedSource: "sbi",
    detectionConfidence: 0.95,
    tierUsed: "rule_based",
    transactionTableFound,
  };

  return { statementInfo, cardInfo, billingSummary, transactions, diagnostics };
}
