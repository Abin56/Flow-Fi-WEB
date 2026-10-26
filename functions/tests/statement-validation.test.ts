/**
 * Local real-statement validation helpers: summary, comparison against figures read off a PDF, and redaction.
 * Synthetic data only. Also pins the "never imports" property of the CLI by asserting the script and helper module
 * contain no Firebase/Firestore write path.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareWithExpected, findResidualIdentifiers, redactionPreservesParse, redactPages, summarizeExtraction } from "../src/tools/statement-validation";
import type { PdfPageText } from "../src/pdf/pdf-document-provider";

function pages(rows: { date: string; desc: string; debit?: string; credit?: string; extra?: string }[]): PdfPageText[] {
  const items: PdfPageText["items"] = [];
  const put = (str: string, x: number, y: number) => items.push({ str, x, y, width: str.length * 5, height: 8 });
  put("PRIVATE NAME SURNAME", 30, 780);
  put("12 Some Street, Bengaluru 560001", 30, 770);
  put("priya.k@example.com", 30, 760);
  put("Card No: 4111 XXXX XXXX 1234", 30, 750);
  put("5500123456789012", 30, 740);
  put("Date", 30, 700);
  put("Description", 100, 700);
  put("Debit", 330, 700);
  put("Credit", 400, 700);
  rows.forEach((r, i) => {
    const y = 688 - i * 12;
    put(r.date, 30, y);
    put(r.desc, 100, y);
    if (r.debit) put(r.debit, 330, y);
    if (r.credit) put(r.credit, 400, y);
  });
  return [{ pageNumber: 1, text: "", items }];
}

const SAMPLE = pages([
  { date: "12/07/2026", desc: "AMAZON PAY INDIA", debit: "1,499.00" },
  { date: "13/07/2026", desc: "SWIGGY ORDER 4412", debit: "640.00" },
  { date: "14/07/2026", desc: "PAYMENT RECEIVED THANK YOU", credit: "5,000.00" },
  { date: "15/07/2026", desc: "UBER TRIP 998", debit: "245.00" },
]);

describe("summarizeExtraction", () => {
  it("counts rows, totals and direction basis without exposing merchant text", () => {
    const s = summarizeExtraction(SAMPLE);
    expect(s.extractor).toBe("generic");
    expect(s.rowCount).toBe(4);
    expect(s.debitCount).toBe(3);
    expect(s.creditCount).toBe(1);
    expect(s.totalDebits).toBe(2384);
    expect(s.totalCredits).toBe(5000);
    expect(s.directionBasisCounts.column).toBe(4);
    expect(JSON.stringify(s)).not.toMatch(/AMAZON|SWIGGY|PRIVATE NAME/);
  });

  it("reports a scanned PDF as no usable text layer, with zero rows", () => {
    const s = summarizeExtraction([{ pageNumber: 1, text: "", items: [] }]);
    expect(s.usableTextLayer).toBe(false);
    expect(s.rowCount).toBe(0);
  });

  it("surfaces ambiguous rows as flags", () => {
    const ambiguous = pages([1, 2, 3].map((n) => ({ date: `1${n}/07/2026`, desc: `SHOP ${n}`, debit: "10.00", credit: "20.00" })));
    const s = summarizeExtraction(ambiguous);
    expect(s.flaggedRowCount).toBe(3);
    expect(s.flagCounts.multiple_amounts_in_row).toBe(3);
  });
});

describe("compareWithExpected", () => {
  const expectedRows = [
    { date: "2026-07-12", amount: 1499, direction: "debit" as const },
    { date: "2026-07-13", amount: 640, direction: "debit" as const },
    { date: "2026-07-14", amount: 5000, direction: "credit" as const },
    { date: "2026-07-15", amount: 245, direction: "debit" as const },
  ];

  it("passes when rows, count and printed totals all agree", () => {
    const r = compareWithExpected(summarizeExtraction(SAMPLE), { rows: expectedRows, rowCount: 4, totalDebits: 2384, totalCredits: 5000 });
    expect(r.pass).toBe(true);
  });

  it("reports a missing row, an extra row and a direction mismatch separately — never silently", () => {
    const r = compareWithExpected(summarizeExtraction(SAMPLE), {
      rows: [
        expectedRows[0]!,
        { date: "2026-07-13", amount: 640, direction: "credit" }, // wrong direction expected
        expectedRows[2]!,
        { date: "2026-07-20", amount: 99, direction: "debit" }, // not extracted
      ],
      totalDebits: 2000,
    });
    expect(r.pass).toBe(false);
    expect(r.missing).toEqual([{ date: "2026-07-20", amount: 99, direction: "debit" }]);
    expect(r.extra.map((e) => e.amount)).toEqual([245]);
    expect(r.directionMismatches).toHaveLength(1);
    expect(r.problems.join(" ")).toMatch(/total debits/);
  });

  it("pairs a same-day credit and debit of equal amount correctly", () => {
    const p = pages([
      { date: "10/07/2026", desc: "PURCHASE A", debit: "100.00" },
      { date: "10/07/2026", desc: "REFUND A", credit: "100.00" },
      { date: "11/07/2026", desc: "PURCHASE B", debit: "50.00" },
    ]);
    const r = compareWithExpected(summarizeExtraction(p), {
      rows: [
        { date: "2026-07-10", amount: 100, direction: "credit" },
        { date: "2026-07-10", amount: 100, direction: "debit" },
        { date: "2026-07-11", amount: 50, direction: "debit" },
      ],
    });
    expect(r.pass).toBe(true);
  });
});

describe("redaction", () => {
  const red = redactPages(SAMPLE);
  const text = JSON.stringify(red);

  it("removes names, addresses, emails, card numbers and merchants, keeping dates, amounts and headers", () => {
    for (const secret of ["PRIVATE NAME", "Some Street", "priya.k@example.com", "4111", "5500123456789012", "AMAZON", "SWIGGY", "UBER"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("12/07/2026");
    expect(text).toContain("1,499.00");
    expect(text).toContain('"Debit"');
    expect(text).toContain("PAYMENT RECEIVED THANK YOU"); // structural wording, kept so direction hints still parse
  });

  it("keeps every item's exact geometry", () => {
    red[0]!.items.forEach((item, i) => {
      const o = SAMPLE[0]!.items[i]!;
      expect([item.x, item.y, item.width, item.height]).toEqual([o.x, o.y, o.width, o.height]);
    });
  });

  it("parses to exactly the same rows as the original", () => {
    const parity = redactionPreservesParse(SAMPLE, red);
    expect(parity).toEqual({ same: true, originalRows: 4, redactedRows: 4 });
  });

  it("flags identifiers that slip through", () => {
    expect(findResidualIdentifiers(red)).toEqual([]);
    expect(findResidualIdentifiers([{ pageNumber: 1, items: [{ str: "a@b.com", x: 0, y: 0, width: 1, height: 1 }] }])).toHaveLength(1);
    expect(findResidualIdentifiers([{ pageNumber: 1, items: [{ str: "5500123456789012", x: 0, y: 0, width: 1, height: 1 }] }])).toHaveLength(1);
  });
});

describe("validation tooling can never write financial data", () => {
  it.each(["../src/tools/statement-validation.ts", "../scripts/validate-real-statement.mjs"])("%s has no Firebase / Firestore dependency", (rel) => {
    const source = readFileSync(resolve(__dirname, rel), "utf8");
    const code = source.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    expect(code).not.toMatch(/firebase-admin|firebase\/|getFirestore|initializeApp|\.collection\(|\.doc\(|\.batch\(|runTransaction|writeStagingDocuments/);
  });
});
