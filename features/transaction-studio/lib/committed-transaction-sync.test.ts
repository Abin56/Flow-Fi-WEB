import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { draftFromRow } from "./transaction-manage-draft";
import {
  applyToCommittedRows,
  deleteCommittedAwareRow,
  describeBulkFailures,
  draftToEditTransactionParams,
  formatAccountDisplay,
  gridPatchToEditTransactionParams,
  partitionRowsByCommitStatus,
  resolveCategoryId,
  saveGridFieldCommittedAware,
} from "./committed-transaction-sync";

function row(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T00:00:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 123.45,
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
    notes: "birthday present",
    duplicateOfTransactionId: null,
    include: true,
    flowType: "expense",
    ownership: "mine",
    modifiers: DEFAULT_RECORD_MODIFIERS,
    actionDetail: null,
    committedTransactionId: "txn-1",
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

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat-shopping",
    name: "Shopping",
    type: "expense",
    iconKey: "other",
    colorValue: 0,
    isDefault: false,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "HDFC Credit Card",
    type: "card",
    openingBalance: 0,
    currentBalance: -1250,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    bankId: null,
    accountHolderName: null,
    notes: null,
    accountNumberLast4: "1234",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-1",
    type: "expense",
    amount: 123.45,
    dateTime: new Date("2026-07-15T00:00:00.000Z"),
    accountId: "acc-1",
    categoryId: "cat-shopping",
    description: "Amazon",
    notes: "birthday present",
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
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("resolveCategoryId", () => {
  it("resolves a known category name to its id", () => {
    expect(resolveCategoryId("Shopping", [category()])).toEqual({ categoryId: "cat-shopping", error: null });
  });

  it("returns undefined categoryId (leave unchanged) for null input, no error", () => {
    expect(resolveCategoryId(null, [category()])).toEqual({ categoryId: undefined, error: null });
  });

  it("errors on an unresolvable category name instead of silently dropping it", () => {
    const result = resolveCategoryId("Ghost Category", [category()]);
    expect(result.categoryId).toBeUndefined();
    expect(result.error).toContain("Ghost Category");
  });
});

describe("formatAccountDisplay", () => {
  it("appends the masked last-4 digits when known", () => {
    expect(formatAccountDisplay(account())).toBe("HDFC Credit Card ••••1234");
  });

  it("falls back to just the name when there's no last-4 on file", () => {
    expect(formatAccountDisplay(account({ accountNumberLast4: null }))).toBe("HDFC Credit Card");
  });
});

describe("deleteCommittedAwareRow", () => {
  it("only deletes the staging record for a not-yet-committed row — never touches TransactionRepository", async () => {
    const softDeleteTransaction = vi.fn().mockResolvedValue(undefined);
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    await deleteCommittedAwareRow({
      row: row({ committedTransactionId: null }),
      committedTransaction: null,
      transactionRepository: { softDeleteTransaction } as unknown as TransactionRepository,
      mutations: { deleteRecord },
    });
    expect(softDeleteTransaction).not.toHaveBeenCalled();
    expect(deleteRecord).toHaveBeenCalledWith("r1");
  });

  it("soft-deletes the real transaction before removing the staging copy for a committed row", async () => {
    const calls: string[] = [];
    const softDeleteTransaction = vi.fn().mockImplementation(async () => {
      calls.push("real");
    });
    const deleteRecord = vi.fn().mockImplementation(async () => {
      calls.push("staging");
    });
    const txn = transaction();
    await deleteCommittedAwareRow({
      row: row({ committedTransactionId: "txn-1" }),
      committedTransaction: txn,
      transactionRepository: { softDeleteTransaction } as unknown as TransactionRepository,
      mutations: { deleteRecord },
    });
    expect(softDeleteTransaction).toHaveBeenCalledWith(txn);
    expect(calls).toEqual(["real", "staging"]); // real delete happens first
  });

  it("leaves the staging row intact when the real delete fails — never removes it and rethrows", async () => {
    const softDeleteTransaction = vi.fn().mockRejectedValue(new Error("network error"));
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    await expect(
      deleteCommittedAwareRow({
        row: row({ committedTransactionId: "txn-1" }),
        committedTransaction: transaction(),
        transactionRepository: { softDeleteTransaction } as unknown as TransactionRepository,
        mutations: { deleteRecord },
      }),
    ).rejects.toThrow("network error");
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("routes a committed transfer leg through deleteTransferPair instead of softDeleteTransaction, so the sibling leg isn't orphaned", async () => {
    const softDeleteTransaction = vi.fn().mockResolvedValue(undefined);
    const deleteTransferPair = vi.fn().mockResolvedValue(undefined);
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    const txn = transaction({ transferId: "transfer-1" });
    await deleteCommittedAwareRow({
      row: row({ committedTransactionId: "txn-1" }),
      committedTransaction: txn,
      transactionRepository: { softDeleteTransaction, deleteTransferPair } as unknown as TransactionRepository,
      mutations: { deleteRecord },
    });
    expect(deleteTransferPair).toHaveBeenCalledWith(txn);
    expect(softDeleteTransaction).not.toHaveBeenCalled();
    expect(deleteRecord).toHaveBeenCalledWith("r1");
  });

  it("refuses to delete a committed row before its real Transaction has loaded, rather than silently deleting only the staging copy", async () => {
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    await expect(
      deleteCommittedAwareRow({
        row: row({ committedTransactionId: "txn-1" }),
        committedTransaction: null,
        transactionRepository: null,
        mutations: { deleteRecord },
      }),
    ).rejects.toThrow(/hasn't finished loading/);
    expect(deleteRecord).not.toHaveBeenCalled();
  });
});

describe("gridPatchToEditTransactionParams", () => {
  it("maps the date column to dateTime", () => {
    const d = new Date("2026-08-01T00:00:00.000Z");
    expect(gridPatchToEditTransactionParams("date", { date: d })).toEqual({ dateTime: d });
  });

  it("maps the merchant column's counterpartyNormalized to description", () => {
    expect(gridPatchToEditTransactionParams("merchant", { counterpartyNormalized: "Amazon" })).toEqual({ description: "Amazon" });
  });

  it("maps the amount column straight through", () => {
    expect(gridPatchToEditTransactionParams("amount", { amount: 999 })).toEqual({ amount: 999 });
  });
});

describe("saveGridFieldCommittedAware", () => {
  it("writes only the staging record for a not-yet-committed row — never touches TransactionRepository", async () => {
    const editTransaction = vi.fn().mockResolvedValue(undefined);
    const updateFields = vi.fn().mockResolvedValue(undefined);
    await saveGridFieldCommittedAware({
      row: row({ committedTransactionId: null }),
      columnId: "amount",
      patch: { amount: 200 },
      committedTransaction: null,
      transactionRepository: { editTransaction } as unknown as TransactionRepository,
      mutations: { updateFields },
    });
    expect(editTransaction).not.toHaveBeenCalled();
    expect(updateFields).toHaveBeenCalledWith("r1", { amount: 200 });
  });

  it("writes the real transaction first, then syncs staging, for a committed row's amount edit", async () => {
    const calls: string[] = [];
    const editTransaction = vi.fn().mockImplementation(async () => {
      calls.push("real");
    });
    const updateFields = vi.fn().mockImplementation(async () => {
      calls.push("staging");
    });
    const txn = transaction();
    await saveGridFieldCommittedAware({
      row: row({ committedTransactionId: "txn-1" }),
      columnId: "amount",
      patch: { amount: 200 },
      committedTransaction: txn,
      transactionRepository: { editTransaction } as unknown as TransactionRepository,
      mutations: { updateFields },
    });
    expect(editTransaction).toHaveBeenCalledWith(txn, { amount: 200 });
    expect(calls).toEqual(["real", "staging"]);
  });

  it("never writes staging when the real transaction edit fails, and rethrows", async () => {
    const editTransaction = vi.fn().mockRejectedValue(new Error("balance write failed"));
    const updateFields = vi.fn().mockResolvedValue(undefined);
    await expect(
      saveGridFieldCommittedAware({
        row: row({ committedTransactionId: "txn-1" }),
        columnId: "amount",
        patch: { amount: 200 },
        committedTransaction: transaction(),
        transactionRepository: { editTransaction } as unknown as TransactionRepository,
        mutations: { updateFields },
      }),
    ).rejects.toThrow("balance write failed");
    expect(updateFields).not.toHaveBeenCalled();
  });

  it("refuses a committed row's edit before its real Transaction has loaded, rather than silently writing only staging", async () => {
    const updateFields = vi.fn().mockResolvedValue(undefined);
    await expect(
      saveGridFieldCommittedAware({
        row: row({ committedTransactionId: "txn-1" }),
        columnId: "date",
        patch: { date: new Date("2026-08-01T00:00:00.000Z") },
        committedTransaction: null,
        transactionRepository: null,
        mutations: { updateFields },
      }),
    ).rejects.toThrow(/hasn't finished loading/);
    expect(updateFields).not.toHaveBeenCalled();
  });
});

describe("draftToEditTransactionParams", () => {
  it("maps a valid draft to EditTransactionParams, resolving category name to categoryId", () => {
    const categories = [category()];
    const result = draftToEditTransactionParams(draftFromRow(row()), categories);
    expect(result.error).toBeNull();
    expect(result.params).toMatchObject({
      amount: 123.45,
      categoryId: "cat-shopping",
      description: "Amazon",
      notes: "birthday present",
      excludeFromCalculations: false,
      clearAccountingMonth: true,
    });
    expect(result.params?.dateTime).toBeInstanceOf(Date);
    expect(result.params?.accountingMonth).toBeNull();
  });

  it("errors when the category name has no matching Category (rather than silently dropping or writing an invalid id)", () => {
    const result = draftToEditTransactionParams(draftFromRow(row({ category: "Ghost Category" })), [category()]);
    expect(result.params).toBeNull();
    expect(result.error).toContain("Ghost Category");
  });

  it("leaves categoryId undefined (unchanged) when the draft has no category at all", () => {
    const result = draftToEditTransactionParams(draftFromRow(row({ category: null })), [category()]);
    expect(result.error).toBeNull();
    expect(result.params?.categoryId).toBeUndefined();
  });

  it("sets clearAccountingMonth false and a real Date when a month attribution is set", () => {
    const draft = { ...draftFromRow(row()), accountingMonth: "2026-03" };
    const result = draftToEditTransactionParams(draft, [category()]);
    expect(result.params?.clearAccountingMonth).toBe(false);
    expect(result.params?.accountingMonth?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("partitionRowsByCommitStatus", () => {
  it("splits a mixed selection into staged and committed", () => {
    const staged1 = row({ id: "s1", committedTransactionId: null });
    const staged2 = row({ id: "s2", committedTransactionId: null });
    const committed1 = row({ id: "c1", committedTransactionId: "txn-1" });
    const result = partitionRowsByCommitStatus([staged1, committed1, staged2]);
    expect(result.staged.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(result.committed.map((r) => r.id)).toEqual(["c1"]);
  });

  it("handles an all-staged selection", () => {
    const rows = [row({ id: "s1", committedTransactionId: null }), row({ id: "s2", committedTransactionId: null })];
    expect(partitionRowsByCommitStatus(rows)).toEqual({ staged: rows, committed: [] });
  });

  it("handles an all-committed selection", () => {
    const rows = [row({ id: "c1", committedTransactionId: "t1" }), row({ id: "c2", committedTransactionId: "t2" })];
    expect(partitionRowsByCommitStatus(rows)).toEqual({ staged: [], committed: rows });
  });

  it("handles an empty selection", () => {
    expect(partitionRowsByCommitStatus([])).toEqual({ staged: [], committed: [] });
  });
});

describe("applyToCommittedRows", () => {
  it("runs a mixed batch (10 staged excluded by the caller + 3 committed here) independently, all succeeding", async () => {
    const committedRows = [row({ id: "c1", committedTransactionId: "t1" }), row({ id: "c2", committedTransactionId: "t2" }), row({ id: "c3", committedTransactionId: "t3" })];
    const byId = new Map([
      ["t1", transaction({ id: "t1" })],
      ["t2", transaction({ id: "t2" })],
      ["t3", transaction({ id: "t3" })],
    ]);
    const apply = vi.fn().mockResolvedValue(undefined);
    const { succeeded, failed } = await applyToCommittedRows(committedRows, byId, { anything: true } as unknown as TransactionRepository, apply);
    expect(succeeded.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(failed).toEqual([]);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("lets each row succeed or fail independently — one failure doesn't block the others", async () => {
    const committedRows = [row({ id: "c1", committedTransactionId: "t1" }), row({ id: "c2", committedTransactionId: "t2" })];
    const byId = new Map([
      ["t1", transaction({ id: "t1" })],
      ["t2", transaction({ id: "t2" })],
    ]);
    const apply = vi.fn().mockImplementation(async (t: Transaction) => {
      if (t.id === "t2") throw new Error("write failed");
    });
    const { succeeded, failed } = await applyToCommittedRows(committedRows, byId, { anything: true } as unknown as TransactionRepository, apply);
    expect(succeeded.map((r) => r.id)).toEqual(["c1"]);
    expect(failed).toHaveLength(1);
    expect(failed[0].row.id).toBe("c2");
  });

  it("fails a row (not the whole batch) when its Transaction hasn't finished loading", async () => {
    const committedRows = [row({ id: "c1", committedTransactionId: "t1" }), row({ id: "c2", committedTransactionId: "missing" })];
    const byId = new Map([["t1", transaction({ id: "t1" })]]); // "missing" isn't loaded yet
    const apply = vi.fn().mockResolvedValue(undefined);
    const { succeeded, failed } = await applyToCommittedRows(committedRows, byId, { anything: true } as unknown as TransactionRepository, apply);
    expect(succeeded.map((r) => r.id)).toEqual(["c1"]);
    expect(failed).toHaveLength(1);
    expect(failed[0].row.id).toBe("c2");
    expect(String(failed[0].error)).toMatch(/hasn't finished loading/);
  });

  it("fails every row when transactionRepository itself is null", async () => {
    const committedRows = [row({ id: "c1", committedTransactionId: "t1" })];
    const byId = new Map([["t1", transaction({ id: "t1" })]]);
    const apply = vi.fn().mockResolvedValue(undefined);
    const { succeeded, failed } = await applyToCommittedRows(committedRows, byId, null, apply);
    expect(succeeded).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns empty succeeded/failed for an empty committed list", async () => {
    const apply = vi.fn();
    const result = await applyToCommittedRows([], new Map(), { anything: true } as unknown as TransactionRepository, apply);
    expect(result).toEqual({ succeeded: [], failed: [] });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("describeBulkFailures", () => {
  it("names up to 3 failed rows by merchant", () => {
    const failed = [
      { row: row({ id: "a", counterpartyNormalized: "Amazon" }), error: new Error("x") },
      { row: row({ id: "b", counterpartyNormalized: "Swiggy" }), error: new Error("x") },
    ];
    expect(describeBulkFailures(failed)).toBe("Amazon, Swiggy");
  });

  it("falls back to a raw counterparty when there's no normalized merchant", () => {
    const failed = [{ row: row({ id: "a", counterpartyNormalized: null, counterpartyRaw: "AMZN RAW" }), error: new Error("x") }];
    expect(describeBulkFailures(failed)).toBe("AMZN RAW");
  });

  it("switches to a count once there are more than 3 failures", () => {
    const failed = Array.from({ length: 5 }, (_, i) => ({ row: row({ id: `r${i}` }), error: new Error("x") }));
    expect(describeBulkFailures(failed)).toBe("5 rows");
  });

  it("returns an empty string for no failures", () => {
    expect(describeBulkFailures([])).toBe("");
  });
});
