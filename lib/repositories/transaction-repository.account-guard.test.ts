import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRepository } from "./transaction-repository";
import type { AccountRepository } from "./account-repository";

/**
 * Covers `countActiveTransactionsForAccount` — the guard `deleteAccount`/`deleteCard`
 * now call before soft-deleting, so an account/card can no longer be removed while
 * active transactions still reference it (see the Account/Credit Card delete
 * integrity fix).
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  getDocs: vi.fn(),
}));

import { getDocs, where } from "firebase/firestore";

function makeRepo() {
  const accountRepository = {} as AccountRepository;
  return new TransactionRepository({ firestore: {} } as never, accountRepository);
}

describe("TransactionRepository.countActiveTransactionsForAccount", () => {
  beforeEach(() => {
    vi.mocked(getDocs).mockClear();
    vi.mocked(where).mockClear();
  });

  it("returns the number of active (non-deleted) transactions referencing the account", async () => {
    vi.mocked(getDocs).mockResolvedValue({ size: 3 } as never);
    const repo = makeRepo();

    const count = await repo.countActiveTransactionsForAccount("acc-a");

    expect(count).toBe(3);
    expect(where).toHaveBeenCalledWith("accountId", "==", "acc-a");
    expect(where).toHaveBeenCalledWith("deletedAt", "==", null);
  });

  it("returns 0 when no active transactions reference the account", async () => {
    vi.mocked(getDocs).mockResolvedValue({ size: 0 } as never);
    const repo = makeRepo();

    const count = await repo.countActiveTransactionsForAccount("acc-empty");

    expect(count).toBe(0);
  });
});
