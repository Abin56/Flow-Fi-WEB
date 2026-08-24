/**
 * HDFC Transaction Row Extractor (Task 4, module 3) — validated against the
 * real (redacted) HDFC Freedom Credit Card statement. Expected combined
 * descriptions and counts were confirmed by manually reading the real
 * statement's extracted text before this test was written.
 */

import { describe, expect, it } from "vitest";
import { detectHdfcTransactionTableRegions } from "../src/parsing/hdfc/hdfc-table-detector";
import { extractHdfcRawTransactionRows } from "../src/parsing/hdfc/hdfc-row-extractor";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const pages = loadRealStatementPages(hdfcFreedomItems as never);
const regions = detectHdfcTransactionTableRegions(pages);
const rawRows = extractHdfcRawTransactionRows(regions);

describe("extractHdfcRawTransactionRows — against the real (redacted) HDFC Freedom statement", () => {
  it("produces exactly 19 logical transaction rows total (17 domestic + 2 international)", () => {
    expect(rawRows).toHaveLength(19);
    expect(rawRows.filter((r) => r.sectionType === "domestic")).toHaveLength(17);
    expect(rawRows.filter((r) => r.sectionType === "international")).toHaveLength(2);
  });

  it("reconstructs a single-line (non-wrapped) description exactly", () => {
    const row = rawRows.find((r) => r.anchorRow.items.some((i) => i.str.includes("22:16")));
    expect(row?.combinedDescription).toBe("ETREASURYKERALATHIRUVANAN");
    expect(row?.physicalRows).toHaveLength(1);
  });

  it("reconstructs a wrapped 2-line description into one coherent string, in correct reading order", () => {
    const row = rawRows.find((r) => r.combinedDescription.includes("2717151193919"));
    expect(row?.combinedDescription).toBe("IGST-VPS2717151193919-RATE 18.0 -32 (Ref# 09999999980619002660882)");
    expect(row?.physicalRows).toHaveLength(3);
  });

  it("reconstructs the second wrapped description on page 1 correctly too", () => {
    const row = rawRows.find((r) => r.combinedDescription.includes("2717151193921"));
    expect(row?.combinedDescription).toBe("IGST-VPS2717151193921-RATE 18.0 -32 (Ref# 09999999980619002660908)");
  });

  it("reconstructs a description split across separate x-positioned tokens on the same anchor line ('EMI' + merchant)", () => {
    const row = rawRows.find((r) => r.combinedDescription.includes("RONY GEORGEERNAKULAM"));
    expect(row?.combinedDescription).toBe("EMI RONY GEORGEERNAKULAM");
    expect(row?.physicalRows).toHaveLength(1);
  });

  it("reconstructs both wrapped international transactions correctly", () => {
    const intl = rawRows.filter((r) => r.sectionType === "international");
    expect(intl).toHaveLength(2);
    expect(intl[0]!.combinedDescription).toBe("IGST-VPS2718487072790-RATE 18.0 -32 (Ref# ST261840084000012820645)");
    expect(intl[0]!.physicalRows).toHaveLength(3);
    expect(intl[1]!.combinedDescription).toBe("IGST-VPS2719835090222-RATE 18.0 -32 (Ref# ST261980084000011767102)");
    expect(intl[1]!.physicalRows).toHaveLength(3);
  });

  it("never includes date, amount, currency-marker, or indicator glyph tokens inside combinedDescription", () => {
    const noise = [/^\d{2}\/\d{2}\/\d{4}/, /^-?[\d,]+\.\d{2}$/];
    for (const row of rawRows) {
      expect(row.combinedDescription).not.toMatch(/^C\s|\sC\s|\sC$/);
      expect(row.combinedDescription).not.toMatch(/^l\s|\sl$/);
      for (const pattern of noise) expect(pattern.test(row.combinedDescription)).toBe(false);
    }
  });

  it("keeps every logical row's physical rows on a single page (never merges across pages)", () => {
    for (const row of rawRows) {
      for (const physicalRow of row.physicalRows) expect(physicalRow.page).toBe(row.page);
    }
  });

  it("every logical row's physicalRows are in strictly descending y (top-to-bottom reading order)", () => {
    for (const row of rawRows) {
      for (let i = 1; i < row.physicalRows.length; i++) {
        expect(row.physicalRows[i]!.y).toBeLessThan(row.physicalRows[i - 1]!.y);
      }
    }
  });

  it("page 2 domestic rows (no wraps) each have exactly 1 physical row", () => {
    const page2Domestic = rawRows.filter((r) => r.page === 2 && r.sectionType === "domestic");
    expect(page2Domestic).toHaveLength(12);
    for (const row of page2Domestic) expect(row.physicalRows).toHaveLength(1);
  });

  it("keeps the credit-payment row's description intact despite the extra '+' credit indicator token on its anchor row", () => {
    const row = rawRows.find((r) => r.combinedDescription.startsWith("CREDIT CARD PAYMENT"));
    expect(row).toBeDefined();
    expect(row!.combinedDescription).toBe("CREDIT CARD PAYMENTNet Banking (Ref# 00000000000706019151184)");
  });

  it("every logical row's anchorRow is itself a member of its own physicalRows", () => {
    for (const row of rawRows) {
      expect(row.physicalRows).toContain(row.anchorRow);
    }
  });

  it("produces byte-for-byte deterministic output across repeated runs against the same fixture", () => {
    const again = extractHdfcRawTransactionRows(detectHdfcTransactionTableRegions(pages));
    expect(again).toEqual(rawRows);
  });

  it("returns an empty array for a region with zero anchor rows, without throwing (defensive regression)", () => {
    const emptyRegionResult = extractHdfcRawTransactionRows([{ page: 1, sectionType: "domestic", rows: [] }]);
    expect(emptyRegionResult).toHaveLength(0);
  });
});
