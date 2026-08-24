import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry, Person } from "@/lib/models/person";
import { LedgerRepository, PersonRepository } from "./person-repository";

/**
 * Regression coverage for the production-hardening pass's PersonRepository
 * finding: `adjustBalance` was a plain, non-transactional read-modify-write
 * (no `runTransaction`), called from `addEntry`/`editEntryAmount`/
 * `softDeleteEntry`/`restoreEntry` — the exact same "concurrent writer can
 * silently drop an update" and "stale caller-supplied balance base" classes
 * of bug already fixed for `AccountRepository`/`TransactionRepository`, but
 * never applied here. Fixed by mirroring that same pattern: each
 * `LedgerRepository` write now reads both the person and (where relevant)
 * the ledger entry fresh inside one atomic `runTransaction`.
 *
 * Same fake-Firestore-transaction approach as
 * `transaction-repository.balance.test.ts`: a `store` Map backs `tx.get`,
 * writes buffer in a `pending` Map and only commit if the callback resolves
 * without throwing — faithfully modeling Firestore's real atomicity
 * guarantee (a mid-transaction throw leaves the store untouched).
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
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

function setUpRunTransaction(store: Map<string, unknown>) {
  const impl = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const { tx, commit } = fakeTx(store);
    const result = await updateFn(tx);
    commit();
    return result;
  };
  vi.mocked(runTransaction).mockImplementation(impl as unknown as typeof runTransaction);
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    name: "Alex",
    phone: null,
    email: null,
    notes: "",
    avatarColorValue: 0,
    openingBalance: 0,
    currentBalance: 500,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "e1",
    personId: "p1",
    type: "gave",
    amount: 100,
    date: new Date("2026-07-01T00:00:00Z"),
    note: "",
    increasesBalance: true,
    transactionRef: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function makeRepos(store: Map<string, unknown>) {
  setUpRunTransaction(store);
  const personRepository = new PersonRepository({ firestore: {} } as never);
  const ledgerRepository = new LedgerRepository({ firestore: {} } as never, personRepository);
  return { personRepository, ledgerRepository };
}

describe("LedgerRepository / PersonRepository balance-affecting mutations", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("addEntry: 'gave' increases the person's balance by exactly the amount, atomically with the entry write", async () => {
    const store = new Map<string, unknown>([["p1", person({ currentBalance: 500 })]]);
    const { ledgerRepository } = makeRepos(store);

    const created = await ledgerRepository.addEntry(person({ currentBalance: 500 }), {
      type: "gave",
      amount: 200,
      date: new Date("2026-08-01T00:00:00Z"),
    });

    expect((store.get("p1") as Person).currentBalance).toBe(700);
    expect((store.get(created.id) as LedgerEntry).amount).toBe(200);
    expect(runTransaction).toHaveBeenCalledTimes(1);
  });

  it("addEntry: 'borrowed' decreases the person's balance", async () => {
    const store = new Map<string, unknown>([["p1", person({ currentBalance: 500 })]]);
    const { ledgerRepository } = makeRepos(store);

    await ledgerRepository.addEntry(person({ currentBalance: 500 }), {
      type: "borrowed",
      amount: 150,
      date: new Date("2026-08-01T00:00:00Z"),
    });

    expect((store.get("p1") as Person).currentBalance).toBe(350);
  });

  it("addEntry: a failure (person missing) leaves the ledger entry unwritten — atomicity, not two independent writes", async () => {
    const store = new Map<string, unknown>(); // no "p1" seeded
    const { ledgerRepository } = makeRepos(store);

    await expect(
      ledgerRepository.addEntry(person({ id: "p1" }), {
        type: "gave",
        amount: 100,
        date: new Date("2026-08-01T00:00:00Z"),
      }),
    ).rejects.toThrow("Person not found");

    expect(store.size).toBe(0);
  });

  it("editEntryAmount: re-syncs the balance by exactly the delta, reading both person and entry fresh (not the stale caller-supplied copies)", async () => {
    const staleEntry = entry({ amount: 999 }); // caller's in-memory copy, deliberately wrong/stale
    const freshEntry = entry({ amount: 100 }); // what's actually in Firestore
    const store = new Map<string, unknown>([
      ["p1", person({ currentBalance: 600 })], // already reflects the +100 from the real (fresh) entry
      ["e1", freshEntry],
    ]);
    const { ledgerRepository } = makeRepos(store);

    await ledgerRepository.editEntryAmount(person({ currentBalance: 600 }), staleEntry, 250);

    // Delta must be computed against the fresh 100, not the stale 999: +150, not -749.
    expect((store.get("p1") as Person).currentBalance).toBe(750);
    expect((store.get("e1") as LedgerEntry).amount).toBe(250);
  });

  it("editEntryAmount: a mid-transaction failure (entry missing) leaves the person's balance untouched", async () => {
    const store = new Map<string, unknown>([["p1", person({ currentBalance: 500 })]]); // no "e1" seeded
    const { ledgerRepository } = makeRepos(store);

    await expect(
      ledgerRepository.editEntryAmount(person({ currentBalance: 500 }), entry({ id: "e1" }), 300),
    ).rejects.toThrow("Ledger entry not found");

    expect((store.get("p1") as Person).currentBalance).toBe(500);
  });

  it("softDeleteEntry then restoreEntry round-trips the balance to its original value, atomically", async () => {
    const theEntry = entry({ type: "gave", amount: 100 });
    const store = new Map<string, unknown>([
      ["p1", person({ currentBalance: 600 })], // already reflects the +100
      ["e1", theEntry],
    ]);
    const { ledgerRepository } = makeRepos(store);

    await ledgerRepository.softDeleteEntry(person({ currentBalance: 600 }), theEntry);
    expect((store.get("p1") as Person).currentBalance).toBe(500);
    expect((store.get("e1") as LedgerEntry).deletedAt).toBeInstanceOf(Date);

    await ledgerRepository.restoreEntry(person({ currentBalance: 500 }), store.get("e1") as LedgerEntry);
    expect((store.get("p1") as Person).currentBalance).toBe(600);
    expect((store.get("e1") as LedgerEntry).deletedAt).toBeNull();
  });

  it("softDeleteEntry: reverses the fresh entry's balance effect, not a stale caller-supplied one", async () => {
    const staleEntry = entry({ amount: 999, type: "gave" });
    const freshEntry = entry({ amount: 100, type: "gave" });
    const store = new Map<string, unknown>([
      ["p1", person({ currentBalance: 600 })], // reflects the real +100
      ["e1", freshEntry],
    ]);
    const { ledgerRepository } = makeRepos(store);

    await ledgerRepository.softDeleteEntry(person({ currentBalance: 600 }), staleEntry);

    // Must reverse the real +100, landing at 500 — not the stale +999.
    expect((store.get("p1") as Person).currentBalance).toBe(500);
  });

  it("concurrent-writer safety: two addEntry calls against the same person both land (simulated sequentially through the same store, as real Firestore transaction retries would)", async () => {
    const store = new Map<string, unknown>([["p1", person({ currentBalance: 500 })]]);
    const { ledgerRepository } = makeRepos(store);

    await ledgerRepository.addEntry(person({ currentBalance: 500 }), {
      type: "gave",
      amount: 100,
      date: new Date("2026-08-01T00:00:00Z"),
    });
    await ledgerRepository.addEntry(person({ currentBalance: 500 }), {
      // second caller's stale in-memory `person` still says 500 — but since
      // each call re-reads inside its own transaction, this must NOT overwrite
      // the first call's effect.
      type: "gave",
      amount: 50,
      date: new Date("2026-08-02T00:00:00Z"),
    });

    expect((store.get("p1") as Person).currentBalance).toBe(650);
  });
});
