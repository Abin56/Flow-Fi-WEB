/**
 * HDFC Statement Extractor — composes Task 4's five HDFC modules
 * (Metadata Extractor → Table Detector → Row Extractor → Field Extractor
 * → Canonical Mapper) into the single "PDF pages in, extracted sections
 * out" seam the End-to-end Pipeline needs. Nothing new is parsed here;
 * this is pure orchestration/reshaping of already-real modules, same
 * "compose, don't reimplement" discipline as `statement-intelligence-pipeline.ts`.
 */

import type { BillingSummary, CardInfo, ExtractionDiagnostics, StatementInfo, WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import type { PdfPageText } from "../../pdf/pdf-document-provider";
import { mapHdfcFieldsToWorkspaceTransactions, type HdfcCanonicalMapperContext } from "./hdfc-canonical-mapper";
import { extractHdfcTransactionFields } from "./hdfc-field-extractor";
import { extractHdfcMetadata, isHdfcStatement } from "./hdfc-metadata-extractor";
import { extractHdfcRawTransactionRows } from "./hdfc-row-extractor";
import { detectHdfcTransactionTableRegions } from "./hdfc-table-detector";

export { isHdfcStatement };

export interface HdfcStatementExtractionResult {
  statementInfo: StatementInfo;
  cardInfo: CardInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
  diagnostics: ExtractionDiagnostics;
}

export function extractHdfcStatement(pages: PdfPageText[], context: HdfcCanonicalMapperContext = {}): HdfcStatementExtractionResult {
  const { statementInfo, cardInfo, billingSummary } = extractHdfcMetadata(pages);

  const regions = detectHdfcTransactionTableRegions(pages);
  const rawRows = extractHdfcRawTransactionRows(regions);
  const fields = rawRows.map(extractHdfcTransactionFields);
  const transactions = mapHdfcFieldsToWorkspaceTransactions(fields, context);

  const diagnostics: ExtractionDiagnostics = {
    detectedSource: "hdfc",
    detectionConfidence: 0.95,
    tierUsed: "rule_based",
    transactionTableFound: regions.length > 0,
  };

  return { statementInfo, cardInfo, billingSummary, transactions, diagnostics };
}
