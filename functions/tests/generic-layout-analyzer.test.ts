/**
 * Universal layout analyzer — synthetic multi-layout fixtures with ground
 * truth, plus real pdf-lib → pdf.js round trips for two of them. Each
 * fixture reports detection recall, amount accuracy, direction accuracy and
 * false-positive (summary) rows; the aggregate is printed so the numbers can
 * be quoted honestly. These are SYNTHETIC layouts written by the same author
 * as the analyzer — they prove the mechanisms, not accuracy on real bank
 * statements.
 */

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractGenericStatement } from "../src/parsing/generic/generic-statement-extractor";
import { analyzeStatementLayout, hasUsableTextLayer, parseAmountToken, parseDatePrefix } from "../src/parsing/generic/layout-analyzer";
import { PdfjsDocumentProvider } from "../src/pdf/pdfjs-document-provider";
import type { PdfPageText } from "../src/pdf/pdf-document-provider";

interface Cell {
  s: string;
  x: number;
}
type Line = Cell[] | { gap: number };
interface Expected {
  date: string; // YYYY-MM-DD
  amount: number;
  direction: "debit" | "credit";
  key: string; // unique substring of the merchant description
}
interface Fixture {
  name: string;
  pages: Line[][];
  expected: Expected[];
  /** Strings that must never appear in any extracted description (summary rows). */
  forbidden?: string[];
  /** Direction on these rows is only a flagged default, so direction accuracy excludes them. */
  directionUnstated?: boolean;
}

const c = (s: string, x: number): Cell => ({ s, x });
const STEP = 12;

function toCells(pages: Line[][]): { s: string; x: number; y: number; page: number }[] {
  const out: { s: string; x: number; y: number; page: number }[] = [];
  pages.forEach((lines, p) => {
    let y = 760;
    for (const line of lines) {
      if ("gap" in line) {
        y -= line.gap;
        continue;
      }
      for (const cell of line) out.push({ s: cell.s, x: cell.x, y, page: p + 1 });
      y -= STEP;
    }
  });
  return out;
}

function toPageText(pages: Line[][]): PdfPageText[] {
  const cells = toCells(pages);
  return pages.map((_, p) => {
    const items = cells.filter((cell) => cell.page === p + 1).map((cell) => ({ str: cell.s, x: cell.x, y: cell.y, width: cell.s.length * 5, height: 8 }));
    return { pageNumber: p + 1, text: items.map((i) => i.str).join(" "), items };
  });
}

async function toPdfBytes(pages: Line[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const cells = toCells(pages);
  pages.forEach((_, p) => {
    const page = pdf.addPage([595, 842]);
    for (const cell of cells.filter((x) => x.page === p + 1)) page.drawText(cell.s, { x: cell.x, y: cell.y, size: 8, font });
  });
  return pdf.save({ useObjectStreams: false });
}

// Column x positions shared by the fixtures.
const DATE = 30, DESC = 100, DEBIT = 330, CREDIT = 400, AMT = 360, DRCR = 440;

// ───────────── Fixture A: Date | Description | Debit | Credit, 2 pages, repeated header, wrapped line, fees/GST/EMI/refund
const fixtureA: Fixture = {
  name: "A debit/credit columns, 2 pages, repeated header",
  pages: [
    [
      [c("Acme Bank Credit Card Statement", 30)],
      [c("Statement Date", 30), c("10/08/2026", 200)],
      [c("Total Amount Due", 30), c("12,345.00", 200)],
      [c("Minimum Amount Due", 30), c("617.00", 200)],
      [c("Credit Limit", 30), c("1,00,000.00", 200)],
      [c("Available Credit Limit", 30), c("87,655.00", 200)],
      { gap: 10 },
      [c("Date", DATE), c("Description", DESC), c("Debit", DEBIT), c("Credit", CREDIT)],
      [c("12/07/2026", DATE), c("AMAZON PAY INDIA", DESC), c("1,499.00", DEBIT), c("0.00", CREDIT)],
      [c("13/07/2026", DATE), c("SWIGGY ORDER 4412", DESC), c("2,35,500.50", DEBIT)],
      [c("14/07/2026", DATE), c("PAYMENT RECEIVED THANK YOU", DESC), c("0.00", DEBIT), c("5,000.00", CREDIT)],
      [c("15/07/2026", DATE), c("EMI PROCESSING FEE LAPTOP", DESC), c("499.00", DEBIT)],
      [c("15/07/2026", DATE), c("GST ON EMI FEE", DESC), c("89.82", DEBIT)],
      [c("16/07/2026", DATE), c("BIGBASKET GROCERIES AND", DESC), c("812.25", DEBIT)],
      [c("CONVENIENCE STORE BANGALORE", DESC)],
      [c("Continued on next page", DATE)],
    ],
    [
      [c("Page 2 of 2", 30)],
      [c("Date", DATE), c("Description", DESC), c("Debit", DEBIT), c("Credit", CREDIT)],
      [c("17/07/2026", DATE), c("REFUND MYNTRA RETURN", DESC), c("", DEBIT), c("1,299.00", CREDIT)],
      [c("18/07/2026", DATE), c("FINANCE CHARGES INTEREST", DESC), c("356.75", DEBIT)],
      [c("19/07/2026", DATE), c("UBER TRIP 998", DESC), c("245.00", DEBIT)],
      { gap: 8 },
      [c("Total Debits", DESC), c("5,901.50", DEBIT)],
      [c("Reward Points Summary", 30), c("120", 300)],
    ],
  ],
  expected: [
    { date: "2026-07-12", amount: 1499, direction: "debit", key: "AMAZON PAY" },
    { date: "2026-07-13", amount: 235500.5, direction: "debit", key: "SWIGGY" },
    { date: "2026-07-14", amount: 5000, direction: "credit", key: "PAYMENT RECEIVED" },
    { date: "2026-07-15", amount: 499, direction: "debit", key: "EMI PROCESSING" },
    { date: "2026-07-15", amount: 89.82, direction: "debit", key: "GST ON EMI" },
    { date: "2026-07-16", amount: 812.25, direction: "debit", key: "BIGBASKET" },
    { date: "2026-07-17", amount: 1299, direction: "credit", key: "REFUND MYNTRA" },
    { date: "2026-07-18", amount: 356.75, direction: "debit", key: "FINANCE CHARGES" },
    { date: "2026-07-19", amount: 245, direction: "debit", key: "UBER TRIP" },
  ],
  forbidden: ["Total Amount Due", "Minimum Amount", "Credit Limit", "Reward", "Total Debits", "Statement Date"],
};

// ───────────── Fixture B: Date | Merchant | Amount | DR/CR
const fixtureB: Fixture = {
  name: "B amount + DR/CR column",
  pages: [
    [
      [c("Date", DATE), c("Merchant", DESC), c("Amount", AMT), c("Dr/Cr", DRCR)],
      [c("01 Aug 2026", DATE), c("NETFLIX COM", DESC), c("649.00", AMT), c("DR", DRCR)],
      [c("02 Aug 2026", DATE), c("CASHBACK CREDIT AUG", DESC), c("150.00", AMT), c("CR", DRCR)],
      [c("03 Aug 2026", DATE), c("IRCTC TICKET", DESC), c("1,845.30", AMT), c("DR", DRCR)],
      [c("04 Aug 2026", DATE), c("REVERSAL IRCTC", DESC), c("1,845.30", AMT), c("CR", DRCR)],
    ],
  ],
  expected: [
    { date: "2026-08-01", amount: 649, direction: "debit", key: "NETFLIX" },
    { date: "2026-08-02", amount: 150, direction: "credit", key: "CASHBACK" },
    { date: "2026-08-03", amount: 1845.3, direction: "debit", key: "IRCTC TICKET" },
    { date: "2026-08-04", amount: 1845.3, direction: "credit", key: "REVERSAL" },
  ],
};

// ───────────── Fixture C: Date | Transaction Details | Amount (Rs.) with "Cr" suffix in the amount token
const fixtureC: Fixture = {
  name: "C amount with Cr suffix",
  pages: [
    [
      [c("Txn Date", DATE), c("Transaction Details", DESC), c("Amount (Rs.)", AMT)],
      [c("05-Sep-2026", DATE), c("ZOMATO ONLINE", DESC), c("₹ 420.00", AMT)],
      [c("06-Sep-2026", DATE), c("PAYMENT RECEIVED", DESC), c("10,000.00 Cr", AMT)],
      [c("07-Sep-26", DATE), c("FUEL SURCHARGE WAIVER", DESC), c("15.50 CR", AMT)],
    ],
  ],
  expected: [
    { date: "2026-09-05", amount: 420, direction: "debit", key: "ZOMATO" },
    { date: "2026-09-06", amount: 10000, direction: "credit", key: "PAYMENT RECEIVED" },
    { date: "2026-09-07", amount: 15.5, direction: "credit", key: "FUEL SURCHARGE" },
  ],
  directionUnstated: true, // ZOMATO has no Dr marker: positive-by-default, flagged
};

// ───────────── Fixture D: ambiguous — single Amount column, no direction information at all
const fixtureD: Fixture = {
  name: "D ambiguous direction (flagged, never certain)",
  pages: [
    [
      [c("Date", DATE), c("Description", DESC), c("Amount", AMT)],
      [c("10/10/2026", DATE), c("STORE ONE", DESC), c("100.00", AMT)],
      [c("11/10/2026", DATE), c("STORE TWO", DESC), c("200.00", AMT)],
      [c("12/10/2026", DATE), c("STORE THREE", DESC), c("300.00", AMT)],
    ],
  ],
  expected: [
    { date: "2026-10-10", amount: 100, direction: "debit", key: "STORE ONE" },
    { date: "2026-10-11", amount: 200, direction: "debit", key: "STORE TWO" },
    { date: "2026-10-12", amount: 300, direction: "debit", key: "STORE THREE" },
  ],
  directionUnstated: true,
};

// ───────────── Fixture E: headerless token-shape layout, day > 12 proves day-first, prose with a stray number
const fixtureE: Fixture = {
  name: "E headerless token-shape",
  pages: [
    [
      [c("Welcome to Some Unknown Bank card statement", 10)],
      [c("Your reward points balance is 1,200.00", 10)],
      [c("19/07/2026", 10), c("Amazon Purchase", 60), c("1,234.56", 300), c("DR", 340)],
      [c("20/07/2026", 10), c("Payment Received Thank You", 60), c("500.00", 300), c("CR", 340)],
      [c("21/07/2026", 10), c("Grocery Store", 60), c("89.99", 300), c("DR", 340)],
    ],
  ],
  expected: [
    { date: "2026-07-19", amount: 1234.56, direction: "debit", key: "Amazon" },
    { date: "2026-07-20", amount: 500, direction: "credit", key: "Payment Received" },
    { date: "2026-07-21", amount: 89.99, direction: "debit", key: "Grocery" },
  ],
  forbidden: ["reward points"],
};

// ───────────── Fixture F: summary-only page — zero transactions expected, several dated/amount-bearing summary lines
const fixtureF: Fixture = {
  name: "F summary-only (no transactions)",
  pages: [
    [
      [c("Statement Summary", 30)],
      [c("Statement Date", 30), c("10/08/2026", 200)],
      [c("Payment Due Date", 30), c("30/08/2026", 200)],
      [c("Total Amount Due", 30), c("12,345.00", 200)],
      [c("Minimum Amount Due", 30), c("617.00", 200)],
      [c("Opening Balance", 30), c("2,000.00", 200)],
      [c("Closing Balance", 30), c("12,345.00", 200)],
      [c("Credit Limit", 30), c("1,00,000.00", 200)],
      [c("Available Credit Limit", 30), c("87,655.00", 200)],
    ],
  ],
  expected: [],
};

const FIXTURES = [fixtureA, fixtureB, fixtureC, fixtureD, fixtureE, fixtureF];

interface Score {
  expected: number;
  detected: number;
  amountCorrect: number;
  directionCorrect: number;
  directionScored: number;
  falsePositives: number;
  forbiddenHits: number;
  ms: number;
}

function score(fixture: Fixture, pages: PdfPageText[]): Score {
  const started = performance.now();
  const result = extractGenericStatement(pages, {});
  const ms = performance.now() - started;
  const rows = result.transactions;
  let detected = 0;
  let amountCorrect = 0;
  let directionCorrect = 0;
  let directionScored = 0;
  const matched = new Set<number>();
  for (const exp of fixture.expected) {
    const idx = rows.findIndex(
      (r, i) => !matched.has(i) && r.merchantRaw.value.includes(exp.key) && r.date.value?.toISOString().slice(0, 10) === exp.date,
    );
    if (idx === -1) continue;
    matched.add(idx);
    detected++;
    const row = rows[idx]!;
    if (row.amount.value === exp.amount) amountCorrect++;
    if (!fixture.directionUnstated || row.warnings.every((w) => w.code !== "direction_not_stated")) {
      directionScored++;
      if (row.direction.value === exp.direction) directionCorrect++;
    }
  }
  const forbiddenHits = rows.filter((r) => (fixture.forbidden ?? []).some((f) => r.originalRawText.toLowerCase().includes(f.toLowerCase()))).length;
  return { expected: fixture.expected.length, detected, amountCorrect, directionCorrect, directionScored, falsePositives: rows.length - matched.size, forbiddenHits, ms };
}

describe("layout analyzer — primitives", () => {
  it("parses Indian amounts, signs, parentheses, Dr/Cr suffix and currency symbols", () => {
    expect(parseAmountToken("1,23,456.78")?.value).toBe(123456.78);
    expect(parseAmountToken("₹ 500")?.currency).toBe("INR");
    expect(parseAmountToken("(200.00)")?.negative).toBe(true);
    expect(parseAmountToken("-45.50")?.negative).toBe(true);
    expect(parseAmountToken("99.00 CR")?.suffixMarker).toBe("CR");
    expect(parseAmountToken("Rs. 1,234.50")?.value).toBe(1234.5);
    expect(parseAmountToken("1,2345.00")).toBeNull();
    expect(parseAmountToken("AMAZON")).toBeNull();
    expect(parseAmountToken("12/07/2026")).toBeNull();
  });

  it("parses common date formats and rejects impossible dates", () => {
    const iso = (s: string) => parseDatePrefix(s)?.date.toISOString().slice(0, 10);
    expect(iso("17 Jul 2026")).toBe("2026-07-17");
    expect(iso("17-Jul-26")).toBe("2026-07-17");
    expect(iso("17/07/2026")).toBe("2026-07-17");
    expect(iso("17.07.26")).toBe("2026-07-17");
    expect(iso("2026-07-17")).toBe("2026-07-17");
    expect(iso("17 Jul 2026 14:35:10")).toBe("2026-07-17");
    expect(iso("31/02/2026")).toBeUndefined();
    expect(iso("45/13/2026")).toBeUndefined();
    expect(iso("Statement Date")).toBeUndefined();
  });

  it("reads month-first dates only when the document proves it (a day > 12 in the second slot)", () => {
    const items = ["07/25/2026", "08/02/2026", "08/03/2026"].map((d, i) => [c(d, 30), c(`SHOP ${i}`, 100), c(`${10 + i}.00`, 360), c("DR", 440)]);
    const pages = toPageText([items]);
    const dates = analyzeStatementLayout(pages).transactions.map((t) => t.date.toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-07-25", "2026-08-02", "2026-08-03"]);
  });

  it("flags a numerically ambiguous day/month order instead of silently trusting it", () => {
    const pages = toPageText([[...[1, 2, 3].map((n) => [c(`0${n}/04/2026`, 30), c(`SHOP ${n}`, 100), c("10.00", 360), c("DR", 440)])]]);
    const rows = extractGenericStatement(pages, {}).transactions;
    expect(rows.every((r) => r.warnings.some((w) => w.code === "date_order_assumed"))).toBe(true);
  });

  it("detects a missing text layer", () => {
    expect(hasUsableTextLayer([{ pageNumber: 1, text: "", items: [] }])).toBe(false);
    expect(hasUsableTextLayer(toPageText(fixtureA.pages))).toBe(true);
  });
});

describe("layout analyzer — fixtures", () => {
  const totals: Score = { expected: 0, detected: 0, amountCorrect: 0, directionCorrect: 0, directionScored: 0, falsePositives: 0, forbiddenHits: 0, ms: 0 };

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: detects every row, correct amounts/direction, no summary rows`, () => {
      const s = score(fixture, toPageText(fixture.pages));
      for (const key of Object.keys(totals) as (keyof Score)[]) totals[key] += s[key];
      expect(s.detected).toBe(s.expected);
      expect(s.amountCorrect).toBe(s.expected);
      expect(s.directionCorrect).toBe(s.directionScored);
      expect(s.falsePositives).toBe(0);
      expect(s.forbiddenHits).toBe(0);
    });
  }

  it("wrapped description lines are merged and page furniture is not", () => {
    const rows = extractGenericStatement(toPageText(fixtureA.pages), {}).transactions;
    const bb = rows.find((r) => r.merchantRaw.value.includes("BIGBASKET"))!;
    expect(bb.merchantRaw.value).toBe("BIGBASKET GROCERIES AND CONVENIENCE STORE BANGALORE");
    expect(bb.merchantRaw.value).not.toMatch(/continued/i);
    expect(rows.some((r) => /page 2 of 2/i.test(r.originalRawText))).toBe(false);
  });

  it("table rows are never above the generic confidence ceiling and always need review", () => {
    for (const fixture of FIXTURES) {
      for (const row of extractGenericStatement(toPageText(fixture.pages), {}).transactions) {
        expect(row.needsReview).toBe(true);
        expect(row.confidence).toBeLessThanOrEqual(0.85);
        expect(row.date.page).toBe(row.sourcePage);
        expect(row.amount.boundingBox).toBeDefined();
      }
    }
  });

  it("unstated direction is flagged with low confidence, never presented as certain", () => {
    const rows = extractGenericStatement(toPageText(fixtureD.pages), {}).transactions;
    for (const row of rows) {
      expect(row.warnings.some((w) => w.code === "direction_not_stated")).toBe(true);
      expect(row.direction.confidence).toBeLessThanOrEqual(0.2);
      expect(row.confidence).toBeLessThanOrEqual(0.2);
    }
  });

  it("a row with BOTH debit and credit filled is flagged, not silently resolved", () => {
    const pages = toPageText([
      [
        [c("Date", DATE), c("Description", DESC), c("Debit", DEBIT), c("Credit", CREDIT)],
        [c("01/07/2026", DATE), c("ODD ROW", DESC), c("10.00", DEBIT), c("20.00", CREDIT)],
        [c("02/07/2026", DATE), c("OK ONE", DESC), c("30.00", DEBIT)],
        [c("03/07/2026", DATE), c("OK TWO", DESC), c("40.00", DEBIT)],
      ],
    ]);
    const rows = extractGenericStatement(pages, {}).transactions;
    const odd = rows.find((r) => r.merchantRaw.value === "ODD ROW")!;
    expect(odd.warnings.some((w) => w.code === "multiple_amounts_in_row")).toBe(true);
    expect(odd.confidence).toBeLessThanOrEqual(0.1);
  });

  it("a negative amount reads as a credit but is flagged as sign-inferred", () => {
    const pages = toPageText([
      [
        [c("Date", DATE), c("Description", DESC), c("Amount", AMT)],
        [c("01/07/2026", DATE), c("SHOP A", DESC), c("10.00", AMT)],
        [c("02/07/2026", DATE), c("RETURN B", DESC), c("-25.00", AMT)],
        [c("03/07/2026", DATE), c("SHOP C", DESC), c("40.00", AMT)],
      ],
    ]);
    const ret = extractGenericStatement(pages, {}).transactions.find((r) => r.merchantRaw.value === "RETURN B")!;
    expect(ret.direction.value).toBe("credit");
    expect(ret.amount.value).toBe(25);
    expect(ret.warnings.some((w) => w.code === "direction_from_sign")).toBe(true);
  });

  it("OCR-style scanned input (no items) yields no transactions and no match", () => {
    const pages: PdfPageText[] = [{ pageNumber: 1, text: "", items: [] }];
    expect(extractGenericStatement(pages, {}).transactions).toHaveLength(0);
  });

  it("processes a 2,000-row statement quickly", () => {
    const lines: Line[] = [[c("Date", DATE), c("Description", DESC), c("Debit", DEBIT), c("Credit", CREDIT)]];
    for (let i = 0; i < 2000; i++) lines.push([c("12/07/2026", DATE), c(`MERCHANT ${i}`, DESC), c("10.00", DEBIT)]);
    // Spread across pages of 50 rows.
    const pages: Line[][] = [];
    for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
    const started = performance.now();
    const rows = extractGenericStatement(toPageText(pages), {}).transactions;
    const ms = performance.now() - started;
    expect(rows).toHaveLength(2000);
    console.log(`[perf] 2000 rows analysed in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(5000);
  });

  it("reports aggregate metrics", () => {
    // Runs after the per-fixture tests (same describe, sequential), so `totals` is complete.
    const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
    console.log(
      `[metrics] fixtures=${FIXTURES.length} expectedRows=${totals.expected} recall=${pct(totals.detected, totals.expected)} ` +
        `amountAccuracy=${pct(totals.amountCorrect, totals.detected)} directionAccuracy(scored)=${pct(totals.directionCorrect, totals.directionScored)} ` +
        `falsePositives=${totals.falsePositives} summaryRowLeaks=${totals.forbiddenHits} analyzeMs=${totals.ms.toFixed(1)}`,
    );
    expect(totals.expected).toBeGreaterThan(0);
  });
});

describe("layout analyzer — real PDF round trip (pdf-lib → pdf.js text positions)", () => {
  for (const fixture of [fixtureA, fixtureB]) {
    it(`${fixture.name}: real PDF bytes extract the same rows`, async () => {
      const bytes = await toPdfBytes(fixture.pages);
      const handle = await new PdfjsDocumentProvider().open(bytes);
      const pages = await handle.getAllPageText();
      await handle.destroy();
      const s = score(fixture, pages);
      expect(s.detected).toBe(s.expected);
      expect(s.amountCorrect).toBe(s.expected);
      expect(s.directionCorrect).toBe(s.directionScored);
      expect(s.falsePositives).toBe(0);
      expect(s.forbiddenHits).toBe(0);
    });
  }

  it("a PDF with only drawn graphics and no text reports no usable text layer", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 300]).drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
    const handle = await new PdfjsDocumentProvider().open(await pdf.save({ useObjectStreams: false }));
    const pages = await handle.getAllPageText();
    await handle.destroy();
    expect(hasUsableTextLayer(pages)).toBe(false);
  });
});
