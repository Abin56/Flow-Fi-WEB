/**
 * Duplicate Detection engine (Statement Intelligence Layer, module 2) —
 * every scenario the task requires, plus a large-fixture performance test.
 * All deterministic, no Firestore (pure functions taking already-fetched
 * existing records) — the Firestore read layer is tested separately in
 * duplicate-lookup-repository.test.ts.
 */

import { describe, expect, it } from "vitest";
import { applyDuplicateDetection } from "../src/duplicate/apply-duplicate-detection";
import { checkStatementDuplicate, checkTransactionDuplicate, detectInternalDuplicates } from "../src/duplicate/duplicate-detector";
import type { ExistingStatementRecord, ExistingTransactionRecord, StatementMetaForDuplicateCheck } from "../src/duplicate/duplicate-types";
import type { WorkspaceTransaction } from "../src/workspace/statement-workspace-model";
import { LARGE_STATEMENT_FIXTURE } from "./fixtures/workspace/large-statement.fixture";

function txn(overrides: Partial<WorkspaceTransaction> & { merchant: string; amountValue: number; day: number; rowNumber: number }): WorkspaceTransaction {
  const { merchant, amountValue, day, rowNumber, ...rest } = overrides;
  return {
    date: { value: new Date(Date.UTC(2026, 5, day)), confidence: 0.97, source: "exact_match" },
    merchantRaw: { value: merchant, confidence: 0.95, source: "exact_match" },
    description: { value: null, confidence: 0, source: "unavailable" },
    amount: { value: amountValue, confidence: 0.97, source: "exact_match" },
    direction: { value: "debit", confidence: 1, source: "exact_match" },
    referenceNumber: { value: null, confidence: 0, source: "unavailable" },
    currency: { value: "INR", confidence: 1, source: "exact_match" },
    sourcePage: 1,
    sourceLineIndex: rowNumber - 1,
    originalRawText: `${merchant} ${amountValue}`,
    originalRowNumber: rowNumber,
    normalizedMerchant: null,
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    duplicateCheck: { status: "unique", type: null, matchedTransactionId: null, confidence: 0, reason: "Not yet checked against existing records." },
    needsReview: false,
    warnings: [],
    confidence: 0.95,
    ...rest,
  };
}

describe("checkStatementDuplicate — same PDF imported twice", () => {
  const existingStatements: ExistingStatementRecord[] = [
    {
      id: "stmt-1",
      documentHash: "abc123hash",
      billingPeriodStart: new Date(Date.UTC(2026, 5, 1)),
      billingPeriodEnd: new Date(Date.UTC(2026, 5, 30)),
      cardId: "card-1",
      closingBalance: 5000,
    },
  ];

  it("matches on identical document hash — the strongest possible signal", () => {
    const meta: StatementMetaForDuplicateCheck = {
      documentHash: "abc123hash",
      billingPeriodStart: new Date(Date.UTC(2026, 5, 1)),
      billingPeriodEnd: new Date(Date.UTC(2026, 5, 30)),
      cardId: "card-1",
      closingBalance: 5000,
    };
    const result = checkStatementDuplicate(meta, existingStatements);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("statement_duplicate");
    expect(result!.confidence).toBe(1);
    expect(result!.matchedTransactionId).toBe("stmt-1");
  });

  it("matches on card + billing period + closing balance when no hash is available", () => {
    const meta: StatementMetaForDuplicateCheck = {
      documentHash: null,
      billingPeriodStart: new Date(Date.UTC(2026, 5, 1)),
      billingPeriodEnd: new Date(Date.UTC(2026, 5, 30)),
      cardId: "card-1",
      closingBalance: 5000,
    };
    const result = checkStatementDuplicate(meta, existingStatements);
    expect(result?.type).toBe("statement_duplicate");
    expect(result?.confidence).toBe(0.95);
  });

  it("does not match a genuinely different statement (different period)", () => {
    const meta: StatementMetaForDuplicateCheck = {
      documentHash: "different-hash",
      billingPeriodStart: new Date(Date.UTC(2026, 6, 1)),
      billingPeriodEnd: new Date(Date.UTC(2026, 6, 31)),
      cardId: "card-1",
      closingBalance: 7000,
    };
    expect(checkStatementDuplicate(meta, existingStatements)).toBeNull();
  });
});

describe("detectInternalDuplicates — two identical rows inside the same statement", () => {
  it("marks both rows of an internal duplicate pair", () => {
    const transactions = [
      txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 }),
      txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 2 }),
      txn({ merchant: "Swiggy", amountValue: 400, day: 20, rowNumber: 3 }),
    ];
    const results = detectInternalDuplicates(transactions);
    expect(results[0]!.type).toBe("internal_duplicate");
    expect(results[0]!.matchedTransactionId).toBe("row-2");
    expect(results[1]!.type).toBe("internal_duplicate");
    expect(results[1]!.matchedTransactionId).toBe("row-1");
    expect(results[2]!.status).toBe("unique");
  });

  it("does not flag rows with the same merchant but different amounts", () => {
    const transactions = [
      txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 }),
      txn({ merchant: "Amazon", amountValue: 500, day: 19, rowNumber: 2 }),
    ];
    const results = detectInternalDuplicates(transactions);
    expect(results.every((r) => r.status === "unique")).toBe(true);
  });

  it("does not flag rows with the same amount but different merchants", () => {
    const transactions = [
      txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 }),
      txn({ merchant: "Flipkart", amountValue: 899, day: 19, rowNumber: 2 }),
    ];
    const results = detectInternalDuplicates(transactions);
    expect(results.every((r) => r.status === "unique")).toBe(true);
  });

  it("prefers normalizedMerchant over merchantRaw when comparing", () => {
    const transactions = [
      txn({ merchant: "AMZN", amountValue: 899, day: 19, rowNumber: 1, normalizedMerchant: { value: "Amazon", confidence: 0.9, source: "merchant_mapping" } }),
      txn({ merchant: "Amazon Marketplace", amountValue: 899, day: 19, rowNumber: 2, normalizedMerchant: { value: "Amazon", confidence: 0.9, source: "merchant_mapping" } }),
    ];
    const results = detectInternalDuplicates(transactions);
    expect(results[0]!.type).toBe("internal_duplicate");
    expect(results[1]!.type).toBe("internal_duplicate");
  });
});

describe("checkTransactionDuplicate — vs already-imported transactions", () => {
  const existing: ExistingTransactionRecord[] = [
    { id: "existing-1", description: "AMAZON purchase (Ref# REF12345)", amount: 899, dateTime: new Date(Date.UTC(2026, 5, 19)) },
  ];

  it("matches an existing transaction on merchant + amount + exact date, no reference number to check", () => {
    const t = txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 });
    const result = checkTransactionDuplicate(t, existing);
    expect(result.type).toBe("transaction_duplicate");
    expect(result.matchedTransactionId).toBe("existing-1");
    expect(result.confidence).toBe(0.9);
  });

  it("matches at higher confidence when the reference number is confirmed in the existing record", () => {
    const t = txn({
      merchant: "Amazon",
      amountValue: 899,
      day: 19,
      rowNumber: 1,
      referenceNumber: { value: "REF12345", confidence: 0.9, source: "pattern_match" },
    });
    const result = checkTransactionDuplicate(t, existing);
    expect(result.type).toBe("transaction_duplicate");
    expect(result.confidence).toBe(0.98);
    expect(result.reason).toContain("REF12345");
  });

  it("matches at lower confidence when a reference number is present but cannot be confirmed", () => {
    const t = txn({
      merchant: "Amazon",
      amountValue: 899,
      day: 19,
      rowNumber: 1,
      referenceNumber: { value: "REF99999", confidence: 0.9, source: "pattern_match" },
    });
    const result = checkTransactionDuplicate(t, existing);
    expect(result.type).toBe("transaction_duplicate");
    expect(result.confidence).toBe(0.75);
  });

  it("near duplicate: same merchant + amount, date off by 1 day", () => {
    const t = txn({ merchant: "Amazon", amountValue: 899, day: 20, rowNumber: 1 });
    const result = checkTransactionDuplicate(t, existing);
    expect(result.type).toBe("near_duplicate");
    expect(result.confidence).toBe(0.6);
  });

  it("no match: different merchant, same amount and date", () => {
    const t = txn({ merchant: "Flipkart", amountValue: 899, day: 19, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, existing).status).toBe("unique");
  });

  it("no match: same merchant, different amount", () => {
    const t = txn({ merchant: "Amazon", amountValue: 500, day: 19, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, existing).status).toBe("unique");
  });

  it("no match: same merchant and amount, date more than 1 day away", () => {
    const t = txn({ merchant: "Amazon", amountValue: 899, day: 25, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, existing).status).toBe("unique");
  });

  it("no match against an empty existing-transactions list", () => {
    const t = txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, []).status).toBe("unique");
  });

  it("no match: a short merchant token must not match as a substring of an unrelated word (CRED vs CREDIT)", () => {
    const existingCreditPayment: ExistingTransactionRecord[] = [
      { id: "existing-2", description: "CREDIT CARD PAYMENT", amount: 500, dateTime: new Date(Date.UTC(2026, 5, 19)) },
    ];
    // "CRED" (a registered merchant) is a substring of "CREDIT" — plain .includes() used to
    // match this and wrongly flag an unrelated ₹500 transaction as a duplicate.
    const t = txn({ merchant: "CRED", amountValue: 500, day: 19, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, existingCreditPayment).status).toBe("unique");
  });

  it("still matches when the merchant occurs as a real whole word inside a longer description", () => {
    const existingWithContext: ExistingTransactionRecord[] = [
      { id: "existing-3", description: "Payment via CRED app", amount: 500, dateTime: new Date(Date.UTC(2026, 5, 19)) },
    ];
    const t = txn({ merchant: "CRED", amountValue: 500, day: 19, rowNumber: 1 });
    expect(checkTransactionDuplicate(t, existingWithContext).status).toBe("duplicate_candidate");
  });
});

describe("applyDuplicateDetection — full orchestration, never mutates other fields", () => {
  it("marks every transaction as statement_duplicate when the whole statement is already imported, short-circuiting per-row checks", () => {
    const transactions = [txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 }), txn({ merchant: "Swiggy", amountValue: 400, day: 20, rowNumber: 2 })];
    const result = applyDuplicateDetection(transactions, {
      statementMeta: { documentHash: "same-hash", billingPeriodStart: null, billingPeriodEnd: null, cardId: null, closingBalance: null },
      existingStatements: [{ id: "stmt-1", documentHash: "same-hash", billingPeriodStart: null, billingPeriodEnd: null, cardId: null, closingBalance: null }],
      existingTransactions: [],
    });
    for (const t of result) {
      expect(t.duplicateCheck.type).toBe("statement_duplicate");
      expect(t.duplicateCandidateOf).toBe("stmt-1");
    }
  });

  it("does not mutate any extracted/suggested field — only duplicateCandidateOf/duplicateCheck change", () => {
    const original = txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 });
    const [result] = applyDuplicateDetection([original], {
      statementMeta: { documentHash: null, billingPeriodStart: null, billingPeriodEnd: null, cardId: null, closingBalance: null },
      existingStatements: [],
      existingTransactions: [],
    });
    const { duplicateCandidateOf: _origDup, duplicateCheck: _origCheck, ...originalRest } = original;
    const { duplicateCandidateOf: _resDup, duplicateCheck: _resCheck, ...resultRest } = result!;
    expect(resultRest).toEqual(originalRest);
  });

  it("internal duplicates take priority over transaction-duplicate checks when both could apply", () => {
    const transactions = [txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 1 }), txn({ merchant: "Amazon", amountValue: 899, day: 19, rowNumber: 2 })];
    const existingTransactions: ExistingTransactionRecord[] = [{ id: "existing-1", description: "AMAZON", amount: 899, dateTime: new Date(Date.UTC(2026, 5, 19)) }];
    const result = applyDuplicateDetection(transactions, {
      statementMeta: { documentHash: null, billingPeriodStart: null, billingPeriodEnd: null, cardId: null, closingBalance: null },
      existingStatements: [],
      existingTransactions,
    });
    expect(result[0]!.duplicateCheck.type).toBe("internal_duplicate");
    expect(result[1]!.duplicateCheck.type).toBe("internal_duplicate");
  });
});

describe("Duplicate Detection — performance on the Large fixture (400 transactions)", () => {
  it("completes internal-duplicate detection over 400 rows well within budget", () => {
    const start = performance.now();
    const results = detectInternalDuplicates(LARGE_STATEMENT_FIXTURE.transactions);
    const elapsedMs = performance.now() - start;
    expect(results).toHaveLength(400);
    expect(elapsedMs).toBeLessThan(100);
  });

  it("completes full applyDuplicateDetection over 400 rows against a non-trivial existing-transaction list well within budget", () => {
    const existingTransactions: ExistingTransactionRecord[] = Array.from({ length: 200 }, (_, i) => ({
      id: `existing-${i}`,
      description: `SOME MERCHANT ${i}`,
      amount: 100 + i,
      dateTime: new Date(Date.UTC(2026, 2, 1 + (i % 28))),
    }));
    const start = performance.now();
    const result = applyDuplicateDetection(LARGE_STATEMENT_FIXTURE.transactions, {
      statementMeta: { documentHash: null, billingPeriodStart: null, billingPeriodEnd: null, cardId: null, closingBalance: null },
      existingStatements: [],
      existingTransactions,
    });
    const elapsedMs = performance.now() - start;
    expect(result).toHaveLength(400);
    expect(elapsedMs).toBeLessThan(500);
  });
});
