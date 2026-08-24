# ADR-006: Add a positional PDF text-items API alongside the flattened-string API

**Status:** Accepted
**Date:** 2026-08-03
**Backlog task:** M3 (Statement Parsing Engine, Task 4 — Statement Metadata Extractor / Transaction Table Detector / Row Extractor)
**Architecture section(s) affected:** §8 (`PdfDocumentProvider` abstraction)

## Context

`PdfDocumentProvider.getPageText()` (`functions/src/pdf/pdf-document-provider.ts`) returns a single flattened string per page: `content.items.map(item => item.str ?? "").join(" ")`. This was sufficient for M1-T7/M2-T2, whose only requirement was confirming a page is readable (a non-empty string).

Building the real Statement Parsing Engine against an actual HDFC statement PDF (password-protected, provided directly by the user for this purpose) surfaced a structural problem, confirmed by direct inspection of `pdfjs-dist`'s `getTextContent()` output: **text items are emitted in PDF content-stream (paint) order, not visual reading order.** On the real statement, the page-1 header block (Credit Card No. / Statement Date / Billing Period — physically at the top of the page) appears *after* the entire transaction table in the item stream, because the PDF generator painted the table before the header box. A flattened, space-joined string interleaves unrelated columns and cannot be reliably split back into rows/columns after the fact — this is a genuine information loss, not merely an inconvenience. The Transaction Table Detector and Transaction Row Extractor (Task 4, modules 2/3) require each item's `(x, y)` position to reconstruct table structure; no string-only heuristic (regex, whitespace collapsing, etc.) can recover it, since the ambiguity is in element *order*, not element *spacing*.

This was also confirmed necessary (not merely convenient) for correctly handling wrapped/multi-line transaction descriptions: on the real statement, a single logical transaction row's description sometimes spans two lines ~8–9pt apart in `y`, while unrelated same-row sub-elements (e.g. a small icon glyph) differ by under 1pt. Distinguishing "next line of this row's wrapped description" from "the next row" requires comparing `y` deltas against a tolerance — impossible without position data.

## Decision

Extend `PdfDocumentHandle`/`PdfPageText` with a new, additive positional API. The existing flattened-string API (`text`, `getPageText`, `getAllPageText`) is kept unchanged — its two existing consumers (`tests/pdf-document-provider.test.ts`, `tests/workspace-edge-fixtures.test.ts`) still only need a readable non-empty string and are unaffected.

New shape, in `functions/src/pdf/pdf-document-provider.ts`:

```ts
export interface PdfPageTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageText {
  pageNumber: number;
  text: string; // unchanged
  items: PdfPageTextItem[]; // new
}
```

`PdfPageText` itself gains the `items` field (rather than adding a parallel `getPageTextItems()` method) — `getPageText`/`getAllPageText` already return `PdfPageText`, so every existing call site automatically gains positional data with no method-surface change. `(x, y)` come from `item.transform[4]`/`item.transform[5]` (pdfjs's text rendering matrix — the position actually painted, already what was used to manually reverse-engineer the real statement's layout during Task 4's investigation). `width`/`height` come straight from pdfjs's `item.width`/`item.height`.

Every future table/row/field extraction module (Task 4 onward) must consume `items`, never re-derive structure from `text` via string heuristics — `text` remains solely for "is this page readable" checks.

## Consequences

- Additive change: `PdfDocumentProvider`'s existing two consumers, and the M2-T2 pipeline's current "confirm readability" usage, are unaffected — they only reference `.text`.
- `functions/src/pdf/pdfjs-document-provider.ts` is the only file touched to satisfy this (per its own module comment, the sole file allowed to import `pdfjs-dist`) — the abstraction boundary is preserved.
- Does **not** change the locked Architecture v1.0's §8 abstraction *principle* (no business logic anywhere else may depend on pdfjs-dist directly) — it changes what data crosses that boundary, not who's allowed to see pdfjs internals.
- Downstream parser modules (Table Detector, Row Extractor, Field Extractor, Canonical Mapper) are built and tested against `PdfPageTextItem[]`, never against raw pdfjs types.

## Alternatives considered

- **Reconstruct rows from the flattened string via regex/whitespace heuristics.** Rejected — demonstrated directly against the real statement to lose information that cannot be recovered after flattening (item order itself is wrong, not just spacing).
- **Replace `text`/`getPageText` entirely with the positional API.** Rejected — unnecessary churn for the two existing consumers that only need a readability check; additive change has zero migration cost for them.
- **A separate `getPageTextItems()` method instead of extending `PdfPageText`.** Rejected — `PdfPageText` is already the return shape of both existing methods; adding a field is a strict superset, whereas a parallel method would mean two separate calls (and two separate pdfjs page-content fetches) to get text and positions for the same page.
