/**
 * SBI Card Transaction Extractor — the SBI-specific counterpart to the
 * HDFC pipeline's Table Detector + Row Extractor + Field Extractor +
 * Canonical Mapper (Task 4 modules 2-5), collapsed into one module because
 * SBI Card's real layout (functions/tests/fixtures/real-statements/
 * sbi-card-2026-07.items.json) doesn't need the same separation HDFC's
 * does: every real transaction line here is a single physical row (no
 * observed multi-line-wrapped description on the real fixture, unlike
 * HDFC's), and there is exactly one transaction table, not
 * Domestic/International sections needing independent region tracking.
 *
 * Real-document findings that shaped this module:
 *  - Every transaction row is FOUR columns at consistent x-positions: date
 *    (~x=27-33, "DD Mon YY" — a deliberately different, shorter pattern
 *    than the summary box's "DD Mon YYYY", so the two never collide),
 *    description (~x=70-74), amount (~x=370-405, right-aligned so its
 *    exact x drifts with digit count), and a trailing one-two-letter type
 *    code (~x=413-423: one of D/C/M/EN/FP/BT/EMD/T per the statement's own
 *    printed legend "C=Credit ; D=Debit; EN=Encash; FP=Flexipay;
 *    EMD=Easy Money Draft; BT=Balance Transfer; M=Monthly Installments;
 *    T=Temporary Credit").
 *  - Not every real charge line has its own date: a same-day
 *    fee/interest/tax line (e.g. "IGST DB @ 18.00%   81.77   D") prints
 *    with NO date column at all, immediately below the transaction it
 *    belongs to — genuinely a continuation, not a parsing gap, so this
 *    module carries the nearest preceding dated row's date forward for
 *    any row that has an amount+code but no date of its own.
 *  - At least one real row (`TRANSFER TO MERCHANT EMI`) prints with NO
 *    trailing type code at all — direction is genuinely undeterminable
 *    from the page for that row, so it's marked `needsReview` with a
 *    low-confidence debit default rather than silently guessed.
 *  - The bank's own two-digit-year date format ("17 Jul 26") is the
 *    reliable boundary signal between real transaction rows and every
 *    other row on the page (summary boxes/legends/footnotes never contain
 *    an isolated three-token day-month-2digit-year string as one text
 *    item) — used both to find the table's page range and to anchor each
 *    row, instead of needing a separate section-title/end-marker template
 *    the way HDFC's shared `table-detector.ts` seam does.
 */

import type { ExtractedField, WorkspaceTransaction } from "../../workspace/statement-workspace-model";
import { NOT_YET_CHECKED_DUPLICATE_RESULT } from "../../workspace/statement-workspace-model";
import type { PdfPageText, PdfPageTextItem } from "../../pdf/pdf-document-provider";
import { groupItemsIntoRows, parseAmount, type LayoutRow } from "../page-layout";

const SBI_TXN_DATE_PATTERN = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})$/;
const SBI_AMOUNT_PATTERN = /^-?[\d,]+\.\d{2}$/;
/** Every type code this statement's own printed legend defines — see module comment. */
const SBI_TYPE_CODES = new Set(["D", "C", "M", "EN", "FP", "BT", "EMD", "T"]);
/** Of those, the ones that mean money coming back TO the cardholder (a credit) — every other known code, and an absent/unrecognized one, defaults to debit. */
const SBI_CREDIT_CODES = new Set(["C", "T"]);

function parseSbiTxnDate(raw: string): Date | null {
  const match = SBI_TXN_DATE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = months.indexOf(match[2]!);
  if (monthIndex === -1) return null;
  return new Date(Date.UTC(2000 + Number(match[3]), monthIndex, Number(match[1])));
}

function isHeaderRow(row: LayoutRow): boolean {
  const labels = new Set(row.items.map((item) => item.str.trim()));
  return labels.has("Date") && labels.has("Amount") && labels.has("Transaction Details");
}

/**
 * The transaction table's page range: starts at the first page whose rows
 * contain the "Date"/"Amount"/"Transaction Details" header (repeated on
 * every continuation page on the real fixture), and extends through every
 * immediately-following page that still has at least one dated transaction
 * row — stopping at the first page (after the header page) that has none,
 * since the real statement's Terms & Conditions pages that follow the
 * table never contain an isolated "DD Mon YY" text item.
 */
function findTransactionTablePages(pages: PdfPageText[]): { page: PdfPageText; rows: LayoutRow[] }[] {
  const withRows = pages.map((page) => ({ page, rows: groupItemsIntoRows(page.pageNumber, page.items).sort((a, b) => b.y - a.y) }));
  const headerIndex = withRows.findIndex(({ rows }) => rows.some(isHeaderRow));
  if (headerIndex === -1) return [];

  const result = [withRows[headerIndex]!];
  for (let i = headerIndex + 1; i < withRows.length; i++) {
    const entry = withRows[i]!;
    const hasDatedRow = entry.rows.some((row) => row.items.some((item) => SBI_TXN_DATE_PATTERN.test(item.str.trim())));
    if (!hasDatedRow) break;
    result.push(entry);
  }
  return result;
}

interface ParsedRow {
  page: number;
  date: Date | null;
  dateItem: PdfPageTextItem | null;
  descriptionItems: PdfPageTextItem[];
  amountItem: PdfPageTextItem | null;
  code: string | null;
}

/** Parses one visual row into its date/description/amount/code parts, or `null` if this row isn't a transaction line at all (the header row, a section sub-header, a legend line, ...). `carriedDate` is the nearest preceding dated row's date, for a same-day continuation line that prints with no date of its own (see module comment). */
function parseRow(row: LayoutRow, carriedDate: Date | null): ParsedRow | null {
  if (isHeaderRow(row)) return null;
  const items = row.items.filter((item) => item.str.trim().length > 0);
  if (items.length === 0) return null;

  const dateItem = items.find((item) => SBI_TXN_DATE_PATTERN.test(item.str.trim())) ?? null;
  const date = dateItem ? parseSbiTxnDate(dateItem.str.trim()) : carriedDate;
  // Only a row that starts the table's very first date-bearing line has neither its own date nor a carried
  // one — everything before the first real transaction (summary boxes, "for Statement Period" line, column
  // headers) is excluded this way without needing a separate skip-pattern list.
  if (date == null) return null;

  const withoutDate = items.filter((item) => item !== dateItem);
  const last = withoutDate[withoutDate.length - 1] ?? null;
  const lastIsCode = last != null && SBI_TYPE_CODES.has(last.str.trim());
  const code = lastIsCode ? last!.str.trim() : null;

  const withoutCode = lastIsCode ? withoutDate.slice(0, -1) : withoutDate;
  const amountItem = [...withoutCode].reverse().find((item) => SBI_AMOUNT_PATTERN.test(item.str.trim())) ?? null;
  // Not a transaction row at all (no trailing amount survives once the date/code are stripped) — e.g. the
  // "TRANSACTIONS FOR <cardholder>" sub-header, which has a date-less, amount-less single text item.
  if (!amountItem) return null;

  const descriptionItems = withoutCode.filter((item) => item !== amountItem);

  return { page: row.page, date, dateItem, descriptionItems, amountItem, code };
}

/** "PAYMENT RECEIVED IY218320261059224622890" → the trailing reference token — the only reference-number shape this statement's real transactions print (no separate column, no "(Ref# ...)" wrapper the way HDFC's does). */
function referenceNumberFrom(description: string): string | null {
  const match = /^PAYMENT RECEIVED\s+([A-Z0-9]{6,})$/.exec(description.trim());
  return match ? match[1]! : null;
}

function toWorkspaceTransaction(parsed: ParsedRow, index: number, accountId: string | undefined): WorkspaceTransaction {
  const description = parsed.descriptionItems
    .map((item) => item.str.trim())
    .filter((str) => str.length > 0)
    .join(" ");
  const amount = parseAmount(parsed.amountItem!.str.trim()) ?? 0;
  const reference = referenceNumberFrom(description);

  const dateField: ExtractedField<Date | null> = parsed.dateItem
    ? { value: parsed.date, confidence: 0.97, source: "exact_match", page: parsed.page, boundingBox: boundingBoxOf(parsed.dateItem) }
    : // A same-day continuation line with no date of its own — the date is real (carried from the row above), just not this row's own printed text, so it's a pattern_match rather than an exact one.
      { value: parsed.date, confidence: 0.75, source: "pattern_match", extractionMethod: "carried-forward-from-preceding-row" };

  const knownCode = parsed.code != null;
  const direction: "debit" | "credit" = knownCode && SBI_CREDIT_CODES.has(parsed.code!) ? "credit" : "debit";

  const merchant: ExtractedField<string> =
    description.length > 0
      ? { value: description, confidence: 0.85, source: "fuzzy_match", page: parsed.page, boundingBox: unionBoundingBox(parsed.descriptionItems) }
      : { value: "", confidence: 0.2, source: "unavailable" };

  return {
    date: dateField,
    merchantRaw: merchant,
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: amount, confidence: 0.95, source: "exact_match", page: parsed.page, boundingBox: boundingBoxOf(parsed.amountItem!) },
    direction: knownCode
      ? { value: direction, confidence: 0.95, source: "exact_match" }
      : // No type code printed at all on this row (see module comment) — direction is a low-confidence default, not a real read.
        { value: "debit", confidence: 0.3, source: "unavailable" },
    referenceNumber: reference
      ? { value: reference, confidence: 0.9, source: "pattern_match", extractionMethod: "regex:PAYMENT RECEIVED <ref>" }
      : { value: null, confidence: 0, source: "unavailable" },
    currency: { value: "INR", confidence: 0.95, source: "pattern_match", extractionMethod: "inferred:no-per-row-currency-column" },

    sourcePage: parsed.page,
    sourceLineIndex: index,
    originalRawText: [parsed.dateItem?.str, ...parsed.descriptionItems.map((i) => i.str), parsed.amountItem!.str, parsed.code]
      .filter((s): s is string => !!s)
      .join(" "),
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
    needsReview: !knownCode,
    warnings: [],
    confidence: Math.min(dateField.confidence, 0.95, merchant.confidence, knownCode ? 0.95 : 0.3),
  };
}

function boundingBoxOf(item: PdfPageTextItem) {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function unionBoundingBox(items: PdfPageTextItem[]) {
  if (items.length === 0) return undefined;
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface SbiTransactionExtractionResult {
  transactions: WorkspaceTransaction[];
  transactionTableFound: boolean;
}

export function extractSbiTransactions(pages: PdfPageText[], context: { accountId?: string } = {}): SbiTransactionExtractionResult {
  const tablePages = findTransactionTablePages(pages);
  if (tablePages.length === 0) return { transactions: [], transactionTableFound: false };

  const parsedRows: ParsedRow[] = [];
  for (const { rows } of tablePages) {
    // Reset per page — a logical row can never span two pages (same guarantee `row-extractor.ts` documents
    // for HDFC), so a page's last transaction's date must never leak into the next page's first row.
    let carriedDate: Date | null = null;
    for (const row of rows) {
      const parsed = parseRow(row, carriedDate);
      if (!parsed) continue;
      carriedDate = parsed.date;
      parsedRows.push(parsed);
    }
  }

  const transactions = parsedRows.map((row, index) => toWorkspaceTransaction(row, index, context.accountId));
  return { transactions, transactionTableFound: transactions.length > 0 };
}
