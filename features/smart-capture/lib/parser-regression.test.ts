import { describe, expect, it } from "vitest";
import { parsePastedStatement, type CaptureRow } from "./parse-pasted-statement";
import { flagRepeatedRows } from "./ocr-review";
import { bulkConfirmEligible, canContinue, toReviewRows } from "./capture-review";
import { detectSourceLayout } from "./source-layout";

const parse = (text: string) => parsePastedStatement(text, { today: new Date(2026, 9, 26) });
const blocking = (r: CaptureRow) => r.issues.filter((i) => i.blocking).map((i) => i.code);
const ymd = (d: Date | null) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null);

/**
 * The invariant under test: a value the parser is not certain of is never presented as fine — the row carries a
 * blocking issue (so Continue is refused) or the line is left out and shown under "Ignored text".
 */
describe("parser safety — uncertain values are never silently guessed", () => {
  it("one-letter C/D before the amount is a merchant fragment, not a Charge/Credit marker (fixed defect)", () => {
    for (const sep of ["  ", "\t"]) {
      const [row] = parse(`05/10/2026${sep}UPI-PERSON${sep}C${sep}100.00`).rows;
      expect(row.sourceOrder).not.toContain("direction");
      expect(row.description).toBe("UPI-PERSON C");
      // Not read as a credit: falls to the card convention, which is flagged for confirmation.
      expect(row.direction).toBe("debit");
      expect(row.issues.some((i) => i.code === "direction_unclear")).toBe(true);
    }
  });

  it("a spelled-out Cr / Credit / Dr / Debit before the amount is a marker, and a one-letter one after it is the C/D column", () => {
    expect(parse("05/10/2026\tSHOP\tCredit\t100.00").rows[0].direction).toBe("credit");
    expect(parse("05/10/2026\tSHOP\tDr\t100.00").rows[0].direction).toBe("debit");
    expect(parse("05/10/2026\tSHOP\t100.00\tC").rows[0].direction).toBe("credit");
  });

  it("a due-date / balance / limit line is never turned into a transaction by a date in a later column (fixed defect)", () => {
    for (const line of ["Amount Due On\t05/10/2026\t1,200.00", "Payment Due Date\t05/10/2026\t1,200.00", "Statement Date\t05/10/2026\t0.00", "Opening Balance\t01/09/2026\t5,000.00", "Available Limit\t05/09/2026\t2,00,000.00", "Total Outstanding\t05/09/2026\t9,999.00"]) {
      const { rows } = parse(line);
      // Either not a row at all, or a row that still blocks on its missing date (as before the column layout feature).
      expect(rows.every((r) => r.date == null && blocking(r).includes("no_date"))).toBe(true);
    }
  });

  it("missing decimal point, amount-first: both candidates offered, none chosen, row blocked", () => {
    const [row, ok] = parse("43461 D\t06/10/2026\tTELECOM\n50.00 D\t07/10/2026\tSHOP").rows;
    expect(row.amount).toBeNull();
    expect(row.amountCandidates).toEqual([434.61, 43461]);
    expect(blocking(row)).toEqual(["decimal_missing"]);
    expect(ok.amount).toBe(50);
  });

  it("a bare integer amount in its own cell is not taken as money — the line is left out, not guessed", () => {
    const r = parse("43461\tD\t06/10/2026\tTELECOM\nAMAZON\t05/09/2026\t1299");
    expect(r.rows).toHaveLength(0);
    expect(r.ignored.map((l) => l.reason)).toEqual(["no_transaction", "no_transaction"]);
  });

  it("several amounts on one line: never reordered, amount not chosen for the user, row blocked", () => {
    for (const line of ["AMAZON\t05/09/2026\t1,299.00\t10,000.00", "1,299.00 Dr\t05/09/2026\tAMAZON\t10,000.00", "05/09/2026\tAMAZON\t1,299.00 Dr\t10,000.00"]) {
      const [row] = parse(line).rows;
      // Off-lead dates are never reordered; a date-first line keeps its legacy date → merchant → amount reading.
      if (!line.startsWith("05/09/2026")) expect(row.sourceOrder).toBeUndefined();
      expect(blocking(row)).toContain("multiple_amounts");
      expect(row.amountCandidates).toEqual([1299, 10000]);
    }
  });

  it("Indian grouping is read exactly, in any column order", () => {
    const [a, b] = parse("1,24,999.00 Dr\t05/09/2026\tAMAZON\n12,34,567.50 Cr\t06/09/2026\tREFUND").rows;
    expect([a.amount, a.direction, b.amount, b.direction]).toEqual([124999, "debit", 1234567.5, "credit"]);
  });

  it("a date glued to the merchant, or a Cr on the amount plus a marker cell, is not guessed: blocked, no value invented", () => {
    for (const line of ["452.00 Dr\t05/09/2026 SWIGGY\t", "450.00 Cr\tD\t05/09/2026\tSWIGGY"]) {
      const [row] = parse(line).rows;
      expect(row.date).toBeNull();
      expect(blocking(row)).toContain("no_date");
    }
  });

  it("cells too close to separate keep every row blocked on its date and the layout standard", () => {
    const r = parse("AMAZON PAY 05/09/2026 1,299.00 Dr\nSWIGGY 07/09/2026 452.00 Dr");
    expect(r.rows.every((x) => x.date == null && blocking(x).includes("no_date"))).toBe(true);
    expect(detectSourceLayout(r).order).toBeNull();
  });

  it("a year-less date in a later column still says the year was assumed", () => {
    expect(parse("450.00 Dr\t05 Sep\tSWIGGY").rows[0].issues.map((i) => i.code)).toContain("year_assumed");
  });

  it("a wrapped description keeps its merged-lines block in every layout", () => {
    for (const text of ["05/09/2026 AMAZON PAY\nINDIA PRIVATE 1,299.00", "1,299.00 Dr\t05/09/2026\tAMAZON PAY\nINDIA PRIVATE"]) {
      const rows = parse(text).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => blocking(r).includes("merged_lines") || r.amount == null || r.date == null)).toBe(true);
    }
  });
});

describe("parser — repeated and opposite transactions survive every column order", () => {
  const orders: Record<string, (d: string, m: string, a: string) => string> = {
    "date/merchant/amount": (d, m, a) => `${d}\t${m}\t${a}`,
    "amount/date/merchant": (d, m, a) => `${a}\t${d}\t${m}`,
    "merchant/amount/date": (d, m, a) => `${m}\t${a}\t${d}`,
  };

  it.each(Object.entries(orders))("identical purchases stay two rows, each flagged possible_repeat, never merged (%s)", (_n, line) => {
    const rows = flagRepeatedRows(parse([line("05/09/2026", "SWIGGY", "452.00 Dr"), line("05/09/2026", "SWIGGY", "452.00 Dr")].join("\n")).rows);
    expect(rows.map((r) => [r.id, r.amount])).toEqual([["r1", 452], ["r2", 452]]);
    expect(rows.every((r) => r.issues.some((i) => i.code === "possible_repeat"))).toBe(true);
    expect(bulkConfirmEligible(toReviewRows(rows, "ocr"))).toHaveLength(0); // repeats always need their own look
  });

  it.each(Object.entries(orders))("a same-amount Charge/Credit pair keeps both directions and says 'opposite' (%s)", (_n, line) => {
    const rows = flagRepeatedRows(parse([line("03/10/2026", "RETAIL STORE", "101.00 Dr"), line("03/10/2026", "RETAIL STORE", "101.00 Cr")].join("\n")).rows);
    expect(rows.map((r) => r.direction)).toEqual(["debit", "credit"]);
    expect(rows.every((r) => r.issues.find((i) => i.code === "possible_repeat")?.message.includes("opposite"))).toBe(true);
  });
});

describe("parser — existing shapes read exactly as before", () => {
  it("date-first rows with a C/D cell, an IN column and a points column are unchanged", () => {
    const r = parse("06/10/2026\tBSNL SELFCARE\tIN\t434.61\tD\n05/09/2026\tSECTOR 5 STORE\tIN\t450.00 Dr\n05/09/2026\tAMAZON\t1,299.00 Dr\t12");
    expect(r.rows.map((x) => [ymd(x.date), x.description, x.amount, x.direction, x.extraColumns.join("+"), x.notes.length])).toEqual([
      ["2026-10-6", "BSNL SELFCARE", 434.61, "debit", "IN", 0],
      ["2026-9-5", "SECTOR 5 STORE", 450, "debit", "IN", 0],
      ["2026-9-5", "AMAZON", 1299, "debit", "12", 0],
    ]);
    expect(r.rows.every((x) => x.issues.every((i) => !i.blocking))).toBe(true);
  });

  it("a second leading date (posting date) is still dropped, and the new guard doesn't touch date-first lines", () => {
    const [row] = parse("05/09/2026\t06/09/2026\tAMAZON\t1,299.00 Dr").rows;
    expect([ymd(row.date), row.description, row.amount]).toEqual(["2026-9-5", "AMAZON", 1299]);
    expect(parse("05/09/2026\tLATE PAYMENT FEE TOTAL\t100.00 Dr").rows).toHaveLength(1);
  });

  it("Continue stays refused while any included reshaped row has an open issue", () => {
    const rows = toReviewRows(parse("999.00\t07/09/2026\tREFUND MYNTRA\n452.00 Dr\t10/09/2026\tSWIGGY").rows);
    expect(canContinue(rows)).toBe(false); // REFUND has no Cr/Dr marker and looks like a credit
  });
});
