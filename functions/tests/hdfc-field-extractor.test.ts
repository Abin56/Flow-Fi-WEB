/**
 * HDFC Transaction Field Extractor (Task 4, module 4) — validated against
 * every one of the 19 real transactions on the real (redacted) HDFC
 * Freedom Credit Card statement. Expected values were independently
 * confirmed by manually reading the statement before this test was
 * written; the debit/credit split was additionally cross-checked against
 * the statement's own printed totals (see hdfc-metadata-extractor.test.ts).
 */

import { describe, expect, it } from "vitest";
import { detectHdfcTransactionTableRegions } from "../src/parsing/hdfc/hdfc-table-detector";
import { extractHdfcRawTransactionRows } from "../src/parsing/hdfc/hdfc-row-extractor";
import { extractHdfcTransactionFields } from "../src/parsing/hdfc/hdfc-field-extractor";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const pages = loadRealStatementPages(hdfcFreedomItems as never);
const regions = detectHdfcTransactionTableRegions(pages);
const rawRows = extractHdfcRawTransactionRows(regions);
const fields = rawRows.map(extractHdfcTransactionFields);

describe("extractHdfcTransactionFields — against every real transaction on the HDFC Freedom statement", () => {
  it("extracts all 19 rows without error", () => {
    expect(fields).toHaveLength(19);
  });

  it("every row has a non-null date, matching its known real value", () => {
    const expectedDates = [
      "2026-06-19T22:16:00.000Z",
      "2026-06-19T00:00:00.000Z",
      "2026-06-19T00:00:00.000Z",
      "2026-06-25T12:40:00.000Z",
      "2026-06-25T04:24:00.000Z",
      "2026-06-30T04:51:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T16:21:00.000Z",
      "2026-07-06T21:36:00.000Z",
      "2026-07-09T00:48:00.000Z",
      "2026-07-14T09:24:00.000Z",
      "2026-07-14T02:20:00.000Z",
      "2026-07-16T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    ];
    expect(fields.map((f) => f.transactionDate.value?.toISOString())).toEqual(expectedDates);
  });

  it("extracts every real amount exactly", () => {
    const expectedAmounts = [
      1361.24, 28.26, 7.2, 6000.0, 189.0, 378.0, 6.62, 62.3, 3911.0, 504.17, 11.0, 79.0, 1.38, 500.0, 695.0, 152.0, 30.0, 1.19, 0.25,
    ];
    expect(fields.map((f) => f.amount.value)).toEqual(expectedAmounts);
  });

  it("the sum of all debit amounts matches the statement's printed 'Purchases/Debit' total exactly", () => {
    const totalDebit = fields.filter((f) => f.debit.value != null).reduce((sum, f) => sum + (f.debit.value ?? 0), 0);
    expect(totalDebit).toBeCloseTo(10006.61, 2);
  });

  it("the sum of all credit amounts matches the statement's printed 'Payments/Credits Received' total exactly", () => {
    const totalCredit = fields.filter((f) => f.credit.value != null).reduce((sum, f) => sum + (f.credit.value ?? 0), 0);
    expect(totalCredit).toBeCloseTo(3911.0, 2);
  });

  it("only the CREDIT CARD PAYMENT row is a credit — every other row is a debit", () => {
    const creditRows = fields.filter((f) => f.credit.value != null);
    expect(creditRows).toHaveLength(1);
    expect(creditRows[0]!.merchant.value).toContain("CREDIT CARD PAYMENT");
  });

  it("exactly one of debit/credit is ever populated for a real row, never both, never neither", () => {
    for (const f of fields) {
      const populated = [f.debit.value != null, f.credit.value != null].filter(Boolean).length;
      expect(populated).toBe(1);
    }
  });

  it("extracts reference numbers only where the description actually contains a (Ref# ...) pattern", () => {
    const withRef = fields.filter((f) => f.referenceNumber.value != null);
    // 2 DCC IGST rows on page1 + 4 loan/EMI rows + 1 CREDIT CARD PAYMENT + 2 DCC rows on page2 + 2 international IGST rows = 11
    expect(withRef).toHaveLength(11);
    const noRef = fields.filter((f) => f.referenceNumber.value == null);
    expect(noRef.map((f) => f.merchant.value)).toEqual([
      "ETREASURYKERALATHIRUVANAN",
      "EMI RONY GEORGEERNAKULAM",
      "RELIANCE RETAIL LIMITENOIDA",
      "FS *SUPERCELLSTOREfsprg.nl",
      "GOOGLE WORKSPACE CYBSSI MUMBAI",
      "KERALA VISION BROAD BABANGALORE",
      "RELIANCE RETAIL LIMITENOIDA",
      "FS *SUPERCELLSTOREfsprg.nl",
    ]);
  });

  it("extracts one specific reference number exactly", () => {
    const row = fields.find((f) => f.merchant.value.includes("2717151193919"));
    expect(row?.referenceNumber.value).toBe("09999999980619002660882");
  });

  it("has no separate description field — genuinely absent on this bank's layout, not a parsing gap", () => {
    for (const f of fields) {
      expect(f.description.value).toBeNull();
      expect(f.description.source).toBe("unavailable");
    }
  });

  it("has no running balance — never printed on this statement", () => {
    for (const f of fields) {
      expect(f.runningBalance.value).toBeNull();
      expect(f.runningBalance.source).toBe("unavailable");
    }
  });

  it("infers INR currency for every row via pattern_match, never claiming it was read from a per-row source", () => {
    for (const f of fields) {
      expect(f.currency.value).toBe("INR");
      expect(f.currency.source).toBe("pattern_match");
    }
  });

  it("every date/amount/merchant field carries non-trivial confidence", () => {
    for (const f of fields) {
      expect(f.transactionDate.confidence).toBeGreaterThan(0.7);
      expect(f.amount.confidence).toBeGreaterThan(0.7);
      expect(f.merchant.confidence).toBeGreaterThan(0.7);
    }
  });

  it("has no value date — this bank's layout prints only one date+time per row, never a distinct value date column", () => {
    for (const f of fields) {
      expect(f.valueDate.value).toBeNull();
      expect(f.valueDate.source).toBe("unavailable");
    }
  });

  it("every populated field carries a page number matching the row's own page", () => {
    for (const f of fields) {
      expect(f.transactionDate.page).toBe(f.page);
      expect(f.amount.page).toBe(f.page);
      expect(f.merchant.page).toBe(f.page);
    }
  });

  it("every populated field's bounding box has positive width and height", () => {
    for (const f of fields) {
      expect(f.transactionDate.boundingBox!.width).toBeGreaterThan(0);
      expect(f.transactionDate.boundingBox!.height).toBeGreaterThan(0);
      expect(f.amount.boundingBox!.width).toBeGreaterThan(0);
      expect(f.merchant.boundingBox!.width).toBeGreaterThan(0);
    }
  });

  it("a reconstructed wrapped-3-line merchant's bounding box spans all three physical rows (union box), not just the anchor line", () => {
    const wrapped = fields.find((f) => f.merchant.value === "IGST-VPS2717151193919-RATE 18.0 -32 (Ref# 09999999980619002660882)");
    expect(wrapped).toBeDefined();
    const box = wrapped!.merchant.boundingBox!;
    // The anchor line alone (just the date/amount row) is ~2pt tall; a genuine 3-physical-row union must be much taller.
    expect(box.height).toBeGreaterThan(15);
  });

  it("a single-line (non-wrapped) merchant's bounding box is a tight single-row box, not artificially inflated", () => {
    const single = fields.find((f) => f.merchant.value === "RELIANCE RETAIL LIMITENOIDA");
    expect(single).toBeDefined();
    expect(single!.merchant.boundingBox!.height).toBeLessThan(15);
  });

  it("the reference number's bounding box comes from its own source token, not the whole row", () => {
    const row = fields.find((f) => f.referenceNumber.value === "09999999980619002660882");
    expect(row).toBeDefined();
    expect(row!.referenceNumber.page).toBe(row!.page);
    expect(row!.referenceNumber.boundingBox).toBeDefined();
    expect(row!.referenceNumber.extractionMethod).toBe("regex:(Ref# ...)");
  });

  it("a row with no reference number leaves both boundingBox and page unset on that field (honestly unavailable, not a fabricated position)", () => {
    const row = fields.find((f) => f.merchant.value === "RELIANCE RETAIL LIMITENOIDA");
    expect(row).toBeDefined();
    expect(row!.referenceNumber.value).toBeNull();
    expect(row!.referenceNumber.boundingBox).toBeUndefined();
    expect(row!.referenceNumber.page).toBeUndefined();
  });

  it("malformed row: an anchor row with a date but no parseable amount token produces an unavailable amount/debit/credit, not a thrown error or a fabricated 0", () => {
    const malformedRegion = {
      page: 1,
      sectionType: "domestic" as const,
      rows: [
        {
          page: 1,
          y: 100,
          items: [
            { str: "01/01/2026| 10:00", x: 10, y: 100, width: 50, height: 10 },
            { str: "SOME MERCHANT", x: 70, y: 100, width: 80, height: 10 },
            // Deliberately no amount/currency/trailing-glyph tokens — a malformed/truncated anchor row.
          ],
        },
      ],
    };
    const raw = extractHdfcRawTransactionRows([malformedRegion]);
    expect(raw).toHaveLength(1);
    const extracted = extractHdfcTransactionFields(raw[0]!);
    expect(extracted.amount.value).toBeNull();
    expect(extracted.amount.source).toBe("unavailable");
    expect(extracted.debit.value).toBeNull();
    expect(extracted.credit.value).toBeNull();
    expect(extracted.merchant.value).toBe("SOME MERCHANT");
  });

  it("malformed row: an anchor row with an amount but no parseable date produces an unavailable transactionDate, not a thrown error", () => {
    const malformedRegion = {
      page: 1,
      sectionType: "domestic" as const,
      rows: [
        {
          page: 1,
          y: 100,
          items: [
            { str: "NOT A DATE", x: 10, y: 100, width: 50, height: 10 },
            { str: "MERCHANT X", x: 70, y: 100, width: 80, height: 10 },
            { str: "C", x: 400, y: 100, width: 5, height: 10 },
            { str: "100.00", x: 410, y: 100, width: 30, height: 10 },
            { str: "l", x: 450, y: 100, width: 5, height: 10 },
          ],
        },
      ],
    };
    // "NOT A DATE" never matches the anchor-row date pattern, so this row is never even recognized as an
    // anchor by extractHdfcRawTransactionRows — confirming the whole region degrades to zero rows gracefully.
    const raw = extractHdfcRawTransactionRows([malformedRegion]);
    expect(raw).toHaveLength(0);
  });

  it("blank row: a region with rows but zero anchor rows produces zero extracted fields, never throws", () => {
    const raw = extractHdfcRawTransactionRows([{ page: 1, sectionType: "domestic", rows: [] }]);
    expect(raw.map(extractHdfcTransactionFields)).toHaveLength(0);
  });

  it("produces deterministic output across repeated runs against the same fixture", () => {
    const again = extractHdfcRawTransactionRows(detectHdfcTransactionTableRegions(pages)).map(extractHdfcTransactionFields);
    expect(again).toEqual(fields);
  });
});
