import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Covers `createTransaction`/`editTransaction`/`softDeleteTransaction`/
 * `restoreTransaction` — the account-balance-critical path that had zero
 * coverage before this pass. Mocks `doc`/`runTransaction` with a fake
 * Firestore transaction that buffers writes and only applies them to the
 * backing store if the callback resolves without throwing, faithfully
 * modeling real Firestore's atomicity guarantee (a mid-transaction throw
 * leaves the store completely untouched) — the exact property being tested.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(),
}));

import { runTransaction } from "firebase/firestore";

function fakeTx(store: Map<string, unknown>) {
  const pending = new Map<string, unknown>();
  const tx = {
    get: vi.fn(async (ref: { id: string }) => {
      const data = pending.has(ref.id) ? pending.get(ref.id) : store.get(ref.id);
      return { exists: () => data !== undefined, data: () => data };
    }),
    set: vi.fn((ref: { id: string }, value: unknown) => {
      pending.set(ref.id, value);
    }),
  };
  return { tx, commit: () => { for (const [k, v] of pending) store.set(k, v); } };
}

function setUpRunTransaction(store: Map<string, unknown>) {
  const impl = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const { tx, commit } = fakeTx(store);
    const result = await updateFn(tx);
    commit();
    return result;
  };
  vi.mocked(runTransaction).mockImplementation(impl as unknown as typeof runTransaction);
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-a",
    name: "Cash",
    type: "cash",
    openingBalance: 0,
    currentBalance: 500,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    bankId: null,
    accountHolderName: null,
    notes: null,
    accountNumberLast4: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    type: "expense",
    amount: 100,
    dateTime: new Date("2026-07-01T00:00:00Z"),
    accountId: "acc-a",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
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

function makeRepos(store: Map<string, unknown>) {
  setUpRunTransaction(store);
  const accountRepository = new AccountRepository({ firestore: {} } as never);
  const transactionRepository = new TransactionRepository({ firestore: {} } as never, accountRepository);
  return { accountRepository, transactionRepository };
}

describe("TransactionRepository balance-affecting mutations", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("createTransaction: expense decreases the account balance by exactly the amount", async () => {
    const store = new Map<string, unknown>([["acc-a", account({ currentBalance: 500 })]]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.createTransaction({
      type: "expense",
      amount: 120,
      dateTime: new Date("2026-08-01T00:00:00Z"),
      accountId: "acc-a",
      categoryId: "cat-1",
    });

    expect((store.get("acc-a") as Account).currentBalance).toBe(380);
  });

  it("createTransaction: income increases the account balance by exactly the amount", async () => {
    const store = new Map<string, unknown>([["acc-a", account({ currentBalance: 500 })]]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.createTransaction({
      type: "income",
      amount: 250,
      dateTime: new Date("2026-08-01T00:00:00Z"),
      accountId: "acc-a",
      categoryId: "cat-1",
    });

    expect((store.get("acc-a") as Account).currentBalance).toBe(750);
  });

  it("editTransaction: same-account amount change applies only the delta, not the full new amount", async () => {
    const original = txn({ accountId: "acc-a", type: "expense", amount: 100 });
    const store = new Map<string, unknown>([
      ["acc-a", account({ currentBalance: 400 })], // already reflects the -100 from `original`
      ["t1", original],
    ]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.editTransaction(original, { amount: 150 });

    // Only the extra -50 delta should apply, not another full -150.
    expect((store.get("acc-a") as Account).currentBalance).toBe(350);
  });

  it("editTransaction: moving to a different account fully reverses the old account and fully applies the new one", async () => {
    const original = txn({ accountId: "acc-a", type: "expense", amount: 100 });
    const store = new Map<string, unknown>([
      ["acc-a", account({ id: "acc-a", currentBalance: 400 })], // already reflects the -100
      ["acc-b", account({ id: "acc-b", currentBalance: 1000 })],
      ["t1", original],
    ]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.editTransaction(original, { accountId: "acc-b" });

    expect((store.get("acc-a") as Account).currentBalance).toBe(500); // fully reversed
    expect((store.get("acc-b") as Account).currentBalance).toBe(900); // fully applied
  });

  it("editTransaction: toggling excludeFromCalculations moves the balance effect to/from zero", async () => {
    const original = txn({ accountId: "acc-a", type: "expense", amount: 100, excludeFromCalculations: false });
    const store = new Map<string, unknown>([
      ["acc-a", account({ currentBalance: 400 })], // already reflects the -100
      ["t1", original],
    ]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.editTransaction(original, { excludeFromCalculations: true });

    // Excluding it should add back the 100 that was previously subtracted.
    expect((store.get("acc-a") as Account).currentBalance).toBe(500);
  });

  it("softDeleteTransaction then restoreTransaction round-trips the balance to its original value", async () => {
    const original = txn({ accountId: "acc-a", type: "expense", amount: 100 });
    const store = new Map<string, unknown>([
      ["acc-a", account({ currentBalance: 400 })],
      ["t1", original],
    ]);
    const { transactionRepository } = makeRepos(store);

    await transactionRepository.softDeleteTransaction(original);
    expect((store.get("acc-a") as Account).currentBalance).toBe(500);
    expect((store.get("t1") as Transaction).deletedAt).toBeInstanceOf(Date);

    await transactionRepository.restoreTransaction(original);
    expect((store.get("acc-a") as Account).currentBalance).toBe(400);
    expect((store.get("t1") as Transaction).deletedAt).toBeNull();
  });

  it("editTransaction: a mid-transaction failure (new account missing) leaves neither the old account nor the transaction doc modified", async () => {
    const original = txn({ accountId: "acc-a", type: "expense", amount: 100 });
    const store = new Map<string, unknown>([
      ["acc-a", account({ currentBalance: 400 })],
      // "acc-b" deliberately absent — simulates the account having been deleted concurrently.
      ["t1", original],
    ]);
    const { transactionRepository } = makeRepos(store);

    await expect(transactionRepository.editTransaction(original, { accountId: "acc-b" })).rejects.toThrow(
      "Account not found",
    );

    // Neither the source account nor the transaction doc should show any partial effect.
    expect((store.get("acc-a") as Account).currentBalance).toBe(400);
    expect(store.get("t1")).toBe(original);
  });

  it("createTransaction: a failure (account missing) leaves the transaction doc unwritten", async () => {
    const store = new Map<string, unknown>(); // no "acc-a" seeded
    const { transactionRepository } = makeRepos(store);

    await expect(
      transactionRepository.createTransaction({
        type: "expense",
        amount: 50,
        dateTime: new Date("2026-08-01T00:00:00Z"),
        accountId: "acc-a",
        categoryId: "cat-1",
      }),
    ).rejects.toThrow("Account not found");

    expect(store.size).toBe(0);
  });
});
