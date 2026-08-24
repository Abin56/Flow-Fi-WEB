/**
 * HDFC Transaction Field Extractor — Task 4 module 4
 * (docs/parser-pipeline-design.md v3 §10; ADR-006).
 *
 * Single responsibility: given one Module-3 logical row, extract typed
 * fields (transaction date, value date, merchant, description, debit,
 * credit, amount, currency, reference number, running balance) with
 * per-field confidence, source, page, and bounding box. Does NOT
 * categorize, normalize merchants, or detect duplicates — those are
 * separate downstream modules, per the standing single-responsibility rule.
 *
 * Real-document findings this module encodes:
 *  - HDFC's "Domestic/International Transactions" table has exactly ONE
 *    description column — there is no separately labeled narration/memo
 *    field distinct from the merchant/description text, and no separate
 *    "value date" column either (only one date+time per row). Both
 *    `description` and `valueDate` are therefore genuinely `unavailable`
 *    for this bank/layout — not a parsing gap. `merchant` carries the full
 *    reconstructed text.
 *  - Direction: a leading "+" token on the anchor row marks a credit
 *    (payment/refund); its absence marks a debit. Confirmed against the
 *    real statement's own totals (see hdfc-metadata-extractor's
 *    reconciliation) — every row without "+" summed to the printed
 *    "Purchases/Debit" total, and the one row with "+" matched exactly
 *    the printed "Payments/Credits Received" total. `debit`/`credit` are
 *    exposed as two separate fields (per the required field list): exactly
 *    one of the pair is ever populated for a given row, the other is
 *    `unavailable` — never both, never neither, when an amount was found.
 *  - Reference number: embedded inline in the description as
 *    "(Ref# ...)" when present — never a separate column. Absent for
 *    ordinary merchant purchases (confirmed: 8 of the 19 real rows have no
 *    reference number at all).
 *  - Currency: this statement never prints a per-row currency code or a
 *    separate original-foreign-currency amount (even the "International
 *    Transactions" section's rows are IGST charges already billed in
 *    INR) — every row's currency is inferred as INR, not read from a
 *    per-row source, so it is marked "pattern_match" rather than
 *    "exact_match".
 *  - Running balance: this statement never prints one — always
 *    unavailable, consistent with typical Indian credit card statements
 *    (unlike a bank account statement).
 *  - Bounding box: for date/amount/debit/credit (always a single anchor-row
 *    item), the box is that item's own x/y/width/height. For `merchant`,
 *    which is reconstructed from every physical row's description tokens
 *    (Module 3), the box is the union (min x/y to max x+width/y+height)
 *    across every contributing item, since the real printed text
 *    genuinely spans that whole area across possibly-wrapped lines. For
 *    `referenceNumber`, "(Ref# ...)" is NOT always one item — a wrapped
 *    3-line description in the real fixture splits it as "...(Ref#" on
 *    one physical line and the closing "...)" on the next, so the box
 *    falls back to whichever item contains the literal "Ref#" opening
 *    when no single item matches the full pattern (a real bug caught by
 *    this module's own test suite before being fixed here).
 */

import type { BoundingBox, ExtractedField, ExtractedFieldSource } from "../../workspace/statement-workspace-model";
import type { HdfcTransactionSectionType } from "./hdfc-table-detector";
import type { RawTransactionRow } from "../row-extractor";
import type { PdfPageTextItem } from "../../pdf/pdf-document-provider";
import { parseAmount } from "../page-layout";

const HDFC_DATE_TIME_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})\s*\|\s*(\d{2}):(\d{2})$/;
const HDFC_AMOUNT_PATTERN = /^-?[\d,]+\.\d{2}$/;
const REFERENCE_NUMBER_PATTERN = /\(Ref#\s*([^)]+)\)/;

function field<T>(value: T, confidence: number, source: ExtractedFieldSource, extra?: Partial<ExtractedField<T>>): ExtractedField<T> {
  return { value, confidence, source, ...extra };
}

function unavailable<T>(): ExtractedField<T | null> {
  return { value: null, confidence: 0, source: "unavailable" };
}

function boundingBoxOf(item: PdfPageTextItem): BoundingBox {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

/** Union bounding box across every item that contributed to the reconstructed merchant/description text. */
function unionBoundingBox(items: PdfPageTextItem[]): BoundingBox | undefined {
  if (items.length === 0) return undefined;
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** "19/06/2026| 22:16" → UTC Date, date+time both encoded (WorkspaceTransaction.date has no separate time field). */
function parseHdfcDateTime(raw: string): Date | null {
  const match = HDFC_DATE_TIME_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
}

export interface HdfcExtractedTransactionFields {
  page: number;
  sectionType: HdfcTransactionSectionType;
  transactionDate: ExtractedField<Date | null>;
  valueDate: ExtractedField<Date | null>;
  merchant: ExtractedField<string>;
  description: ExtractedField<string | null>;
  debit: ExtractedField<number | null>;
  credit: ExtractedField<number | null>;
  amount: ExtractedField<number | null>;
  currency: ExtractedField<string>;
  referenceNumber: ExtractedField<string | null>;
  runningBalance: ExtractedField<number | null>;
  originalRawText: string;
}

export function extractHdfcTransactionFields(row: RawTransactionRow<HdfcTransactionSectionType>): HdfcExtractedTransactionFields {
  const anchorItems = row.anchorRow.items;
  const anchorTokens = anchorItems.map((item) => item.str.trim());

  const dateItem = anchorItems.find((item) => HDFC_DATE_TIME_PATTERN.test(item.str.trim()));
  const transactionDate = dateItem
    ? field(parseHdfcDateTime(dateItem.str.trim()), 0.97, "exact_match", { page: row.page, boundingBox: boundingBoxOf(dateItem) })
    : unavailable<Date>();

  // No separate "value date" column exists on this bank's layout (see module comment) — genuinely absent, not a parsing gap.
  const valueDate = unavailable<Date>();

  const amountItem = anchorItems.find((item) => HDFC_AMOUNT_PATTERN.test(item.str.trim()));
  const amount = amountItem
    ? field(parseAmount(amountItem.str.trim()), 0.95, "exact_match", { page: row.page, boundingBox: boundingBoxOf(amountItem) })
    : unavailable<number>();

  const isCredit = anchorTokens.includes("+");
  const debit: ExtractedField<number | null> =
    amountItem && !isCredit ? field(amount.value, 0.95, "exact_match", { page: row.page, boundingBox: boundingBoxOf(amountItem) }) : unavailable();
  const credit: ExtractedField<number | null> =
    amountItem && isCredit ? field(amount.value, 0.95, "exact_match", { page: row.page, boundingBox: boundingBoxOf(amountItem) }) : unavailable();

  const referenceMatch = REFERENCE_NUMBER_PATTERN.exec(row.combinedDescription);
  // The regex matches against the reconstructed string, but "(Ref# ...)" is NOT always a single description
  // token: a wrapped 3-line description (real fixture case) can split it across two physical lines — e.g.
  // "...(Ref#" on one line and "09999999980619002660882)" on the next. A single-item exact match is therefore
  // only sometimes possible; the item carrying the literal "Ref#" opening is always present and is the more
  // meaningful anchor for a bounding box regardless, so it's used whenever the full pattern isn't found on one item.
  const referenceItems = referenceMatch ? row.physicalRows.flatMap((physicalRow) => physicalRow.items) : [];
  const referenceSourceItem =
    referenceItems.find((item) => REFERENCE_NUMBER_PATTERN.test(item.str)) ?? referenceItems.find((item) => item.str.includes("Ref#"));
  const referenceNumber = referenceMatch
    ? field(referenceMatch[1]!.trim(), 0.9, "pattern_match", {
        extractionMethod: "regex:(Ref# ...)",
        ...(referenceSourceItem ? { page: row.page, boundingBox: boundingBoxOf(referenceSourceItem) } : {}),
      })
    : unavailable<string>();

  const merchantItems = row.physicalRows.flatMap((physicalRow) => physicalRow.items).filter((item) => item.str.trim().length > 0);
  const merchant: ExtractedField<string> =
    row.combinedDescription.length > 0
      ? field(row.combinedDescription, 0.85, "fuzzy_match", { page: row.page, boundingBox: unionBoundingBox(merchantItems) })
      : field("", 0.2, "unavailable");

  const originalRawText = row.physicalRows.map((physicalRow) => physicalRow.items.map((item) => item.str).join(" ")).join(" / ");

  return {
    page: row.page,
    sectionType: row.sectionType,
    transactionDate,
    valueDate,
    merchant,
    // Genuinely absent field for this bank/layout (see module comment) — not a parsing gap.
    description: unavailable<string>(),
    debit,
    credit,
    amount,
    // Inferred, never read from a per-row source on this statement (see module comment).
    currency: field("INR", 0.95, "pattern_match", { extractionMethod: "inferred:no-per-row-currency-column" }),
    referenceNumber,
    // Never printed on this statement.
    runningBalance: unavailable<number>(),
    originalRawText,
  };
}
