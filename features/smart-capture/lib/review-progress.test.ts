import { describe, expect, it } from "vitest";
import { annotateOcrRows } from "./ocr-review";
import { parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, bulkConfirm, bulkConfirmEligible, canContinue, confirmField, reviewProgress, toReviewRows, undoBulkConfirm, type ReviewRow } from "./capture-review";
import { ocrLine, ocrText } from "./ocr-test-helpers";

const TODAY = new Date(2026, 9, 26);

/** Synthetic OCR capture with one row of every kind the bulk action must treat differently. */
function capture(): ReviewRow[] {
  const lines = [
    ocrLine(0, ["03 Oct 26", "STORE A", "101.00", "D"]), // r1 clean
    ocrLine(30, ["03 Oct 26", "STORE A", "101.00", "C"]), // r2 clean, but same date/merchant/amount as r1 (genuine pair)
    ocrLine(60, ["06 Oct 26", "TELECOM", "43461", "D"]), // r3 dropped decimal point
    ocrLine(90, ["06 Oct 26", "PERSON", "100.00", "D"], { "100.00": 50 }), // r4 low-confidence amount
    ocrLine(120, ["07 Oct 26", "GROCER", "504.17", "D"], { D: 40 }), // r5 low-confidence C/D marker
    ocrLine(150, ["09 Oct 26", "CAFE", "80.00", "D"]), // r6 clean
    ocrLine(180, ["10 Oct 26", "BOOKS", "220.00", "D"]), // r7 clean
    ocrLine(205, ["11 Oct 26", "SLIVER", "50.00", "D"], {}, 6), // r8 cut-off line → excluded
  ];
  const parsed = parsePastedStatement(ocrText(lines), { today: TODAY });
  return toReviewRows(annotateOcrRows(parsed.rows, lines), "ocr");
}

const ids = (rows: ReviewRow[]) => rows.map((r) => r.id);

describe("bulk 'Confirm all reviewed rows'", () => {
  it("only offers rows whose single open item is the image check", () => {
    expect(ids(bulkConfirmEligible(capture()))).toEqual(["r6", "r7"]);
  });

  it("never clears financial ambiguity: decimal point, low-confidence amount / C-D, repeated pair, cut-off row", () => {
    const rows = capture();
    const eligible = new Set(ids(bulkConfirmEligible(rows)));
    for (const id of ["r1", "r2", "r3", "r4", "r5", "r8"]) expect(eligible.has(id)).toBe(false);
  });

  it("does not touch or re-include excluded rows", () => {
    let rows = capture();
    rows = rows.map((r) => (r.id === "r6" ? applyRowPatch(r, { include: false }) : r));
    const after = bulkConfirm(rows, new Set(ids(bulkConfirmEligible(rows))));
    expect(after.find((r) => r.id === "r6")).toMatchObject({ include: false, confirmed: false });
    expect(after.find((r) => r.id === "r8")).toMatchObject({ include: false, confirmed: false });
  });

  it("undo reverts only the bulk confirmations, keeping individual ones", () => {
    let rows = capture();
    rows = rows.map((r) => (r.id === "r1" ? applyRowPatch(r, { confirmed: true }) : r));
    rows = bulkConfirm(rows, new Set(ids(bulkConfirmEligible(rows))));
    expect(rows.filter((r) => r.confirmed).map((r) => r.id)).toEqual(["r1", "r6", "r7"]);
    rows = undoBulkConfirm(rows);
    expect(rows.filter((r) => r.confirmed).map((r) => r.id)).toEqual(["r1"]);
  });

  it("an individual change of mind takes a row out of the bulk undo set", () => {
    let rows = bulkConfirm(capture(), new Set(["r6", "r7"]));
    rows = rows.map((r) => (r.id === "r6" ? applyRowPatch(r, { confirmed: true }) : r));
    expect(undoBulkConfirm(rows).filter((r) => r.confirmed).map((r) => r.id)).toEqual(["r6"]);
  });
});

describe("review progress counts", () => {
  it("separates verified, needs-correction and ready rows", () => {
    expect(reviewProgress(capture())).toEqual({ included: 7, verified: 0, toCheck: 7, fieldIssues: 3, ready: 0, pending: 7 });
  });

  it("tracks a realistic walk-through to zero pending, and only then allows continuing", () => {
    let rows = capture();
    rows = bulkConfirm(rows, new Set(ids(bulkConfirmEligible(rows))));
    expect(reviewProgress(rows)).toMatchObject({ verified: 2, ready: 2, pending: 5 });

    // Genuine same-amount Charge/Credit pair: confirmed one by one.
    rows = rows.map((r) => (r.id === "r1" || r.id === "r2" ? applyRowPatch(r, { confirmed: true }) : r));
    // r3: pick a candidate, then confirm the amount explicitly.
    rows = rows.map((r) => (r.id === "r3" ? confirmField(applyRowPatch(applyRowPatch(r, { amount: 434.61 }), { confirmed: true }), "amount") : r));
    // r4: confirm the low-confidence amount as read; r5: confirm the C/D.
    rows = rows.map((r) => (r.id === "r4" ? confirmField(applyRowPatch(r, { confirmed: true }), "amount") : r));
    expect(canContinue(rows)).toBe(false);
    rows = rows.map((r) => (r.id === "r5" ? confirmField(applyRowPatch(r, { confirmed: true }), "direction") : r));
    expect(reviewProgress(rows)).toMatchObject({ verified: 7, fieldIssues: 0, ready: 7, pending: 0 });
    expect(canContinue(rows)).toBe(true);
  });
});
