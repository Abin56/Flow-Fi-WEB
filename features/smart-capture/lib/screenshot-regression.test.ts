/**
 * Regression for a real card-statement screenshot (2026-10-26), REDACTED: same column layout — Date | Details |
 * narrow country column ("IN") | Amount | separate single-letter C/D column — and the same defect shape (a row sliver
 * cut off under the table header, read as a second copy of the first row). Merchants and amounts are synthetic.
 */
import { describe, expect, it } from "vitest";
import { annotateOcrRows, flagRepeatedRows } from "./ocr-review";
import { parsePastedStatement, splitDescriptionColumns } from "./parse-pasted-statement";
import { applyRowPatch, canContinue, confirmField, openIssues, toReviewRows } from "./capture-review";
import { ocrLine, ocrText } from "./ocr-test-helpers";

const TODAY = new Date(2026, 9, 26);

const LINES = [
  ocrLine(0, ["Date", "Transaction Details", "Amount (Rs.)"]),
  // Sliver: only the bottom few pixels of a row survived under the header; OCR still produced text (with D).
  ocrLine(24, ["03 Oct 26", "RETAIL STORE LIMITE", "IN", "101.00", "D"], {}, 7),
  ocrLine(40, ["03 Oct 26", "RETAIL STORE LIMITE", "IN", "101.00", "C"]),
  ocrLine(70, ["06 Oct 26", "TELECOM SELFCARE", "IN", "434.61", "D"], { "434.61": 70 }),
  ocrLine(100, ["06 Oct 26", "UPI-PERSON D", "", "100.00", "D"]),
  ocrLine(130, ["07 Oct 26", "BROADBAND PROVIDER BA", "IN", "504.17", "D"]),
];

function review() {
  const parsed = parsePastedStatement(ocrText(LINES), { today: TODAY });
  return toReviewRows(annotateOcrRows(parsed.rows, LINES), "ocr");
}

describe("real-screenshot regression (redacted)", () => {
  it("maps the separate C/D column to Charge/Credit on every row", () => {
    const rows = review();
    expect(rows.map((r) => [r.description, r.direction])).toEqual([
      ["RETAIL STORE LIMITE", "debit"],
      ["RETAIL STORE LIMITE", "credit"],
      ["TELECOM SELFCARE", "debit"],
      ["UPI-PERSON D", "debit"],
      ["BROADBAND PROVIDER BA", "debit"],
    ]);
    // The marker WAS read — the review must not claim otherwise.
    expect(rows.every((r) => !r.issues.some((i) => i.code === "direction_inferred"))).toBe(true);
  });

  it("keeps the narrow country column out of the merchant description", () => {
    const rows = review();
    expect(rows[1]).toMatchObject({ description: "RETAIL STORE LIMITE", extraColumns: ["IN"] });
    // A trailing "D" that is part of the merchant name (before the amount) stays in the description.
    expect(rows[3]).toMatchObject({ description: "UPI-PERSON D", extraColumns: [] });
  });

  it("reads dates and amounts as on the image", () => {
    const rows = review();
    expect(rows.map((r) => [r.date?.getDate(), r.date?.getMonth(), r.amount])).toEqual([
      [3, 9, 101],
      [3, 9, 101],
      [6, 9, 434.61],
      [6, 9, 100],
      [7, 9, 504.17],
    ]);
    expect(rows[2].issues.some((i) => i.code === "low_confidence_amount")).toBe(true);
  });

  it("flags the cut-off sliver, starts it excluded, and explains the repeat — without deleting either row", () => {
    const [sliver, real] = review();
    expect(sliver.issues.map((i) => i.code)).toContain("partial_line");
    expect(sliver.include).toBe(false);
    expect(real.include).toBe(true);
    expect(real.issues.map((i) => i.code)).not.toContain("partial_line");
    expect(sliver.issues.find((i) => i.code === "possible_repeat")?.message).toMatch(/opposite Charge\/Credit/);
    expect(real.issues.find((i) => i.code === "possible_repeat")?.message).toMatch(/row 1/);
  });

  it("maps each row to its own OCR line box for highlighting (sliver ≠ real row)", () => {
    const [sliver, real] = review();
    expect(sliver.ocr?.box).toMatchObject({ y0: 24, y1: 31 });
    expect(real.ocr?.box).toMatchObject({ y0: 40, y1: 60 });
  });

  it("still requires confirmation of every included row before continuing", () => {
    let rows = review();
    expect(canContinue(rows)).toBe(false);
    rows = rows.map((r) => applyRowPatch(r, { confirmed: true }));
    // Row 3's low-confidence amount is strict — a row confirm alone is not enough.
    expect(canContinue(rows)).toBe(false);
    rows = rows.map((r) => (r.id === "r3" ? applyRowPatch(r, { amount: 434.61 }) : r));
    expect(canContinue(rows)).toBe(true);
    // The sliver stays flagged until it is itself confirmed.
    expect(openIssues({ ...rows[0], confirmed: false }).map((i) => i.code)).toContain("partial_line");
  });
});

describe("same merchant/date/amount with different directions (legitimate)", () => {
  it("keeps both rows included; each needs one look before continuing (never merged, never silently passed)", () => {
    const text = `03/10/2026\tSTORE A\t101.00\tD\n03/10/2026\tSTORE A\t101.00\tC\n04/10/2026\tSTORE B\t50.00\tD`;
    const parsed = parsePastedStatement(text, { today: TODAY });
    const rows = toReviewRows(flagRepeatedRows(parsed.rows));
    expect(rows.map((r) => [r.direction, r.include])).toEqual([
      ["debit", true],
      ["credit", true],
      ["debit", true],
    ]);
    const repeat = rows[0].issues.find((i) => i.code === "possible_repeat")!;
    expect(repeat.blocking).toBe(true);
    expect(canContinue(rows)).toBe(false);
    expect(canContinue(rows.map((r) => applyRowPatch(r, { confirmed: true })))).toBe(true);
  });
});

describe("C/D column in pasted text", () => {
  it("accepts a C/D column separated by several spaces or tabs", () => {
    const text = "03 Oct 26   RETAIL STORE LIMITE   IN   101.00    C\n06 Oct 26\tTELECOM SELFCARE\tIN\t434.61\tD";
    const rows = parsePastedStatement(text, { today: TODAY }).rows;
    expect(rows.map((r) => [r.description, r.extraColumns, r.direction])).toEqual([
      ["RETAIL STORE LIMITE", ["IN"], "credit"],
      ["TELECOM SELFCARE", ["IN"], "debit"],
    ]);
  });

  it("blocks a row whose C/D marker is missing when the statement has a C/D column", () => {
    const rows = parsePastedStatement("03/10/2026\tSTORE A\t101.00\tD\n04/10/2026\tSTORE B\t50.00", { today: TODAY }).rows;
    expect(rows[1].direction).toBeNull();
    expect(rows[1].issues.find((i) => i.code === "direction_unclear")?.blocking).toBe(true);
  });

  it("card-statement convention (only Cr marked) still reads unmarked rows as charges", () => {
    const rows = parsePastedStatement("03/10/2026\tSTORE A\t101.00\n04/10/2026\tREFUND STORE\t50.00 Cr", { today: TODAY }).rows;
    expect(rows.map((r) => r.direction)).toEqual(["debit", "credit"]);
  });

  it("splits description columns only on real column gaps", () => {
    expect(splitDescriptionColumns("PVR CINEMAS BANGALORE")).toEqual({ description: "PVR CINEMAS BANGALORE", extra: [] });
    expect(splitDescriptionColumns("AMAZON\tSEATTLE\tUSD")).toEqual({ description: "AMAZON SEATTLE", extra: ["USD"] });
    expect(splitDescriptionColumns("| SHOP | IN")).toEqual({ description: "SHOP", extra: ["IN"] });
  });
});

describe("OCR misreads seen on the redacted screenshot (exact text Tesseract produced)", () => {
  const READ = [
    "03 0ct 26\tRETAIL STORE LIMITE\tIN\t101.00\tC",
    "06 Oct 26\tTELECOM SELFCARE IN 43461 D",
    "06 Oct 26\tUPI-PERSOND\t100.00\tD",
    "07 Oct 26\tBROADBAND PROVIDER BA IN 50417 D",
    "090ct26 MOBILE PAYMENTS IN 39900 D",
  ].join("\n");
  const rows = () => toReviewRows(parsePastedStatement(READ, { today: TODAY }).rows);

  it("keeps every transaction as its own row — a misread date never merges two transactions", () => {
    const r = rows();
    expect(r.map((x) => x.description)).toEqual(["RETAIL STORE LIMITE", "TELECOM SELFCARE", "UPI-PERSOND", "BROADBAND PROVIDER BA", "MOBILE PAYMENTS"]);
    expect(r.every((x) => !x.issues.some((i) => i.code === "merged_lines"))).toBe(true);
  });

  it("accepts '0ct' (zero for O) as October but makes the user confirm that date", () => {
    const [first, , , , last] = rows();
    expect(first.date).toEqual(new Date(2026, 9, 3, 12));
    expect(last.date).toEqual(new Date(2026, 9, 9, 12));
    for (const row of [first, last]) {
      expect(openIssues(applyRowPatch(row, { confirmed: true })).map((i) => i.code)).toContain("low_confidence_date");
    }
  });

  it("never guesses a dropped decimal point: the user picks 434.61 or 43,461.00", () => {
    const telecom = rows()[1];
    expect(telecom.amount).toBeNull();
    expect(telecom.direction).toBe("debit");
    expect(telecom.amountCandidates).toEqual([434.61, 43461]);
    expect(telecom.extraColumns).toEqual(["IN"]);
    expect(openIssues(telecom).map((i) => i.code)).toContain("decimal_missing");
    // Picking a candidate is not acceptance: the amount must then be confirmed explicitly.
    const picked = applyRowPatch(applyRowPatch(telecom, { amount: 434.61 }), { confirmed: true });
    expect(openIssues(picked).map((i) => i.code)).toEqual(["decimal_missing"]);
    const confirmed = confirmField(picked, "amount");
    expect(openIssues(confirmed)).toEqual([]);
    // Changing the amount afterwards withdraws that confirmation.
    expect(openIssues(applyRowPatch(confirmed, { amount: 43461 })).map((i) => i.code)).toEqual(["decimal_missing"]);
  });

  it("manual typing works the same way — typed, then confirmed", () => {
    const telecom = rows()[1];
    const typed = applyRowPatch(applyRowPatch(telecom, { amount: 434.6 }), { confirmed: true });
    expect(openIssues(typed).map((i) => i.code)).toEqual(["decimal_missing"]);
    expect(openIssues(confirmField(typed, "amount"))).toEqual([]);
  });

  it("a wrapped description with its amount on the next line still joins, but asks for a check", () => {
    const [row] = toReviewRows(parsePastedStatement("08/09/2026 PAYU*SHOP INTERNET\nPVT LTD 2,349.00", { today: TODAY }).rows);
    expect(row).toMatchObject({ description: "PAYU*SHOP INTERNET PVT LTD", amount: 2349 });
    expect(openIssues(row).map((i) => i.code)).toContain("merged_lines");
  });
});

describe("C/D marker after an amount that lost its decimal point (OCR)", () => {
  it("still counts the marker — no false 'C/D not read'", () => {
    const lines = [ocrLine(0, ["06 Oct 26", "TELECOM SELFCARE IN 43461", "D"]), ocrLine(30, ["07 Oct 26", "SHOP", "101.00", "C"])];
    const rows = toReviewRows(annotateOcrRows(parsePastedStatement(ocrText(lines), { today: TODAY }).rows, lines), "ocr");
    expect(rows[0].direction).toBe("debit");
    expect(rows[0].issues.map((i) => i.code)).not.toContain("direction_inferred");
    expect(rows[0].issues.map((i) => i.code)).toContain("decimal_missing");
  });
});
