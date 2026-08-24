import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Covers `createTransferPair`'s two-write orchestration, including the
 * audit finding that its rollback-on-failure had no safety net of its
 * own: if the destination leg's write failed AND the best-effort rollback
 * of the already-created source leg also failed, the original error used
 * to mask that — leaving a live source leg with money already deducted
 * and no way for the caller to know the rollback didn't happen.
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
  return {
    tx,
    commit: () => {
      for (const [k, v] of pending) store.set(k, v);
    },
  };
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

function makeRepos(store: Map<string, unknown>, options?: { failOn?: (id: string, callIndex: number) => boolean }) {
  let callIndex = 0;
  const impl = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const currentCall = callIndex++;
    const { tx, commit } = fakeTx(store);
    if (options?.failOn && options.failOn("call", currentCall)) {
      throw new Error(`Simulated failure on runTransaction call #${currentCall}`);
    }
    const result = await updateFn(tx);
    commit();
    return result;
  };
  vi.mocked(runTransaction).mockImplementation(impl as unknown as typeof runTransaction);

  const accountRepository = new AccountRepository({ firestore: {} } as never);
  const transactionRepository = new TransactionRepository({ firestore: {} } as never, accountRepository);
  return { transactionRepository };
}

describe("TransactionRepository.createTransferPair", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("creates both legs sharing one transferId, applying the correct balance effect to each account", async () => {
    const store = new Map<string, unknown>([
      ["acc-a", account({ id: "acc-a", currentBalance: 1000 })],
      ["acc-b", account({ id: "acc-b", currentBalance: 500 })],
    ]);
    const { transactionRepository } = makeRepos(store);

    const [sourceLeg, destinationLeg] = await transactionRepository.createTransferPair({
      amount: 300,
      dateTime: new Date("2026-08-01T00:00:00Z"),
      sourceAccountId: "acc-a",
      destinationAccountId: "acc-b",
      categoryId: "cat-transfer",
    });

    expect(sourceLeg.transferId).toBe(destinationLeg.transferId);
    expect((store.get("acc-a") as Account).currentBalance).toBe(700);
    expect((store.get("acc-b") as Account).currentBalance).toBe(800);
  });

  it("rolls back the source leg when the destination leg's write fails", async () => {
    const store = new Map<string, unknown>([
      ["acc-a", account({ id: "acc-a", currentBalance: 1000 })],
      // "acc-b" deliberately absent — the destination leg's createTransaction fails with "Account not found".
    ]);
    const { transactionRepository } = makeRepos(store);

    await expect(
      transactionRepository.createTransferPair({
        amount: 300,
        dateTime: new Date("2026-08-01T00:00:00Z"),
        sourceAccountId: "acc-a",
        destinationAccountId: "acc-b",
        categoryId: "cat-transfer",
      }),
    ).rejects.toThrow("Account not found");

    // The source leg's balance effect must be fully reversed by the rollback.
    expect((store.get("acc-a") as Account).currentBalance).toBe(1000);
    const sourceTxn = [...store.values()].find((v): v is Transaction => (v as Transaction)?.accountId === "acc-a") as
      | Transaction
      | undefined;
    expect(sourceTxn?.deletedAt).toBeInstanceOf(Date);
  });

  it("surfaces a distinct error (not the original, silently masked) when the rollback itself also fails", async () => {
    const store = new Map<string, unknown>([["acc-a", account({ id: "acc-a", currentBalance: 1000 })]]);
    // Call sequence: #0 = source leg createTransaction (succeeds), #1 = destination leg
    // createTransaction (fails — "acc-b" absent, but we also force-fail it directly here to
    // keep the scenario deterministic), #2 = the rollback's softDeleteTransaction (forced to fail).
    const { transactionRepository } = makeRepos(store, {
      failOn: (_id, callIndex) => callIndex === 1 || callIndex === 2,
    });

    await expect(
      transactionRepository.createTransferPair({
        amount: 300,
        dateTime: new Date("2026-08-01T00:00:00Z"),
        sourceAccountId: "acc-a",
        destinationAccountId: "acc-b",
        categoryId: "cat-transfer",
      }),
    ).rejects.toThrow(/couldn't be fully undone/i);
  });
});
