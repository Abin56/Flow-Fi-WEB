/**
 * HDFC Transaction Table Detector — Task 4 module 2. Supplies the
 * bank-specific anchor strings (real, copied from the redacted real HDFC
 * Freedom statement fixture — never guessed) to the bank-independent
 * `detectTransactionTableRegions` (page-layout/table-detector.ts).
 *
 * Real-document findings this template encodes (documented so a future
 * reader doesn't "fix" what looks like a gap but is actually deliberate,
 * per the same discipline as the metadata extractor):
 *  - Both "Domestic Transactions" and "International Transactions"
 *    sections repeat their own section title AND full column-header row
 *    every time the section continues onto a new page.
 *  - Every section's column-header row is immediately followed by a
 *    cardholder sub-header row containing "[CKYC ID ...]" — never a real
 *    transaction, always skipped.
 *  - The page-number footer ("Page 1 of 4") sits below the transaction
 *    rows in y and must be excluded, or it would be misread as a
 *    transaction row with a single item.
 *  - After the last transaction section, unrelated tables/notices follow
 *    with their own distinct titles/footnotes — each is registered as an
 *    end marker so the region doesn't swallow them.
 */

import type { PdfPageText } from "../../pdf/pdf-document-provider";
import { detectTransactionTableRegions, type TransactionTableRegion, type TransactionTableTemplate } from "../table-detector";

export type HdfcTransactionSectionType = "domestic" | "international";

export const HDFC_TRANSACTION_TABLE_TEMPLATE: TransactionTableTemplate<HdfcTransactionSectionType> = {
  sectionTitles: [
    { title: "Domestic Transactions", sectionType: "domestic" },
    { title: "International Transactions", sectionType: "international" },
  ],
  headerColumnLabels: ["DATE & TIME", "TRANSACTION DESCRIPTION", "REWARDS", "AMOUNT", "PI"],
  skipRowPatterns: [/\[CKYC ID/, /^Page \d+ of \d+$/],
  endMarkerPatterns: [
    /^\*Transaction time captured/,
    /^Eligible for$/,
    /^Rewards Program Points Summary$/,
    /^Smart EMI Loan Summary$/,
    /^Insta Loan Summary$/,
    /^GST Summary$/,
    /^Important Information$/,
  ],
};

export function detectHdfcTransactionTableRegions(pages: PdfPageText[]): TransactionTableRegion<HdfcTransactionSectionType>[] {
  return detectTransactionTableRegions(pages, HDFC_TRANSACTION_TABLE_TEMPLATE);
}
