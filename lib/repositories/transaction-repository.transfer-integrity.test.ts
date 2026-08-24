import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository, TransferEditRestrictedError } from "./transaction-repository";
import type { AccountRepository } from "./account-repository";

/**
 * Regression coverage for the transfer-integrity audit findings:
 *   - editing a transfer leg's amount/account/date used to silently desync
 *     the paired leg (nothing kept the two documents consistent);
 *   - deleting one leg used to reverse only that leg's own account balance,
 *     orphaning the sibling leg's balance effect on the other account.
 *
 * `editTransaction`/`deleteTransferPair`/`restoreTransferPair` all go
 * through `runTransaction`, so this fakes just enough of the Firestore
 * transaction API (`tx.get`/`tx.set`) to exercise the real business logic
 * without an emulator — same approach as the sibling `*.account-guard` and
 * `*.reconcile` test files in this directory.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id, path: `col/${id}` })),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  limit: vi.fn((n: number) => ({ limit: n })),
  runTransaction: vi.fn(),
}));

import { doc, getDocs, runTransaction } from "firebase/firestore";

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

function account(id: string, balance: number): Account {
  return {
    id,
    name: id,
    type: "bank",
    openingBalance: 0,
    currentBalance: balance,
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
  };
}

/** Minimal stand-in for AccountRepository — only the two methods TransactionRepository calls. */
function makeAccountRepoStub(): AccountRepository {
  return {
    docRef: (id: string) => ({ id, path: `accounts/${id}` }) as never,
    applyBalanceDelta: (acc: Account, delta: number) => ({ ...acc, currentBalance: acc.currentBalance + delta }),
  } as unknown as AccountRepository;
}

/**
 * Simulates `runTransaction`'s tx: `get` resolves from a single in-memory
 * docs map keyed by ref id — used for both the transaction document itself
 * (editTransaction re-reads it fresh, see the "stale transaction object"
 * fix) and account documents, since a real Firestore transaction reads
 * from whatever collection the ref points at. `set` records writes.
 */
function makeFakeTx(docsById: Record<string, unknown>) {
  const writes: Array<{ id: string; data: unknown }> = [];
  const tx = {
    get: vi.fn(async (ref: { id: string }) => {
      const value = docsById[ref.id];
      return { exists: () => value != null, data: () => value };
    }),
    set: vi.fn((ref: { id: string }, data: unknown) => {
      writes.push({ id: ref.id, data });
    }),
  };
  return { tx, writes };
}

function makeRepo() {
  return new TransactionRepository({ firestore: {} } as never, makeAccountRepoStub());
}

describe("TransactionRepository transfer integrity", () => {
  beforeEach(() => {
    vi.mocked(doc).mockClear();
    vi.mocked(getDocs).mockClear();
    vi.mocked(runTransaction).mockClear();
  });

  describe("editTransaction — blocks edits that would desync a transfer pair", () => {
    it("throws TransferEditRestrictedError when changing amount on a transfer leg", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a" });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(t, { amount: 999 })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    });

    it("throws TransferEditRestrictedError when changing accountId on a transfer leg", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a" });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(t, { accountId: "acc-z" })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    });

    it("throws TransferEditRestrictedError when changing dateTime on a transfer leg", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a", dateTime: new Date("2026-07-01T00:00:00Z") });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(t, { dateTime: new Date("2026-08-01T00:00:00Z") })).rejects.toBeInstanceOf(
        TransferEditRestrictedError,
      );
    });

    it("re-derives the guard from the freshly-read document, not the stale caller-supplied copy", async () => {
      // The caller's in-memory copy still looks like a plain transaction (no transferId) — but
      // another writer already linked it into a transfer by the time this edit actually runs.
      // The guard must catch this from the fresh read, or a stale UI could still desync a pair.
      const repo = makeRepo();
      const staleCopy = txn({ id: "t1", transferId: null, accountId: "acc-a", amount: 100 });
      const freshOnServer = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a", amount: 100 });
      const { tx } = makeFakeTx({ t1: freshOnServer, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(staleCopy, { amount: 250 })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    });

    it("allows editing safe metadata (description, notes, category) on a transfer leg", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a" });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(t, { description: "Renamed", notes: "note", categoryId: "cat-2" })).resolves.toBeUndefined();
      expect(runTransaction).toHaveBeenCalledTimes(1);
    });

    it("allows a non-transfer transaction's amount/account/date to be edited normally", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: null, accountId: "acc-a", amount: 100 });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(repo.editTransaction(t, { amount: 250 })).resolves.toBeUndefined();
    });

    it("does not throw when params redundantly repeat the transfer leg's existing values", async () => {
      const repo = makeRepo();
      const t = txn({ id: "t1", transferId: "xfer-1", accountId: "acc-a", amount: 100, dateTime: new Date("2026-07-01T00:00:00Z") });
      const { tx } = makeFakeTx({ t1: t, "acc-a": account("acc-a", 500) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await expect(
        repo.editTransaction(t, { amount: 100, accountId: "acc-a", dateTime: new Date("2026-07-01T00:00:00Z") }),
      ).resolves.toBeUndefined();
    });
  });

  describe("findTransferSibling", () => {
    it("returns null for a non-transfer transaction without querying Firestore", async () => {
      const repo = makeRepo();
      const result = await repo.findTransferSibling(txn({ transferId: null }));
      expect(result).toBeNull();
      expect(getDocs).not.toHaveBeenCalled();
    });

    it("returns the other leg sharing the same transferId, excluding itself", async () => {
      const repo = makeRepo();
      const self = txn({ id: "leg-a", transferId: "xfer-1" });
      const sibling = txn({ id: "leg-b", transferId: "xfer-1", type: "income", accountId: "acc-b" });
      vi.mocked(getDocs).mockResolvedValue({ docs: [{ data: () => self }, { data: () => sibling }] } as never);

      const result = await repo.findTransferSibling(self);
      expect(result?.id).toBe("leg-b");
    });

    it("returns null when no sibling document exists (desynced/orphaned legacy transfer)", async () => {
      const repo = makeRepo();
      const self = txn({ id: "leg-a", transferId: "xfer-1" });
      vi.mocked(getDocs).mockResolvedValue({ docs: [{ data: () => self }] } as never);

      const result = await repo.findTransferSibling(self);
      expect(result).toBeNull();
    });
  });

  describe("deleteTransferPair", () => {
    it("soft-deletes both legs and reverses each leg's own account balance atomically", async () => {
      const repo = makeRepo();
      const outflow = txn({ id: "out-1", transferId: "xfer-1", type: "expense", accountId: "acc-a", amount: 500 });
      const inflow = txn({ id: "in-1", transferId: "xfer-1", type: "income", accountId: "acc-b", amount: 500 });
      vi.mocked(getDocs).mockResolvedValue({ docs: [{ data: () => outflow }, { data: () => inflow }] } as never);

      const accountsById = { "acc-a": account("acc-a", 1000), "acc-b": account("acc-b", 2000) };
      const { tx, writes } = makeFakeTx(accountsById);
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await repo.deleteTransferPair(outflow);

      // Deleting the expense leg restores the 500 it removed from acc-a; deleting the income
      // leg reverses the 500 it added to acc-b.
      const accountWrites = writes.filter((w) => w.id === "acc-a" || w.id === "acc-b");
      const accA = accountWrites.find((w) => w.id === "acc-a")!.data as Account;
      const accB = accountWrites.find((w) => w.id === "acc-b")!.data as Account;
      expect(accA.currentBalance).toBe(1500);
      expect(accB.currentBalance).toBe(1500);

      const outWrite = writes.find((w) => w.id === "out-1")!.data as Transaction;
      const inWrite = writes.find((w) => w.id === "in-1")!.data as Transaction;
      expect(outWrite.deletedAt).toBeInstanceOf(Date);
      expect(inWrite.deletedAt).toBeInstanceOf(Date);
    });

    it("falls back to a single-leg soft delete when no live sibling exists", async () => {
      const repo = makeRepo();
      const orphan = txn({ id: "out-1", transferId: "xfer-1", type: "expense", accountId: "acc-a", amount: 500 });
      vi.mocked(getDocs).mockResolvedValue({ docs: [{ data: () => orphan }] } as never);

      const { tx, writes } = makeFakeTx({ "acc-a": account("acc-a", 1000) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await repo.deleteTransferPair(orphan);

      expect(writes.find((w) => w.id === "out-1")).toBeTruthy();
      // Only the one account this leg actually belongs to should be touched.
      expect(writes.filter((w) => w.id === "acc-a" || w.id === "acc-b")).toHaveLength(1);
    });
  });

  describe("restoreTransferPair", () => {
    it("restores both legs and re-applies each leg's balance effect atomically", async () => {
      const repo = makeRepo();
      const now = new Date();
      const outflow = txn({ id: "out-1", transferId: "xfer-1", type: "expense", accountId: "acc-a", amount: 500, deletedAt: now });
      const inflow = txn({ id: "in-1", transferId: "xfer-1", type: "income", accountId: "acc-b", amount: 500, deletedAt: now });
      vi.mocked(getDocs).mockResolvedValue({ docs: [{ data: () => outflow }, { data: () => inflow }] } as never);

      const { tx, writes } = makeFakeTx({ "acc-a": account("acc-a", 1000), "acc-b": account("acc-b", 2000) });
      vi.mocked(runTransaction).mockImplementation(async (_db, cb) => (cb as (tx: unknown) => unknown)(tx));

      await repo.restoreTransferPair(outflow);

      const accA = writes.find((w) => w.id === "acc-a")!.data as Account;
      const accB = writes.find((w) => w.id === "acc-b")!.data as Account;
      expect(accA.currentBalance).toBe(500); // expense leg restored: -500
      expect(accB.currentBalance).toBe(2500); // income leg restored: +500

      const outWrite = writes.find((w) => w.id === "out-1")!.data as Transaction;
      const inWrite = writes.find((w) => w.id === "in-1")!.data as Transaction;
      expect(outWrite.deletedAt).toBeNull();
      expect(inWrite.deletedAt).toBeNull();
    });
  });
});
