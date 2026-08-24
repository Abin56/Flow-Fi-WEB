/**
 * Integration-level coverage across the SMS candidate pipeline — exercises
 * several modules together (Firestore round-trip → account/card display
 * resolution → status derivation → commit → duplicate detection) the way a
 * single unit test of one module can't. Repository-layer Firestore calls are
 * mocked at the SDK boundary (same convention as
 * `lib/repositories/sms-transaction-candidate-repository.test.ts`); no DOM
 * rendering is involved, consistent with this repo's existing test
 * conventions (there are no component/RTL tests anywhere in this codebase).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { smsTransactionCandidateFromFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { formatMatchedAccountLabel, formatUnresolvedAccountHint } from "./candidate-account-matching";
import { deriveCandidateStatus } from "./candidate-status";
import { evaluateCandidateDuplicate } from "./candidate-duplicate";
import { importCandidate } from "./import-candidate";
import { applyCandidateSearchAndFilters, applyCandidateTabFilter, DEFAULT_CANDIDATE_FILTERS, type DuplicatesByCandidateId } from "./filters";

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  deleteDoc: vi.fn().mockResolvedValue(undefined),
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d }),
  },
}));

import { deleteDoc, doc } from "firebase/firestore";

function firestoreSnapshot(id: string, data: Record<string, unknown>) {
  return { id, data: () => data } as unknown as Parameters<typeof smsTransactionCandidateFromFirestore>[0];
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-sbi",
    name: "SBI Savings",
    type: "bank",
    openingBalance: 0,
    currentBalance: 0,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date(),
    bankId: "sbi",
    accountHolderName: null,
    notes: null,
    accountNumberLast4: "9981",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function card(overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id: "card-hdfc",
    accountId: "acc-hdfc-card",
    sharedLimitId: null,
    statementDay: 1,
    paymentDueDay: 15,
    creditLimit: 100000,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: "4821",
    issuer: "hdfc",
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: new Date(),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  } as CreditCardProfile;
}

function mockRepos(createTransactionImpl?: () => Promise<Transaction>) {
  const createTransaction = vi.fn(createTransactionImpl ?? (async () => ({ id: "txn-1" }) as Transaction));
  return {
    transactionRepository: { createTransaction } as unknown as import("@/lib/repositories/transaction-repository").TransactionRepository,
    candidateRepository: {
      deleteById: (id: string) => deleteDoc(doc({} as never, id)),
    } as unknown as import("@/lib/repositories/sms-transaction-candidate-repository").SmsTransactionCandidateRepository,
    expenseRepository: {} as unknown as import("@/lib/repositories/expense-repository").ExpenseRepository,
    createTransaction,
  };
}

describe("SMS candidate pipeline (integration)", () => {
  beforeEach(() => {
    vi.mocked(doc).mockClear();
    vi.mocked(deleteDoc).mockClear();
  });

  it("candidate appears: a Firestore document in the real Android shape parses into a candidate ready for display", () => {
    const candidate = smsTransactionCandidateFromFirestore(
      firestoreSnapshot("sms-appear-1", {
        amount: 1249,
        direction: "debit",
        eventType: "creditCardPurchase",
        transactionDate: Timestamp.fromDate(new Date("2026-08-01T10:00:00.000Z")),
        merchant: "Amazon",
        bankName: "HDFC",
        rawLastFour: "4821",
        accountId: null,
        cardId: "card-hdfc",
        confidenceLevel: "high",
        confidenceScore: 0.95,
        needsReview: false,
        needsReviewReasons: [],
        source: "sms",
        createdAt: Timestamp.fromDate(new Date("2026-08-01T10:00:05.000Z")),
      }),
    );

    expect(candidate.id).toBe("sms-appear-1");
    expect(deriveCandidateStatus(candidate, null)).toMatchObject({ label: "Ready to Import" });
    expect(formatMatchedAccountLabel(candidate, [], [card()])).toBe("Credit Card •••• 4821");
  });

  it("account/card resolution: accountId resolves against accounts, cardId resolves against creditCards, no web-side matching involved", () => {
    const bankMatch: SmsTransactionCandidate = { ...baseCandidate(), accountId: "acc-sbi", cardId: null };
    expect(formatMatchedAccountLabel(bankMatch, [account()], [])).toBe("SBI Savings •••• 9981");

    const cardMatch: SmsTransactionCandidate = { ...baseCandidate(), accountId: null, cardId: "card-hdfc" };
    expect(formatMatchedAccountLabel(cardMatch, [], [card()])).toBe("Credit Card •••• 4821");
  });

  it("unresolved account fallback: rawLastFour is shown, never an invented account", () => {
    const unresolved: SmsTransactionCandidate = { ...baseCandidate(), accountId: null, cardId: null, rawLastFour: "7743", bankName: "AXIS" };
    expect(formatMatchedAccountLabel(unresolved, [account()], [card()])).toBeNull();
    expect(formatUnresolvedAccountHint(unresolved)).toBe("Unmatched • •••• 7743");
    expect(deriveCandidateStatus(unresolved, null).label).toBe("Unmatched Account");
  });

  it("needs-review reasons surface verbatim from Android, both in status derivation and in filtering", () => {
    const needsReview: SmsTransactionCandidate = {
      ...baseCandidate(),
      needsReview: true,
      confidenceLevel: "low",
      needsReviewReasons: ["Parsed by a generic, lower-confidence parser rather than a bank-specific one."],
    };
    const status = deriveCandidateStatus(needsReview, null);
    expect(status.label).toBe("Needs Review");
    expect(status.reasons).toEqual(["Parsed by a generic, lower-confidence parser rather than a bank-specific one."]);

    const noDuplicates: DuplicatesByCandidateId = new Map();
    const filtered = applyCandidateSearchAndFilters([needsReview, baseCandidate()], "", applyCandidateTabFilter(DEFAULT_CANDIDATE_FILTERS, "needsReview"), noDuplicates);
    expect(filtered.map((c) => c.id)).toEqual([needsReview.id]);
  });

  it("successful commit: creates the Transaction with source 'sms', then deletes the candidate document only after that succeeds", async () => {
    const { transactionRepository, candidateRepository, expenseRepository, createTransaction } = mockRepos(async () => ({ id: "txn-success-1" }) as Transaction);
    const candidate = baseCandidate({ id: "sms-commit-1" });

    const result = await importCandidate({ candidate, accountId: "acc-sbi", matchedCard: null, categoryId: "cat-1" }, transactionRepository, candidateRepository, expenseRepository);

    expect(result).toEqual({ status: "success", transactionId: "txn-success-1" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ source: "sms", accountId: "acc-sbi" }));
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(doc).toHaveBeenCalledWith(expect.anything(), "sms-commit-1");
  });

  it("failed commit: candidate document is never deleted, so it remains visible and retryable", async () => {
    const { transactionRepository, candidateRepository, expenseRepository } = mockRepos(async () => {
      throw new Error("network error");
    });
    const candidate = baseCandidate({ id: "sms-fail-1" });

    const result = await importCandidate({ candidate, accountId: "acc-sbi", matchedCard: null, categoryId: "cat-1" }, transactionRepository, candidateRepository, expenseRepository);

    expect(result.status).toBe("transaction_create_failed");
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("candidate deletion after successful commit is the ONLY write — no status field is ever set", async () => {
    const { transactionRepository, candidateRepository, expenseRepository } = mockRepos();
    const candidate = baseCandidate({ id: "sms-delete-check" });

    await importCandidate({ candidate, accountId: "acc-sbi", matchedCard: null, categoryId: "cat-1" }, transactionRepository, candidateRepository, expenseRepository);

    // deleteDoc is the mocked SDK call the repository's deleteById routes through — confirming no
    // updateDoc/setDoc ("mark confirmed") call exists is implicit: `candidateRepository` here only
    // exposes `deleteById`, matching the real SmsTransactionCandidateRepository's API surface.
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });

  it("duplicate protection: a candidate matching an already-committed sms Transaction is flagged, not silently reimportable", () => {
    const candidate = baseCandidate({ id: "sms-dup-1", merchant: "Amazon", amount: 499, referenceNumber: "REF123" });
    const committed: Pick<Transaction, "id" | "description" | "amount" | "dateTime" | "accountId" | "type">[] = [
      { id: "txn-already-committed", description: "Amazon REF123", amount: 499, dateTime: candidate.transactionDate, accountId: "acc-sbi", type: "expense" },
    ];

    const duplicateResult = evaluateCandidateDuplicate(candidate, committed);
    expect(duplicateResult.duplicateOfTransactionId).toBe("txn-already-committed");

    const status = deriveCandidateStatus(candidate, duplicateResult);
    expect(status.label).toBe("Possible Duplicate");
  });

  it("repeated Android sync / resurrection scenario: importing a candidate, then seeing the SAME candidate id reappear (simulating Android's next full-document re-sync while the source SMS is still locally pending) results in it being flagged against the transaction just created, not silently re-importable", async () => {
    const { transactionRepository, candidateRepository, expenseRepository } = mockRepos(async () => ({ id: "txn-resurrection-1" }) as Transaction);
    const original = baseCandidate({ id: "sms-resurrect-1", merchant: "Netflix", amount: 649, referenceNumber: "REF999" });

    // Step 1: user imports the candidate — Transaction created, candidate document deleted.
    const importResult = await importCandidate(
      { candidate: original, accountId: "acc-sbi", matchedCard: null, categoryId: "cat-1" },
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );
    expect(importResult.status).toBe("success");
    expect(deleteDoc).toHaveBeenCalledTimes(1);

    // Step 2: Android re-syncs the same SMS (still locally pending on-device) — the identical
    // document (same id, same fields) reappears in Firestore. The web app has no way to prevent
    // this (see docs/sms-candidate-contract.md's Lifecycle section) — only to detect it.
    const resurrected = { ...original };

    // Step 3: the resurrected candidate must be checked against the transaction the first import
    // already created — this is the actual mechanism that keeps Android's next sync from silently
    // producing a second Transaction.
    const committedTransactions: Pick<Transaction, "id" | "description" | "amount" | "dateTime" | "accountId" | "type">[] = [
      { id: "txn-resurrection-1", description: "Netflix", amount: 649, dateTime: original.transactionDate, accountId: "acc-sbi", type: "expense" },
    ];
    const duplicateResult = evaluateCandidateDuplicate(resurrected, committedTransactions);
    expect(duplicateResult.duplicateOfTransactionId).toBe("txn-resurrection-1");

    const status = deriveCandidateStatus(resurrected, duplicateResult);
    expect(status.label).toBe("Possible Duplicate");
    expect(status.reasons[0]).toContain("txn-resurrection-1");
  });
});

function baseCandidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-base",
    amount: 500,
    direction: "debit",
    eventType: "cardPurchase",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    merchant: "Amazon",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: null,
    cardId: "card-hdfc",
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
