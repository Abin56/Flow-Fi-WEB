/**
 * Generic fallback extractor — unlike the bank-specific extractors, this
 * one has no real bank statement fixture to validate against (its whole
 * point is working for banks nobody's built a dedicated parser for yet),
 * so its tests are synthetic `PdfPageText` fixtures covering the token
 * shapes it's meant to recognize. Also exercises it against the real SBI
 * fixture as a sanity check: it should find rows there too (SBI's layout
 * happens to fit the generic shape), just at lower confidence than the
 * dedicated SBI extractor — proving the fallback would have provided
 * *some* coverage even before the SBI-specific extractor existed.
 */

import { describe, expect, it } from "vitest";
import { extractGenericStatement, isGenericStatementMatch } from "../src/parsing/generic/generic-statement-extractor";
import { detectPossibleBankName } from "../src/parsing/generic/bank-name-guesser";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import sbiCardItems from "./fixtures/real-statements/sbi-card-2026-07.items.json";
import type { PdfPageText } from "../src/pdf/pdf-document-provider";

function item(str: string, x: number, y: number): { str: string; x: number; y: number; width: number; height: number } {
  return { str, x, y, width: str.length * 5, height: 10 };
}

/** A synthetic statement in a layout none of HDFC/SBI's own anchors would recognize — three transaction rows plus unrelated prose, to prove the generic extractor works purely off token shape, not any bank-specific label. */
function fakeStatementPages(): PdfPageText[] {
  const items = [
    item("Some Bank You've Never Heard Of — Card Statement", 10, 900),
    item("This statement covers your recent activity.", 10, 850),
    item("19/07/2026", 10, 700),
    item("Amazon Purchase", 60, 700),
    item("1,234.56", 300, 700),
    item("DR", 330, 700),
    item("20/07/2026", 10, 690),
    item("Payment Received Thank You", 60, 690),
    item("500.00", 300, 690),
    item("CR", 330, 690),
    item("21/07/2026", 10, 680),
    item("Grocery Store", 60, 680),
    item("89.99", 300, 680),
    // No Dr/Cr marker on this one — direction should default to a low-confidence debit.
  ];
  return [{ pageNumber: 1, text: items.map((i) => i.str).join(" "), items }];
}

describe("isGenericStatementMatch / extractGenericStatement", () => {
  it("recognizes a completely unfamiliar layout purely from date+amount token shape", () => {
    const pages = fakeStatementPages();
    expect(isGenericStatementMatch(pages)).toBe(true);

    const result = extractGenericStatement(pages, { accountId: "acc-1" });
    expect(result.diagnostics.detectedSource).toBe("generic");
    expect(result.diagnostics.transactionTableFound).toBe(true);
    expect(result.transactions).toHaveLength(3);
  });

  it("every extracted row is unconditionally needsReview, regardless of how confident the direction marker looked", () => {
    const result = extractGenericStatement(fakeStatementPages(), {});
    expect(result.transactions.every((t) => t.needsReview)).toBe(true);
  });

  it("reads an explicit Dr/Cr marker token when present", () => {
    const result = extractGenericStatement(fakeStatementPages(), {});
    const purchase = result.transactions.find((t) => t.merchantRaw.value.includes("Amazon"));
    const payment = result.transactions.find((t) => t.merchantRaw.value.includes("Payment Received"));
    expect(purchase!.direction.value).toBe("debit");
    expect(payment!.direction.value).toBe("credit");
  });

  it("defaults to a low-confidence debit when no Dr/Cr marker exists at all", () => {
    const grocery = extractGenericStatement(fakeStatementPages(), {}).transactions.find((t) => t.merchantRaw.value.includes("Grocery"));
    expect(grocery!.direction.value).toBe("debit");
    expect(grocery!.direction.source).toBe("unavailable");
  });

  it("does not misfire on a page with fewer than the minimum candidate rows (avoids a stray date+number in prose)", () => {
    const items = [item("Some prose mentioning 19/07/2026 and also Rs. 500.00 once.", 10, 900)];
    const pages: PdfPageText[] = [{ pageNumber: 1, text: items[0]!.str, items }];
    expect(isGenericStatementMatch(pages)).toBe(false);
  });

  it("finds real transaction-shaped rows in the real SBI fixture too, at lower confidence than the dedicated SBI extractor", () => {
    const pages = loadRealStatementPages(sbiCardItems as never);
    const result = extractGenericStatement(pages, {});
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.diagnostics.detectionConfidence).toBeLessThan(0.95);
    expect(result.transactions.every((t) => t.needsReview)).toBe(true);
  });
});

describe("detectPossibleBankName", () => {
  it("recognizes a known issuer's name from raw page text", () => {
    const items = [item("Welcome to your ICICI Bank Credit Card Statement", 10, 900)];
    const pages: PdfPageText[] = [{ pageNumber: 1, text: items[0]!.str, items }];
    expect(detectPossibleBankName(pages)).toBe("ICICI Bank");
  });

  it("returns null when nothing in the known-issuer list appears anywhere", () => {
    const items = [item("Some Bank You've Never Heard Of", 10, 900)];
    const pages: PdfPageText[] = [{ pageNumber: 1, text: items[0]!.str, items }];
    expect(detectPossibleBankName(pages)).toBeNull();
  });

  it("recognizes the real SBI fixture's own issuer name", () => {
    const pages = loadRealStatementPages(sbiCardItems as never);
    expect(detectPossibleBankName(pages)).toBe("SBI Card");
  });
});
