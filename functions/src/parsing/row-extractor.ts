/**
 * Transaction Row Extractor — Task 4 module 3
 * (docs/parser-pipeline-design.md v3 §10; ADR-006).
 *
 * Single responsibility: convert a Transaction Table Detector region's
 * PHYSICAL rows (Module 2's output — one per printed line, wrapped
 * descriptions still split across multiple lines) into logical
 * transaction rows: one entry per real transaction, with any wrapped
 * description reconstructed into a single coherent string. Does not
 * extract/parse individual fields (date, amount, merchant) — that is
 * Module 4's job; this module only regroups physical lines and rebuilds
 * the description text.
 *
 * "Never merge rows across pages" is a structural guarantee, not a runtime
 * check: `TransactionTableRegion`s are already page-scoped (Module 2), and
 * this module resets its "current logical row" state at the start of every
 * region — so a logical row can never span two regions, and therefore
 * never spans two pages.
 *
 * Bank-independent: which row is a new transaction's "anchor" (the line
 * carrying the date) and which items on the anchor row are description
 * text (as opposed to the date/amount/currency/direction-indicator tokens
 * a bank's layout also puts on that same line) are both supplied by a
 * bank-specific `RowExtractionTemplate`.
 */

import type { TransactionTableRegion } from "./table-detector";
import type { LayoutRow } from "./page-layout";

export interface RowExtractionTemplate {
  /** True if this physical row is a new logical transaction's anchor line (i.e., it carries the date). */
  isAnchorRow(row: LayoutRow): boolean;
  /** True if an item on the ANCHOR row is description/narration text, as opposed to a date/amount/currency/indicator token that belongs to a different logical field. Continuation (non-anchor) rows are always treated as pure description text in full. */
  isDescriptionToken(str: string): boolean;
}

export interface RawTransactionRow<TSectionType extends string> {
  page: number;
  sectionType: TSectionType;
  /** The anchor line plus every wrapped continuation line, in top-to-bottom visual order. */
  physicalRows: LayoutRow[];
  /** The single physical row carrying the date (and, when not wrapped, the full description). */
  anchorRow: LayoutRow;
  /** The fully reconstructed description/narration text, in reading order, regardless of how many physical lines it was split across. */
  combinedDescription: string;
}

function descriptionTokensOf(row: LayoutRow, isAnchor: boolean, template: RowExtractionTemplate): string[] {
  if (!isAnchor) return row.items.map((item) => item.str.trim()).filter((str) => str.length > 0);
  return row.items.map((item) => item.str.trim()).filter((str) => str.length > 0 && template.isDescriptionToken(str));
}

export function extractRawTransactionRows<TSectionType extends string>(
  regions: TransactionTableRegion<TSectionType>[],
  template: RowExtractionTemplate,
): RawTransactionRow<TSectionType>[] {
  const result: RawTransactionRow<TSectionType>[] = [];

  for (const region of regions) {
    const anchorIndices = region.rows.reduce<number[]>((acc, row, index) => {
      if (template.isAnchorRow(row)) acc.push(index);
      return acc;
    }, []);
    if (anchorIndices.length === 0) continue;

    // A wrapped description's first continuation line prints ABOVE its own
    // anchor row (the anchor — carrying date+amount — sits vertically
    // centered between the two wrapped lines), so a simple left-to-right
    // "attach to whichever anchor came before" pass would misattach or
    // drop it. Every non-anchor row is instead assigned to whichever
    // anchor (previous or next) is nearest by y-distance — verified
    // against the real statement: a continuation line's gap to its own
    // anchor is ~4-5pt, while the gap between two different transactions'
    // anchors is consistently ~14-16pt, so "nearest" is unambiguous.
    const rowsByAnchor = new Map<number, LayoutRow[]>(anchorIndices.map((i) => [i, [region.rows[i]!]]));

    region.rows.forEach((row, index) => {
      if (anchorIndices.includes(index)) return;
      const nearestAnchorIndex = anchorIndices.reduce((best, anchorIndex) =>
        Math.abs(region.rows[anchorIndex]!.y - row.y) < Math.abs(region.rows[best]!.y - row.y) ? anchorIndex : best,
      );
      rowsByAnchor.get(nearestAnchorIndex)!.push(row);
    });

    for (const anchorIndex of anchorIndices) {
      const anchorRow = region.rows[anchorIndex]!;
      const physicalRows = rowsByAnchor.get(anchorIndex)!.sort((a, b) => b.y - a.y);
      const combinedDescription = physicalRows
        .map((row) => descriptionTokensOf(row, row === anchorRow, template).join(" "))
        .filter((part) => part.length > 0)
        .join(" ");

      result.push({ page: region.page, sectionType: region.sectionType, physicalRows, anchorRow, combinedDescription });
    }
  }

  return result;
}
