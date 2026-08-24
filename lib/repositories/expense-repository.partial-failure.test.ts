import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { ExpenseRepository } from "./expense-repository";
import type { PaymentScheduleRepository } from "./payment-schedule-repository";
import type { PersonRepository, LedgerRepository } from "./person-repository";
import type { InstallmentRepository } from "./payment-schedule-repository";

/**
 * Covers `createExpense`'s compensation on partial failure — if schedule/ledger
 * generation throws after the Transaction (and its account-balance effect) already
 * committed, the Transaction must be rolled back rather than left orphaned, which
 * is what previously let a caller's retry create a second Transaction and double
 * the balance effect for the same statement line.
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
    openingBalance: 500,
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

describe("ExpenseRepository.createExpense partial-failure compensation", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("rolls back the just-created Transaction (and its balance effect) when schedule generation fails", async () => {
    const store = new Map<string, unknown>([["acc-a", account({ currentBalance: 500 })]]);
    setUpRunTransaction(store);

    const accountRepository = new AccountRepository({ firestore: {} } as never);
    const transactionRepository = new TransactionRepository({ firestore: {} } as never, accountRepository);

    const boom = new Error("schedule generation failed");
    const paymentScheduleRepository = { createSchedule: vi.fn().mockRejectedValue(boom) } as unknown as PaymentScheduleRepository;
    const personRepository = {} as PersonRepository;
    const installmentRepositoryFor = vi.fn() as unknown as (scheduleId: string) => InstallmentRepository;
    const ledgerRepositoryFor = vi.fn() as unknown as (personId: string) => LedgerRepository;

    const expenseRepository = new ExpenseRepository(
      { firestore: {} } as never,
      transactionRepository,
      paymentScheduleRepository,
      personRepository,
      installmentRepositoryFor,
      ledgerRepositoryFor,
    );

    await expect(
      expenseRepository.createExpense({
        description: "Dinner",
        totalAmount: 200,
        date: new Date("2026-08-01T00:00:00Z"),
        categoryId: "cat-1",
        accountId: "acc-a",
        splitType: "equal",
        participantInputs: [
          { name: "Me", isMe: true },
          { name: "Bob", personId: "person-bob" },
        ],
      }),
    ).rejects.toThrow("schedule generation failed");

    // Exactly one Transaction doc exists (the one created before the failure), and it
    // must be soft-deleted — not left active, which would otherwise let a retry pile a
    // second Transaction (and a second balance adjustment) on top of it.
    const transactionDocs = [...store.values()].filter(
      (v): v is Transaction => typeof v === "object" && v !== null && "amount" in (v as object),
    );
    expect(transactionDocs).toHaveLength(1);
    expect(transactionDocs[0].deletedAt).toBeInstanceOf(Date);

    // The account balance must be back to its pre-call value — the failed attempt's
    // Transaction effect was fully reversed, not left applied.
    expect((store.get("acc-a") as Account).currentBalance).toBe(500);
  });
});
