/**
 * Generic Credit Card Statement Extractor — the last-resort fallback tier
 * in `pipeline/multi-bank-credit-card-statement-pipeline.ts`'s registry,
 * tried only after every bank-specific extractor (HDFC, SBI, ...) fails to
 * recognize the statement. Where the bank-specific extractors anchor on
 * exact printed label strings and fixed column x-positions (verified
 * against one real statement per bank), this one knows nothing about any
 * particular bank: `layout-analyzer.ts` detects the transaction table's
 * header and columns from the page's own text positions (falling back to
 * date+amount token shape when no header exists), merges wrapped
 * descriptions, and excludes statement summary rows.
 *
 * This exists to turn "unrecognized bank = zero rows, hard stop" into
 * "unrecognized bank = rows to review" for any statement, without waiting
 * to hand-build a dedicated parser for every bank a real user might
 * upload. It deliberately trades precision for coverage: every row this
 * module produces is unconditionally `needsReview: true` with capped,
 * evidence-based confidence, so nothing it extracts can ever silently
 * commit without a human confirming it in Transaction Studio first
 * (`commit-review-import.ts`'s `validateRow` already hard-blocks any
 * `needsReview` row from commit — this extractor leans on that existing
 * guarantee rather than re-implementing its own).
 *
 * Deterministic/pattern-based, not AI/OCR/LLM — same "no AI tier"
 * constraint every other extractor in this parser observes (see
 * `ExtractionDiagnostics.tierUsed: "rule_based"`, the only tier that
 * exists). Costs nothing beyond the existing parse invocation.
 */

import type { WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../workspace/statement-workspace-model";
import type { PdfPageText, PdfPageTextItem } from "../../pdf/pdf-document-provider";
import type { BankStatementExtractionResult } from "../../pipeline/multi-bank-credit-card-statement-pipeline";
import { analyzeStatementLayout, MIN_TRANSACTION_ROWS, type AnalyzedTransaction, type DirectionBasis } from "./layout-analyzer";

/** Ceiling for any generic-tier field: never reaches what a verified bank-specific parser reports (0.95). */
const MAX_GENERIC_CONFIDENCE = 0.85;

const DIRECTION_CONFIDENCE: Record<DirectionBasis, number> = {
  column: 0.85,
  marker: 0.85,
  sign: 0.6,
  keyword: 0.4,
  none: 0.2,
  conflict: 0.1,
};

function boundingBoxOf(item: PdfPageTextItem) {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function confidenceOf(txn: AnalyzedTransaction) {
  const inColumn = txn.mode === "table" && txn.dateInDateColumn;
  const date = Math.min(MAX_GENERIC_CONFIDENCE, (inColumn ? 0.85 : 0.65) * (txn.dateOrderAssumed ? 0.8 : 1));
  const amount =
    txn.amountBasis === "ambiguous"
      ? 0.3
      : txn.amountBasis === "debit_column" || txn.amountBasis === "credit_column"
        ? 0.85
        : txn.amountBasis === "amount_column"
          ? 0.8
          : 0.6;
  const direction = DIRECTION_CONFIDENCE[txn.directionBasis];
  const description = txn.description.length > 0 ? 0.7 : 0.2;
  // A row is only as trustworthy as its weakest financial field.
  const row = Math.min(date, amount, direction) * (txn.description.length > 0 ? 1 : 0.7);
  return { date, amount, direction, description, row: Math.min(MAX_GENERIC_CONFIDENCE, row) };
}

function toWorkspaceTransaction(
  txn: AnalyzedTransaction,
  index: number,
  accountId: string | undefined,
  documentCurrency: string | null,
): WorkspaceTransaction {
  const c = confidenceOf(txn);
  const currency = txn.explicitCurrency
    ? { value: txn.explicitCurrency, confidence: 0.9, source: "pattern_match" as const, extractionMethod: "amount-token-currency-symbol" }
    : documentCurrency
      ? { value: documentCurrency, confidence: 0.7, source: "pattern_match" as const, extractionMethod: "inferred:document-currency-marker" }
      : { value: "INR", confidence: 0.5, source: "pattern_match" as const, extractionMethod: "inferred:generic-fallback-default-inr" };

  return {
    date: { value: txn.date, confidence: c.date, source: "pattern_match", page: txn.page, boundingBox: boundingBoxOf(txn.dateItem), extractionMethod: `layout:${txn.mode}` },
    merchantRaw:
      txn.description.length > 0
        ? { value: txn.description, confidence: c.description, source: "fuzzy_match", page: txn.page }
        : { value: "", confidence: 0.2, source: "unavailable" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: txn.amount, confidence: c.amount, source: "pattern_match", page: txn.page, boundingBox: boundingBoxOf(txn.amountItem), extractionMethod: `layout:${txn.amountBasis}` },
    // Never `exact_match`, even for an explicit column/marker — this tier does not know the bank, so its ceiling stays below a verified template's.
    direction: {
      value: txn.direction,
      confidence: c.direction,
      source: txn.directionBasis === "none" || txn.directionBasis === "conflict" ? "unavailable" : "pattern_match",
      extractionMethod: `direction:${txn.directionBasis}`,
    },
    referenceNumber: { value: null, confidence: 0, source: "unavailable" },
    currency,

    sourcePage: txn.page,
    sourceLineIndex: index,
    originalRawText: txn.rawText,
    originalRowNumber: index + 1,

    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: accountId ? { value: accountId, confidence: 1, source: "account_assignment" } : null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    duplicateCheck: NOT_YET_CHECKED_DUPLICATE_RESULT,
    // Always true — `validateRow` in `commit-review-import.ts` hard-blocks a `needsReview` row from commit until a human confirms it.
    needsReview: true,
    warnings: [
      { code: "generic_fallback_extraction", message: "Extracted by the generic fallback parser — this bank's layout isn't specifically supported yet. Please double-check every field.", severity: "warning" },
      ...txn.warnings.map((w) => ({ ...w, severity: "warning" as const })),
    ],
    confidence: c.row,
  };
}

export function isGenericStatementMatch(pages: PdfPageText[]): boolean {
  return analyzeStatementLayout(pages).transactions.length >= MIN_TRANSACTION_ROWS;
}

export function extractGenericStatement(pages: PdfPageText[], context: { accountId?: string } = {}): BankStatementExtractionResult {
  const analysis = analyzeStatementLayout(pages);
  const transactions = analysis.transactions.map((txn, index) => toWorkspaceTransaction(txn, index, context.accountId, analysis.documentCurrency));

  const unavailable = { value: null, confidence: 0, source: "unavailable" as const };

  return {
    statementInfo: {
      statementNumber: unavailable,
      statementDate: unavailable,
      billingPeriodStart: unavailable,
      billingPeriodEnd: unavailable,
      paymentDueDate: unavailable,
    },
    cardInfo: {
      bankName: unavailable,
      cardName: unavailable,
      cardLast4: unavailable,
      network: unavailable,
    },
    billingSummary: {
      openingBalance: unavailable,
      closingBalance: unavailable,
      minimumDue: unavailable,
      totalDue: unavailable,
      creditLimit: unavailable,
      availableCredit: unavailable,
      rewardPointsEarned: unavailable,
      cashback: unavailable,
      interestCharged: unavailable,
      gst: unavailable,
      lateFee: unavailable,
    },
    transactions,
    diagnostics: {
      detectedSource: "generic",
      // Below every bank-specific extractor's own diagnostic confidence (0.95) — this tier is a fallback,
      // never a verified template match.
      detectionConfidence: 0.4,
      tierUsed: "rule_based",
      transactionTableFound: transactions.length > 0,
    },
  };
}
