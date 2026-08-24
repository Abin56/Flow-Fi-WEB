import { describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";
import {
  bulkImportCandidates,
  bulkIgnoreCandidates,
  importCandidate,
  ignoreCandidate,
  type ImportCandidateParams,
} from "./import-candidate";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-1",
    amount: 499,
    direction: "debit",
    eventType: "creditCardPurchase",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    merchant: "Amazon",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: null,
    cardId: "card-1",
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function baseParams(overrides: Partial<ImportCandidateParams> = {}): ImportCandidateParams {
  return {
    candidate: candidate(),
    accountId: "acc-1",
    matchedCard: null,
    categoryId: "cat-1",
    ...overrides,
  };
}

function mockRepos(createTransactionImpl?: () => Promise<Transaction>) {
  const createTransaction = vi.fn(createTransactionImpl ?? (async () => ({ id: "txn-created-1" }) as Transaction));
  const editTransaction = vi.fn(async () => undefined);
  const deleteById = vi.fn(async () => undefined);
  const convertToAssigned = vi.fn(async () => undefined);
  const convertToSplit = vi.fn(async () => undefined);
  return {
    transactionRepository: { createTransaction, editTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository,
    candidateRepository: {
      deleteById,
    } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository,
    expenseRepository: {
      convertToAssigned,
      convertToSplit,
    } as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository,
    createTransaction,
    editTransaction,
    deleteById,
    convertToAssigned,
    convertToSplit,
  };
}

describe("importCandidate", () => {
  it("fails validation without any writes when accountId is missing", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction, deleteById } = mockRepos();
    const result = await importCandidate(baseParams({ accountId: null }), transactionRepository, candidateRepository, expenseRepository);
    expect(result.status).toBe("validation_failed");
    expect(createTransaction).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("fails validation without any writes when categoryId is missing", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const result = await importCandidate(baseParams({ categoryId: null }), transactionRepository, candidateRepository, expenseRepository);
    expect(result.status).toBe("validation_failed");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("resolves the account id from a matched card's accountId, not the card's own id", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    await importCandidate(
      baseParams({
        accountId: null,
        matchedCard: { id: "card-1", accountId: "acc-behind-card" } as CreditCardProfile,
      }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-behind-card", source: "sms" }));
  });

  it("maps direction credit -> income, debit -> expense", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    await importCandidate(baseParams({ candidate: candidate({ direction: "credit" }) }), transactionRepository, candidateRepository, expenseRepository);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "income" }));
  });

  it("uses merchant for the description, falling back to bankName when merchant is null", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    await importCandidate(baseParams({ candidate: candidate({ merchant: null, bankName: "SBI" }) }), transactionRepository, candidateRepository, expenseRepository);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ description: "SBI" }));
  });

  it("on success: creates the transaction first, then deletes the candidate document", async () => {
    const calls: string[] = [];
    const { transactionRepository, candidateRepository, expenseRepository, deleteById } = mockRepos(async () => {
      calls.push("createTransaction");
      return { id: "txn-created-1" } as Transaction;
    });
    deleteById.mockImplementation(async () => {
      calls.push("deleteById");
    });

    const result = await importCandidate(baseParams(), transactionRepository, candidateRepository, expenseRepository);

    expect(result).toEqual({ status: "success", transactionId: "txn-created-1" });
    expect(deleteById).toHaveBeenCalledWith("sms-1");
    expect(calls).toEqual(["createTransaction", "deleteById"]);
  });

  it("leaves the candidate document untouched when createTransaction throws", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, deleteById } = mockRepos(async () => {
      throw new Error("network error");
    });

    const result = await importCandidate(baseParams(), transactionRepository, candidateRepository, expenseRepository);

    expect(result.status).toBe("transaction_create_failed");
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("surfaces a distinct outcome when the transaction is created but the candidate delete fails", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, deleteById } = mockRepos(async () => ({ id: "txn-created-1" }) as Transaction);
    deleteById.mockImplementation(async () => {
      throw new Error("delete failed");
    });

    const result = await importCandidate(baseParams(), transactionRepository, candidateRepository, expenseRepository);

    expect(result).toMatchObject({ status: "imported_not_deleted", transactionId: "txn-created-1" });
  });
});

/**
 * Regression coverage for the SMS Candidate duplicate-detection bug: an SMS candidate matching an
 * already-existing `Transaction` (regardless of that transaction's origin — manual entry, PDF
 * import, or a prior SMS import) must be flagged via the shared `checkForDuplicates` core and must
 * NOT silently create a second transaction. `importCandidate` itself is the write path — this is the
 * one place a bypassed/stale UI-level check could no longer let a duplicate through.
 */
describe("importCandidate — duplicate detection", () => {
  function existingTransaction(overrides: Partial<ExistingTransactionForDuplicateCheck> = {}): ExistingTransactionForDuplicateCheck {
    return {
      id: "txn-existing-1",
      description: "Amazon",
      amount: 500,
      dateTime: new Date("2026-08-20T00:00:00.000Z"),
      accountId: "acc-1",
      type: "expense",
      ...overrides,
    };
  }

  function matchingCandidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
    return candidate({
      id: "sms-match-1",
      merchant: "Amazon",
      amount: 500,
      direction: "debit",
      transactionDate: new Date("2026-08-20T00:00:00.000Z"),
      accountId: "acc-1",
      cardId: null,
      ...overrides,
    });
  }

  // A. Existing manual transaction → SMS Candidate
  it("A: flags a candidate matching an already-existing MANUALLY created transaction, and writes nothing", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction, deleteById } = mockRepos();
    const existing = [existingTransaction()]; // stands in for a manually created transaction — the check has no notion of "source"

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") {
      expect(result.result.bestMatch?.transactionId).toBe("txn-existing-1");
    }
    expect(createTransaction).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
  });

  // B. Existing PDF transaction → SMS Candidate
  it("B: flags a candidate matching an already-existing transaction that originated from PDF import", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ id: "txn-from-pdf", description: "AMAZON.IN PDF STATEMENT ROW" })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") expect(result.result.bestMatch?.transactionId).toBe("txn-from-pdf");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // C. Existing SMS transaction → new SMS Candidate
  it("C: flags a candidate matching an already-existing transaction that originated from a previous SMS import", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ id: "txn-from-sms", description: "Amazon" })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate({ id: "sms-new-candidate" }), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") expect(result.result.bestMatch?.transactionId).toBe("txn-from-sms");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // Final UAT cross-source combination: Existing Credit Card PDF Transaction → SMS candidate.
  // The check has no notion of "credit card" — a card's transactions are just `Transaction` records
  // posted to the card's underlying `accountId`, same as `commit-review-import.ts`'s credit-card
  // handling resolves it. This pins that an SMS candidate on the same card account still gets flagged
  // against a transaction that was imported from that card's PDF statement.
  it("Existing CREDIT CARD PDF transaction → SMS candidate on the same card account is flagged", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ id: "txn-from-cc-pdf", description: "Amazon", accountId: "acc-behind-hdfc-card" })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate({ accountId: "acc-behind-hdfc-card" }), accountId: "acc-behind-hdfc-card", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") {
      expect(result.result.bestMatch?.transactionId).toBe("txn-from-cc-pdf");
      expect(result.result.bestMatch?.sameAccount).toBe(true);
    }
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // Resurrection safety, exercised at the actual write-path enforcement point (importCandidate),
  // not just the display-only evaluateCandidateDuplicate helper: import once (transaction created,
  // candidate deleted), then simulate Android re-syncing the identical candidate id — the resurrected
  // candidate must be blocked by importCandidate itself when checked against the transaction the
  // first import already created, not silently reimportable into a second transaction.
  it("resurrection: a candidate re-imported after Android resyncs the same id is blocked against the transaction its own earlier import created", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction, deleteById } = mockRepos(
      async () => ({ id: "txn-resurrection-1" }) as Transaction,
    );
    const original = matchingCandidate({ id: "sms-resurrect-1" });

    // Step 1: first import succeeds — transaction created, candidate deleted.
    const firstImport = await importCandidate(
      baseParams({ candidate: original, accountId: "acc-1", existingTransactions: [] }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );
    expect(firstImport).toEqual({ status: "success", transactionId: "txn-resurrection-1" });
    expect(deleteById).toHaveBeenCalledTimes(1);

    // Step 2: Android re-syncs the identical candidate id/fields — the resurrected candidate is
    // checked again, now against the transaction step 1 just created (as a live hook would supply).
    const resurrected = { ...original };
    const existingAfterFirstImport = [
      existingTransaction({ id: "txn-resurrection-1", description: original.merchant!, amount: original.amount, dateTime: original.transactionDate, accountId: "acc-1" }),
    ];
    createTransaction.mockClear();

    const secondImport = await importCandidate(
      baseParams({ candidate: resurrected, accountId: "acc-1", existingTransactions: existingAfterFirstImport }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(secondImport.status).toBe("duplicate_detected");
    if (secondImport.status === "duplicate_detected") expect(secondImport.result.bestMatch?.transactionId).toBe("txn-resurrection-1");
    expect(createTransaction).not.toHaveBeenCalled(); // no second transaction was silently created
  });

  // D. Cancel — caller simply never re-invokes with skipDuplicateCheck; nothing was ever written.
  it("D: cancelling after a duplicate warning creates no transaction and leaves the candidate untouched", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction, deleteById } = mockRepos();
    const existing = [existingTransaction()];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    expect(createTransaction).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled(); // candidate remains — never deleted for a blocked import
  });

  // E. Import Anyway
  it("E: 'Import anyway' (skipDuplicateCheck) creates the new transaction with source 'sms', leaves the old transaction alone, and still deletes the candidate", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction, deleteById } = mockRepos(
      async () => ({ id: "txn-new-from-sms" }) as Transaction,
    );
    const existing = [existingTransaction()];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing, skipDuplicateCheck: true }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result).toEqual({ status: "success", transactionId: "txn-new-from-sms" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ source: "sms", accountId: "acc-1" }));
    // The old transaction is never touched by importCandidate — no edit/delete repository call exists for it.
    expect(deleteById).toHaveBeenCalledWith("sms-match-1"); // only the candidate document is deleted
  });

  // F. Fresh-state scenario: the matching transaction is supplied at call time, exactly like a live
  // Firestore snapshot would be — proving the check isn't relying on any earlier, cached snapshot
  // taken back when the candidate first appeared.
  it("F: a transaction created AFTER the candidate existed is still detected, since existingTransactions is read fresh at import time", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    // Candidate "existed" first (conceptually) — the existing transaction below simulates one created
    // later, and is passed in exactly as a live hook would supply it at the moment of import.
    const freshlyCreatedTransaction = [existingTransaction({ id: "txn-created-after-candidate" })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: freshlyCreatedTransaction }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") expect(result.result.bestMatch?.transactionId).toBe("txn-created-after-candidate");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not flag when no existing transactions match (unique candidate imports normally)", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos(async () => ({ id: "txn-unique" }) as Transaction);
    const unrelated = [existingTransaction({ id: "txn-unrelated", description: "Netflix", amount: 649 })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: unrelated }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result).toEqual({ status: "success", transactionId: "txn-unique" });
    expect(createTransaction).toHaveBeenCalledTimes(1);
  });

  it("still flags a different-account match, just with a weaker (halved) confidence — different account is not exempt from detection", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ id: "txn-diff-account", accountId: "acc-OTHER" })];

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") {
      expect(result.result.bestMatch?.sameAccount).toBe(false);
      expect(result.result.bestMatch?.transactionId).toBe("txn-diff-account");
    }
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("still flags a near-duplicate within the existing ±1-day window", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ dateTime: new Date("2026-08-19T00:00:00.000Z") })]; // 1 day before the candidate's 2026-08-20

    const result = await importCandidate(
      baseParams({ candidate: matchingCandidate(), accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // Regression: a candidate with neither `merchant` nor `bankName` (Android couldn't parse either
  // out of the SMS) used to skip the duplicate check entirely, since the old code bailed out before
  // calling `checkForDuplicates` whenever there was no description text — letting a same-amount,
  // same-day candidate silently create a second transaction titled the literal fallback
  // "SMS transaction". It must now still be checked, matching on amount/direction/exact date alone.
  it("still flags a duplicate for a candidate with no merchant AND no bankName (falls back to amount/date-only matching)", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ description: "dd" })]; // an existing transaction with unrelated free-text description
    const noMerchantCandidate = matchingCandidate({ merchant: null, bankName: null });

    const result = await importCandidate(
      baseParams({ candidate: noMerchantCandidate, accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") expect(result.result.bestMatch?.transactionId).toBe("txn-existing-1");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  // Same gap, one day off: with no description anchor, `requireDescriptionMatch: false` also means
  // the date comparison is exact-day only (see `checkForDuplicates`'s doc comment) — a real near
  // (not identical) duplicate one day apart is NOT flagged in this no-merchant/no-bankName case,
  // unlike the ±1-day window that applies when there IS description text to anchor the match.
  it("does NOT flag a no-merchant/no-bankName candidate a day off from an existing transaction (exact-day only, no description anchor to justify a near-duplicate window)", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ description: "dd", dateTime: new Date("2026-08-19T00:00:00.000Z") })];
    const noMerchantCandidate = matchingCandidate({ merchant: null, bankName: null });

    const result = await importCandidate(
      baseParams({ candidate: noMerchantCandidate, accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("success");
    expect(createTransaction).toHaveBeenCalled();
  });

  // Regression: the stricter "same amount + same exact date, by itself, must warn" fallback
  // (`checkForDuplicates`'s "Amount+date fallback" doc section) exercised at the actual write-path
  // enforcement point, not just the shared core service — a candidate WITH a merchant that simply
  // doesn't match the existing transaction's description must still be blocked here.
  it("blocks the write when amount + exact date match but the merchant is completely different from the existing transaction's description", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ description: "Totally Unrelated Text" })];
    const differentMerchantCandidate = matchingCandidate({ merchant: "A Completely Different Merchant" });

    const result = await importCandidate(
      baseParams({ candidate: differentMerchantCandidate, accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("duplicate_detected");
    if (result.status === "duplicate_detected") expect(result.result.bestMatch?.transactionId).toBe("txn-existing-1");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does NOT block on a different date, even with the same amount (no warning from the amount+date fallback beyond exact-day)", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ description: "Totally Unrelated Text", dateTime: new Date("2026-08-15T00:00:00.000Z") })];
    const differentMerchantCandidate = matchingCandidate({ merchant: "A Completely Different Merchant", transactionDate: new Date("2026-08-20T00:00:00.000Z") });

    const result = await importCandidate(
      baseParams({ candidate: differentMerchantCandidate, accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("success");
    expect(createTransaction).toHaveBeenCalled();
  });

  it("does NOT block on a different amount, even with the same exact date", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos();
    const existing = [existingTransaction({ description: "Totally Unrelated Text", amount: 999 })];
    const differentMerchantCandidate = matchingCandidate({ merchant: "A Completely Different Merchant", amount: 500 });

    const result = await importCandidate(
      baseParams({ candidate: differentMerchantCandidate, accountId: "acc-1", existingTransactions: existing }),
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );

    expect(result.status).toBe("success");
    expect(createTransaction).toHaveBeenCalled();
  });
});

describe("bulkImportCandidates — duplicate detection", () => {
  it("G: preserves same-batch/resurrection protections — a row matching an existing transaction is flagged (no write), independent rows still succeed", async () => {
    const clean = candidate({ id: "clean-1", merchant: "Uber", amount: 220, accountId: "acc-1", cardId: null, transactionDate: new Date("2026-08-05T00:00:00.000Z") });
    const dup = candidate({ id: "dup-1", merchant: "Amazon", amount: 500, accountId: "acc-1", cardId: null, transactionDate: new Date("2026-08-20T00:00:00.000Z") });
    const existing: ExistingTransactionForDuplicateCheck[] = [
      { id: "txn-existing", description: "Amazon", amount: 500, dateTime: new Date("2026-08-20T00:00:00.000Z"), accountId: "acc-1", type: "expense" },
    ];

    const createTransaction = vi.fn(async () => ({ id: "txn-clean-1" }) as Transaction);
    const deleteById = vi.fn(async () => undefined);
    const transactionRepository = { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository;
    const candidateRepository = { deleteById } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository;
    const expenseRepository = {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository;

    const results = await bulkImportCandidates([clean, dup], "cat-1", [], transactionRepository, candidateRepository, expenseRepository, existing, false);

    expect(results.find((r) => r.candidateId === "clean-1")?.outcome).toEqual({ status: "success", transactionId: "txn-clean-1" });
    expect(results.find((r) => r.candidateId === "dup-1")?.outcome.status).toBe("duplicate_detected");
    expect(createTransaction).toHaveBeenCalledTimes(1); // the flagged row never reached createTransaction
    expect(deleteById).toHaveBeenCalledTimes(1); // only the clean row's candidate was deleted
  });

  it("re-running only the flagged candidates with skipDuplicateCheck imports them without re-touching the already-succeeded row", async () => {
    const dup = candidate({ id: "dup-1", merchant: "Amazon", amount: 500, accountId: "acc-1", cardId: null, transactionDate: new Date("2026-08-20T00:00:00.000Z") });
    const existing: ExistingTransactionForDuplicateCheck[] = [
      { id: "txn-existing", description: "Amazon", amount: 500, dateTime: new Date("2026-08-20T00:00:00.000Z"), accountId: "acc-1", type: "expense" },
    ];
    const createTransaction = vi.fn(async () => ({ id: "txn-dup-1" }) as Transaction);
    const deleteById = vi.fn(async () => undefined);
    const transactionRepository = { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository;
    const candidateRepository = { deleteById } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository;
    const expenseRepository = {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository;

    const results = await bulkImportCandidates([dup], "cat-1", [], transactionRepository, candidateRepository, expenseRepository, existing, true);

    expect(results[0].outcome).toEqual({ status: "success", transactionId: "txn-dup-1" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ source: "sms" }));
    expect(deleteById).toHaveBeenCalledWith("dup-1");
  });
});

describe("ignoreCandidate", () => {
  it("only deletes the candidate document, never touches transactions", async () => {
    const { candidateRepository, deleteById } = mockRepos();
    await ignoreCandidate(candidate(), candidateRepository);
    expect(deleteById).toHaveBeenCalledWith("sms-1");
  });
});

describe("bulkIgnoreCandidates", () => {
  it("dismisses every candidate when all succeed", async () => {
    const { candidateRepository, deleteById } = mockRepos();
    const results = await bulkIgnoreCandidates([candidate({ id: "c1" }), candidate({ id: "c2" })], candidateRepository);
    expect(results).toEqual([
      { candidateId: "c1", ok: true },
      { candidateId: "c2", ok: true },
    ]);
    expect(deleteById).toHaveBeenCalledTimes(2);
  });

  it("one candidate's failure doesn't stop the rest of the batch, and is reported per-row", async () => {
    const { candidateRepository, deleteById } = mockRepos();
    deleteById.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(undefined);
    const results = await bulkIgnoreCandidates([candidate({ id: "c1" }), candidate({ id: "c2" })], candidateRepository);
    expect(results[0]).toMatchObject({ candidateId: "c1", ok: false });
    expect(results[1]).toEqual({ candidateId: "c2", ok: true });
  });
});

describe("bulkImportCandidates", () => {
  it("mixed batch: succeeds, fails validation, and fails transaction creation independently, without stopping the batch", async () => {
    const ready = candidate({ id: "ready", accountId: "acc-1", cardId: null });
    const unresolved = candidate({ id: "unresolved", accountId: null, cardId: null });
    const willFailCreate = candidate({ id: "will-fail", accountId: "acc-2", cardId: null });

    let call = 0;
    const createTransaction = vi.fn(async () => {
      call += 1;
      if (call === 1) return { id: "txn-ready" } as Transaction;
      throw new Error("network error");
    });
    const deleteById = vi.fn(async () => undefined);
    const transactionRepository = { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository;
    const candidateRepository = {
      deleteById,
    } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository;
    const expenseRepository = {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository;

    const results = await bulkImportCandidates([ready, unresolved, willFailCreate], "cat-1", [], transactionRepository, candidateRepository, expenseRepository);

    expect(results[0]).toEqual({ candidateId: "ready", outcome: { status: "success", transactionId: "txn-ready" } });
    expect(results[1].outcome.status).toBe("validation_failed"); // no account/card resolved — no writes
    expect(results[2].outcome.status).toBe("transaction_create_failed"); // candidate left untouched, still present
    expect(createTransaction).toHaveBeenCalledTimes(2); // never called for the unresolved row
    expect(deleteById).toHaveBeenCalledTimes(1); // only the successful row's candidate is deleted
  });

  it("resolves a matched card to its underlying accountId, not the card's own id", async () => {
    const withCard = candidate({ id: "c1", accountId: null, cardId: "card-1" });
    const creditCards = [{ id: "card-1", accountId: "acc-behind-card" } as CreditCardProfile];
    const createTransaction = vi.fn(async () => ({ id: "txn-1" }) as Transaction);
    const transactionRepository = { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository;
    const candidateRepository = {
      deleteById: vi.fn(async () => undefined),
    } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository;
    const expenseRepository = {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository;

    await bulkImportCandidates([withCard], "cat-1", creditCards, transactionRepository, candidateRepository, expenseRepository);

    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-behind-card" }));
  });

  it("treats a cardId that can't be resolved against the given credit cards as validation_failed, with no writes", async () => {
    const withUnresolvableCard = candidate({ id: "c1", accountId: null, cardId: "missing-card" });
    const createTransaction = vi.fn(async () => ({ id: "txn-1" }) as Transaction);
    const transactionRepository = { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository;
    const candidateRepository = {
      deleteById: vi.fn(async () => undefined),
    } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository;
    const expenseRepository = {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository;

    const results = await bulkImportCandidates([withUnresolvableCard], "cat-1", [], transactionRepository, candidateRepository, expenseRepository);

    expect(results[0].outcome.status).toBe("validation_failed");
    expect(createTransaction).not.toHaveBeenCalled();
  });
});
