import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRepository } from "./transaction-repository";
import type { AccountRepository } from "./account-repository";

/**
 * Covers `getAllForAccountIncludingTrash` — the query the account/credit-card permanent-delete
 * cascade (`lib/repositories/account-deletion.ts`) uses to find every transaction (active and
 * trashed alike) that needs to be wiped alongside a deleted account. Unlike a plain `getAll()`,
 * this must NOT filter on `deletedAt` — a trashed transaction still needs to be swept up, not left
 * behind as an orphan once the account itself is gone.
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

describe("TransactionRepository.getAllForAccountIncludingTrash", () => {
  beforeEach(() => {
    vi.mocked(getDocs).mockClear();
    vi.mocked(where).mockClear();
  });

  it("queries by accountId only — no deletedAt filter — so trashed transactions are included", async () => {
    vi.mocked(getDocs).mockResolvedValue({ docs: [] } as never);
    const repo = makeRepo();

    await repo.getAllForAccountIncludingTrash("acc-a");

    expect(where).toHaveBeenCalledWith("accountId", "==", "acc-a");
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("returns every matching document's data, active and trashed alike", async () => {
    const active = { id: "tx-1", deletedAt: null };
    const trashed = { id: "tx-2", deletedAt: new Date("2026-08-01T00:00:00Z") };
    vi.mocked(getDocs).mockResolvedValue({
      docs: [active, trashed].map((data) => ({ data: () => data })),
    } as never);
    const repo = makeRepo();

    const result = await repo.getAllForAccountIncludingTrash("acc-a");

    expect(result).toEqual([active, trashed]);
  });
});
