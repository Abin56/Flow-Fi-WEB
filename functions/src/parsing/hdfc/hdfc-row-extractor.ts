/**
 * HDFC Transaction Row Extractor — Task 4 module 3. Supplies the
 * bank-specific anchor/description-token rules (real, from the redacted
 * real HDFC Freedom statement fixture) to the bank-independent
 * `extractRawTransactionRows` (row-extractor.ts).
 *
 * Real-document findings this template encodes:
 *  - The date/time token always has the shape "DD/MM/YYYY| HH:MM" (domestic
 *    rows) or "DD/MM/YYYY | HH:MM" (international rows — note the extra
 *    space before the pipe; both are accepted).
 *  - On the anchor row, the currency-marker "C" glyph (ADR-006/page-layout.ts's
 *    finding: this font maps ₹ to a bare "C" text run), a leading "+" (the
 *    credit/payment indicator), the amount itself, and the trailing "l"
 *    purchase-indicator glyph are never description text.
 */

import type { HdfcTransactionSectionType } from "./hdfc-table-detector";
import type { LayoutRow } from "../page-layout";
import type { RawTransactionRow } from "../row-extractor";
import { extractRawTransactionRows, type RowExtractionTemplate } from "../row-extractor";
import type { TransactionTableRegion } from "../table-detector";

const HDFC_DATE_TIME_PATTERN = /^\d{2}\/\d{2}\/\d{4}\s*\|\s*\d{2}:\d{2}$/;
const HDFC_AMOUNT_PATTERN = /^-?[\d,]+\.\d{2}$/;

export const HDFC_ROW_EXTRACTION_TEMPLATE: RowExtractionTemplate = {
  isAnchorRow(row: LayoutRow): boolean {
    return row.items.some((item) => HDFC_DATE_TIME_PATTERN.test(item.str.trim()));
  },
  isDescriptionToken(str: string): boolean {
    if (HDFC_DATE_TIME_PATTERN.test(str)) return false;
    if (HDFC_AMOUNT_PATTERN.test(str)) return false;
    if (str === "C" || str === "+" || str === "l") return false;
    return true;
  },
};

export function extractHdfcRawTransactionRows(
  regions: TransactionTableRegion<HdfcTransactionSectionType>[],
): RawTransactionRow<HdfcTransactionSectionType>[] {
  return extractRawTransactionRows(regions, HDFC_ROW_EXTRACTION_TEMPLATE);
}
