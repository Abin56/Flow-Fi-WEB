/**
 * HDFC Statement Metadata Extractor (Task 4, module 1) — validated against
 * a real HDFC Freedom Credit Card statement (redacted of PII, see
 * tests/fixtures/real-statements/hdfc-freedom-2026-07.items.json's own
 * provenance note). Every expected value below was independently confirmed
 * against the real statement's own printed summary before this test was
 * written — see the Task 4 completion report for the balance-arithmetic
 * cross-check (debits/credits reconciled to the paisa against the
 * statement's own totals).
 */

import { describe, expect, it } from "vitest";
import { extractHdfcMetadata, isHdfcStatement } from "../src/parsing/hdfc/hdfc-metadata-extractor";
import { loadRealStatementPages } from "./fixtures/real-statements/load-real-statement";
import hdfcFreedomItems from "./fixtures/real-statements/hdfc-freedom-2026-07.items.json";

const pages = loadRealStatementPages(hdfcFreedomItems as never);

describe("isHdfcStatement", () => {
  it("recognizes the real HDFC Freedom statement via its GSTIN footer anchor", () => {
    expect(isHdfcStatement(pages)).toBe(true);
  });

  it("does not misfire on an empty page set", () => {
    expect(isHdfcStatement([])).toBe(false);
  });
});

describe("extractHdfcMetadata — against the real (redacted) HDFC Freedom statement", () => {
  const result = extractHdfcMetadata(pages);

  it("extracts bank and card name from the real footer/title text", () => {
    expect(result.cardInfo.bankName.value).toBe("HDFC Bank");
    expect(result.cardInfo.cardName.value).toBe("Freedom Credit Card");
  });

  it("extracts the card's last 4 digits from the masked card number", () => {
    // Redacted fixture uses a placeholder card number ending in 1234 (real statement's actual last 4 digits are not committed to git).
    expect(result.cardInfo.cardLast4.value).toBe("1234");
  });

  it("has no extractable card network — genuinely absent on this statement, not a parsing gap", () => {
    expect(result.cardInfo.network.value).toBeNull();
    expect(result.cardInfo.network.source).toBe("unavailable");
  });

  it("has no distinct statement number — this HDFC card product's layout never prints one", () => {
    expect(result.statementInfo.statementNumber.value).toBeNull();
    expect(result.statementInfo.statementNumber.source).toBe("unavailable");
  });

  it("extracts statement date, billing period, and due date exactly as printed", () => {
    expect(result.statementInfo.statementDate.value).toEqual(new Date(Date.UTC(2026, 6, 19)));
    expect(result.statementInfo.billingPeriodStart.value).toEqual(new Date(Date.UTC(2026, 5, 20)));
    expect(result.statementInfo.billingPeriodEnd.value).toEqual(new Date(Date.UTC(2026, 6, 19)));
    expect(result.statementInfo.paymentDueDate.value).toEqual(new Date(Date.UTC(2026, 7, 8)));
  });

  it("extracts every billing summary figure exactly as printed on the real statement", () => {
    expect(result.billingSummary.openingBalance.value).toBeCloseTo(3910.68, 2);
    expect(result.billingSummary.closingBalance.value).toBeCloseTo(10006.0, 2);
    expect(result.billingSummary.totalDue.value).toBeCloseTo(10006.0, 2);
    expect(result.billingSummary.minimumDue.value).toBeCloseTo(1818.0, 2);
    expect(result.billingSummary.creditLimit.value).toBeCloseTo(38000, 2);
    expect(result.billingSummary.availableCredit.value).toBeCloseTo(11691, 2);
    expect(result.billingSummary.rewardPointsEarned.value).toBeCloseTo(38, 2);
    expect(result.billingSummary.interestCharged.value).toBeCloseTo(0, 2);
    expect(result.billingSummary.gst.value).toBeCloseTo(36.9, 2);
  });

  it("has no cashback or late fee — genuinely absent line items on this card product", () => {
    expect(result.billingSummary.cashback.value).toBeNull();
    expect(result.billingSummary.cashback.source).toBe("unavailable");
    expect(result.billingSummary.lateFee.value).toBeNull();
    expect(result.billingSummary.lateFee.source).toBe("unavailable");
  });

  it("every extracted field carries a non-trivial confidence, every unavailable field carries confidence 0", () => {
    const extractedFields = [
      result.cardInfo.bankName,
      result.cardInfo.cardName,
      result.cardInfo.cardLast4,
      result.statementInfo.statementDate,
      result.statementInfo.billingPeriodStart,
      result.statementInfo.billingPeriodEnd,
      result.statementInfo.paymentDueDate,
      result.billingSummary.openingBalance,
      result.billingSummary.totalDue,
      result.billingSummary.minimumDue,
      result.billingSummary.creditLimit,
      result.billingSummary.availableCredit,
      result.billingSummary.rewardPointsEarned,
      result.billingSummary.interestCharged,
      result.billingSummary.gst,
    ];
    for (const f of extractedFields) expect(f.confidence).toBeGreaterThan(0.7);

    const unavailableFields = [result.cardInfo.network, result.statementInfo.statementNumber, result.billingSummary.cashback, result.billingSummary.lateFee];
    for (const f of unavailableFields) expect(f.confidence).toBe(0);
  });
});
