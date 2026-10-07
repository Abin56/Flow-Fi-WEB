import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "./transaction-repository";
import type { AccountRepository } from "./account-repository";

/**
 * `reconcileTransfers` orchestration without a Firestore emulator (this repo's package-wide "no emulator
 * available in this environment" constraint — see B2/B3's same note). Each pair is linked by
 * `linkTransferPair` in its own Firestore transaction that re-reads both legs (and the inflow's account)
 * fresh: `runTransaction` runs the callback over `docs` (seeded from the stubbed `getAll`), and each
 * transaction's `set` calls are kept in `linkWrites` — one entry per linked pair.
 */
const docs = new Map<string, unknown>();
const linkWrites: ReturnType<typeof vi.fn>[] = [];
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const set = vi.fn();
    linkWrites.push(set);
    return fn({ get: async (ref: { id: string }) => ({ exists: () => docs.has(ref.id), data: () => structuredClone(docs.get(ref.id)) }), set });
  }),
}));

import { doc } from "firebase/firestore";

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
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
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
  const accounts = { docRef: (id: string) => ({ id: `account:${id}` }) } as unknown as AccountRepository;
  const repo = new TransactionRepository({ firestore: {} } as never, accounts);
  repo.getAll = vi.fn().mockResolvedValue(all);
  docs.clear();
  for (const t of all) {
    docs.set(t.id, t);
    docs.set(`account:${t.accountId}`, { id: t.accountId, type: "bank" });
  }
  return repo;
}

describe("TransactionRepository.reconcileTransfers", () => {
  beforeEach(() => {
    linkWrites.length = 0;
    vi.mocked(doc).mockClear();
  });

  it("links a confident pair: writes a shared transferId + transferMatchedAt to both legs in one transaction", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000, dateTime: new Date("2026-07-01T00:00:00Z") });
    const repo = makeRepo([outflow, inflow]);

    const result = await repo.reconcileTransfers();

    expect(result.matches).toHaveLength(1);
    expect(linkWrites).toHaveLength(1);
    expect(doc).toHaveBeenCalledWith(expect.anything(), "out-1");
    expect(doc).toHaveBeenCalledWith(expect.anything(), "in-1");

    const set = linkWrites[0];
    expect(set).toHaveBeenCalledTimes(2); // both legs, nothing else (no account write — linking moves no money)
    const [, outflowWrite] = set.mock.calls[0];
    const [, inflowWrite] = set.mock.calls[1];
    expect(outflowWrite.transferId).toBe(inflowWrite.transferId); // same shared id on both legs
    expect([outflowWrite.amount, inflowWrite.amount]).toEqual([5000, 5000]);
    expect(outflowWrite.transferMatchedAt).toBeInstanceOf(Date);
    expect(inflowWrite.transferMatchedAt).toBeInstanceOf(Date);
  });

  it("idempotency: already-linked transactions (transferId set) are excluded from the candidate pool — no link write is ever made", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000, transferId: "xfer-existing" });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000, transferId: "xfer-existing" });
    const repo = makeRepo([outflow, inflow]);

    const result = await repo.reconcileTransfers();

    expect(result.matches).toHaveLength(0);
    expect(linkWrites).toHaveLength(0);
  });

  it("retry safety: re-running after a successful link finds nothing left to do for that pair", async () => {
    const outflow = txn({ id: "out-1", type: "expense", accountId: "acc-a", amount: 5000 });
    const inflow = txn({ id: "in-1", type: "income", accountId: "acc-b", amount: 5000 });
    const firstRunRepo = makeRepo([outflow, inflow]);
    const firstResult = await firstRunRepo.reconcileTransfers();
    expect(firstResult.matches).toHaveLength(1);
    expect(linkWrites).toHaveLength(1);

    // Simulate the persisted state a real Firestore read would now return: both legs carry the
    // shared transferId the first run just wrote.
    const linkedOutflow = { ...outflow, transferId: "xfer-linked" };
    const linkedInflow = { ...inflow, transferId: "xfer-linked" };
    const secondRunRepo = makeRepo([linkedOutflow, linkedInflow]);
    const secondResult = await secondRunRepo.reconcileTransfers();

    expect(secondResult.matches).toHaveLength(0);
    // Only the first run's link write exists — the retry made no new link write since there was nothing to link.
    expect(linkWrites).toHaveLength(1);
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
