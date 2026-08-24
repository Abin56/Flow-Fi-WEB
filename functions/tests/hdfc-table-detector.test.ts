/**
 * HDFC Transaction Table Detector (Task 4, module 2) — validated against
 * the real (redacted) HDFC Freedom Credit Card statement. Expected row
 * counts were independently confirmed by manually reading the statement's
 * text extraction before this test was written (see the Task 4 completion
 * report for the full transaction-by-transaction breakdown and the
 * balance-arithmetic cross-check).
 */

import { describe, expect, it } from "vitest";
import { detectHdfcTransactionTableRegions } from "../src/parsing/hdfc/hdfc-table-detector";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const pages = loadRealStatementPages(hdfcFreedomItems as never);

describe("detectHdfcTransactionTableRegions — against the real (redacted) HDFC Freedom statement", () => {
  const regions = detectHdfcTransactionTableRegions(pages);

  it("finds exactly 3 regions: domestic on page 1, domestic continuation on page 2, international on page 2", () => {
    expect(regions).toHaveLength(3);
    expect(regions.map((r) => ({ page: r.page, sectionType: r.sectionType }))).toEqual([
      { page: 1, sectionType: "domestic" },
      { page: 2, sectionType: "domestic" },
      { page: 2, sectionType: "international" },
    ]);
  });

  // Module 2 hands back PHYSICAL rows within the table region — it does not
  // merge a wrapped description's continuation lines into one logical
  // transaction (that's Module 3's explicit, separate responsibility).
  // A wrapped 2-line description real HDFC statement produces 3 physical
  // rows: continuation line 1, the date+amount "anchor" line (vertically
  // centered between the two wrapped lines), then continuation line 2.

  it("page 1 domestic region has 9 physical rows (5 logical transactions: 3 single-line + 2 wrapped-3-line)", () => {
    expect(regions[0]!.rows).toHaveLength(9);
  });

  it("page 2 domestic region has 12 physical rows (12 logical transactions, none wrapped)", () => {
    expect(regions[1]!.rows).toHaveLength(12);
  });

  it("page 2 international region has 6 physical rows (2 logical transactions, both wrapped-3-line)", () => {
    expect(regions[2]!.rows).toHaveLength(6);
  });

  it("every region's anchor rows (the ones carrying a date) match the real logical transaction count", () => {
    const dateAnchorCount = (rows: typeof regions[number]["rows"]) =>
      rows.filter((row) => row.items.some((item) => /^\d{2}\/\d{2}\/\d{4}\s*\|?\s*\d{2}:\d{2}$/.test(item.str.trim()))).length;
    expect(dateAnchorCount(regions[0]!.rows)).toBe(5);
    expect(dateAnchorCount(regions[1]!.rows)).toBe(12);
    expect(dateAnchorCount(regions[2]!.rows)).toBe(2);
  });

  it("never includes the cardholder sub-header row ('[CKYC ID ...]') as a transaction row", () => {
    for (const region of regions) {
      for (const row of region.rows) {
        expect(row.items.some((item) => /\[CKYC ID/.test(item.str))).toBe(false);
      }
    }
  });

  it("never includes the page-number footer row as a transaction row", () => {
    for (const region of regions) {
      for (const row of region.rows) {
        expect(row.items.some((item) => /^Page \d+ of \d+$/.test(item.str.trim()))).toBe(false);
      }
    }
  });

  it("never leaks unrelated tables (GST Summary, Loan Summary, Rewards Program) into a region", () => {
    const leakPatterns = [/GST Summary/, /Loan Summary/, /Rewards Program Points Summary/, /Eligible for/];
    for (const region of regions) {
      for (const row of region.rows) {
        for (const item of row.items) {
          for (const pattern of leakPatterns) expect(pattern.test(item.str)).toBe(false);
        }
      }
    }
  });

  it("every row's y strictly decreases within a region (rows are in top-to-bottom reading order)", () => {
    for (const region of regions) {
      for (let i = 1; i < region.rows.length; i++) {
        expect(region.rows[i]!.y).toBeLessThan(region.rows[i - 1]!.y);
      }
    }
  });

  it("finds no regions on pages without a real transaction table (pages 3 and 4)", () => {
    expect(regions.some((r) => r.page === 3 || r.page === 4)).toBe(false);
  });
});
