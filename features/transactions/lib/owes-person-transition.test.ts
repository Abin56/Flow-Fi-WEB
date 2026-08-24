import { describe, expect, it, vi } from "vitest";
import type { Expense } from "@/lib/models/expense";
import type { Transaction } from "@/lib/models/transaction";
import { applyOwesPersonChange } from "./owes-person-transition";

/**
 * Covers `applyOwesPersonChange`'s compensation when the transaction-stamp
 * write fails after the ledger-side change already committed — without it,
 * a failure here either leaves an untraceable "owed" ledger balance with no
 * transaction backing it, or silently drops a real debt from People totals.
 */

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    type: "expense",
    amount: 500,
    dateTime: new Date("2026-08-01T00:00:00Z"),
    accountId: "acc-a",
    categoryId: "cat-1",
    description: "Dinner",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-08-01T00:00:00Z"),
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

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "exp-1",
    description: "Dinner",
    totalAmount: 500,
    date: new Date("2026-08-01T00:00:00Z"),
    categoryId: "cat-1",
    accountId: "acc-a",
    transactionId: "t1",
    splitType: "custom",
    participants: [{ personId: "person-bob", name: "Bob", share: 500, installmentId: null, isMe: false }],
    scheduleId: null,
    notes: "",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("applyOwesPersonChange rollback on transaction-stamp failure", () => {
  it("not-owed -> owed: unassigns the just-created expense if the transaction stamp fails", async () => {
    const newExpense = expense({ id: "exp-new" });
    const expenseRepository = {
      convertToAssigned: vi.fn().mockResolvedValue(newExpense),
      unassignFromPerson: vi.fn().mockResolvedValue(undefined),
    };
    const transactionRepository = {
      editTransaction: vi.fn().mockRejectedValue(new Error("stamp failed")),
    };

    const t = transaction();

    await expect(
      applyOwesPersonChange({
        transaction: t,
        existingExpense: null,
        target: { personId: "person-bob", personName: "Bob", owesPersonToggle: true },
        transactionRepository: transactionRepository as never,
        expenseRepository: expenseRepository as never,
        installmentRepositoryFor: vi.fn() as never,
      }),
    ).rejects.toThrow("stamp failed");

    expect(expenseRepository.convertToAssigned).toHaveBeenCalledTimes(1);
    expect(expenseRepository.unassignFromPerson).toHaveBeenCalledWith(newExpense);
  });

  it("owed -> not-owed: re-creates the torn-down assignment if the transaction stamp fails", async () => {
    const existing = expense();
    const expenseRepository = {
      unassignFromPerson: vi.fn().mockResolvedValue(undefined),
      convertToAssigned: vi.fn().mockResolvedValue(expense({ id: "exp-restored" })),
    };
    const transactionRepository = {
      editTransaction: vi.fn().mockRejectedValue(new Error("stamp failed")),
    };

    const t = transaction({ linkedPersonId: "person-bob", owesPersonToggle: true });

    await expect(
      applyOwesPersonChange({
        transaction: t,
        existingExpense: existing,
        target: { personId: null, personName: "", owesPersonToggle: false },
        transactionRepository: transactionRepository as never,
        expenseRepository: expenseRepository as never,
        installmentRepositoryFor: vi.fn() as never,
      }),
    ).rejects.toThrow("stamp failed");

    expect(expenseRepository.unassignFromPerson).toHaveBeenCalledWith(existing);
    // Restores the same person who was just unassigned.
    expect(expenseRepository.convertToAssigned).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "person-bob", personName: "Bob" }),
    );
  });

  it("owed -> owed, different person: reverses both the new assignment and restores the old one if the transaction stamp fails", async () => {
    const existing = expense({ participants: [{ personId: "person-bob", name: "Bob", share: 500, installmentId: null, isMe: false }] });
    const newExpense = expense({ id: "exp-carol", participants: [{ personId: "person-carol", name: "Carol", share: 500, installmentId: null, isMe: false }] });
    const restoredExpense = expense({ id: "exp-bob-restored" });

    const expenseRepository = {
      unassignFromPerson: vi.fn().mockResolvedValue(undefined),
      convertToAssigned: vi.fn().mockResolvedValueOnce(newExpense).mockResolvedValueOnce(restoredExpense),
    };
    const transactionRepository = {
      editTransaction: vi.fn().mockRejectedValue(new Error("stamp failed")),
    };

    const t = transaction({ linkedPersonId: "person-bob", owesPersonToggle: true });

    await expect(
      applyOwesPersonChange({
        transaction: t,
        existingExpense: existing,
        target: { personId: "person-carol", personName: "Carol", owesPersonToggle: true },
        transactionRepository: transactionRepository as never,
        expenseRepository: expenseRepository as never,
        installmentRepositoryFor: vi.fn() as never,
      }),
    ).rejects.toThrow("stamp failed");

    // New (Carol) assignment torn down...
    expect(expenseRepository.unassignFromPerson).toHaveBeenCalledWith(newExpense);
    // ...and the original (Bob) assignment restored.
    expect(expenseRepository.convertToAssigned).toHaveBeenLastCalledWith(
      expect.objectContaining({ personId: "person-bob", personName: "Bob" }),
    );
  });

  it("succeeds without any rollback call when the transaction stamp succeeds", async () => {
    const newExpense = expense({ id: "exp-new" });
    const expenseRepository = {
      convertToAssigned: vi.fn().mockResolvedValue(newExpense),
      unassignFromPerson: vi.fn().mockResolvedValue(undefined),
    };
    const transactionRepository = {
      editTransaction: vi.fn().mockResolvedValue(undefined),
    };

    await applyOwesPersonChange({
      transaction: transaction(),
      existingExpense: null,
      target: { personId: "person-bob", personName: "Bob", owesPersonToggle: true },
      transactionRepository: transactionRepository as never,
      expenseRepository: expenseRepository as never,
      installmentRepositoryFor: vi.fn() as never,
    });

    expect(expenseRepository.unassignFromPerson).not.toHaveBeenCalled();
  });
});
