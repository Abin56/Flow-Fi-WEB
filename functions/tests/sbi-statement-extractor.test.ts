/**
 * SBI Card metadata + transaction + statement extractors — validated
 * against a real SBI Card statement (redacted of PII, see
 * tests/fixtures/real-statements/sbi-card-2026-07.items.json's own
 * provenance note in this file's sibling module comments). Every expected
 * value below was independently confirmed against the real statement's own
 * printed rows before this test was written.
 */

import { describe, expect, it } from "vitest";
import { extractSbiMetadata, isSbiStatement } from "../src/parsing/sbi/sbi-metadata-extractor";
import { extractSbiTransactions } from "../src/parsing/sbi/sbi-transaction-extractor";
import { extractSbiStatement } from "../src/parsing/sbi/sbi-statement-extractor";
import { isHdfcStatement } from "../src/parsing/hdfc/hdfc-statement-extractor";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import sbiCardItems from "./fixtures/real-statements/sbi-card-2026-07.items.json";

const pages = loadRealStatementPages(sbiCardItems as never);

describe("isSbiStatement", () => {
  it("recognizes the real SBI Card statement via its GSTIN footer anchor", () => {
    expect(isSbiStatement(pages)).toBe(true);
  });

  it("does not misfire on an empty page set", () => {
    expect(isSbiStatement([])).toBe(false);
  });

  it("an SBI Card statement is never also misdetected as HDFC", () => {
    expect(isHdfcStatement(pages)).toBe(false);
  });
});

describe("extractSbiMetadata — against the real (redacted) SBI Card statement", () => {
  const result = extractSbiMetadata(pages);

  it("extracts the bank name from the GSTIN anchor", () => {
    expect(result.cardInfo.bankName.value).toBe("SBI Card");
  });

  it("extracts the card's last 2 printed digits from the masked card number", () => {
    // Redacted fixture uses a placeholder card number ending in 99 (real statement's actual digits are not committed to git).
    expect(result.cardInfo.cardLast4.value).toBe("99");
  });

  it("has no extractable card network or product name — genuinely absent on this statement, not a parsing gap", () => {
    expect(result.cardInfo.network.value).toBeNull();
    expect(result.cardInfo.cardName.value).toBeNull();
  });

  it("extracts statement date, billing period, and due date exactly as printed", () => {
    expect(result.statementInfo.statementDate.value).toEqual(new Date(Date.UTC(2026, 6, 17)));
    expect(result.statementInfo.billingPeriodStart.value).toEqual(new Date(Date.UTC(2026, 5, 18)));
    expect(result.statementInfo.billingPeriodEnd.value).toEqual(new Date(Date.UTC(2026, 6, 17)));
    expect(result.statementInfo.paymentDueDate.value).toEqual(new Date(Date.UTC(2026, 7, 6)));
  });

  it("extracts every billing summary figure exactly as printed on the real statement", () => {
    expect(result.billingSummary.totalDue.value).toBeCloseTo(41208.0, 2);
    expect(result.billingSummary.minimumDue.value).toBeCloseTo(3496.0, 2);
    expect(result.billingSummary.creditLimit.value).toBeCloseTo(80000.0, 2);
    expect(result.billingSummary.availableCredit.value).toBeCloseTo(11537.01, 2);
    expect(result.billingSummary.openingBalance.value).toBeCloseTo(39968.79, 2);
    // "Total Outstanding" — distinct from Total Amount Due on this card product, see module comment.
    expect(result.billingSummary.closingBalance.value).toBeCloseTo(68463.0, 2);
  });

  it("has no reward points, cashback, GST total, or late fee — genuinely absent on this statement's pages, not a parsing gap", () => {
    expect(result.billingSummary.rewardPointsEarned.source).toBe("unavailable");
    expect(result.billingSummary.cashback.source).toBe("unavailable");
    expect(result.billingSummary.gst.source).toBe("unavailable");
    expect(result.billingSummary.lateFee.source).toBe("unavailable");
  });
});

describe("extractSbiTransactions — against the real (redacted) SBI Card statement", () => {
  const result = extractSbiTransactions(pages, { accountId: "acc-123" });

  it("finds the transaction table across both pages it spans on the real fixture", () => {
    expect(result.transactionTableFound).toBe(true);
  });

  it("extracts every real transaction row, including same-day continuation lines with no date of their own", () => {
    expect(result.transactions).toHaveLength(47);
  });

  it("reads the first row's date/merchant/amount/direction exactly as printed", () => {
    const first = result.transactions[0]!;
    expect(first.date.value).toEqual(new Date(Date.UTC(2026, 6, 2)));
    expect(first.merchantRaw.value).toContain("PAYMENT RECEIVED");
    expect(first.amount.value).toBeCloseTo(13574.0, 2);
    expect(first.direction.value).toBe("credit");
    expect(first.needsReview).toBe(false);
  });

  it("extracts the embedded reference number from a PAYMENT RECEIVED row", () => {
    const first = result.transactions[0]!;
    expect(first.referenceNumber.value).toBe("IY000000000000000000000");
  });

  it("carries the preceding row's date forward for a same-day continuation line with no date of its own", () => {
    const igst = result.transactions.find((t) => t.merchantRaw.value.includes("IGST"));
    expect(igst).toBeDefined();
    expect(igst!.date.value).toEqual(new Date(Date.UTC(2026, 6, 17)));
    expect(igst!.date.source).toBe("pattern_match");
    expect(igst!.amount.value).toBeCloseTo(81.77, 2);
    expect(igst!.direction.value).toBe("debit");
  });

  it("flags a row with no printed type code as needsReview instead of silently guessing its direction", () => {
    const untyped = result.transactions.find((t) => t.merchantRaw.value.includes("TRANSFER TO MERCHANT EMI"));
    expect(untyped).toBeDefined();
    expect(untyped!.needsReview).toBe(true);
    expect(untyped!.direction.source).toBe("unavailable");
  });

  it("tags every extracted transaction with the caller-supplied account, as a direct assignment not an inference", () => {
    expect(result.transactions.every((t) => t.suggestedAccount?.value === "acc-123")).toBe(true);
    expect(result.transactions.every((t) => t.suggestedAccount?.source === "account_assignment")).toBe(true);
  });

  it("every extracted row's amount is a positive number reconstructed from its own printed text", () => {
    for (const t of result.transactions) {
      expect(t.amount.value).toBeGreaterThan(0);
      expect(t.originalRawText.length).toBeGreaterThan(0);
    }
  });
});

describe("extractSbiStatement — orchestration", () => {
  it("composes metadata and transactions into one result with rule_based diagnostics", () => {
    const result = extractSbiStatement(pages, { accountId: "acc-123" });
    expect(result.diagnostics.detectedSource).toBe("sbi");
    expect(result.diagnostics.tierUsed).toBe("rule_based");
    expect(result.diagnostics.transactionTableFound).toBe(true);
    expect(result.transactions.length).toBe(47);
    expect(result.cardInfo.bankName.value).toBe("SBI Card");
  });
});
