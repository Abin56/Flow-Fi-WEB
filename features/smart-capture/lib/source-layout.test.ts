// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { parsePastedStatement, type CaptureRow } from "./parse-pasted-statement";
import { applyRowPatch, bulkConfirmEligible, canContinue, toReviewRows } from "./capture-review";
import { annotateOcrRows, LOW_CONFIDENCE } from "./ocr-review";
import { baseColumns, detectSourceLayout, loadColumnPreference, moveColumn, saveColumnPreference, validCustomOrder } from "./source-layout";
import { ocrLine, ocrText } from "./ocr-test-helpers";

const TODAY = new Date(2026, 9, 26);
const parse = (text: string) => parsePastedStatement(text, { today: TODAY });

const iso = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);
const values = (rows: CaptureRow[]) => rows.map((r) => [iso(r.date), r.description, r.amount, r.direction]);

const TXNS = [
  { date: "05/09/2026", merchant: "AMAZON PAY INDIA", amount: "1,299.00", dir: "Dr" },
  { date: "07/09/2026", merchant: "REFUND MYNTRA", amount: "999.00", dir: "Cr" },
  { date: "10/09/2026", merchant: "SWIGGY", amount: "452.00", dir: "Dr" },
];
const EXPECTED = [
  ["2026-09-05", "AMAZON PAY INDIA", 1299, "debit"],
  ["2026-09-07", "REFUND MYNTRA", 999, "credit"],
  ["2026-09-10", "SWIGGY", 452, "debit"],
];

type Core = "date" | "merchant" | "amount";
function table(order: Core[], { header = false }: { header?: boolean } = {}) {
  const cell = (t: (typeof TXNS)[number], f: Core) => (f === "date" ? t.date : f === "merchant" ? t.merchant : `${t.amount} ${t.dir}`);
  const head = { date: "Date", merchant: "Transaction Description", amount: "Amount" };
  return [...(header ? [order.map((f) => head[f]).join("\t")] : []), ...TXNS.map((t) => order.map((f) => cell(t, f)).join("\t"))].join("\n");
}

describe("source column order — the same values whatever the column order", () => {
  const ORDERS: Core[][] = [
    ["date", "merchant", "amount"],
    ["amount", "date", "merchant"],
    ["merchant", "amount", "date"],
    ["amount", "merchant", "date"],
    ["merchant", "date", "amount"],
    ["date", "amount", "merchant"],
  ];

  it.each(ORDERS)("%s / %s / %s: identical dates, merchants, amounts and directions; order detected from the cells", (...order) => {
    const result = parse(table(order));
    expect(values(result.rows)).toEqual(EXPECTED);
    expect(result.rows.every((r) => r.issues.every((i) => !i.blocking))).toBe(true);
    const layout = detectSourceLayout(result);
    expect(layout.order).toEqual(order);
    expect(layout.basis).toBe("rows");
    expect(layout.evidence).toEqual({ voting: 3, agreeing: 3, total: 3 });
  });

  it.each(ORDERS)("%s / %s / %s with a header line: the header gives the same order, confirmed by the rows", (...order) => {
    const result = parse(table(order, { header: true }));
    expect(values(result.rows)).toEqual(EXPECTED);
    expect(result.headerOrder).toEqual(order);
    const layout = detectSourceLayout(result);
    expect(layout.order).toEqual(order);
    expect(layout.basis).toBe("header");
  });

  it("a date that isn't the first column is marked for a look, never silently trusted", () => {
    const [first] = parse(table(["amount", "date", "merchant"])).rows;
    expect(first.notes.some((n) => /wasn't the first column/.test(n))).toBe(true);
    expect(parse(table(["date", "merchant", "amount"])).rows[0].notes).toEqual([]);
  });

  it("keeps row ids, source lines and source text exactly as pasted", () => {
    const text = table(["amount", "date", "merchant"]);
    const { rows } = parse(text);
    expect(rows.map((r) => [r.id, r.lineStart, r.sourceText])).toEqual(text.split("\n").map((line, i) => [`r${i + 1}`, i, line]));
  });
});

describe("Charge/Credit as its own column", () => {
  it("Merchant | Date | Charge/Credit | Amount — the marker cell sets the direction by its contents", () => {
    const result = parse("AMAZON PAY INDIA\t05/09/2026\tDebit\t1,299.00\nREFUND MYNTRA\t07/09/2026\tCredit\t999.00\nSWIGGY\t10/09/2026\tDr\t452.00");
    expect(values(result.rows)).toEqual(EXPECTED);
    expect(result.rows.map((r) => r.sourceOrder)).toEqual(Array(3).fill(["merchant", "date", "direction", "amount"]));
    expect(detectSourceLayout(result).order).toEqual(["merchant", "date", "direction", "amount"]);
  });

  it("Date | Merchant | Amount | C/D in its own cell after the amount stays a column after the amount", () => {
    const result = parse("05/09/2026\tAMAZON\t1,299.00\tD\n07/09/2026\tREFUND MYNTRA\t999.00\tC\n10/09/2026\tSWIGGY\t452.00\tD");
    expect(result.rows.map((r) => r.direction)).toEqual(["debit", "credit", "debit"]);
    expect(detectSourceLayout(result).order).toEqual(["date", "merchant", "amount", "direction"]);
  });

  it("an inline marker ('1,299.00 Dr') is part of the amount, not a column", () => {
    expect(detectSourceLayout(parse(table(["date", "merchant", "amount"]))).order).toEqual(["date", "merchant", "amount"]);
  });

  it("a marker not next to the amount is not trusted as a column or as a direction — the row is read the legacy way", () => {
    const [row] = parse("05/09/2026\tD\tAMAZON\t1,299.00").rows;
    expect(row.sourceOrder).not.toContain("direction");
    expect(row.description).toBe("D AMAZON");
  });
});

describe("separate Debit and Credit columns", () => {
  const TEXT = ["Date\tNarration\tDebit\tCredit", "05/09/2026\tAMAZON PAY INDIA\t1,299.00", "07/09/2026\tREFUND MYNTRA\t\t999.00", "10/09/2026\tSWIGGY\t452.00"].join("\n");

  it("takes the header's debit/credit columns, confirmed by the rows; directions still come from the columns", () => {
    const result = parse(TEXT);
    expect(result.headerOrder).toEqual(["date", "merchant", "debit", "credit"]);
    expect(result.rows.map((r) => r.direction)).toEqual(["debit", "credit", "debit"]);
    expect(detectSourceLayout(result)).toMatchObject({ order: ["date", "merchant", "debit", "credit"], basis: "header" });
  });

  it("a header that disagrees with the rows is not trusted", () => {
    const text = ["Amount\tNarration\tDate", "05/09/2026\tAMAZON\t1,299.00 Dr", "07/09/2026\tSWIGGY\t452.00 Dr"].join("\n");
    expect(detectSourceLayout(parse(text))).toMatchObject({ order: null, basis: "none" });
  });
});

describe("ambiguous sources keep the standard layout", () => {
  it("rows that disagree about their order → no order", () => {
    const result = parse("05/09/2026\tAMAZON\t1,299.00 Dr\n100.00 Dr\t06/09/2026\tSHOP\n452.00 Dr\t07/09/2026\tSWIGGY");
    const layout = detectSourceLayout(result);
    expect(layout.order).toBeNull();
    expect(layout.reason).toMatch(/disagree/);
  });

  it("cells too close to separate (single spaces) with the date not first → order unknown, date still asked for", () => {
    const result = parse("AMAZON PAY 05/09/2026 1,299.00 Dr\nSWIGGY 07/09/2026 452.00 Dr");
    expect(result.rows.every((r) => r.sourceOrder === undefined)).toBe(true);
    expect(result.rows.every((r) => r.issues.some((i) => i.code === "no_date" && i.blocking))).toBe(true);
    expect(detectSourceLayout(result).order).toBeNull();
  });

  it("two dates in a non-leading position are never guessed between", () => {
    const [row] = parse("AMAZON\t05/09/2026\t06/09/2026\t1,299.00 Dr").rows;
    expect(row.date).toBeNull();
    expect(row.sourceOrder).toBeUndefined();
  });

  it("two amounts (e.g. a running balance) are not read column by column", () => {
    const [row] = parse("AMAZON\t05/09/2026\t1,299.00 Dr\t10,000.00").rows;
    expect(row.sourceOrder).toBeUndefined();
  });

  it("a summary line with a date in a later column is not turned into a transaction", () => {
    const result = parse("Payment Due Date\t05/10/2026\t1,200.00\nSWIGGY\t05/09/2026\t452.00 Dr");
    expect(result.rows.map((r) => r.description)).toEqual(["SWIGGY"]);
    expect(result.ignored.some((l) => l.reason === "summary" && /Payment Due Date/.test(l.text))).toBe(true);
  });

  it("a wrapped (multi-line) row has no order of its own", () => {
    const result = parse("05/09/2026 AMAZON\nPAY INDIA 1,299.00\n06/09/2026 SWIGGY 452.00");
    expect(result.rows[0].issues.some((i) => i.code === "merged_lines")).toBe(true);
    expect(result.rows[0].sourceOrder).toBeUndefined();
    expect(result.rows[1].sourceOrder).toEqual(["date", "merchant", "amount"]);
  });

  it("when most rows can't be read column by column, the few that can don't decide the order", () => {
    const result = parse("100.00 Dr\t05/09/2026\tSHOP A\nSHOP B 06/09/2026 200.00 Dr\nSHOP C 07/09/2026 300.00 Dr\nSHOP D 08/09/2026 400.00 Dr");
    expect(result.rows[0].sourceOrder).toEqual(["amount", "date", "merchant"]);
    const layout = detectSourceLayout(result);
    expect(layout.order).toBeNull();
    expect(layout.reason).toMatch(/Too few rows/);
  });

  it("legacy date-first rows with text after the amount have no order (they would drop that text)", () => {
    expect(parse("05/09/2026 1,299.00 Dr AMAZON").rows[0].sourceOrder).toBeUndefined();
  });
});

describe("presentation never changes review gates or values", () => {
  it("reordering columns is not a row edit: the same rows pass and fail the same gates", () => {
    const a = toReviewRows(parse(table(["date", "merchant", "amount"])).rows);
    const b = toReviewRows(parse(table(["amount", "merchant", "date"])).rows);
    expect(b.map((r) => [r.date, r.description, r.amount, r.direction, r.edited])).toEqual(a.map((r) => [r.date, r.description, r.amount, r.direction, r.edited]));
    expect(bulkConfirmEligible(b).length).toBe(bulkConfirmEligible(a).length);
    expect(canContinue(b)).toBe(canContinue(a));
  });

  it("a missing direction stays missing (no direction is inferred from where a cell sits)", () => {
    const rows = toReviewRows(parse("05/09/2026\tREFUND MYNTRA\t999.00\n06/09/2026\tSWIGGY\t452.00").rows);
    expect(rows[0].direction).toBeNull();
    const moved = toReviewRows(parse("999.00\t05/09/2026\tREFUND MYNTRA").rows);
    expect(moved[0].direction).toBeNull();
    expect(applyRowPatch(moved[0], { direction: "credit" }).direction).toBe("credit");
  });
});

describe("screenshot (OCR) rows — confidence checks follow the field, not the position", () => {
  const issuesOf = (lines: ReturnType<typeof ocrLine>[]) => {
    const parsed = parse(ocrText(lines));
    return { parsed, rows: annotateOcrRows(parsed.rows, lines) };
  };

  it("reads Amount | Merchant | Date and still flags a low-confidence date in the last column", () => {
    const { rows, parsed } = issuesOf([
      ocrLine(0, ["1,299.00 Dr", "AMAZON PAY", "05/09/2026"]),
      ocrLine(40, ["452.00 Dr", "SWIGGY", "07/09/2026"], { "07/09/2026": LOW_CONFIDENCE - 20 }),
    ]);
    expect(values(rows)).toEqual([
      ["2026-09-05", "AMAZON PAY", 1299, "debit"],
      ["2026-09-07", "SWIGGY", 452, "debit"],
    ]);
    expect(detectSourceLayout(parsed).order).toEqual(["amount", "merchant", "date"]);
    expect(rows[0].issues.some((i) => i.code === "low_confidence_date")).toBe(false);
    expect(rows[1].issues.find((i) => i.code === "low_confidence_date")).toMatchObject({ strict: true, blocking: true });
  });

  it("a Cr/Dr column before the amount is checked for confidence too", () => {
    const { rows } = issuesOf([ocrLine(0, ["AMAZON PAY", "05/09/2026", "Dr", "1,299.00"], { Dr: 40 }), ocrLine(40, ["SWIGGY", "07/09/2026", "Dr", "452.00"])]);
    expect(rows.map((r) => r.direction)).toEqual(["debit", "debit"]);
    expect(rows[0].issues.find((i) => i.code === "low_confidence_direction")).toMatchObject({ strict: true });
    expect(rows[1].issues.some((i) => i.code === "low_confidence_direction")).toBe(false);
  });

  it("every OCR row still needs its own 'checked against the image' confirmation, whatever the order", () => {
    const { rows } = issuesOf([ocrLine(0, ["1,299.00 Dr", "AMAZON PAY", "05/09/2026"])]);
    expect(rows[0].issues.some((i) => i.code === "ocr_unverified" && i.blocking)).toBe(true);
  });

  it("OCR words too close together to separate (single gaps) leave the order unknown", () => {
    const lines = [ocrLine(0, ["AMAZON PAY 05/09/2026 1,299.00 Dr"]), ocrLine(40, ["SWIGGY 07/09/2026 452.00 Dr"])];
    const { parsed } = issuesOf(lines);
    expect(detectSourceLayout(parsed).order).toBeNull();
  });
});

describe("custom order helpers", () => {
  beforeEach(() => sessionStorage.clear());

  it("moves one column by one place and never past either end", () => {
    expect(moveColumn(["date", "merchant", "amount"], "amount", -1)).toEqual(["date", "amount", "merchant"]);
    expect(moveColumn(["date", "merchant", "amount"], "date", -1)).toEqual(["date", "merchant", "amount"]);
    expect(moveColumn(["date", "merchant", "amount"], "amount", 1)).toEqual(["date", "merchant", "amount"]);
  });

  it("falls back to date / merchant / amount when the source order is unknown", () => {
    expect(baseColumns({ order: null, basis: "none", reason: "", evidence: { voting: 0, agreeing: 0, total: 0 } })).toEqual(["date", "merchant", "amount"]);
  });

  it("a saved order applies only to exactly the columns now available", () => {
    expect(validCustomOrder(["amount", "date", "merchant"], ["date", "merchant", "amount"])).toBe(true);
    expect(validCustomOrder(["amount", "date"], ["date", "merchant", "amount"])).toBe(false);
    expect(validCustomOrder(["amount", "amount", "date"], ["date", "merchant", "amount"])).toBe(false);
    expect(validCustomOrder(["debit", "credit", "date", "merchant"], ["date", "merchant", "amount"])).toBe(false);
    saveColumnPreference(["merchant", "date", "amount"]);
    expect(loadColumnPreference(["date", "merchant", "amount"])).toEqual(["merchant", "date", "amount"]);
    expect(loadColumnPreference(["date", "merchant", "debit", "credit"])).toBeNull();
    saveColumnPreference(null);
    expect(loadColumnPreference(["date", "merchant", "amount"])).toBeNull();
  });
});
