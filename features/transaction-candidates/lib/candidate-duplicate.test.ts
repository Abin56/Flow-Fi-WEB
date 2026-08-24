import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { evaluateCandidateDuplicate } from "./candidate-duplicate";

function existing(overrides: Partial<Transaction> = {}): Pick<Transaction, "id" | "description" | "amount" | "dateTime" | "accountId" | "type"> {
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

function candidate(overrides: Partial<Parameters<typeof evaluateCandidateDuplicate>[0]> = {}) {
  return {
    merchant: "Amazon",
    bankName: "HDFC",
    amount: 499,
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    referenceNumber: null,
    direction: "debit" as const,
    accountId: "account-a" as string | null,
    ...overrides,
  };
}

describe("evaluateCandidateDuplicate", () => {
  it("finds no duplicate when nothing matches", () => {
    const result = evaluateCandidateDuplicate(candidate(), [existing({ description: "SWIGGY", amount: 100 })]);
    expect(result.duplicateOfTransactionId).toBeNull();
  });

  it("matches exact merchant/amount/date with no reference number at 0.9 confidence", () => {
    const result = evaluateCandidateDuplicate(candidate(), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
    expect(result.confidence).toBe(0.9);
  });

  it("matches exact date with a confirmed reference number at 0.98 confidence", () => {
    const result = evaluateCandidateDuplicate(candidate({ referenceNumber: "REF123" }), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
    expect(result.confidence).toBe(0.98);
  });

  it("matches exact date with an unconfirmed reference number at 0.75 confidence", () => {
    const result = evaluateCandidateDuplicate(candidate({ referenceNumber: "NOMATCH" }), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
    expect(result.confidence).toBe(0.75);
  });

  it("matches a ±1-day near duplicate at 0.6 confidence", () => {
    const result = evaluateCandidateDuplicate(candidate({ transactionDate: new Date("2026-08-02T00:00:00.000Z") }), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
    expect(result.confidence).toBe(0.6);
  });

  it("does not match beyond the 1-day gap", () => {
    const result = evaluateCandidateDuplicate(candidate({ transactionDate: new Date("2026-08-05T00:00:00.000Z") }), [existing()]);
    expect(result.duplicateOfTransactionId).toBeNull();
  });

  it("does not match when the amount differs beyond the epsilon", () => {
    const result = evaluateCandidateDuplicate(candidate({ amount: 500 }), [existing()]);
    expect(result.duplicateOfTransactionId).toBeNull();
  });

  it("matches when the amount differs within the epsilon", () => {
    const result = evaluateCandidateDuplicate(candidate({ amount: 499.005 }), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
  });

  // Previously "does not match" (the anchored, description-anchored rule alone never fires here,
  // since "FLIPKART" isn't found in "AMAZON PAY REF123") — now still flagged via the unconditional
  // amount+date fallback (`checkForDuplicates`'s "Amount+date fallback" doc section), at a visibly
  // lower confidence than the anchored tiers above it, since same amount + same exact date is treated
  // as worth a warning on its own regardless of description.
  it("still matches via the amount+date fallback when the merchant text isn't found in the existing description, at a lower confidence than an anchored match", () => {
    const result = evaluateCandidateDuplicate(candidate({ merchant: "Flipkart" }), [existing()]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
    expect(result.confidence).toBeLessThan(0.6); // below every anchored tier — fallback-only signal
  });

  it("falls back to bankName when merchant is null (e.g. an ATM withdrawal with no counterparty)", () => {
    const result = evaluateCandidateDuplicate(
      candidate({ merchant: null, bankName: "AMAZON" }),
      [existing()],
    );
    expect(result.duplicateOfTransactionId).toBe("txn-1");
  });

  // Regression: previously bailed out before checking at all whenever there was no merchant/bankName
  // text (empty description), letting a same-amount, same-date candidate go unflagged no matter how
  // obviously it matched. See `checkCandidateForDuplicates` in `import-candidate.ts` for the
  // identical fix on the write-path enforcement side of this same gap.
  it("still flags same amount + same exact date when the candidate has NEITHER merchant NOR bankName, even against an unrelated existing description", () => {
    const result = evaluateCandidateDuplicate(candidate({ merchant: null, bankName: null }), [existing({ description: "Totally Unrelated Text" })]);
    expect(result.duplicateOfTransactionId).toBe("txn-1");
  });

  it("does NOT flag a no-merchant/no-bankName candidate a day off from an existing transaction (exact-day only, no description anchor to justify the ±1-day near-duplicate window)", () => {
    const result = evaluateCandidateDuplicate(
      candidate({ merchant: null, bankName: null, transactionDate: new Date("2026-08-02T00:00:00.000Z") }),
      [existing({ description: "Totally Unrelated Text" })],
    );
    expect(result.duplicateOfTransactionId).toBeNull();
  });

  it("resurrection guard: a re-synced candidate with the exact same fields as an already-committed transaction is flagged, not silently re-importable", () => {
    // Simulates the exact scenario in this file's module doc: Android re-uploads
    // the same smsItemId after the web app already imported and deleted it.
    const alreadyCommitted = existing({ id: "txn-committed-1", description: "Amazon REF123" });
    const resurrected = candidate({ referenceNumber: "REF123" });
    const result = evaluateCandidateDuplicate(resurrected, [alreadyCommitted]);
    expect(result.duplicateOfTransactionId).toBe("txn-committed-1");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
