/**
 * Shared spatial-layout primitives for the deterministic Statement Parsing
 * Engine (docs/parser-pipeline-design.md v3 §10 Task 4; ADR-006). Every
 * bank-specific parser module (metadata extractor, table detector, row
 * extractor) builds on these — none may re-derive row/column structure from
 * `PdfPageText.text` (the flattened string), only from `items` (ADR-006).
 *
 * Row grouping is the foundational operation: pdfjs emits items in
 * content-stream (paint) order, not reading order, so nothing about a raw
 * `items` array's index order can be trusted as layout order. Grouping by a
 * `y` tolerance and re-sorting each group by `x` is the only reliable way to
 * reconstruct a page's visual rows.
 *
 * Every row carries the page it came from (`page`). This is not optional
 * bookkeeping: a multi-page statement's pages each start their own
 * coordinate space (roughly 0-800 in y), so two rows from different pages
 * can have near-identical or "row A below row B" y-relationships that are
 * spatially meaningless. Built against a real HDFC statement, this was
 * caught as a genuine bug during Task 4: a page-3 transaction row and a
 * page-1 summary-box row shared close enough y values that a naive
 * cross-page comparison matched the wrong one. `findRowByLabel`/
 * `valueBelowLabel` therefore always resolve "below" strictly within the
 * label's own page.
 */

import type { PdfPageText, PdfPageTextItem } from "../pdf/pdf-document-provider";

/** A visual row: every item painted at (approximately) the same y on the same page, sorted left-to-right. */
export interface LayoutRow {
  page: number;
  y: number;
  items: PdfPageTextItem[];
}

/**
 * Groups a single page's items into visual rows. Tolerance default (2pt) is
 * derived from the real HDFC statement this module was built against
 * (ADR-006's investigation): same-row sub-elements (e.g. a small trailing
 * icon glyph) differed by ~0.6-0.7pt, while a genuinely wrapped next line of
 * a multi-line description differed by ~8-9pt — 2pt cleanly separates the
 * two without merging real wrapped lines into one row.
 */
export function groupItemsIntoRows(page: number, items: PdfPageTextItem[], yTolerance = 2): LayoutRow[] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: LayoutRow[] = [];

  for (const item of sorted) {
    const openRow = rows.find((row) => Math.abs(row.y - item.y) <= yTolerance);
    if (openRow) {
      openRow.items.push(item);
    } else {
      rows.push({ page, y: item.y, items: [item] });
    }
  }

  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/** Convenience wrapper: groups every page's items into rows, each correctly tagged with its own page number. */
export function groupPagesIntoRows(pages: PdfPageText[], yTolerance = 2): LayoutRow[] {
  return pages.flatMap((page) => groupItemsIntoRows(page.pageNumber, page.items, yTolerance));
}

/** Finds the row containing an item whose `str` matches exactly (after trimming). */
export function findRowByLabel(rows: LayoutRow[], label: string): LayoutRow | null {
  return rows.find((row) => row.items.some((item) => item.str.trim() === label)) ?? null;
}

/**
 * "Label left, value right, same row" pattern (e.g. "Statement Date" / "19 Jul, 2026"
 * on the same visual line). Returns every token strictly to the right of the
 * label, joined with a single space, or null if the label isn't found or
 * has nothing after it.
 */
export function valueRightOfLabel(rows: LayoutRow[], label: string): string | null {
  const row = findRowByLabel(rows, label);
  if (!row) return null;
  const labelIndex = row.items.findIndex((item) => item.str.trim() === label);
  const rest = row.items.slice(labelIndex + 1).filter((item) => item.str.trim().length > 0);
  if (rest.length === 0) return null;
  return rest.map((item) => item.str.trim()).join(" ");
}

/**
 * "Label above, value below, same column" pattern (e.g. "TOTAL AMOUNT DUE"
 * with its value one line below). Finds the label's row, then the nearest
 * row strictly below it ON THE SAME PAGE within `maxYGap`, whose items
 * include one within `xTolerance` of the label's x. Two real sub-patterns
 * exist on the real HDFC statement this was built against: some boxes align
 * the value exactly under the label (delta 0), others right-shift the value
 * relative to a left-aligned two-line title (deltas up to ~29.6pt observed,
 * e.g. "AVAILABLE CASH LIMIT") — `xTolerance` defaults to 35 to cover both
 * without reaching into an adjacent column (adjacent labels in that row are
 * always >80pt apart).
 *
 * Returns the single item NEAREST the label's x, not every item within
 * tolerance joined together — a value is always one token, so "nearest" is
 * strictly more correct than "join all within range". This was a real bug
 * caught against the real statement: the "TOTAL AMOUNT DUE" value row also
 * contains a decorative "A + B + C = Total" equation strip ("+", "="
 * glyphs) whose "=" symbol falls inside a naive tolerance-wide join,
 * producing "= 10,006.00" instead of "10,006.00". A bare currency-marker
 * "C" glyph (this statement's font maps the ₹ symbol to a stray "C" text
 * run, per ADR-006's investigation) is also never treated as the value,
 * even if it happens to be nearest.
 *
 * `minYGap` (default 12) is a second real-bug fix: several labels here are
 * themselves two-line titles (e.g. "TOTAL CREDIT LIMIT" / "(Including
 * Cash)"), and that continuation line sits a consistent ~8.5pt below the
 * label — closer than the true value row (consistently ~17-24pt below
 * across every box measured on the real statement) — so a naive nearest-row
 * search picks up the label's own second line as if it were the value.
 * Requiring at least a 12pt gap (comfortably between the two observed
 * distances) skips continuation lines without needing to special-case
 * which labels happen to wrap.
 */
export function valueBelowLabel(rows: LayoutRow[], label: string, xTolerance = 35, maxYGap = 40, minYGap = 12): string | null {
  const labelRow = findRowByLabel(rows, label);
  if (!labelRow) return null;
  const labelItem = labelRow.items.find((item) => item.str.trim() === label)!;

  const candidateRows = rows
    .filter((row) => row.page === labelRow.page && row.y <= labelRow.y - minYGap && labelRow.y - row.y <= maxYGap)
    .sort((a, b) => b.y - a.y);

  for (const row of candidateRows) {
    const meaningful = row.items.filter(
      (item) => Math.abs(item.x - labelItem.x) <= xTolerance && item.str.trim().length > 0 && !isDecorativeGlyph(item.str.trim()),
    );
    if (meaningful.length === 0) continue;
    const nearest = meaningful.reduce((best, item) => (Math.abs(item.x - labelItem.x) < Math.abs(best.x - labelItem.x) ? item : best));
    return nearest.str.trim();
  }
  return null;
}

/**
 * A decorative currency/equation glyph, never a real value — even when it
 * happens to be the item nearest a label's x. Two real shapes confirmed
 * against real statements from different banks, each with its own font
 * quirk for rendering the ₹ symbol: HDFC's font maps it to a bare "C" text
 * run (ADR-006), while SBI Card's maps it to a stray "( ` )" run (SBI
 * parser task). Also covers the "A + B + C = Total" summary equation's
 * connector symbols — a real bug caught against the HDFC statement: for
 * "FINANCE CHARGES", the equation's "+" glyph sits closer to the label
 * than the actual "0.00" value. The `( ` )` check only matches a token
 * made ENTIRELY of parens/backtick/whitespace, so it can never accidentally
 * swallow a real amount or label text (neither ever contains those
 * characters alone).
 */
function isDecorativeGlyph(str: string): boolean {
  if (str === "C") return true;
  if (str.length === 1 && /[+=\-_]/.test(str)) return true;
  if (str.trim().length > 0 && /^[()`\s]+$/.test(str)) return true;
  return false;
}

/** Strips thousands separators and parses a printed amount ("10,006.00", "38,000") to a plain number. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}
