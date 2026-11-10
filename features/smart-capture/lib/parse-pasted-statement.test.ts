import { describe, expect, it } from "vitest";
import { findAmounts, parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, canContinue, captureSessionId, openIssues, toReviewRows, toStagedRecords } from "./capture-review";
import { detectFreshDuplicatesForCommit, getPreflightBlockers } from "@/features/transaction-studio/lib/commit-review-import";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";

const TODAY = new Date(2026, 9, 26);
const parse = (text: string) => parsePastedStatement(text, { today: TODAY });

// Synthetic, HDFC-style: single amount column, "Cr" marks credits.
const HDFC_STYLE = `Date\tTransaction Description\tAmount (in Rs.)
02/09/2026\tSWIGGY BANGALORE\t452.00
05/09/2026\tAMAZON PAY INDIA PRIVATE\t1,24,999.00
07/09/2026\tREFUND AMAZON PAY INDIA\t1,299.00 Cr
10/09/2026\tPAYMENT RECEIVED - THANK YOU\t25,000.00 Cr
15/09/2026\tFINANCE CHARGES\t312.40
15/09/2026\tIGST-CI@18%\t56.23
18/09/2026\tEMI PRINCIPAL 3/12 SMARTEMI\t4,166.67
Total Amount Due\t1,28,000.00
Minimum Amount Due\t6,400.00
Credit Limit\t3,00,000.00`;

describe("parsePastedStatement — copied tables", () => {
  it("extracts every transaction row and ignores the header and summary totals", () => {
    const result = parse(HDFC_STYLE);
    expect(result.rows).toHaveLength(7);
    expect(result.ignored.filter((l) => l.reason === "header")).toHaveLength(1);
    expect(result.ignored.filter((l) => l.reason === "summary").map((l) => l.text.split("\t")[0])).toEqual([
      "Total Amount Due",
      "Minimum Amount Due",
      "Credit Limit",
    ]);
    expect(result.rows.map((r) => r.amount)).toEqual([452, 124999, 1299, 25000, 312.4, 56.23, 4166.67]);
  });

  it("reads Indian lakh grouping and dd/mm dates", () => {
    const row = parse(HDFC_STYLE).rows[1];
    expect(row.amount).toBe(124999);
    expect(row.date).toEqual(new Date(2026, 8, 5, 12));
    expect(row.description).toBe("AMAZON PAY INDIA PRIVATE");
  });

  it("uses Cr markers for credits and treats unmarked rows as charges once the convention is established", () => {
    const rows = parse(HDFC_STYLE).rows;
    expect(rows[0].direction).toBe("debit");
    expect(rows[0].confidence).toBe("high");
    expect(rows[2]).toMatchObject({ direction: "credit", kind: "refund" });
  });

  it("classifies interest, GST and EMI rows", () => {
    const rows = parse(HDFC_STYLE).rows;
    expect(rows[4].kind).toBe("interest");
    expect(rows[5].kind).toBe("tax");
    expect(rows[6].kind).toBe("emi");
  });

  it("starts EMI and card-payment rows excluded, with an explanation", () => {
    const rows = parse(HDFC_STYLE).rows;
    expect(rows[6].suggestedInclude).toBe(false);
    expect(rows[6].notes[0]).toMatch(/EMI/);
    expect(rows[3]).toMatchObject({ kind: "payment", suggestedInclude: false });
    expect(rows[0].suggestedInclude).toBe(true);
  });
});

describe("parsePastedStatement — other bank formats", () => {
  it("handles dd MMM yy dates with space-separated columns and Dr/Cr suffixes", () => {
    const text = `12 Sep 26  UBER INDIA SYSTEMS        BANGALORE   389.50 Dr
14 Sep 26  CASHBACK CREDIT                         150.00 Cr`;
    const rows = parse(text).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: 389.5, direction: "debit", description: "UBER INDIA SYSTEMS BANGALORE" });
    expect(rows[1]).toMatchObject({ amount: 150, direction: "credit", kind: "cashback" });
  });

  it("drops a second (posting) date column from the description", () => {
    const rows = parse("03-09-2026 04-09-2026 MAKEMYTRIP INDIA 8,450.00").rows;
    expect(rows[0].description).toBe("MAKEMYTRIP INDIA");
    expect(rows[0].date).toEqual(new Date(2026, 8, 3, 12));
  });

  it("maps separate Debit / Credit columns from a tab-separated bank table", () => {
    const text = `Date\tNarration\tDebit\tCredit\tBalance
01/10/2026\tSALARY ACME LTD\t\t85,000.00\t1,02,000.00
03/10/2026\tRENT TRANSFER\t20,000.00\t\t82,000.00`;
    const rows = parse(text).rows;
    expect(rows[0]).toMatchObject({ amount: 85000, direction: "credit" });
    expect(rows[1]).toMatchObject({ amount: 20000, direction: "debit" });
    expect(rows.every((r) => r.issues.every((i) => !i.blocking))).toBe(true);
  });

  it("assumes the year for year-less dates and flags it", () => {
    const rows = parse("05 Oct  ZOMATO  220.00").rows;
    expect(rows[0].date).toEqual(new Date(2026, 9, 5, 12));
    expect(rows[0].issues.map((i) => i.code)).toContain("year_assumed");
  });

  it("rolls a year-less date that would be in the future back a year", () => {
    const rows = parse("15 Dec  BOOKMYSHOW  600.00").rows;
    expect(rows[0].date?.getFullYear()).toBe(2025);
  });
});

describe("parsePastedStatement — multiline and ambiguity", () => {
  it("joins wrapped descriptions onto the row above", () => {
    const text = `08/09/2026 PAYU*FLIPKART INTERNET
PVT LTD BANGALORE 2,349.00
09/09/2026 BIGBASKET 812.75`;
    const rows = parse(text).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toBe("PAYU*FLIPKART INTERNET PVT LTD BANGALORE");
    expect(rows[0].amount).toBe(2349);
    expect(rows[0].lineEnd).toBe(1);
  });

  it("flags a refund with no Cr marker instead of guessing its direction", () => {
    const row = parse("07/09/2026 REFUND MYNTRA 999.00").rows[0];
    expect(row.direction).toBeNull();
    expect(row.confidence).toBe("low");
    expect(row.issues.find((i) => i.code === "direction_unclear")?.blocking).toBe(true);
  });

  it("flags rows with several amounts instead of picking silently", () => {
    const row = parse("11/09/2026 FUEL SURCHARGE WAIVER 1,000.00 25.00").rows[0];
    expect(row.issues.find((i) => i.code === "multiple_amounts")?.blocking).toBe(true);
    expect(row.amountCandidates).toEqual([1000, 25]);
  });

  it("flags a dated row with no amount", () => {
    const row = parse("11/09/2026 SOMETHING WITHOUT AMOUNT").rows[0];
    expect(row.amount).toBeNull();
    expect(row.issues.map((i) => i.code)).toContain("no_amount");
  });

  it("warns (non-blocking) when the paste has no Cr/Dr markers at all", () => {
    const row = parse("11/09/2026 CROMA 5,499.00").rows[0];
    expect(row.direction).toBe("debit");
    expect(row.confidence).toBe("medium");
    expect(row.issues.every((i) => !i.blocking)).toBe(true);
  });

  it("does not read reference numbers, pin codes or reward points as amounts", () => {
    expect(findAmounts("REF 123456789012 BANGALORE 560001 12").map((t) => t.value)).toEqual([]);
  });

  it("returns nothing for empty or non-statement input", () => {
    expect(parse("").rows).toEqual([]);
    const junk = parse("hello world\nthis is not a statement");
    expect(junk.rows).toEqual([]);
    expect(junk.ignored).toHaveLength(2);
  });

  it("ignores opening/closing balance lines even when dated", () => {
    const rows = parse("01/09/2026 OPENING BALANCE 10,000.00\n02/09/2026 DMART 1,100.00").rows;
    expect(rows.map((r) => r.description)).toEqual(["DMART"]);
  });

  it("preserves the original source text for each row", () => {
    const result = parse(HDFC_STYLE);
    expect(result.rows[0].sourceText).toBe("02/09/2026\tSWIGGY BANGALORE\t452.00");
    expect(result.lines).toHaveLength(HDFC_STYLE.split("\n").length);
  });
});

const CATEGORIES = [
  { id: "c-food", name: "Food", type: "expense" },
  { id: "c-ref", name: "Refunds", type: "income" },
] as unknown as Category[];

describe("capture review → Transaction Studio staged records", () => {
  it("blocks continuing while an included row has an unresolved issue, and clears on edit or confirm", () => {
    let rows = toReviewRows(parse("07/09/2026 REFUND MYNTRA 999.00\n08/09/2026 DMART 100.00").rows);
    expect(canContinue(rows)).toBe(false);
    rows = rows.map((r) => (r.id === "r1" ? applyRowPatch(r, { direction: "credit" }) : r));
    expect(openIssues(rows[0])).toEqual([]);
    expect(rows[0].action).toBe("refund");
    expect(canContinue(rows)).toBe(true);
  });

  it("explicit confirm clears flagged-but-complete rows; incomplete rows still can't continue", () => {
    const rows = toReviewRows(parse("11/09/2026 FUEL 1,000.00 Dr 25.00 Dr\n12/09/2026 NO AMOUNT HERE").rows);
    const confirmed = rows.map((r) => applyRowPatch(r, { confirmed: true }));
    expect(openIssues(confirmed[0])).toEqual([]);
    expect(canContinue(confirmed)).toBe(false);
    expect(canContinue([confirmed[0]])).toBe(true);
  });

  it("builds StagedRecords only for included rows, and Studio's preflight requires a category", () => {
    const rows = toReviewRows(parse(HDFC_STYLE).rows);
    const staged = toStagedRecords(rows);
    expect(staged.map((s) => s.id)).toEqual(["r1", "r2", "r3", "r5", "r6"]);
    expect(staged[2]).toMatchObject({ flowType: "reversal", direction: "credit", needsReview: false });
    const blockers = getPreflightBlockers(staged, CATEGORIES);
    expect(blockers).toHaveLength(5);
    expect(blockers[0].blockingReasons[0].code).toBe("unresolved_category");

    const categorized = toStagedRecords(rows.map((r) => applyRowPatch(r, { category: r.direction === "credit" ? "Refunds" : "Food" })));
    expect(getPreflightBlockers(categorized, CATEGORIES)).toEqual([]);
  });

  it("never offers EMI / loan / transfer actions", () => {
    const staged = toStagedRecords(toReviewRows(parse(HDFC_STYLE).rows).map((r) => applyRowPatch(r, { include: true })));
    expect(staged.every((s) => s.flowType === "expense" || s.flowType === "income" || s.flowType === "reversal")).toBe(true);
  });

  it("feeds Studio's duplicate check — matches an existing transaction and same-paste repeats", () => {
    const rows = toReviewRows(parse("02/09/2026 SWIGGY BANGALORE 452.00\n02/09/2026 SWIGGY BANGALORE 452.00").rows);
    const staged = toStagedRecords(rows);
    const warnings = detectFreshDuplicatesForCommit(staged, [], "acc-card");
    expect(warnings.map((w) => w.recordId)).toEqual(["r2"]);

    const existing = [
      { id: "t1", description: "SWIGGY BANGALORE", amount: 452, dateTime: new Date(2026, 8, 2, 20), accountId: "acc-card", type: "expense", deletedAt: null, transferId: null },
    ] as unknown as Transaction[];
    expect(detectFreshDuplicatesForCommit(staged.slice(0, 1), existing, "acc-card")).toHaveLength(1);
  });

  it("scopes the idempotency session to the paste and the account", () => {
    expect(captureSessionId("a  b", "x")).toBe(captureSessionId("a b", "x"));
    expect(captureSessionId("a b", "x")).not.toBe(captureSessionId("a b", "y"));
    expect(captureSessionId("a b", "x")).toMatch(/^smartcapture_[0-9a-f]+$/);
  });
});

describe("parsePastedStatement — month totals (Google Pay history)", () => {
  const GPAY = `2026
November  ₹3,949.90
Jio Prepaid  ₹3,600.90
2 November
ABIN JOHN  ₹350
1 November
2026
October  ₹7,735
Indian Railways  ₹1,521.80
31 October`;

  it("never reads a month heading's total (or its year line) as a transaction", () => {
    const result = parsePastedStatement(GPAY, { today: TODAY });
    expect(result.rows.map((r) => r.amount)).not.toContain(3949.9);
    expect(result.rows.map((r) => r.amount)).not.toContain(7735);
    expect(result.rows.every((r) => !/^(november|october)$/i.test(r.description.trim()))).toBe(true);
    expect(result.ignored.filter((i) => i.reason === "summary").map((i) => i.text)).toEqual(
      expect.arrayContaining(["2026", "November  ₹3,949.90", "October  ₹7,735"]),
    );
  });

  it("still reads a dated row that starts with a month name", () => {
    const result = parsePastedStatement("Oct 5 2026 SWIGGY 450.00", { today: TODAY });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].amount).toBe(450);
  });
});

describe("parsePastedStatement — merchant and amount on one line, date below (Google Pay screenshot)", () => {
  // What OCR read from the screenshot: ₹ comes out as a digit glued to the amount, avatars as stray characters.
  const OCR = [
    "2026",
    "November                     3394990",
    "Jio)  Jio Prepaid                  323,600.90",
    "2 November",
    "G    Google Pay rewards                       +31",
    "1 November",
    "A  ABIN JOHN                      3350",
    "1 November",
    "2026",
    "October                           7.735",
    "il  Indian Railways            31,521.80",
    "31 October",
    "(  Channel Online                   3500",
    "29 October",
    "B     BAAD AKASH APPA                      +3300",
    "24 October",
  ].join("\n");

  const result = parsePastedStatement(OCR, { today: TODAY });

  it("makes one row per transaction, each with the date from the line below", () => {
    expect(result.rows.map((r) => [r.description, r.date?.getDate(), r.date?.getMonth()])).toEqual([
      ["Jio Prepaid", 2, 10],
      ["Google Pay rewards", 1, 10],
      ["ABIN JOHN", 1, 10],
      ["Indian Railways", 31, 9],
      ["Channel Online", 29, 9],
      ["BAAD AKASH APPA", 24, 9],
    ]);
  });

  it("leaves the month totals out", () => {
    expect(result.rows.flatMap((r) => r.amountCandidates)).not.toContain(7735);
    expect(result.rows.flatMap((r) => r.amountCandidates)).not.toContain(3949.9);
  });

  it("reads the ₹ that OCR turned into a leading digit, and says so on the row", () => {
    expect(result.rows.map((r) => [r.description, r.amount])).toEqual([
      ["Jio Prepaid", 3600.9],
      ["Google Pay rewards", 1],
      ["ABIN JOHN", 350],
      ["Indian Railways", 1521.8],
      ["Channel Online", 500],
      ["BAAD AKASH APPA", 300],
    ]);
    expect(result.rows.every((r) => r.issues.some((i) => i.code === "amount_without_decimals" && !i.blocking))).toBe(true);
  });

  it("strips a lowercase avatar scrap but keeps a real first word", () => {
    const r = parsePastedStatement("aq  Indian Railways      1,521.80\n22 October\nMr  Mohan Lal      200.00\n21 October", { today: TODAY });
    expect(r.rows.map((x) => x.description)).toEqual(["Indian Railways", "Mr Mohan Lal"]);
  });

  it("leaves amounts alone when the ₹ was read correctly", () => {
    const r = parsePastedStatement("Jio Prepaid      ₹3,600.90\n2 November\nABIN JOHN      ₹350\n1 November", { today: TODAY });
    expect(r.rows.map((x) => x.amount)).toEqual([3600.9, 350]);
  });

  it("reads a leading + as money in, and no sign as money out", () => {
    const byName = (n: string) => result.rows.find((r) => r.description === n)!;
    expect(byName("Google Pay rewards").direction).toBe("credit");
    expect(byName("BAAD AKASH APPA").direction).toBe("credit");
    expect(byName("ABIN JOHN").direction).toBe("debit");
  });

  it("takes a clean amount as read", () => {
    const clean = parsePastedStatement("Indian Railways      1,521.80\n31 October\nZomato      450.00\n30 October", { today: TODAY });
    expect(clean.rows.map((r) => r.amount)).toEqual([1521.8, 450]);
  });

  it("does not turn a date-above layout into a date-below one", () => {
    const above = parsePastedStatement("2 Nov\nSWIGGY      450.00\n3 Nov\nZOMATO      120.00", { today: TODAY });
    expect(above.rows.map((r) => [r.description, r.date?.getDate()])).toEqual([["SWIGGY", 2], ["ZOMATO", 3]]);
  });
});
