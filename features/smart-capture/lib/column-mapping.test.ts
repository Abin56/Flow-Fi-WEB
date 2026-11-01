import { describe, expect, it } from "vitest";
import { assignRole, buildGrid, detectColumnRoles, headerRole, parseMoneyCell, validateMapping, type ColumnRole } from "./column-mapping";
import { extractMapped, linesForMapping, summarizeExtraction, swapDebitCredit } from "./mapped-extract";
import { annotateOcrRows } from "./ocr-review";
import { parsePastedStatement } from "./parse-pasted-statement";
import type { OcrLine } from "./tesseract-ocr";

const TODAY = new Date(2026, 9, 20);
const tab = (...rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

function auto(text: string, ocrLines?: OcrLine[]) {
  const grid = buildGrid({ text, ocrLines });
  if (!grid) throw new Error("no grid");
  return { grid, ...detectColumnRoles(grid) };
}
const read = (text: string, roles?: ColumnRole[]) => {
  const a = auto(text);
  return extractMapped(a.grid, roles ?? a.roles, { today: TODAY });
};

const BANK = tab(
  ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["01/10/26", "UPI-SWIGGY-9876@ybl", "0000427412345", "01/10/26", "450.00", "", "49,550.00"],
  ["02/10/26", "SALARY CREDIT ACME", "0000427499999", "02/10/26", "", "1,00,000.00", "1,49,550.00"],
  ["03/10/26", "ATM WDL MG ROAD", "0000427455555", "03/10/26", "10,000.00", "", "1,39,550.00"],
);

describe("header and cell reading", () => {
  it("names columns from their headers, whatever the bank calls them", () => {
    expect(headerRole("Withdrawal Amt.")).toBe("debit");
    expect(headerRole("Deposit Amt.")).toBe("credit");
    expect(headerRole("Closing Balance")).toBe("balance");
    expect(headerRole("Chq./Ref.No.")).toBe("reference");
    expect(headerRole("Value Dt")).toBe("ignore");
    expect(headerRole("Txn Date")).toBe("date");
    expect(headerRole("Transaction Details")).toBe("description");
    expect(headerRole("Amount (Dr)")).toBe("debit");
    expect(headerRole("Dr/Cr")).toBe("type");
    expect(headerRole("Branch")).toBeNull();
    // "No" can mean a row counter or a reference number: alone it numbers rows, with Ref/Chq/Cheque it is a reference.
    for (const counter of ["S.No", "Sl. No.", "Sr No", "No.", "#", "Serial No"]) expect(headerRole(counter)).toBe("ignore");
    for (const reference of ["Ref No.", "Cheque No", "Chq./Ref.No."]) expect(headerRole(reference)).toBe("reference");
  });

  it("reads a money cell only when the whole cell is the money", () => {
    expect(parseMoneyCell("1,299.00 Cr")).toMatchObject({ kind: "money", value: 1299, marker: "credit" });
    expect(parseMoneyCell("")).toEqual({ kind: "empty" });
    expect(parseMoneyCell("-")).toEqual({ kind: "empty" });
    expect(parseMoneyCell("0.00")).toEqual({ kind: "zero" });
    expect(parseMoneyCell("PAID 450.00")).toEqual({ kind: "other" });
  });
});

describe("a bank statement with Debit, Credit and Balance columns", () => {
  it("proposes every role from the header and reads debits and credits from their columns", () => {
    const { roles, confidence, grid } = auto(BANK);
    expect(grid.method).toBe("delimited");
    expect(roles).toEqual(["date", "description", "reference", "ignore", "debit", "credit", "balance"]);
    expect(confidence.every((c) => c === "high")).toBe(true);

    const { result, balance } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.description, r.amount, r.direction])).toEqual([
      ["UPI-SWIGGY-9876@ybl", 450, "debit"],
      ["SALARY CREDIT ACME", 100000, "credit"],
      ["ATM WDL MG ROAD", 10000, "debit"],
    ]);
    expect(result.rows.map((r) => r.referenceNumber)).toEqual(["0000427412345", "0000427499999", "0000427455555"]);
    // Balance is checked, never imported as an amount.
    expect(result.rows.every((r) => r.issues.length === 0)).toBe(true);
    expect(balance).toMatchObject({ mapped: true, checked: 2, matched: 2, mismatched: 0, trusted: true });
    expect(result.rows[1].directionBasis).toBe("column");
  });

  it("finds the same roles with no header at all, using the running balance", () => {
    const body = BANK.split("\n").slice(1).join("\n");
    const { roles, confidence } = auto(body);
    expect(roles).toEqual(["date", "description", "reference", "ignore", "debit", "credit", "balance"]);
    // Debit-before-Credit is the usual order but nothing in the text proves it → marked for a look.
    expect(confidence[4]).toBe("check");
    expect(confidence[6]).toBe("high");
  });

  it("blocks a row whose balance doesn't follow its amount", () => {
    const more = tab(
      ...BANK.split("\n").map((l) => l.split("\t")),
      ["04/10/26", "UPI-ZOMATO", "0000427400001", "04/10/26", "300.00", "", "1,39,250.00"],
      ["05/10/26", "UPI-UBER", "0000427400002", "05/10/26", "200.00", "", "1,39,050.00"],
      ["06/10/26", "UPI-FUEL", "0000427400003", "06/10/26", "1,000.00", "", "1,38,050.00"],
    ).replace("1,39,250.00", "1,39,000.00"); // the 04/10 balance is off by 250
    const { result, balance } = read(more);
    expect(balance.trusted).toBe(true);
    const flagged = result.rows.filter((r) => r.issues.some((i) => i.code === "balance_mismatch" && i.blocking));
    expect(flagged.map((r) => r.description)).toContain("UPI-ZOMATO");
    expect(balance.mismatched).toBe(flagged.length);
  });

  it("lets the user swap meanings; a mapping can't use Amount together with Debit/Credit", () => {
    const { grid, roles } = auto(BANK);
    const swapped = assignRole(assignRole(roles, 4, "credit"), 5, "debit");
    expect(swapped.slice(4, 6)).toEqual(["credit", "debit"]);
    const { result, balance } = extractMapped(grid, swapped, { today: TODAY });
    expect(result.rows[0].direction).toBe("credit"); // follows the user's mapping…
    expect(balance.inverted).toBe(true); // …and the balance says the two columns look swapped, so the preview can offer the swap
    expect(extractMapped(grid, swapDebitCredit(swapped), { today: TODAY }).balance.inverted).toBe(false);
    const both = assignRole(roles, 1, "amount");
    expect(validateMapping(grid, both).some((p) => p.level === "error")).toBe(true);
  });
});

describe("other statement layouts", () => {
  it("one Amount column with a Cr/Dr column beside it", () => {
    const text = tab(
      ["Date", "Description", "Amount", "Dr/Cr"],
      ["05/10/2026", "SWIGGY BANGALORE", "452.00", "Dr"],
      ["07/10/2026", "REFUND AMAZON", "1,299.00", "Cr"],
    );
    const { roles } = auto(text);
    expect(roles).toEqual(["date", "description", "amount", "type"]);
    const { result } = read(text);
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[452, "debit"], [1299, "credit"]]);
    expect(result.rows.every((r) => !r.issues.some((i) => i.blocking))).toBe(true);
  });

  it("a card statement: amount with Cr attached, no headers, a trailing country column", () => {
    const text = tab(["05/10/2026", "SWIGGY BANGALORE", "452.00"], ["07/10/2026", "REFUND AMAZON", "1,299.00 Cr"]);
    const { roles } = auto(text);
    expect(roles).toEqual(["date", "description", "amount"]);
    const { result } = read(text);
    expect(result.rows.map((r) => r.direction)).toEqual(["debit", "credit"]);
  });

  it("an extra date column and a serial-number column are ignored, wherever they sit", () => {
    const text = tab(["1", "05 Oct 2026", "06 Oct 2026", "SWIGGY BANGALORE", "452.00 Dr", "9,548.00"], ["2", "08 Oct 2026", "09 Oct 2026", "ZOMATO", "310.00 Dr", "9,238.00"]);
    const { roles, grid } = auto(text);
    expect(roles).toEqual(["ignore", "date", "ignore", "description", "amount", "balance"]);
    const { result } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.date?.getDate(), r.description, r.amount])).toEqual([[5, "SWIGGY BANGALORE", 452], [8, "ZOMATO", 310]]);
  });

  it("monospaced text with aligned columns, including blank Debit/Credit cells", () => {
    const text = [
      "Date        Particulars                Debit        Credit       Balance",
      "01/10/2026  UPI SWIGGY                  450.00                 49,550.00",
      "02/10/2026  SALARY ACME                         1,00,000.00  1,49,550.00",
      "03/10/2026  ATM WITHDRAWAL           10,000.00               1,39,550.00",
    ].join("\n");
    // The header is slightly mis-aligned on purpose: columns come from the data rows.
    const { roles, grid } = auto(text);
    expect(grid.method).toBe("aligned");
    expect(roles).toEqual(["date", "description", "debit", "credit", "balance"]);
    const { result } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[450, "debit"], [100000, "credit"], [10000, "debit"]]);
  });

  it("CSV", () => {
    const text = ["Date,Description,Debit,Credit,Balance", '01/10/2026,"SWIGGY, BLR",450.00,,"49,550.00"', '02/10/2026,SALARY,,"1,00,000.00","1,49,550.00"'].join("\n");
    const { grid, roles } = auto(text);
    expect(grid.method).toBe("delimited");
    expect(roles).toEqual(["date", "description", "debit", "credit", "balance"]);
    expect(extractMapped(grid, roles, { today: TODAY }).result.rows.map((r) => r.description)).toEqual(["SWIGGY, BLR", "SALARY"]);
  });
});

describe("single-spaced text pasted from a PDF", () => {
  const PDF = ["01 Oct 2026 UPI SWIGGY BANGALORE 450.00 49,550.00", "02 Oct 2026 SALARY ACME 1,00,000.00 1,49,550.00", "03 Oct 2026 ATM WITHDRAWAL MG ROAD 10,000.00 1,39,550.00"].join("\n");

  it("reads date · description · numbers, finds the balance, and works direction out from it — saying so", () => {
    const { roles, grid } = auto(PDF);
    expect(grid.method).toBe("tokens");
    expect(roles).toEqual(["date", "description", "amount", "balance"]);
    const { result, balance } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[450, null], [100000, "credit"], [10000, "debit"]]);
    // The first row has no earlier balance, so nothing can settle it — it asks. The others are worked out and flagged for a look.
    expect(result.rows[0].issues.some((i) => i.code === "direction_unclear" && i.blocking)).toBe(true);
    expect(result.rows[1].issues.map((i) => i.code)).toContain("direction_inferred");
    expect(result.rows[1].directionBasis).toBe("balance");
    expect(balance.trusted).toBe(true);
  });

  it("with no balance and no marker, nothing is invented: the existing card convention applies and is flagged", () => {
    const { roles, grid } = auto("05 Oct 2026 SWIGGY BANGALORE 452.00\n06 Oct 2026 ZOMATO 310.00");
    expect(roles).toEqual(["date", "description", "amount"]);
    const { result } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => r.direction)).toEqual(["debit", "debit"]);
    expect(result.rows[0].issues.map((i) => i.code)).toContain("direction_unclear");
  });
});

describe("screenshots (word positions)", () => {
  /** Words placed at fixed x per column, so blank cells leave real gaps. */
  function row(y: number, cells: (string | null)[], xs: number[], conf: Record<string, number> = {}): OcrLine {
    const words: OcrLine["words"] = [];
    cells.forEach((cell, c) => {
      let x = xs[c];
      for (const text of (cell ?? "").split(" ").filter(Boolean)) {
        const width = text.length * 10;
        words.push({ text, confidence: conf[text] ?? 96, bbox: { x0: x, y0: y, x1: x + width, y1: y + 20 } });
        x += width + 6;
      }
    });
    const sorted = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const text = sorted.map((w, i) => (i === 0 ? "" : w.bbox.x0 - sorted[i - 1].bbox.x1 > 30 ? "\t" : " ") + w.text).join("");
    return { text, bbox: { x0: xs[0], y0: y, x1: Math.max(...sorted.map((w) => w.bbox.x1)), y1: y + 20 }, words };
  }
  const xs = [10, 140, 420, 560, 720];
  const lines = [
    row(0, ["Date", "Narration", "Withdrawal", "Deposit", "Balance"], xs),
    row(30, ["01/10/2026", "UPI SWIGGY BANGALORE", "450.00", null, "49,550.00"], xs),
    row(60, ["02/10/2026", "SALARY ACME", null, "1,00,000.00", "1,49,550.00"], xs),
    row(90, ["03/10/2026", "ATM WITHDRAWAL", "10,000.00", null, "1,39,550.00"], xs, { "10,000.00": 60 }),
  ];
  const text = lines.map((l) => l.text).join("\n");

  it("finds columns by position, so a blank Debit or Credit cell keeps its column", () => {
    const { roles, grid } = auto(text, lines);
    expect(grid.method).toBe("positioned");
    expect(roles).toEqual(["date", "description", "debit", "credit", "balance"]);
    const { result } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[450, "debit"], [100000, "credit"], [10000, "debit"]]);
  });

  it("the safety layer judges only mapped value columns: direction comes from the column, a doubtful Balance word doesn't flag the row", () => {
    const noisy = lines.map((l, i) => (i === 2 ? { ...l, words: l.words.map((w) => (w.text === "1,49,550.00" ? { ...w, confidence: 40 } : w)) } : l));
    const { roles, grid } = auto(text, noisy);
    const { result } = extractMapped(grid, roles, { today: TODAY });
    const annotated = annotateOcrRows(result.rows, linesForMapping(grid, roles, noisy), { hasCreditMarkers: result.hasCreditMarkers });
    const codes = annotated.map((r) => r.issues.filter((i) => i.blocking).map((i) => i.code));
    expect(codes[0]).toEqual([]); // clear read, direction from the Debit column: nothing to click
    expect(codes[1]).toEqual([]); // the unclear word is in the Balance column, which is not imported
    expect(codes[2]).toEqual(["low_confidence_amount"]); // an unclear imported amount still blocks
  });
});

describe("validation and summary", () => {
  it("needs a date, a description and a money column; keeps optional columns optional", () => {
    const { grid, roles } = auto(BANK);
    expect(validateMapping(grid, roles).filter((p) => p.level === "error")).toEqual([]);
    const noMoney = roles.map((r) => (r === "debit" || r === "credit" ? "ignore" : r)) as ColumnRole[];
    expect(validateMapping(grid, noMoney).map((p) => p.message).join(" ")).toMatch(/money column/);
    // Reference, balance and the value date can all be ignored without any error.
    const minimal = roles.map((r) => (r === "reference" || r === "balance" ? "ignore" : r)) as ColumnRole[];
    expect(validateMapping(grid, minimal).filter((p) => p.level === "error")).toEqual([]);
  });

  it("totals what was read", () => {
    const { result } = read(BANK);
    const s = summarizeExtraction(result.rows);
    expect(s).toMatchObject({ rows: 3, needsLook: 0, debitPaise: 1045000, creditPaise: 10000000 });
  });

  it("returns no grid when the text has no table", () => {
    expect(buildGrid({ text: "hello world" })).toBeNull();
  });
});

describe("parity with the plain parser on ordinary card layouts", () => {
  const FIXTURES: Record<string, string> = {
    aligned: "02/09/2026  SWIGGY BANGALORE             452.00\n07/09/2026  REFUND AMAZON PAY INDIA    1,299.00 Cr\n15/09/2026  FINANCE CHARGES              312.40\nTotal Amount Due                       1,28,000.00",
    "C/D column with a country column": ["03 Oct 26\tRETAIL STORE LIMITE\tIN\t101.00\tD", "03 Oct 26\tRETAIL STORE LIMITE\tIN\t101.00\tC", "04 Oct 26\tUBER INDIA\tIN\t389.50\tD"].join("\n"),
    "single spaces": "05 Oct 2026 SWIGGY BANGALORE 452.00\n07 Oct 2026 REFUND MYNTRA 1,299.00 Cr\n08 Oct 2026 UBER 389.50",
    "pipes": "| 05/10/2026 | SWIGGY | 452.00 |\n| 07/10/2026 | REFUND | 1,299.00 Cr |",
    "wrapped description": "05/10/2026\tSWIGGY BANGALORE\t452.00\nKARNATAKA\n06/10/2026\tUBER\t390.00",
  };
  const shape = (rows: { date: Date | null; description: string; amount: number | null; direction: string | null; issues: { code: string; blocking: boolean }[] }[]) =>
    rows.map((r) => [r.date?.getTime(), r.description, r.amount, r.direction, r.issues.filter((i) => i.blocking).map((i) => i.code)]);

  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`${name}: the confirmed detected mapping reads exactly what the plain parser reads`, () => {
      const plain = parsePastedStatement(text, { today: TODAY });
      expect(shape(read(text).result.rows)).toEqual(shape(plain.rows));
    });
  }
});

describe("a UPI text column is the description, not a reference (real screenshot, 2026-11-02)", () => {
  const rows = [
    ["1", "01-10-2026", "UPI/627481159639/CR/MOH", "", "2000.00", "$9,694.47"],
    ["2", "03-10-2026", "UPI/627632125367/DR/Jio", "299.00", "", "711,395.47"],
    ["3", "09-10-2026", "NEFT/SBIN526282200965/S", "", "12000.00", "¥13,395.47"],
    ["4", "10-10-2026", "UPI/628323405861/DR/ABIN", "1000.00", "", "$12,395.47"],
  ];

  it("'Remarks Instrument' reads as Description, the Sr No counter is ignored, and OCR's $ / ¥ for ₹ doesn't hide the balance", () => {
    const text = tab(["Sr No", "Date", "Remarks Instrument", "Debit", "Credit", "Balance"], ...rows);
    const { roles } = auto(text);
    expect(roles).toEqual(["ignore", "date", "description", "debit", "credit", "balance"]);
  });

  it("with no header at all the widest text column still becomes the Description (never Reference with nothing left)", () => {
    const { roles } = auto(tab(...rows));
    expect(roles[2]).toBe("description");
  });

  it("a mapping with no Description names the likely column and offers it in one click", () => {
    const text = tab(["Sr No", "Date", "Remarks Instrument", "Debit", "Credit", "Balance"], ...rows);
    const { grid, roles } = auto(text);
    const noDesc = assignRole(roles, 2, "reference");
    const problem = validateMapping(grid, noDesc).find((p) => p.level === "error");
    expect(problem?.fix).toEqual({ column: 2, role: "description" });
    expect(problem?.message).toMatch(/Remarks Instrument/);
    expect(validateMapping(grid, assignRole(noDesc, 2, "description")).filter((p) => p.level === "error")).toEqual([]);
  });
});

describe("currency signs on amounts and balances (₹, Rs., $, ¥ and OCR's other guesses)", () => {
  it("reads the number whatever sign sits in front of it, and leaves ordinary text alone", () => {
    for (const cell of ["₹ 9,694.47", "₹9,694.47", "Rs. 9,694.47", "INR 9,694.47", "$9,694.47", "¥9,694.47", "€ 9,694.47", "£9,694.47", "T9,694.47", "%9,694.47", "|9,694.47"]) {
      expect(parseMoneyCell(cell), cell).toMatchObject({ kind: "money", value: 9694.47 });
    }
    expect(parseMoneyCell("(₹ 450.00)")).toMatchObject({ kind: "money", value: 450, negative: true });
    expect(parseMoneyCell("T-SHIRT 450.00")).toEqual({ kind: "other" });
    expect(parseMoneyCell("UPI/627481159639")).toEqual({ kind: "other" });
  });

  it("a Balance column written with signs is still found, checked, and never imported", () => {
    const text = tab(
      ["Date", "Narration", "Debit", "Credit", "Balance"],
      ["01/10/2026", "UPI SWIGGY", "₹ 450.00", "", "₹ 49,550.00"],
      ["02/10/2026", "SALARY ACME", "", "$1,00,000.00", "$1,49,550.00"],
      ["03/10/2026", "ATM WDL", "¥10,000.00", "", "¥1,39,550.00"],
      ["04/10/2026", "UPI ZOMATO", "Rs. 310.50", "", "T1,39,239.50"],
    );
    const { grid, roles } = auto(text);
    expect(roles).toEqual(["date", "description", "debit", "credit", "balance"]);
    const { result, balance } = extractMapped(grid, roles, { today: TODAY });
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[450, "debit"], [100000, "credit"], [10000, "debit"], [310.5, "debit"]]);
    expect(balance).toMatchObject({ mapped: true, checked: 3, matched: 3, trusted: true, mismatched: 0 });
    expect(result.rows.every((r) => r.issues.length === 0)).toBe(true);
  });

  it("the same without any header: the balance is still recognised by how it moves", () => {
    const text = tab(
      ["01/10/2026", "UPI SWIGGY", "₹ 450.00", "", "₹ 49,550.00"],
      ["02/10/2026", "SALARY ACME", "", "$1,00,000.00", "$1,49,550.00"],
      ["03/10/2026", "ATM WDL", "¥10,000.00", "", "¥1,39,550.00"],
    );
    expect(auto(text).roles).toEqual(["date", "description", "debit", "credit", "balance"]);
  });
});
