import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "./transaction-repository";
import type { AccountRepository } from "./account-repository";

/**
 * `reconcileTransfers` is the only method on this repository that calls
 * `doc`/`writeBatch` directly (every other method goes through the inherited
 * `FirestoreCrudRepository.add`/`update`, which this file never exercises
 * since `getAll` is stubbed on the instance) — mocking just those two
 * functions is enough to test the orchestration layer without a Firestore
 * emulator, matching this repo's package-wide "no emulator available in
 * this environment" constraint (see B2/B3's same note).
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) })),
}));

import { doc, writeBatch } from "firebase/firestore";

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

function makeRepo(all: Transaction[]) {
  const repo = new TransactionRepository({ firestore: {} } as never, {} as AccountRepository);
  repo.getAll = vi.fn().mockResolvedValue(all);
  return repo;
}

describe("TransactionRepository.reconcileTransfers", () => {
  beforeEach(() => {
    vi.mocked(writeBatch).mockClear();
    vi.mocked(doc).mockClear();
  });

  it("links a confident pair: writes a shared transferId + transferMatchedAt to both legs in one batch", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const repo = makeRepo([outflow, inflow]);

    const result = await repo.reconcileTransfers();

    expect(result.matches).toHaveLength(1);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(doc).toHaveBeenCalledWith(expect.anything(), "out-1");
    expect(doc).toHaveBeenCalledWith(expect.anything(), "in-1");

    const batchInstance = vi.mocked(writeBatch).mock.results[0].value;
    expect(batchInstance.set).toHaveBeenCalledTimes(2);
    const [, outflowWrite] = batchInstance.set.mock.calls[0];
    const [, inflowWrite] = batchInstance.set.mock.calls[1];
    expect(outflowWrite.transferId).toBe(inflowWrite.transferId); // same shared id on both legs
    expect(outflowWrite.transferMatchedAt).toBeInstanceOf(Date);
    expect(inflowWrite.transferMatchedAt).toBeInstanceOf(Date);
    expect(batchInstance.commit).toHaveBeenCalledTimes(1);
  });

  it("idempotency: already-linked transactions (transferId set) are excluded from the candidate pool — no batch is ever created", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000, transferId: "xfer-existing" });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000, transferId: "xfer-existing" });
    const repo = makeRepo([outflow, inflow]);

    const result = await repo.reconcileTransfers();

    expect(result.matches).toHaveLength(0);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("retry safety: re-running after a successful link finds nothing left to do for that pair", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000 });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000 });
    const firstRunRepo = makeRepo([outflow, inflow]);
    const firstResult = await firstRunRepo.reconcileTransfers();
    expect(firstResult.matches).toHaveLength(1);
    expect(writeBatch).toHaveBeenCalledTimes(1);

    // Simulate the persisted state a real Firestore read would now return: both legs carry the
    // shared transferId the first run just wrote.
    const linkedOutflow = { ...outflow, transferId: "xfer-linked" };
    const linkedInflow = { ...inflow, transferId: "xfer-linked" };
    const secondRunRepo = makeRepo([linkedOutflow, linkedInflow]);
    const secondResult = await secondRunRepo.reconcileTransfers();

    expect(secondResult.matches).toHaveLength(0);
    // Only the first run's batch exists — the retry created no new batch since there was nothing to link.
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it("does not touch unrelated already-linked pairs while linking a new unmatched pair in the same run", async () => {
    const alreadyLinkedOut = txn({ id: "old-out", type: "expense", accountId: "acc-a", amount: 999, transferId: "xfer-old" });
    const alreadyLinkedIn = txn({ id: "old-in", type: "income", accountId: "acc-b", amount: 999, transferId: "xfer-old" });
    const newOut = txn({ id: "new-out", type: "expense", accountId: "acc-a", amount: 2500, dateTime: new Date("2026-08-01T00:00:00Z") });
    const newIn = txn({ id: "new-in", type: "income", accountId: "acc-c", amount: 2500, dateTime: new Date("2026-08-01T00:00:00Z") });
    const repo = makeRepo([alreadyLinkedOut, alreadyLinkedIn, newOut, newIn]);

    const result = await repo.reconcileTransfers();

    expect(result.matches).toEqual([{ outflowId: "new-out", inflowId: "new-in", amountDelta: 0, dateDeltaDays: 0 }]);
  });
});
