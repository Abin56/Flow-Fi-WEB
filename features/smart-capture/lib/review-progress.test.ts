import { describe, expect, it } from "vitest";
import { annotateOcrRows, READY_CONFIDENCE } from "./ocr-review";
import { parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, bulkConfirm, bulkConfirmEligible, canContinue, confirmField, openIssues, reviewProgress, toReviewRows, undoBulkConfirm, type ReviewRow } from "./capture-review";
import { ocrLine, ocrText } from "./ocr-test-helpers";

const TODAY = new Date(2026, 9, 26);
/** Comfortably above READY_CONFIDENCE and below it, for rows that must land on either side of the line. */
const HIGH = 99;
const MIDDLING = READY_CONFIDENCE - 2;

/** Synthetic OCR capture with one row of every kind the review screen must treat differently. */
function capture(): ReviewRow[] {
  const lines = [
    ocrLine(0, ["03 Oct 26", "STORE A", "101.00", "D"], { "03 Oct 26": HIGH, "101.00": HIGH, D: HIGH }), // r1 clean, but...
    ocrLine(30, ["03 Oct 26", "STORE A", "101.00", "C"], { "03 Oct 26": HIGH, "101.00": HIGH, C: HIGH }), // r2 ...same date/merchant/amount as r1 (genuine pair) — needs its own look either way
    ocrLine(60, ["06 Oct 26", "TELECOM", "43461", "D"]), // r3 dropped decimal point — fix
    ocrLine(90, ["06 Oct 26", "PERSON", "100.00", "D"], { "100.00": 50 }), // r4 low-confidence amount — fix
    ocrLine(120, ["07 Oct 26", "GROCER", "504.17", "D"], { D: 40 }), // r5 low-confidence C/D marker — fix
    ocrLine(150, ["09 Oct 26", "CAFE", "80.00", "D"], { "09 Oct 26": MIDDLING, "80.00": MIDDLING, D: MIDDLING }), // r6 decent but not strong enough to skip the check
    ocrLine(180, ["10 Oct 26", "BOOKS", "220.00", "D"], { "10 Oct 26": MIDDLING, "220.00": MIDDLING, D: MIDDLING }), // r7 same
    ocrLine(205, ["11 Oct 26", "SLIVER", "50.00", "D"], {}, 6), // r8 cut-off line → excluded
    ocrLine(230, ["12 Oct 26", "PHARMACY", "60.00", "D"], { "12 Oct 26": HIGH, "60.00": HIGH, D: HIGH }), // r9 clean, strong evidence, no twin — ready with no row-level click
    ocrLine(260, ["13 Oct 26", "GYM", "300.00", "D"], { "13 Oct 26": HIGH, "300.00": HIGH, D: HIGH }), // r10 same
  ];
  const parsed = parsePastedStatement(ocrText(lines), { today: TODAY });
  return toReviewRows(annotateOcrRows(parsed.rows, lines), "ocr");
}

const ids = (rows: ReviewRow[]) => rows.map((r) => r.id);

describe("automatic readiness", () => {
  it("marks clean, high-confidence, un-paired rows Ready immediately — no row-level click needed", () => {
    const rows = capture();
    const [r9, r10] = [rows.find((r) => r.id === "r9")!, rows.find((r) => r.id === "r10")!];
    expect(openIssues(r9)).toEqual([]);
    expect(openIssues(r10)).toEqual([]);
    expect(canContinue([r9, r10])).toBe(true);
  });

  it("still asks for a look when confidence is only middling, even with nothing field-specific wrong", () => {
    const rows = capture();
    const r6 = rows.find((r) => r.id === "r6")!;
    expect(openIssues(r6).map((i) => i.code)).toEqual(["ocr_unverified"]);
  });

  it("a genuine same-amount Charge/Credit pair always needs its own look, however clean the read", () => {
    const rows = capture();
    const [r1, r2] = [rows.find((r) => r.id === "r1")!, rows.find((r) => r.id === "r2")!];
    expect(openIssues(r1).map((i) => i.code)).toEqual(["ocr_unverified", "possible_repeat"]);
    expect(openIssues(r2).map((i) => i.code)).toEqual(["ocr_unverified", "possible_repeat"]);
  });

  it("a field-specific problem is the row's only open ask — no separate generic check on top of it", () => {
    const rows = capture();
    for (const id of ["r3", "r4", "r5"]) {
      const row = rows.find((r) => r.id === id)!;
      expect(openIssues(row).some((i) => i.code === "ocr_unverified")).toBe(false);
    }
  });
});

describe("bulk 'Confirm all reviewed rows'", () => {
  it("only offers rows whose single open item is the image check", () => {
    expect(ids(bulkConfirmEligible(capture()))).toEqual(["r6", "r7"]);
  });

  it("never clears financial ambiguity: decimal point, low-confidence amount / C-D, repeated pair, cut-off row — and never touches an already-ready row", () => {
    const rows = capture();
    const eligible = new Set(ids(bulkConfirmEligible(rows)));
    for (const id of ["r1", "r2", "r3", "r4", "r5", "r8", "r9", "r10"]) expect(eligible.has(id)).toBe(false);
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
  it("separates ready, verified, to-check and needs-correction rows", () => {
    // r9, r10 are already Ready; r1/r2 (the pair), r4/r5 (unclear reads, values present) and r6/r7 (middling
    // confidence) need one look; only r3 (dropped decimal point) needs a value corrected. "Verified" = no row-level
    // check left open — true of r3/r4/r5, whose only asks are field-specific.
    expect(reviewProgress(capture())).toEqual({ included: 9, verified: 5, toCheck: 6, fieldIssues: 1, ready: 2, pending: 7 });
  });

  it("tracks a realistic walk-through to zero pending, and only then allows continuing", () => {
    let rows = capture();
    expect(reviewProgress(rows)).toMatchObject({ ready: 2, pending: 7 }); // r9, r10 ready from the start

    rows = bulkConfirm(rows, new Set(ids(bulkConfirmEligible(rows))));
    expect(reviewProgress(rows)).toMatchObject({ verified: 7, ready: 4, pending: 5 }); // + r6, r7

    // Genuine same-amount Charge/Credit pair: confirmed one by one.
    rows = rows.map((r) => (r.id === "r1" || r.id === "r2" ? applyRowPatch(r, { confirmed: true }) : r));
    // r3: pick a candidate, then confirm the amount explicitly.
    rows = rows.map((r) => (r.id === "r3" ? confirmField(applyRowPatch(applyRowPatch(r, { amount: 434.61 }), { confirmed: true }), "amount") : r));
    // r4: confirm the low-confidence amount as read; r5: confirm the C/D.
    rows = rows.map((r) => (r.id === "r4" ? confirmField(applyRowPatch(r, { confirmed: true }), "amount") : r));
    expect(canContinue(rows)).toBe(false);
    rows = rows.map((r) => (r.id === "r5" ? confirmField(applyRowPatch(r, { confirmed: true }), "direction") : r));
    expect(reviewProgress(rows)).toMatchObject({ verified: 9, fieldIssues: 0, ready: 9, pending: 0 });
    expect(canContinue(rows)).toBe(true);
  });
});
