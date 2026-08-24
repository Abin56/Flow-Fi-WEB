/**
 * Transaction Table Detector — Task 4 module 2
 * (docs/parser-pipeline-design.md v3 §10; ADR-006).
 *
 * Single responsibility: given a statement's pages, find the transaction
 * table region(s) and hand back only those rows — never the summary boxes,
 * reward sections, advertisements, headers/footers, or legal text that
 * surround them on a real statement. Everything here is bank-independent;
 * a bank's specific section-title strings, header column labels, and
 * skip/end markers are supplied as a `TransactionTableTemplate` by a
 * bank-specific module (e.g. `hdfc/hdfc-table-detector.ts`), never
 * hardcoded here.
 *
 * A logical section (e.g. "Domestic Transactions") can span multiple
 * pages on a real statement — this module does NOT merge those into one
 * region. Each page's occurrence of a section becomes its own
 * `TransactionTableRegion`, still correctly tagged with the same
 * `sectionType`. Module 3 (Row Extractor) is the one that must never merge
 * rows across pages (per its own single responsibility), so keeping
 * regions page-scoped here keeps that guarantee trivial to hold downstream.
 */

import type { PdfPageText } from "../pdf/pdf-document-provider";
import { groupItemsIntoRows, type LayoutRow } from "./page-layout";

export interface SectionTitleAnchor<TSectionType extends string> {
  title: string;
  sectionType: TSectionType;
}

export interface TransactionTableTemplate<TSectionType extends string> {
  /** Section title strings that start a distinct transaction section, tried in scan order per page. */
  sectionTitles: SectionTitleAnchor<TSectionType>[];
  /** A row is the column-header row only if it contains an item matching every one of these (exact, trimmed). */
  headerColumnLabels: string[];
  /** A row is skipped (not real transaction data) if any of its items match one of these — e.g. a repeated cardholder-name sub-header, a page-number footer. */
  skipRowPatterns: RegExp[];
  /** A row ends the CURRENT region (without being included in it) if any of its items match one of these — e.g. a footnote, an unrelated table's own title. */
  endMarkerPatterns: RegExp[];
}

export interface TransactionTableRegion<TSectionType extends string> {
  page: number;
  sectionType: TSectionType;
  /** Rows strictly between the header row and the region's end, in top-to-bottom order, with skip-pattern rows already removed. */
  rows: LayoutRow[];
}

function isHeaderRow(row: LayoutRow, headerColumnLabels: string[]): boolean {
  const present = new Set(row.items.map((item) => item.str.trim()));
  return headerColumnLabels.every((label) => present.has(label));
}

function matchesAny(row: LayoutRow, patterns: RegExp[]): boolean {
  return row.items.some((item) => patterns.some((pattern) => pattern.test(item.str.trim())));
}

export function detectTransactionTableRegions<TSectionType extends string>(
  pages: PdfPageText[],
  template: TransactionTableTemplate<TSectionType>,
): TransactionTableRegion<TSectionType>[] {
  const regions: TransactionTableRegion<TSectionType>[] = [];

  for (const page of pages) {
    const rows = groupItemsIntoRows(page.pageNumber, page.items).sort((a, b) => b.y - a.y);
    let currentSectionType: TSectionType | null = null;
    let activeRegion: TransactionTableRegion<TSectionType> | null = null;

    for (const row of rows) {
      const titleMatch = template.sectionTitles.find((anchor) => row.items.some((item) => item.str.trim() === anchor.title));
      if (titleMatch) {
        currentSectionType = titleMatch.sectionType;
        activeRegion = null; // A new section always requires re-finding its own header row before collecting rows.
        continue;
      }

      if (isHeaderRow(row, template.headerColumnLabels)) {
        if (currentSectionType == null) continue; // A header row with no preceding known section title isn't one of ours.
        activeRegion = { page: page.pageNumber, sectionType: currentSectionType, rows: [] };
        regions.push(activeRegion);
        continue;
      }

      if (!activeRegion) continue;

      if (matchesAny(row, template.endMarkerPatterns)) {
        activeRegion = null;
        continue;
      }

      if (matchesAny(row, template.skipRowPatterns)) continue;

      activeRegion.rows.push(row);
    }
  }

  return regions;
}
