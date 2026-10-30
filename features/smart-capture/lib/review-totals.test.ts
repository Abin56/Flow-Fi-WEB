import { describe, expect, it } from "vitest";
import { parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, reviewTotals, toReviewRows } from "./capture-review";

const rows = () =>
  toReviewRows(
    parsePastedStatement(
      ["05/09/2026\tSWIGGY\t0.10 Dr", "05/09/2026\tUBER\t0.20 Dr", "06/09/2026\tREFUND MYNTRA\t1,299.00 Cr", "07/09/2026\tSALARY\t40,000.00 Cr", "08/09/2026\tGROCER\t2,812.75 Dr"].join("\n"),
      { today: new Date(2026, 9, 26) },
    ).rows,
  );

describe("reviewTotals", () => {
  it("sums the included rows exactly (paise, no float drift) by statement direction and import category", () => {
    const t = reviewTotals(rows());
    expect(t).toMatchObject({ debits: 2813.05, credits: 41299, net: 38485.95, debitCount: 3, creditCount: 2, expenses: 2813.05, refunds: 1299, income: 40000, skipped: 0 });
  });

  it("updates for edits, exclusions and restores; excluded rows never count", () => {
    let r = rows();
    r = r.map((x) => (x.description === "GROCER" ? applyRowPatch(x, { amount: 100 }) : x));
    expect(reviewTotals(r).debits).toBe(100.3);
    r = r.map((x) => (x.description === "SALARY" ? applyRowPatch(x, { include: false }) : x));
    expect(reviewTotals(r)).toMatchObject({ credits: 1299, income: 0, creditCount: 1 });
    r = r.map((x) => (x.description === "SALARY" ? applyRowPatch(x, { include: true }) : x));
    expect(reviewTotals(r).credits).toBe(41299);
  });

  it("never calls a skipped debit or a card payment an expense", () => {
    let r = rows().map((x) => (x.description === "UBER" ? applyRowPatch(x, { action: "ignore" }) : x));
    r = r.map((x) => (x.description === "SALARY" ? { ...x, kind: "payment" as const } : x));
    const t = reviewTotals(r);
    expect(t).toMatchObject({ debits: 2813.05, expenses: 2812.85, skipped: 0.2, payments: 40000, income: 0 });
  });

  it("leaves rows without an amount or direction out of the sums and counts them", () => {
    const r = rows().map((x, i) => (i === 0 ? { ...x, amount: null } : x));
    expect(reviewTotals(r)).toMatchObject({ uncounted: 1, debits: 2812.95 });
  });
});
