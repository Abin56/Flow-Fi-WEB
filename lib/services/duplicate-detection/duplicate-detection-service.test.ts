import { describe, expect, it } from "vitest";
import { checkForDuplicates, type DuplicateCandidateInput, type ExistingTransactionForDuplicateCheck } from "./duplicate-detection-service";

function existing(overrides: Partial<ExistingTransactionForDuplicateCheck> = {}): ExistingTransactionForDuplicateCheck {
  return {
    id: "txn-1",
    description: "AMAZON PAY REF123",
    amount: 499,
    dateTime: new Date("2026-08-01T00:00:00.000Z"),
    accountId: "account-a",
    type: "expense",
    ...overrides,
  };
}

function candidate(overrides: Partial<DuplicateCandidateInput> = {}): DuplicateCandidateInput {
  return {
    description: "Amazon",
    amount: 499,
    date: new Date("2026-08-01T00:00:00.000Z"),
    direction: "debit",
    accountId: "account-a",
    referenceNumber: null,
    source: "manual",
    ...overrides,
  };
}

describe("checkForDuplicates — core matching rule", () => {
  it("finds no duplicate when nothing matches", () => {
    const result = checkForDuplicates(candidate(), [existing({ description: "SWIGGY", amount: 100 })]);
    expect(result.status).toBe("unique");
    expect(result.matches).toHaveLength(0);
  });

  it("matches exact description/amount/date with no reference number at 0.9 confidence", () => {
    const result = checkForDuplicates(candidate(), [existing()]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.transactionId).toBe("txn-1");
    expect(result.bestMatch?.confidence).toBe(0.9);
  });

  it("matches exact date with a confirmed reference number at 0.98 confidence", () => {
    const result = checkForDuplicates(candidate({ referenceNumber: "REF123" }), [existing()]);
    expect(result.bestMatch?.confidence).toBe(0.98);
  });

  it("matches exact date with an unconfirmed reference number at 0.75 confidence", () => {
    const result = checkForDuplicates(candidate({ referenceNumber: "NOMATCH" }), [existing()]);
    expect(result.bestMatch?.confidence).toBe(0.75);
  });

  it("matches a +/-1-day near duplicate at 0.6 confidence", () => {
    const result = checkForDuplicates(candidate({ date: new Date("2026-08-02T00:00:00.000Z") }), [existing()]);
    expect(result.bestMatch?.confidence).toBe(0.6);
    expect(result.bestMatch?.dayGap).toBe(1);
  });

  it("does not match beyond the 1-day gap", () => {
    const result = checkForDuplicates(candidate({ date: new Date("2026-08-05T00:00:00.000Z") }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("boundary precision: a 2-day gap (one past the threshold) does not match — no off-by-one", () => {
    const result = checkForDuplicates(candidate({ date: new Date("2026-08-03T00:00:00.000Z") }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("a -1-day gap (existing transaction dated AFTER the candidate) also matches — the near-duplicate window is symmetric, not just forward-looking", () => {
    const result = checkForDuplicates(candidate({ date: new Date("2026-07-31T00:00:00.000Z") }), [existing()]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.confidence).toBe(0.6);
    expect(result.bestMatch?.dayGap).toBe(1);
  });

  it("does not match when the amount differs beyond the epsilon", () => {
    const result = checkForDuplicates(candidate({ amount: 500 }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("matches when the amount differs within the epsilon", () => {
    const result = checkForDuplicates(candidate({ amount: 499.005 }), [existing()]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("does not match when the description text isn't found in the existing description", () => {
    const result = checkForDuplicates(candidate({ description: "Flipkart" }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("does not match when direction/type disagree (an expense should never match an income of the same amount)", () => {
    const result = checkForDuplicates(candidate({ direction: "debit" }), [existing({ type: "income" })]);
    expect(result.status).toBe("unique");
  });

  it("matches credit direction against an income-typed existing transaction", () => {
    const result = checkForDuplicates(candidate({ direction: "credit" }), [existing({ type: "income" })]);
    expect(result.status).toBe("duplicate_candidate");
  });
});

describe("checkForDuplicates — requireDescriptionMatch: false (manual entry)", () => {
  it("matches on amount/date/direction alone, ignoring differing description text", () => {
    const result = checkForDuplicates(candidate({ description: "Flipkart", requireDescriptionMatch: false }), [existing({ description: "AMAZON PAY REF123" })]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.transactionId).toBe("txn-1");
  });

  it("still requires direction/type to agree even with description matching disabled", () => {
    const result = checkForDuplicates(candidate({ direction: "debit", requireDescriptionMatch: false }), [existing({ type: "income" })]);
    expect(result.status).toBe("unique");
  });

  it("still requires amount to match within epsilon with description matching disabled", () => {
    const result = checkForDuplicates(candidate({ amount: 500, requireDescriptionMatch: false }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("does not use the +/-1-day near-duplicate window — a 1-day gap does not match", () => {
    const result = checkForDuplicates(candidate({ date: new Date("2026-08-02T00:00:00.000Z"), requireDescriptionMatch: false }), [existing()]);
    expect(result.status).toBe("unique");
  });

  it("matches an exact same-day candidate even with an empty description", () => {
    const result = checkForDuplicates(candidate({ description: "", requireDescriptionMatch: false }), [existing()]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("reason text omits the description clause when description matching was disabled", () => {
    const result = checkForDuplicates(candidate({ description: "Flipkart", requireDescriptionMatch: false }), [existing()]);
    expect(result.bestMatch?.reason).not.toContain("description");
  });
});

describe("checkForDuplicates — account awareness (same amount, different account)", () => {
  it("scores a same-account match at full confidence", () => {
    const result = checkForDuplicates(candidate({ accountId: "account-a" }), [existing({ accountId: "account-a" })]);
    expect(result.bestMatch?.sameAccount).toBe(true);
    expect(result.bestMatch?.confidence).toBe(0.9);
  });

  it("still flags a same-amount, same-date match on a DIFFERENT account, but at reduced confidence", () => {
    const result = checkForDuplicates(candidate({ accountId: "account-a" }), [existing({ accountId: "account-b" })]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.sameAccount).toBe(false);
    expect(result.bestMatch?.confidence).toBeCloseTo(0.45);
    expect(result.bestMatch?.reason).toContain("different account");
  });

  it("never auto-drops a cross-account match — it is surfaced, just weaker", () => {
    const result = checkForDuplicates(candidate({ accountId: "account-a", referenceNumber: "REF123" }), [existing({ accountId: "account-b" })]);
    expect(result.matches).toHaveLength(1);
    expect(result.bestMatch?.confidence).toBeCloseTo(0.49);
  });

  it("treats a null candidate accountId as unknown — full confidence, not penalized", () => {
    const result = checkForDuplicates(candidate({ accountId: null }), [existing({ accountId: "account-b" })]);
    expect(result.bestMatch?.sameAccount).toBe(true);
    expect(result.bestMatch?.confidence).toBe(0.9);
  });

  it("ranks a same-account match above a different-account match when both exist", () => {
    const result = checkForDuplicates(candidate({ accountId: "account-a" }), [
      existing({ id: "txn-cross-account", accountId: "account-b" }),
      existing({ id: "txn-same-account", accountId: "account-a" }),
    ]);
    expect(result.matches).toHaveLength(2);
    expect(result.bestMatch?.transactionId).toBe("txn-same-account");
    expect(result.matches[1]?.transactionId).toBe("txn-cross-account");
  });
});

describe("checkForDuplicates — cross-source scenarios (SMS vs PDF vs manual all feed the same shape)", () => {
  it("an SMS-sourced candidate flags against an already-imported PDF transaction", () => {
    const smsCandidate = candidate({ source: "sms", description: "Amazon", referenceNumber: "UPI/REF123" });
    const pdfImportedTransaction = existing({ id: "txn-from-pdf", description: "AMAZON PAY UPI/REF123" });
    const result = checkForDuplicates(smsCandidate, [pdfImportedTransaction]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.confidence).toBe(0.98);
  });

  it("a PDF statement row flags against an already-imported SMS transaction", () => {
    const pdfCandidate = candidate({ source: "pdf", description: "Swiggy" });
    const smsImportedTransaction = existing({ id: "txn-from-sms", description: "SWIGGY BANGALORE" });
    const result = checkForDuplicates(pdfCandidate, [smsImportedTransaction]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("a manually entered transaction flags against an already-imported SMS or PDF transaction", () => {
    const manualCandidate = candidate({ source: "manual", description: "Netflix" });
    const priorImport = existing({ id: "txn-existing", description: "NETFLIX.COM" });
    const result = checkForDuplicates(manualCandidate, [priorImport]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.transactionId).toBe("txn-existing");
  });

  it("source of the incoming candidate never changes the matching outcome by itself — only description/amount/date/direction/account do", () => {
    const base = { description: "Amazon", amount: 499, date: new Date("2026-08-01T00:00:00.000Z"), direction: "debit" as const, accountId: "account-a", referenceNumber: null };
    const smsResult = checkForDuplicates({ ...base, source: "sms" }, [existing()]);
    const pdfResult = checkForDuplicates({ ...base, source: "pdf" }, [existing()]);
    const manualResult = checkForDuplicates({ ...base, source: "manual" }, [existing()]);
    expect(smsResult.bestMatch?.confidence).toBe(pdfResult.bestMatch?.confidence);
    expect(pdfResult.bestMatch?.confidence).toBe(manualResult.bestMatch?.confidence);
  });

  it("multiple existing matches across sources are all returned, sorted by confidence", () => {
    const result = checkForDuplicates(candidate({ referenceNumber: "REF123" }), [
      existing({ id: "txn-weak", description: "Amazon", dateTime: new Date("2026-08-02T00:00:00.000Z") }),
      existing({ id: "txn-strong", description: "Amazon REF123" }),
    ]);
    expect(result.matches.map((m) => m.transactionId)).toEqual(["txn-strong", "txn-weak"]);
  });
});

/**
 * Regression coverage for the strict "same amount + same exact date, by itself, must warn" product
 * requirement — a stricter fallback layered on top of everything above it, scoped to SMS and PDF
 * (credit-card PDF review shares the PDF path in `commit-review-import.ts`, so it's covered by proxy;
 * see that module's own regression tests). Ignores description, reference number, account, and even
 * direction for this fallback specifically — the anchored, stronger-confidence rules tested in the
 * describe blocks above remain completely unchanged and untouched by this fallback.
 */
describe("checkForDuplicates — amount+date-only fallback (SMS/PDF, ignores description/account/direction)", () => {
  it("SMS: same amount + same exact date warns even with a completely different, non-empty description", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "Totally Different Merchant" }), [existing({ description: "Unrelated Existing Text" })]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.transactionId).toBe("txn-1");
  });

  it("SMS: same amount + same exact date warns with an EMPTY description", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "" }), [existing({ description: "Unrelated Existing Text" })]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("SMS: same amount + same exact date warns even when direction disagrees (a same-day, same-amount refund still gets flagged for review)", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "Totally Different Merchant", direction: "credit" }), [
      existing({ description: "Unrelated Existing Text", type: "expense" }),
    ]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("SMS: same amount + same exact date warns even when the account differs (still surfaced, just at reduced confidence)", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "Totally Different Merchant", accountId: "account-OTHER" }), [
      existing({ description: "Unrelated Existing Text", accountId: "account-a" }),
    ]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.sameAccount).toBe(false);
  });

  it("SMS: same amount + same exact date warns even when EVERY other identifying field is missing/different at once (no description, no reference number, different account, different direction)", () => {
    const result = checkForDuplicates(
      candidate({ source: "sms", description: "", referenceNumber: null, accountId: "account-OTHER", direction: "credit" }),
      [existing({ description: "Unrelated Existing Text", accountId: "account-a", type: "expense" })],
    );
    expect(result.status).toBe("duplicate_candidate");
  });

  it("PDF: same amount + same exact date warns even with a completely different, non-empty description", () => {
    const result = checkForDuplicates(candidate({ source: "pdf", description: "Totally Different Merchant" }), [existing({ description: "Unrelated Existing Text" })]);
    expect(result.status).toBe("duplicate_candidate");
    expect(result.bestMatch?.transactionId).toBe("txn-1");
  });

  it("PDF: same amount + same exact date warns with an EMPTY description (blank counterparty column)", () => {
    const result = checkForDuplicates(candidate({ source: "pdf", description: "" }), [existing({ description: "Unrelated Existing Text" })]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("PDF: same amount + same exact date warns even when direction disagrees", () => {
    const result = checkForDuplicates(candidate({ source: "pdf", description: "Totally Different Merchant", direction: "credit" }), [
      existing({ description: "Unrelated Existing Text", type: "expense" }),
    ]);
    expect(result.status).toBe("duplicate_candidate");
  });

  it("does NOT warn from this fallback for a same-amount candidate on a DIFFERENT date (even one day off — no near-duplicate window for this fallback)", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "Totally Different Merchant", date: new Date("2026-08-02T00:00:00.000Z") }), [
      existing({ description: "Unrelated Existing Text" }),
    ]);
    expect(result.status).toBe("unique");
  });

  it("does NOT warn from this fallback for a same-date candidate with a DIFFERENT amount", () => {
    const result = checkForDuplicates(candidate({ source: "sms", description: "Totally Different Merchant", amount: 501 }), [
      existing({ description: "Unrelated Existing Text", amount: 499 }),
    ]);
    expect(result.status).toBe("unique");
  });

  it("does NOT apply this fallback to source: 'manual' — manual entry keeps its existing direction-required rule unchanged", () => {
    const result = checkForDuplicates(candidate({ source: "manual", description: "Totally Different Merchant", direction: "credit", requireDescriptionMatch: false }), [
      existing({ description: "Unrelated Existing Text", type: "expense" }),
    ]);
    expect(result.status).toBe("unique");
  });

  it("the fallback match sits at a lower confidence than any anchored match for the same pair, and never overrides a stronger anchored match", () => {
    // Same description/amount/date as `existing()` (a genuine anchored match) — the anchored 0.9 tier
    // must win, not the weaker fallback, and there must be exactly one match, not two, for this pair.
    const result = checkForDuplicates(candidate({ source: "sms" }), [existing()]);
    expect(result.matches).toHaveLength(1);
    expect(result.bestMatch?.confidence).toBe(0.9);
  });

  it("SMS and PDF behave identically for the amount+date-only fallback — same inputs, same outcome", () => {
    const existingTxn = existing({ description: "Unrelated Existing Text" });
    const smsResult = checkForDuplicates(candidate({ source: "sms", description: "Different Merchant A" }), [existingTxn]);
    const pdfResult = checkForDuplicates(candidate({ source: "pdf", description: "Different Merchant B" }), [existingTxn]);
    expect(smsResult.status).toBe("duplicate_candidate");
    expect(pdfResult.status).toBe("duplicate_candidate");
    expect(smsResult.bestMatch?.confidence).toBe(pdfResult.bestMatch?.confidence);
  });
});
