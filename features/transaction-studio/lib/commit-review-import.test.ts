import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type RecordAction, type StagedRecord } from "@/lib/models/document-import";
import type { Transaction } from "@/lib/models/transaction";
import { actionToAxesPatch } from "./action-metadata";
import { commitReviewImport, detectFreshDuplicatesForCommit, type CommitRepositories } from "./commit-review-import";

function row(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 100,
    direction: "debit",
    referenceNumber: null,
    currency: "INR",
    category: "Shopping",
    subcategory: null,
    confidenceScores: {},
    sourcePage: 1,
    sourceLineIndex: 0,
    splitParentId: null,
    mergedInto: null,
    userEdited: false,
    lastEditedAt: null,
    lastEditedBy: null,
    tags: [],
    notes: "",
    duplicateOfTransactionId: null,
    include: true,
    flowType: "expense",
    ownership: "mine",
    modifiers: DEFAULT_RECORD_MODIFIERS,
    actionDetail: null,
    committedTransactionId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    needsReview: false,
    ...overrides,
  };
}

/** Builds a row whose flowType/ownership/actionDetail resolve to `action` via `deriveRecordAction`, using the same `actionToAxesPatch` the ActionCell dropdown writes — so each test exercises the real axis combination, not a hand-picked one. */
function rowForAction(action: RecordAction, overrides: Partial<StagedRecord> = {}): StagedRecord {
  return row({ ...actionToAxesPatch(action), ...overrides });
}

/** Repositories that throw if any method is actually invoked — proves blocked/skipped rows never reach a write call. */
function unreachableRepositories(): CommitRepositories {
  const fail = () => {
    throw new Error("should not be called for a blocked/skipped row");
  };
  return {
    transactionRepository: { createTransaction: fail, createTransferPair: fail } as never,
    expenseRepository: { createExpense: fail, assignToPerson: fail } as never,
    emiRepository: { createEmi: fail } as never,
    loanRepository: { createLoan: fail } as never,
    installmentRepositoryFor: fail as never,
  };
}

const baseParams = {
  accountId: "acc-1",
  categories: [{ id: "cat-shopping", name: "Shopping" } as never],
  people: [],
  accounts: [],
  emis: [],
  loans: [],
  bills: [],
};

describe("commitReviewImport — skip/block short-circuits", () => {
  it("skips a row with include: false without touching any repository", async () => {
    const onRowCommitted = vi.fn();
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ include: false })],
      repositories: unreachableRepositories(),
      onRowCommitted,
    });
    expect(result.skippedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "skipped" });
    expect(onRowCommitted).not.toHaveBeenCalled();
  });

  it("treats a row with committedTransactionId already set as already committed, idempotently — no repository call", async () => {
    const onRowCommitted = vi.fn();
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ committedTransactionId: "txn-existing" })],
      repositories: unreachableRepositories(),
      onRowCommitted,
    });
    expect(result.committedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "committed", transactionId: "txn-existing" });
    expect(onRowCommitted).not.toHaveBeenCalled();
  });

  it("blocks a needsReview row without touching any repository", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ needsReview: true })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("needs_review");
  });

  it("blocks a row whose category doesn't resolve to a known category", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ category: "Nonexistent" })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("unresolved_category");
  });

  it("blocks a row with an unresolved duplicate candidate", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ duplicateCandidateOf: "txn-1" })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("unresolved_duplicate");
  });

  it("blocks a row with no Action chosen yet (flowType null)", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ flowType: null, ownership: null })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("missing_action");
  });

  it("commits a fully-clean plain expense row via createTransaction, and reports the resulting transaction id", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    const onRowCommitted = vi.fn();
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row()],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted,
    });
    expect(result.committedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "committed", transactionId: "txn-new" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "expense", amount: 100, categoryId: "cat-shopping" }));
    expect(onRowCommitted).toHaveBeenCalledWith("r1", "txn-new");
  });

  it("records a failed row's error message without throwing, and continues processing remaining rows", async () => {
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ id: "r1" }), row({ id: "r2" })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(2);
    expect(result.results.every((r) => r.outcome === "failed")).toBe(true);
    expect(result.results[0].error).toBe("network error");
  });

  it("skips an ignore-Action row without touching any repository, same as include: false", async () => {
    const onRowCommitted = vi.fn();
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("ignore")],
      repositories: unreachableRepositories(),
      onRowCommitted,
    });
    expect(result.skippedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "skipped" });
    expect(onRowCommitted).not.toHaveBeenCalled();
  });
});

describe("commitReviewImport — unimplemented actions fail loudly, never silently downgrade (B2)", () => {
  it.each(["cashback", "recurring_bill", "investment"] satisfies RecordAction[])(
    "blocks a %s row pre-commit with code unimplemented_action, without touching any repository",
    async (action) => {
      const result = await commitReviewImport({
        ...baseParams,
        rows: [rowForAction(action)],
        repositories: unreachableRepositories(),
        onRowCommitted: vi.fn(),
      });
      expect(result.blockedCount).toBe(1);
      expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("unimplemented_action");
    },
  );
});

describe("commitReviewImport — every Action dispatches to its correct repository/commit path", () => {
  it("normal_expense: debit -> expense via createTransaction", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("normal_expense")],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "expense" }));
  });

  it("income: credit -> income via createTransaction", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("income", { direction: "credit" })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "income" }));
  });

  it("refund: routes through the same plain createTransaction path as normal_expense/income", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("refund", { direction: "credit" })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "income" }));
  });

  it("shared_expense: routes through expenseRepository.createExpense with the row's split participants", async () => {
    const createExpense = vi.fn().mockResolvedValue({ transactionId: "expense-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("shared_expense", {
            kind: "shared_expense",
            splitType: "equal",
            participants: [{ personId: null, name: "Me", share: 50, isMe: true }],
          }),
        }),
      ],
      repositories: { ...unreachableRepositories(), expenseRepository: { createExpense, assignToPerson: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createExpense).toHaveBeenCalledWith(expect.objectContaining({ splitType: "equal" }));
    expect(result.results[0].transactionId).toBe("expense-txn");
  });

  it("someone_elses_expense: routes through expenseRepository.assignToPerson", async () => {
    const assignToPerson = vi.fn().mockResolvedValue({ transactionId: "assigned-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("someone_elses_expense", { kind: "someone_elses_expense", personId: "person-1", personName: "Alex" }),
        }),
      ],
      repositories: { ...unreachableRepositories(), expenseRepository: { createExpense: vi.fn(), assignToPerson } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(assignToPerson).toHaveBeenCalledWith(expect.objectContaining({ personId: "person-1" }));
    expect(result.results[0].transactionId).toBe("assigned-txn");
  });

  it("transfer: routes through transactionRepository.createTransferPair", async () => {
    const createTransferPair = vi.fn().mockResolvedValue([{ id: "leg-source" }, { id: "leg-dest" }]);
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: "acc-2" }) })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction: vi.fn(), createTransferPair } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createTransferPair).toHaveBeenCalledWith(expect.objectContaining({ destinationAccountId: "acc-2" }));
    expect(result.results[0].transactionId).toBe("leg-source");
  });

  it("existing_emi: pays the earliest open installment then writes a plain expense transaction", async () => {
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]);
    const createTransaction = vi.fn().mockResolvedValue({ id: "emi-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(applyPayment).toHaveBeenCalled();
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "expense" }));
  });

  it("existing_emi: fails loudly (not silently) when the linked EMI is already closed", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: true, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(result.results[0].error).toContain("already closed");
  });

  it("create_emi: creates the EMI, pays the first installment, then writes a plain expense transaction", async () => {
    const createEmi = vi.fn().mockResolvedValue({ scheduleId: "sched-new" });
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]);
    const createTransaction = vi.fn().mockResolvedValue({ id: "emi-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_emi", {
            kind: "create_emi",
            name: "New Phone",
            principalAmount: 1200,
            interestRatePercent: null,
            months: 12,
            startDate: new Date("2026-08-01"),
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi } as never,
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createEmi).toHaveBeenCalledWith(expect.objectContaining({ name: "New Phone" }));
    expect(applyPayment).toHaveBeenCalled();
  });

  it("existing_loan: pays the earliest open installment then writes a plain expense transaction", async () => {
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]);
    const createTransaction = vi.fn().mockResolvedValue({ id: "loan-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      loans: [{ id: "loan-1", scheduleId: "sched-1", isClosed: false } as never],
      rows: [row({ ...actionToAxesPatch("existing_loan", { kind: "existing_loan", loanId: "loan-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(applyPayment).toHaveBeenCalled();
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: "expense" }));
  });

  it("create_loan: creates the loan, pays the first installment, then writes a plain expense transaction", async () => {
    const createLoan = vi.fn().mockResolvedValue({ scheduleId: "sched-new" });
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]);
    const createTransaction = vi.fn().mockResolvedValue({ id: "loan-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_loan", {
            kind: "create_loan",
            name: "Friend loan",
            loanAmount: 5000,
            interestRatePercent: null,
            months: 6,
            startDate: new Date("2026-08-01"),
            personId: "person-1",
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        loanRepository: { createLoan } as never,
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(createLoan).toHaveBeenCalledWith(expect.objectContaining({ name: "Friend loan" }));
    expect(applyPayment).toHaveBeenCalled();
  });
});

describe("commitReviewImport — B3: atomicity, compensation, and retry safety for multi-write Actions", () => {
  const openInstallment = { id: "inst-1", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false };

  it("existing_emi: rolls back the installment payment if writing the Transaction fails, and reports the row as failed (not committed)", async () => {
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([openInstallment]);
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(result.committedCount).toBe(0);
    // First call pays (+100), second call is the compensating reversal (-100) — the installment
    // ends up exactly where it started, so a retry doesn't see it as already partially paid.
    expect(applyPayment).toHaveBeenCalledTimes(2);
    expect(applyPayment.mock.calls[0]).toEqual([openInstallment, 100]);
    expect(applyPayment.mock.calls[1]).toEqual([openInstallment, -100]);
  });

  it("existing_loan: rolls back the installment payment if writing the Transaction fails", async () => {
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([openInstallment]);
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await commitReviewImport({
      ...baseParams,
      loans: [{ id: "loan-1", scheduleId: "sched-1", isClosed: false } as never],
      rows: [row({ ...actionToAxesPatch("existing_loan", { kind: "existing_loan", loanId: "loan-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(applyPayment).toHaveBeenCalledTimes(2);
    expect(applyPayment.mock.calls[1]).toEqual([openInstallment, -100]);
  });

  it("existing_emi: reverses only the amount actually applied (clamped by applyPayment), not the requested amount", async () => {
    // The installment only has 40 left owing even though the row is for 100 — payEarliestOpenInstallment
    // clamps to what's actually due, and the reversal must undo exactly that, not the full row amount.
    const almostPaidInstallment = { id: "inst-1", dueDate: new Date("2026-08-01"), amountPaid: 60, amountDue: 100, isSkipped: false };
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([almostPaidInstallment]);
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(applyPayment.mock.calls[0]).toEqual([almostPaidInstallment, 40]);
    expect(applyPayment.mock.calls[1]).toEqual([almostPaidInstallment, -40]);
  });

  it("create_emi: hard-deletes the just-created EMI if paying the first installment fails, leaving no orphan", async () => {
    const createdEmi = { id: "emi-new", scheduleId: "sched-new" };
    const createEmi = vi.fn().mockResolvedValue(createdEmi);
    const permanentlyDeleteEmi = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockRejectedValue(new Error("installments unavailable"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_emi", {
            kind: "create_emi",
            name: "New Phone",
            principalAmount: 1200,
            interestRatePercent: null,
            months: 12,
            startDate: new Date("2026-08-01"),
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi, permanentlyDeleteEmi } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(result.committedCount).toBe(0);
    expect(permanentlyDeleteEmi).toHaveBeenCalledWith(createdEmi);
  });

  it("create_emi: hard-deletes the just-created EMI if writing the final Transaction fails", async () => {
    const createdEmi = { id: "emi-new", scheduleId: "sched-new" };
    const createEmi = vi.fn().mockResolvedValue(createdEmi);
    const permanentlyDeleteEmi = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([openInstallment]);
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_emi", {
            kind: "create_emi",
            name: "New Phone",
            principalAmount: 1200,
            interestRatePercent: null,
            months: 12,
            startDate: new Date("2026-08-01"),
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi, permanentlyDeleteEmi } as never,
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(permanentlyDeleteEmi).toHaveBeenCalledWith(createdEmi);
  });

  it("create_emi: a rollback failure never masks the original error", async () => {
    const createdEmi = { id: "emi-new", scheduleId: "sched-new" };
    const createEmi = vi.fn().mockResolvedValue(createdEmi);
    const permanentlyDeleteEmi = vi.fn().mockRejectedValue(new Error("rollback also failed"));
    const getAll = vi.fn().mockRejectedValue(new Error("original failure"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_emi", {
            kind: "create_emi",
            name: "New Phone",
            principalAmount: 1200,
            interestRatePercent: null,
            months: 12,
            startDate: new Date("2026-08-01"),
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi, permanentlyDeleteEmi } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.results[0].error).toBe("original failure");
  });

  it("create_loan: hard-deletes the just-created loan if paying the first installment fails, leaving no orphan", async () => {
    const createdLoan = { id: "loan-new", scheduleId: "sched-new" };
    const createLoan = vi.fn().mockResolvedValue(createdLoan);
    const permanentlyDeleteLoan = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockRejectedValue(new Error("installments unavailable"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_loan", {
            kind: "create_loan",
            name: "Friend loan",
            loanAmount: 5000,
            interestRatePercent: null,
            months: 6,
            startDate: new Date("2026-08-01"),
            personId: "person-1",
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        loanRepository: { createLoan, permanentlyDeleteLoan } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(permanentlyDeleteLoan).toHaveBeenCalledWith(createdLoan);
  });

  it("create_loan: hard-deletes the just-created loan if writing the final Transaction fails", async () => {
    const createdLoan = { id: "loan-new", scheduleId: "sched-new" };
    const createLoan = vi.fn().mockResolvedValue(createdLoan);
    const permanentlyDeleteLoan = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue([openInstallment]);
    const applyPayment = vi.fn().mockResolvedValue(undefined);
    const createTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_loan", {
            kind: "create_loan",
            name: "Friend loan",
            loanAmount: 5000,
            interestRatePercent: null,
            months: 6,
            startDate: new Date("2026-08-01"),
            personId: "person-1",
          }),
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        loanRepository: { createLoan, permanentlyDeleteLoan } as never,
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.failedCount).toBe(1);
    expect(permanentlyDeleteLoan).toHaveBeenCalledWith(createdLoan);
  });

  it("retry safety: a failed create_emi commit leaves no orphan, so retrying with working repositories produces exactly one EMI, not a duplicate", async () => {
    const failingCreateEmi = vi.fn().mockResolvedValue({ id: "emi-attempt-1", scheduleId: "sched-1" });
    const permanentlyDeleteEmi = vi.fn().mockResolvedValue(undefined);
    const failingGetAll = vi.fn().mockRejectedValue(new Error("transient failure"));
    const failingRow = row({
      ...actionToAxesPatch("create_emi", {
        kind: "create_emi",
        name: "New Phone",
        principalAmount: 1200,
        interestRatePercent: null,
        months: 12,
        startDate: new Date("2026-08-01"),
      }),
    });

    const firstAttempt = await commitReviewImport({
      ...baseParams,
      rows: [failingRow],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi: failingCreateEmi, permanentlyDeleteEmi } as never,
        installmentRepositoryFor: () => ({ getAll: failingGetAll, applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(firstAttempt.failedCount).toBe(1);
    expect(permanentlyDeleteEmi).toHaveBeenCalledTimes(1); // the failed attempt's EMI was cleaned up

    // Retry: same row (still not committed — `committedTransactionId` is still null), fresh working repositories.
    const workingCreateEmi = vi.fn().mockResolvedValue({ id: "emi-attempt-2", scheduleId: "sched-2" });
    const workingGetAll = vi.fn().mockResolvedValue([openInstallment]);
    const workingCreateTransaction = vi.fn().mockResolvedValue({ id: "txn-final" });
    const secondAttempt = await commitReviewImport({
      ...baseParams,
      rows: [failingRow],
      repositories: {
        ...unreachableRepositories(),
        emiRepository: { createEmi: workingCreateEmi, permanentlyDeleteEmi } as never,
        transactionRepository: { createTransaction: workingCreateTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll: workingGetAll, applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });

    expect(secondAttempt.committedCount).toBe(1);
    expect(workingCreateEmi).toHaveBeenCalledTimes(1); // exactly one EMI created on retry — no duplicate from attempt 1
  });

  it("idempotency: a row already carrying committedTransactionId is never re-dispatched, even for multi-write Actions", async () => {
    const createEmi = vi.fn();
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          ...actionToAxesPatch("create_emi", { kind: "create_emi", name: "x", principalAmount: 1, interestRatePercent: null, months: 1, startDate: new Date() }),
          committedTransactionId: "txn-already-committed",
        }),
      ],
      repositories: { ...unreachableRepositories(), emiRepository: { createEmi } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "committed", transactionId: "txn-already-committed" });
    expect(createEmi).not.toHaveBeenCalled();
  });
});

describe("commitReviewImport — B5: 'No Action selected' is always a hard block, never a silent guess", () => {
  it("blocks when flowType is null regardless of other fields being otherwise complete", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ flowType: null, ownership: null, actionDetail: null, category: "Shopping" })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.committedCount).toBe(0);
    expect(result.results[0].blockingReasons).toEqual([
      expect.objectContaining({ code: "missing_action", recordId: "r1" }),
    ]);
  });
});

describe("commitReviewImport — B6: Action/detail/ownership consistency validation", () => {
  it("blocks existing_emi with no emiId set on the detail", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "" }) })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("inconsistent_detail");
  });

  it("blocks existing_loan with no loanId set on the detail", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("existing_loan", { kind: "existing_loan", loanId: "" }) })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("inconsistent_detail");
  });

  it("blocks transfer with no destinationAccountId set on the detail", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: "" }) })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("inconsistent_detail");
  });

  it("blocks a row whose flowType/ownership disagree with its actionDetail.kind (the exact owner/action drift B1 was meant to close)", async () => {
    // flowType: expense + ownership: shared derives Action "shared_expense" via deriveRecordAction, but the
    // actionDetail is left at the someone_elses_expense shape — the two axes disagree about the same fact.
    const result = await commitReviewImport({
      ...baseParams,
      rows: [
        row({
          flowType: "expense",
          ownership: "shared",
          actionDetail: { kind: "someone_elses_expense", personId: "p1", personName: "Alex" },
        }),
      ],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("inconsistent_detail");
  });

  it("blocks shared_expense with zero participants", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("shared_expense", { kind: "shared_expense", splitType: "equal", participants: [] }) })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("inconsistent_detail");
  });

  it("does not block a fully consistent existing_emi row on detail grounds", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "emi-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll: vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]), applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
  });
});

describe("commitReviewImport — B22: the Business modifier reaches the committed Transaction", () => {
  it("passes modifiers.business through to createTransaction for a plain expense", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    await commitReviewImport({
      ...baseParams,
      rows: [row({ modifiers: { business: true, recurring: false, splitByCategory: false } })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ isBusiness: true }));
  });

  it("defaults isBusiness to false when the modifier isn't set", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new" });
    await commitReviewImport({
      ...baseParams,
      rows: [row()],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ isBusiness: false }));
  });

  it("passes modifiers.business through on an existing_emi commit too, not just the plain-expense path", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "emi-txn" });
    await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [
        row({
          ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }),
          modifiers: { business: true, recurring: false, splitByCategory: false },
        }),
      ],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll: vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]), applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ isBusiness: true }));
  });
});

describe("commitReviewImport — B30: Category is only required when the flow type makes it a meaningful choice", () => {
  it("does not block a transfer row with no category set", async () => {
    const createTransferPair = vi.fn().mockResolvedValue([{ id: "leg-source" }, { id: "leg-dest" }]);
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: "acc-2" }), category: null })],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction: vi.fn(), createTransferPair } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(0);
    expect(result.committedCount).toBe(1);
  });

  it("does not block a debt_movement (existing_emi) row with no category set", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "emi-txn" });
    const result = await commitReviewImport({
      ...baseParams,
      emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
      rows: [row({ ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }), category: null })],
      repositories: {
        ...unreachableRepositories(),
        transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never,
        installmentRepositoryFor: () => ({ getAll: vi.fn().mockResolvedValue([{ dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]), applyPayment: vi.fn() }) as never,
      },
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(0);
    expect(result.committedCount).toBe(1);
  });

  it("does not block an ignore row with no category set (it's skipped before validation anyway)", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("ignore", { category: null })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.skippedCount).toBe(1);
    expect(result.blockedCount).toBe(0);
  });

  it("still blocks a plain expense row (category-applicable flow type) with no category set", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [rowForAction("normal_expense", { category: null })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("unresolved_category");
  });

  it("still blocks an investment_movement row with no category set — B30 keeps Category for investment/reversal flow types", async () => {
    const result = await commitReviewImport({
      ...baseParams,
      rows: [row({ flowType: "investment_movement", ownership: null, category: null })],
      repositories: unreachableRepositories(),
      onRowCommitted: vi.fn(),
    });
    expect(result.blockedCount).toBe(1);
    expect(result.results[0].blockingReasons?.map((b) => b.code)).toContain("unresolved_category");
  });
});

function existingTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-existing",
    type: "expense",
    amount: 100,
    dateTime: new Date("2026-07-15T00:00:00.000Z"),
    accountId: "acc-1",
    categoryId: "cat-shopping",
    description: "Amazon",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: "manual",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("detectFreshDuplicatesForCommit — catches duplicates the static server-side flag missed", () => {
  it("flags a row whose description/amount/date matches an existing transaction, even with no duplicateOfTransactionId/duplicateCandidateOf set", () => {
    const warnings = detectFreshDuplicatesForCommit([row()], [existingTransaction()], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.recordId).toBe("r1");
    expect(warnings[0]?.result.status).toBe("duplicate_candidate");
  });

  it("does not re-flag a row the server pipeline already flagged — that row has its own dedicated review UI and is hard-blocked from commit already", () => {
    const warnings = detectFreshDuplicatesForCommit([row({ duplicateCandidateOf: "txn-existing" })], [existingTransaction()], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  it("skips excluded rows, ignore-action rows, and already-committed rows", () => {
    const excluded = row({ include: false });
    const committed = row({ id: "r2", committedTransactionId: "txn-already" });
    const warnings = detectFreshDuplicatesForCommit([excluded, committed], [existingTransaction()], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  it("scores a same-amount match on a different account lower, but still surfaces it — never silently drops it", () => {
    const warnings = detectFreshDuplicatesForCommit([row()], [existingTransaction({ accountId: "acc-2" })], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.sameAccount).toBe(false);
    expect(warnings[0]?.result.bestMatch?.confidence).toBeLessThan(0.9);
  });

  it("finds no duplicate for a genuinely new transaction", () => {
    const warnings = detectFreshDuplicatesForCommit([row()], [existingTransaction({ description: "SWIGGY", amount: 250 })], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  // Final UAT cross-source combination: Existing SMS Transaction → normal (non-credit-card) PDF row.
  // `detectFreshDuplicatesForCommit` never reads `Transaction.source` at all (see its mapping of
  // `existingTransactions` above) — this pins that explicitly for a plain bank-statement PDF import,
  // not just the credit-card variant covered separately below.
  it("flags a normal PDF statement row against an already-existing transaction imported from SMS", () => {
    const smsImportedTransaction = existingTransaction({ id: "txn-from-sms", description: "Amazon", source: "sms" });
    const warnings = detectFreshDuplicatesForCommit([row()], [smsImportedTransaction], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-from-sms");
  });

  // Regression: a row with a blank counterparty column (no narration text parsed for it — both
  // `counterpartyNormalized` and `counterpartyRaw` empty) used to skip duplicate detection entirely,
  // since `checkForDuplicates` bails out before matching whenever there's no description text to
  // anchor a match to and `requireDescriptionMatch` (its default) is true. Same class of gap as
  // `features/transaction-candidates/lib/import-candidate.ts`'s no-merchant/no-bankName fix.
  it("still flags same amount + same exact date for a row with a BLANK counterparty (no narration text), even against an unrelated existing description", () => {
    const blankRow = row({ counterpartyRaw: "", counterpartyNormalized: null });
    const warnings = detectFreshDuplicatesForCommit([blankRow], [existingTransaction({ description: "Totally Unrelated Text" })], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-existing");
  });

  it("does NOT flag a blank-counterparty row a day off from an existing transaction (exact-day only, no description anchor to justify the ±1-day near-duplicate window)", () => {
    const blankRow = row({ counterpartyRaw: "", counterpartyNormalized: null, date: new Date("2026-07-16T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([blankRow], [existingTransaction({ description: "Totally Unrelated Text" })], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  // Regression: the stricter "same amount + same exact date, by itself, must warn" fallback exercised
  // at the actual write-path enforcement point — a row WITH a non-empty counterparty that simply
  // doesn't match the existing transaction's description must still be flagged.
  it("still flags same amount + same exact date when the row's counterparty is completely different from the existing transaction's description", () => {
    const differentRow = row({ counterpartyNormalized: "A Completely Different Merchant", counterpartyRaw: "A Completely Different Merchant" });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existingTransaction({ description: "Totally Unrelated Text" })], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-existing");
  });

  it("does NOT flag from this fallback on a different date, even with the same amount", () => {
    const differentRow = row({
      counterpartyNormalized: "A Completely Different Merchant",
      counterpartyRaw: "A Completely Different Merchant",
      date: new Date("2026-08-20T00:00:00.000Z"),
    });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existingTransaction({ description: "Totally Unrelated Text", dateTime: new Date("2026-07-15T00:00:00.000Z") })], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT flag from this fallback on a different amount, even with the same exact date", () => {
    const differentRow = row({ counterpartyNormalized: "A Completely Different Merchant", counterpartyRaw: "A Completely Different Merchant", amount: 500 });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existingTransaction({ description: "Totally Unrelated Text", amount: 999 })], "acc-1");
    expect(warnings).toHaveLength(0);
  });
});

describe("detectFreshDuplicatesForCommit — same-batch duplicates (UAT: 'PDF batch' scenario)", () => {
  it("flags row B as a duplicate of row A when both are in the same commit batch and neither was flagged server-side, since committing A would create the transaction B then duplicates", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499, date: new Date("2026-07-15T00:00:00.000Z") });
    const rowB = row({ id: "rB", counterpartyNormalized: "Amazon", amount: 499, date: new Date("2026-07-15T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [], "acc-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.recordId).toBe("rB");
    expect(warnings[0]?.result.bestMatch?.reason).toContain("rA");
    expect(warnings[0]?.result.bestMatch?.reason).not.toContain("pending-row-");
    expect(warnings[0]?.result.bestMatch?.reason.toLowerCase()).toContain("this same import");
  });

  it("does NOT flag row A itself — only later rows are checked against earlier ones, matching commit order", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499 });
    const rowB = row({ id: "rB", counterpartyNormalized: "Amazon", amount: 499 });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [], "acc-1");
    expect(warnings.map((w) => w.recordId)).toEqual(["rB"]);
  });

  it("a third row can duplicate either of the first two, and both are reported independently", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499 });
    const rowB = row({ id: "rB", counterpartyNormalized: "Swiggy", amount: 250 });
    const rowC = row({ id: "rC", counterpartyNormalized: "Amazon", amount: 499 });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB, rowC], [], "acc-1");
    expect(warnings.map((w) => w.recordId)).toEqual(["rC"]);
    expect(warnings[0]?.result.bestMatch?.reason).toContain("rA");
  });

  it("a row the server already flagged is skipped from being warned about, but still counts as a same-batch match for LATER rows", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499, duplicateCandidateOf: "txn-server-flagged" });
    const rowB = row({ id: "rB", counterpartyNormalized: "Amazon", amount: 499 });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [], "acc-1");
    // rowA has its own dedicated review UI (server-flagged) — not re-warned here.
    // rowB is warned because rowA will still become a real Transaction once resolved.
    expect(warnings.map((w) => w.recordId)).toEqual(["rB"]);
  });

  it("does not confuse unrelated rows in the same batch — different amount/description never flags", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499 });
    const rowB = row({ id: "rB", counterpartyNormalized: "Swiggy", amount: 250 });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [], "acc-1");
    expect(warnings).toHaveLength(0);
  });

  it("when a row matches both a real existing transaction and an earlier same-batch row, the real (higher-confidence) match wins the ranking", () => {
    const rowA = row({ id: "rA", counterpartyNormalized: "Amazon", amount: 499, referenceNumber: null });
    const rowB = row({ id: "rB", counterpartyNormalized: "Amazon", amount: 499, referenceNumber: "REF123" });
    const realExisting = existingTransaction({ id: "txn-real", description: "Amazon REF123", amount: 499 });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [realExisting], "acc-1");
    // rowA itself now also matches the real existing transaction (same amount/description/date) —
    // both rows are legitimately flagged. This test's focus is rowB's ranking.
    expect(warnings.map((w) => w.recordId)).toEqual(["rA", "rB"]);
    const rowBWarning = warnings.find((w) => w.recordId === "rB")!;
    // Confirmed reference number against the REAL existing transaction (0.98) beats the
    // unconfirmed same-batch match against rowA (0.9 * accountFactor) — real data wins the ranking.
    expect(rowBWarning.result.bestMatch?.transactionId).toBe("txn-real");
    expect(rowBWarning.result.bestMatch?.confidence).toBe(0.98);
  });
});

/**
 * Regression coverage for the "Credit Card PDF Statement Review" duplicate-detection audit.
 *
 * There is no separate credit-card commit path to test: `app/(app)/statement-review/[documentId]/page.tsx`
 * renders `TransactionStudio` directly for a credit-card statement's `documentId`, and
 * `TransactionStudio.handleApprove` (`transaction-studio.tsx`) resolves the credit card's underlying
 * `Account.id` via `creditCards.find(c => c.id === activeDocument.accountId)?.accountId` BEFORE calling
 * this exact `detectFreshDuplicatesForCommit`/`commitReviewImport` pair — the same functions already
 * exercised above for the generic PDF flow. These tests exist to make that fact explicit and pinned:
 * a credit card's resolved account id behaves like any other account id to this engine, and existing
 * transactions from every source (manual/SMS/PDF) are checked identically, since `Transaction.source`
 * plays no role in `checkForDuplicates` at all.
 */
describe("credit-card PDF statement review — duplicate detection (same shared engine, card-resolved accountId)", () => {
  const cardAccountId = "acc-behind-hdfc-card"; // stands in for `CreditCardProfile.accountId` resolved in transaction-studio.tsx

  function cardRow(overrides: Partial<StagedRecord> = {}): StagedRecord {
    return row({ counterpartyNormalized: "Amazon", amount: 2500, date: new Date("2026-08-20T00:00:00.000Z"), ...overrides });
  }

  // 1. Existing manual credit-card transaction → same transaction in PDF
  it("1: flags a credit-card statement row matching an already-existing MANUALLY entered transaction on the same card account", () => {
    const existing = existingTransaction({ id: "txn-manual", description: "Amazon", amount: 2500, accountId: cardAccountId, source: "manual", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-manual");
  });

  // 2. Existing SMS credit-card transaction → same transaction in PDF
  it("2: flags a credit-card statement row matching an already-existing transaction imported from SMS", () => {
    const existing = existingTransaction({ id: "txn-sms", description: "Amazon", amount: 2500, accountId: cardAccountId, source: "sms", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-sms");
  });

  // 3. Existing PDF credit-card transaction → same transaction appears in another PDF
  it("3: flags a credit-card statement row matching an already-existing transaction from a PRIOR PDF import", () => {
    const existing = existingTransaction({ id: "txn-prior-pdf", description: "Amazon", amount: 2500, accountId: cardAccountId, source: "pdf", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-prior-pdf");
  });

  // 4. Same amount/date but a DIFFERENT credit card — weaker, not exempt
  it("4: a same amount/date match on a DIFFERENT card's account is still surfaced, just at reduced (cross-account) confidence — never an exact-strength match", () => {
    const otherCardAccountId = "acc-behind-different-card";
    const existing = existingTransaction({ id: "txn-other-card", description: "Amazon", amount: 2500, accountId: otherCardAccountId, source: "manual", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.sameAccount).toBe(false);
    expect(warnings[0]?.result.bestMatch?.confidence).toBeLessThan(0.9); // halved by DIFFERENT_ACCOUNT_CONFIDENCE_FACTOR, still surfaced
  });

  // 5. Same amount/date but opposite direction/type — not a duplicate
  it("5: a same-amount/date row of the OPPOSITE direction (e.g. a refund credit vs. the original debit) is never flagged", () => {
    const existing = existingTransaction({ id: "txn-opposite", description: "Amazon", amount: 2500, accountId: cardAccountId, type: "income" });
    const warnings = detectFreshDuplicatesForCommit([cardRow({ direction: "debit" })], [existing], cardAccountId);
    expect(warnings).toHaveLength(0);
  });

  // 6. Within the existing ±1-day date window
  it("6: a credit-card statement row one day off from an existing transaction is still flagged as a near-duplicate", () => {
    const existing = existingTransaction({ id: "txn-near", description: "Amazon", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-19T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow({ date: new Date("2026-08-20T00:00:00.000Z") })], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.dayGap).toBe(1);
  });

  // 7. "Import Anyway" — commitReviewImport itself has no duplicate gate of its own (that's the
  // advisory pre-step `detectFreshDuplicatesForCommit` above, which `handleApprove` skips when
  // called with `skipDuplicateCheck: true`) — proving it still writes normally, and never touches
  // the pre-existing transaction (the mock repository exposes no edit/delete method at all).
  it("7: 'Import Anyway' — commitReviewImport writes the new transaction unconditionally (the duplicate check is a separate pre-step it never re-runs), and never touches the old transaction", async () => {
    const createTransaction = vi.fn().mockResolvedValue({ id: "txn-new-from-pdf" });
    const result = await commitReviewImport({
      ...baseParams,
      accountId: cardAccountId,
      rows: [cardRow()],
      repositories: { ...unreachableRepositories(), transactionRepository: { createTransaction, createTransferPair: vi.fn() } as never },
      onRowCommitted: vi.fn(),
    });
    expect(result.committedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "committed", transactionId: "txn-new-from-pdf" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ accountId: cardAccountId }));
    // `unreachableRepositories()` gives `transactionRepository` no edit/delete method at all — if
    // commitReviewImport ever tried to touch the pre-existing transaction it would throw, not pass quietly.
  });

  // 8. Cancel — proven at the advisory-check layer: a flagged row produces a warning and
  // `detectFreshDuplicatesForCommit` performs no writes of any kind (it's a pure function with no
  // repository access) — "cancel" in the UI is simply never calling commitReviewImport afterward,
  // so the row's `committedTransactionId` stays null and it remains in its normal review state.
  it("8: cancelling after a duplicate warning is a no-op at the detection layer — detecting duplicates never writes anything or marks rows committed", () => {
    const rowToCheck = cardRow();
    const existing = existingTransaction({ id: "txn-manual", description: "Amazon", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([rowToCheck], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(rowToCheck.committedTransactionId).toBeNull(); // row itself is never mutated by detection
  });

  // 9. Same-batch credit-card PDF duplicates
  it("9: two rows in the same credit-card statement batch that duplicate each other are still caught by the existing same-batch protection", () => {
    const rowA = cardRow({ id: "cc-rA" });
    const rowB = cardRow({ id: "cc-rB" });
    const warnings = detectFreshDuplicatesForCommit([rowA, rowB], [], cardAccountId);
    expect(warnings.map((w) => w.recordId)).toEqual(["cc-rB"]);
    expect(warnings[0]?.result.bestMatch?.reason.toLowerCase()).toContain("this same import");
  });

  // 10. Credit-card statement transaction duplicated by an SMS candidate (symmetric cross-source check)
  it("10: cross-source detection is symmetric — an existing SMS-sourced transaction duplicates a credit-card PDF row exactly like a PDF-sourced one would", () => {
    const smsExisting = existingTransaction({ id: "txn-from-sms", description: "Amazon", amount: 2500, accountId: cardAccountId, source: "sms", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [smsExisting], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-from-sms");
  });

  // 11. Credit-card statement transaction duplicated by a manually created transaction
  it("11: source never prevents matching — a manually created transaction still duplicates a later credit-card PDF row", () => {
    const manualExisting = existingTransaction({ id: "txn-manual-2", description: "Amazon", amount: 2500, accountId: cardAccountId, source: "manual", dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [manualExisting], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-manual-2");
  });

  // 12. Existing transaction created AFTER PDF staging but BEFORE final import — fresh detection at commit time
  it("12: a transaction created after the statement was staged (but before Approve & Import is clicked) is still caught, since existingTransactions is supplied fresh at commit time", () => {
    // Simulates `liveTransactions` (from `useTransactions()`'s live Firestore snapshot in
    // transaction-studio.tsx) having gained a new row between when the statement was parsed/staged
    // and the moment the user actually clicks Approve & Import — detectFreshDuplicatesForCommit
    // takes whatever is passed at call time, never a cached snapshot from staging time.
    const justCreatedTransaction = existingTransaction({ id: "txn-created-after-staging", description: "Amazon", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([cardRow()], [justCreatedTransaction], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-created-after-staging");
  });

  // 13. Regression: blank-counterparty credit-card statement row — same class of gap as the plain
  // PDF case above, exercised on the card-resolved accountId to confirm the fix isn't accidentally
  // account-path-specific.
  it("13: still flags same amount + same exact date for a BLANK-counterparty credit-card row, even against an unrelated existing description", () => {
    const blankCardRow = cardRow({ counterpartyRaw: "", counterpartyNormalized: null });
    const existing = existingTransaction({ id: "txn-unrelated-desc", description: "Totally Unrelated Text", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([blankCardRow], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-unrelated-desc");
  });

  // 14. Regression: strict "same amount + same exact date, by itself, must warn" fallback, exercised
  // with a non-empty but completely different counterparty text on a credit-card row.
  it("14: still flags same amount + same exact date for a credit-card row whose counterparty is completely different from the existing transaction's description", () => {
    const differentRow = cardRow({ counterpartyNormalized: "A Completely Different Merchant", counterpartyRaw: "A Completely Different Merchant" });
    const existing = existingTransaction({ id: "txn-unrelated-desc-2", description: "Totally Unrelated Text", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existing], cardAccountId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.result.bestMatch?.transactionId).toBe("txn-unrelated-desc-2");
  });

  it("15: does NOT flag from this fallback on a different date, even with the same amount, on a credit-card row", () => {
    const differentRow = cardRow({ counterpartyNormalized: "A Completely Different Merchant", counterpartyRaw: "A Completely Different Merchant", date: new Date("2026-08-25T00:00:00.000Z") });
    const existing = existingTransaction({ description: "Totally Unrelated Text", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existing], cardAccountId);
    expect(warnings).toHaveLength(0);
  });

  it("16: does NOT flag from this fallback on a different amount, even with the same exact date, on a credit-card row", () => {
    const differentRow = cardRow({ counterpartyNormalized: "A Completely Different Merchant", counterpartyRaw: "A Completely Different Merchant", amount: 500 });
    const existing = existingTransaction({ description: "Totally Unrelated Text", amount: 2500, accountId: cardAccountId, dateTime: new Date("2026-08-20T00:00:00.000Z") });
    const warnings = detectFreshDuplicatesForCommit([differentRow], [existing], cardAccountId);
    expect(warnings).toHaveLength(0);
  });
});
