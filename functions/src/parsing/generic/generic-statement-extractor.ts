/**
 * Generic Credit Card Statement Extractor — the last-resort fallback tier
 * in `pipeline/multi-bank-credit-card-statement-pipeline.ts`'s registry,
 * tried only after every bank-specific extractor (HDFC, SBI, ...) fails to
 * recognize the statement. Where the bank-specific extractors anchor on
 * exact printed label strings and fixed column x-positions (verified
 * against one real statement per bank), this one deliberately knows
 * nothing about any particular bank's layout — it only looks for the one
 * pattern almost every Indian credit card statement's transaction table
 * shares: a row containing a date-shaped token and a decimal-amount token,
 * read purely from token SHAPE, not position.
 *
 * This exists to turn "unrecognized bank = zero rows, hard stop" into
 * "unrecognized bank = some rows to review" for any statement, without
 * waiting to hand-build a dedicated parser for every bank a real user
 * might upload. It deliberately trades precision for coverage — see
 * `docs/adr/*` (or the plan this was scoped from) for the explicit product
 * tradeoff: every row this module produces is unconditionally
 * `needsReview: true` with capped confidence, so nothing it extracts can
 * ever silently commit without a human confirming it in Transaction
 * Studio first (`commit-review-import.ts`'s `validateRow` already hard-
 * blocks any `needsReview` row from commit — this extractor leans on that
 * existing guarantee rather than re-implementing its own).
 *
 * Deliberately still deterministic/pattern-based, not AI/OCR/LLM — same
 * "no AI tier" constraint every other extractor in this parser observes
 * (see `hdfc-statement-extractor.ts` / `statement-workspace-model.ts`'s
 * `ExtractionDiagnostics.tierUsed: "rule_based"`, the only tier that
 * exists). A future AI-assisted tier, if ever added, is a separate,
 * deliberate product decision — not something this fallback silently
 * introduces.
 */

import type { WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../workspace/statement-workspace-model";
import type { PdfPageText, PdfPageTextItem } from "../../pdf/pdf-document-provider";
import { groupPagesIntoRows, parseAmount, type LayoutRow } from "../page-layout";
import type { BankStatementExtractionResult } from "../../pipeline/multi-bank-credit-card-statement-pipeline";

/** Every date shape observed across the bank-specific extractors' real fixtures, plus the two most common numeric formats — tried in order, first match wins. Deliberately excludes ambiguous bare "DD/MM" (no year) and US-style "MM/DD/YYYY" (Indian statements are consistently day-first). */
const DATE_PATTERNS: { pattern: RegExp; parse: (match: RegExpExecArray) => Date | null }[] = [
  {
    // "17 Jul 2026" / "17 Jul, 2026" / "17 Jul 26"
    pattern: /^(\d{1,2})\s+([A-Za-z]{3,})[,]?\s+(\d{2}|\d{4})$/,
    parse: (m) => {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const monthIndex = months.indexOf(m[2]!.slice(0, 3).toLowerCase());
      if (monthIndex === -1) return null;
      const yearRaw = m[3]!;
      const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
      return new Date(Date.UTC(year, monthIndex, Number(m[1])));
    },
  },
  {
    // "19/07/2026" / "19-07-2026" / "19.07.2026" / two-digit-year variants
    pattern: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/,
    parse: (m) => {
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const yearRaw = m[3]!;
      const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
      return new Date(Date.UTC(year, month - 1, day));
    },
  },
];

const AMOUNT_PATTERN = /^-?[\d,]+\.\d{2}$/;
const DIRECTION_MARKER_PATTERN = /^(DR|CR)\.?$/i;
/** Description keywords that mean money coming back to the cardholder, when no explicit Dr/Cr marker token exists on the row — a strictly lower-confidence signal than a real marker, never enough alone to mark a row anything but `needsReview`. */
const CREDIT_KEYWORDS = /\b(payment received|credit|reversal|refund|cashback received)\b/i;

/** Minimum candidate rows across the whole document before this extractor claims a match at all — below this, a stray date+number in unrelated prose (a T&C page mentioning "Rs.500" near an unrelated date) isn't mistaken for a real transaction table. */
const MIN_CANDIDATE_ROWS = 3;

function parseGenericDate(item: PdfPageTextItem): Date | null {
  const str = item.str.trim();
  for (const { pattern, parse } of DATE_PATTERNS) {
    const match = pattern.exec(str);
    if (match) return parse(match);
  }
  return null;
}

interface CandidateRow {
  page: number;
  dateItem: PdfPageTextItem;
  date: Date;
  amountItem: PdfPageTextItem;
  otherItems: PdfPageTextItem[];
}

function findCandidateRow(row: LayoutRow): CandidateRow | null {
  const items = row.items.filter((item) => item.str.trim().length > 0);
  if (items.length < 2) return null;

  const dateItem = items.find((item) => parseGenericDate(item) != null);
  if (!dateItem) return null;
  const date = parseGenericDate(dateItem)!;

  const withoutDate = items.filter((item) => item !== dateItem);
  const amountItem = [...withoutDate].reverse().find((item) => AMOUNT_PATTERN.test(item.str.trim()));
  if (!amountItem) return null;

  const otherItems = withoutDate.filter((item) => item !== amountItem);
  return { page: row.page, dateItem, date, amountItem, otherItems };
}

function boundingBoxOf(item: PdfPageTextItem) {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function toWorkspaceTransaction(candidate: CandidateRow, index: number, accountId: string | undefined): WorkspaceTransaction {
  const markerItem = candidate.otherItems.find((item) => DIRECTION_MARKER_PATTERN.test(item.str.trim()));
  const descriptionItems = candidate.otherItems.filter((item) => item !== markerItem);
  const description = descriptionItems
    .map((item) => item.str.trim())
    .filter((str) => str.length > 0)
    .join(" ");

  const direction: "debit" | "credit" = markerItem
    ? /^CR/i.test(markerItem.str.trim())
      ? "credit"
      : "debit"
    : CREDIT_KEYWORDS.test(description)
      ? "credit"
      : "debit";

  const amount = parseAmount(candidate.amountItem.str.trim()) ?? 0;

  return {
    date: { value: candidate.date, confidence: 0.6, source: "pattern_match", page: candidate.page, boundingBox: boundingBoxOf(candidate.dateItem) },
    merchantRaw:
      description.length > 0
        ? { value: description, confidence: 0.5, source: "fuzzy_match", page: candidate.page }
        : { value: "", confidence: 0.2, source: "unavailable" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: Math.abs(amount), confidence: 0.6, source: "pattern_match", page: candidate.page, boundingBox: boundingBoxOf(candidate.amountItem) },
    // Never `exact_match`, even when a Dr/Cr marker token was found — this extractor's whole premise is "I
    // don't actually know this bank's layout," so its ceiling confidence stays below what a verified
    // bank-specific parser reports for the exact same shape of evidence.
    direction: { value: direction, confidence: markerItem ? 0.55 : 0.3, source: markerItem ? "pattern_match" : "unavailable" },
    referenceNumber: { value: null, confidence: 0, source: "unavailable" },
    currency: { value: "INR", confidence: 0.7, source: "pattern_match", extractionMethod: "inferred:generic-fallback-no-bank-template" },

    sourcePage: candidate.page,
    sourceLineIndex: index,
    originalRawText: [candidate.dateItem.str, ...candidate.otherItems.map((i) => i.str), candidate.amountItem.str].join(" "),
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
    // Always true — this extractor's entire premise is "I don't know this statement's real layout," so
    // every row it produces requires human confirmation before it can ever be imported (`validateRow` in
    // `commit-review-import.ts` hard-blocks a `needsReview` row from commit regardless of anything else).
    needsReview: true,
    warnings: [{ code: "generic_fallback_extraction", message: "Extracted by the generic fallback parser — this bank's layout isn't specifically supported yet. Please double-check every field.", severity: "warning" }],
    confidence: 0.4,
  };
}

export function isGenericStatementMatch(pages: PdfPageText[]): boolean {
  const rows = groupPagesIntoRows(pages);
  const candidates = rows.map(findCandidateRow).filter((c): c is CandidateRow => c != null);
  return candidates.length >= MIN_CANDIDATE_ROWS;
}

export function extractGenericStatement(pages: PdfPageText[], context: { accountId?: string } = {}): BankStatementExtractionResult {
  const rows = groupPagesIntoRows(pages);
  const candidates = rows.map(findCandidateRow).filter((c): c is CandidateRow => c != null);
  const transactions = candidates.map((candidate, index) => toWorkspaceTransaction(candidate, index, context.accountId));

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
