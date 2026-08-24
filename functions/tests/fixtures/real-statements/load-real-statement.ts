/**
 * Loads a redacted real-statement positional-items snapshot (ADR-006,
 * docs/parser-pipeline-design.md v3 §10 Task 4) into the shape parser
 * modules actually consume (`PdfPageText[]`). These snapshots are captured
 * once, directly from a real bank statement PDF via pdfjs-dist, with all
 * personal identifiers (name/address/email/CKYC ID/etc.) replaced by
 * placeholders before being committed — see the sibling .items.json files'
 * own provenance: never re-derive them from a live PDF in CI, and never
 * commit an unredacted one.
 */

import type { PdfPageText, PdfPageTextItem } from "../../../src/pdf/pdf-document-provider";

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface RawPage {
  pageNumber: number;
  items: RawItem[];
}

export function loadRealStatementPages(jsonModule: RawPage[]): PdfPageText[] {
  return jsonModule.map((page) => {
    const items: PdfPageTextItem[] = page.items.map((item) => ({
      str: item.str,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }));
    return {
      pageNumber: page.pageNumber,
      text: items.map((item) => item.str).join(" "),
      items,
    };
  });
}
