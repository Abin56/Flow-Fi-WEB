import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import { compareLedgerEntriesNewestFirst } from "@/lib/models/person";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { ExpenseRepository } from "./expense-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { PaymentScheduleRepository, InstallmentRepository } from "./payment-schedule-repository";

/**
 * End-to-end coverage of Task 1 (custom-name split participants get promoted
 * into a real Person + People Ledger entry, idempotently across re-saves)
 * and Task 2 (per-participant Received/Yet-to-Receive/Don't-count status,
 * correctly reflected in ledger totals and reconciled on edit/delete), using
 * an in-memory fake for the small slice of the modular Firestore API these
 * repositories call (`doc`/`getDoc`/`getDocs`/`setDoc`/`query`/`where`/
 * `runTransaction`) — the same style `expense-repository.partial-failure.test.ts`
 * already uses for `runTransaction`, extended to cover reads/writes too so
 * `PersonRepository`/`LedgerRepository`'s real dedup and balance-sync logic
 * runs for real rather than being stubbed out.
 */

interface FakeDoc {
  id: string;
  collectionPath: string;
  data: unknown;
}

function makeFakeFirestore() {
  const docs = new Map<string, FakeDoc>();
  const keyOf = (collectionPath: string, id: string) => `${collectionPath}/${id}`;

  function collection(pathSegments: string[]) {
    const collectionPath = pathSegments.join("/");
    return { __collectionPath: collectionPath, firestore: {} } as unknown as { __collectionPath: string };
  }

  function doc(coll: { __collectionPath: string }, id: string) {
    return { __collectionPath: coll.__collectionPath, id };
  }

  async function getDoc(ref: { __collectionPath: string; id: string }) {
    const entry = docs.get(keyOf(ref.__collectionPath, ref.id));
    return { exists: () => entry !== undefined, data: () => entry?.data, id: ref.id };
  }

  async function setDoc(ref: { __collectionPath: string; id: string }, value: unknown) {
    docs.set(keyOf(ref.__collectionPath, ref.id), { id: ref.id, collectionPath: ref.__collectionPath, data: value });
  }

  function query(coll: { __collectionPath: string }, ..._clauses: unknown[]) {
    return { __collectionPath: coll.__collectionPath, __clauses: _clauses };
  }

  function where(field: string, op: string, value: unknown) {
    return { field, op, value };
  }

  async function getDocs(q: { __collectionPath: string; __clauses: { field: string; op: string; value: unknown }[] }) {
    const all = [...docs.values()].filter((d) => d.collectionPath === q.__collectionPath);
    const filtered = all.filter((d) =>
      q.__clauses.every((clause) => {
        const value = (d.data as Record<string, unknown>)[clause.field];
        if (clause.op === "==") return value === clause.value;
        if (clause.op === "!=") return value !== clause.value;
        return true;
      }),
    );
    return { docs: filtered.map((d) => ({ id: d.id, data: () => d.data })) };
  }

  async function runTransaction(_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) {
    const pending = new Map<string, unknown>();
    const tx = {
      get: async (ref: { __collectionPath: string; id: string }) => {
        const key = keyOf(ref.__collectionPath, ref.id);
        const data = pending.has(key) ? pending.get(key) : docs.get(key)?.data;
        return { exists: () => data !== undefined, data: () => data };
      },
      set: (ref: { __collectionPath: string; id: string }, value: unknown) => {
        pending.set(keyOf(ref.__collectionPath, ref.id), value);
      },
    };
    const result = await updateFn(tx);
    for (const [key, value] of pending) {
      const [collectionPath, id] = [key.slice(0, key.lastIndexOf("/")), key.slice(key.lastIndexOf("/") + 1)];
      docs.set(key, { id, collectionPath, data: value });
    }
    return result;
  }

  return { docs, collection, doc, getDoc, setDoc, query, where, getDocs, runTransaction };
}

const fake = makeFakeFirestore();

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => fake.doc(...(args as [{ __collectionPath: string }, string])),
  getDoc: (...args: Parameters<typeof fake.getDoc>) => fake.getDoc(...args),
  setDoc: (...args: Parameters<typeof fake.setDoc>) => fake.setDoc(...args),
  query: (...args: unknown[]) => fake.query(...(args as [{ __collectionPath: string }])),
  where: (...args: Parameters<typeof fake.where>) => fake.where(...args),
  getDocs: (...args: Parameters<typeof fake.getDocs>) => fake.getDocs(...args),
  runTransaction: (...args: Parameters<typeof fake.runTransaction>) => fake.runTransaction(...args),
  onSnapshot: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  collection: vi.fn(),
}));

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-a",
    name: "Cash",
    type: "cash",
    openingBalance: 1000,
    currentBalance: 1000,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    bankId: null,
    accountHolderName: null,
    notes: null,
    accountNumberLast4: null,
    bankAccountSubtype: null,
    minimumBalance: null,
    interestRatePercent: null,
    maturityDate: null,
    tenureMonths: null,
    cardSubtype: null,
    cardProvider: null,
    linkedAccountId: null,
    reloadable: null,
    currency: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function buildRepos() {
  const accountsCollection = fake.collection(["accounts"]);
  const transactionsCollection = fake.collection(["transactions"]);
  const peopleCollection = fake.collection(["people"]);
  const expensesCollection = fake.collection(["expenses"]);
  const paymentSchedulesCollection = fake.collection(["paymentSchedules"]);

  const accountRepository = new AccountRepository(accountsCollection as never);
  const transactionRepository = new TransactionRepository(transactionsCollection as never, accountRepository);
  const personRepository = new PersonRepository(peopleCollection as never);
  const paymentScheduleRepository = new PaymentScheduleRepository(paymentSchedulesCollection as never);

  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(fake.collection(["paymentSchedules", scheduleId, "installments"]) as never);
  const ledgerRepositoryFor = (personId: string) =>
    new LedgerRepository(fake.collection(["people", personId, "ledger"]) as never, personRepository);

  const expenseRepository = new ExpenseRepository(
    expensesCollection as never,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
  );

  return { accountRepository, transactionRepository, personRepository, paymentScheduleRepository, expenseRepository, installmentRepositoryFor, ledgerRepositoryFor };
}

async function seedAccount(accountRepository: AccountRepository, overrides: Partial<Account> = {}) {
  const acc = account(overrides);
  await fake.setDoc({ __collectionPath: "accounts", id: acc.id }, acc);
  return acc;
}

beforeEach(() => {
  fake.docs.clear();
});

describe("Custom-name split participants → People Ledger (Task 1)", () => {
  it("promotes a custom name to a new Person and posts a ledger entry with the right amount/date/description/transactionRef", async () => {
    const { accountRepository, expenseRepository, personRepository, ledgerRepositoryFor } = buildRepos();
    await seedAccount(accountRepository);

    const expense = await expenseRepository.createExpense({
      description: "Dinner at Cafe",
      totalAmount: 300,
      date: new Date("2026-03-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Priya", personId: null },
      ],
    });

    const people = await personRepository.getAll();
    const priya = people.find((p) => p.name === "Priya");
    expect(priya).toBeDefined();

    const priyaParticipant = expense.participants.find((p) => p.name === "Priya");
    expect(priyaParticipant?.personId).toBe(priya!.id);

    const ledgerEntries = await ledgerRepositoryFor(priya!.id).getAll();
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].type).toBe("gave");
    expect(ledgerEntries[0].amount).toBe(150);
    expect(ledgerEntries[0].date).toEqual(new Date("2026-03-01T00:00:00Z"));
    expect(ledgerEntries[0].note).toBe("Split: Dinner at Cafe");
    expect(ledgerEntries[0].transactionRef).toBe(expense.transactionId);
    expect(priya!.currentBalance).toBe(150);
  });

  it("reuses the same Person (case-insensitively) across two different splits instead of creating a duplicate", async () => {
    const { accountRepository, expenseRepository, personRepository } = buildRepos();
    await seedAccount(accountRepository);

    await expenseRepository.createExpense({
      description: "Lunch",
      totalAmount: 100,
      date: new Date("2026-03-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true }, { name: "priya", personId: null }],
    });
    await expenseRepository.createExpense({
      description: "Coffee",
      totalAmount: 40,
      date: new Date("2026-03-02T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true }, { name: "Priya", personId: null }],
    });

    const people = await personRepository.getAll();
    expect(people.filter((p) => p.name.toLowerCase() === "priya")).toHaveLength(1);
  });

  it("does not create a duplicate ledger entry when the same expense is edited/saved again", async () => {
    const { accountRepository, expenseRepository, personRepository, ledgerRepositoryFor, installmentRepositoryFor } = buildRepos();
    await seedAccount(accountRepository);

    const expense = await expenseRepository.createExpense({
      description: "Groceries",
      totalAmount: 200,
      date: new Date("2026-03-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true }, { name: "Sam", personId: null }],
    });

    const people = await personRepository.getAll();
    const sam = people.find((p) => p.name === "Sam")!;
    const currentInstallments = await installmentRepositoryFor(expense.scheduleId!).getAll();

    // Re-save without changing the split at all.
    const edited = await expenseRepository.editExpense({
      expense,
      currentInstallments,
      description: "Groceries",
      totalAmount: 200,
      splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true }, { personId: sam.id, name: "Sam" }],
    });

    const ledgerEntries = await ledgerRepositoryFor(sam.id).getAll();
    expect(ledgerEntries).toHaveLength(1); // still just the one "gave" entry, not two
    expect(edited.participants.find((p) => p.name === "Sam")?.personId).toBe(sam.id);
  });
});

describe("Received / Yet-to-Receive / Don't-count status (Task 2)", () => {
  async function createSplitWithStatus(status: "received" | "yetToReceive" | "excluded") {
    const repos = buildRepos();
    await seedAccount(repos.accountRepository);
    const expense = await repos.expenseRepository.createExpense({
      description: "Movie night",
      totalAmount: 400,
      date: new Date("2026-04-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Alex", personId: null, receivedStatus: status },
      ],
    });
    const people = await repos.personRepository.getAll();
    const alex = people.find((p) => p.name === "Alex")!;
    return { ...repos, expense, alex };
  }

  it("'Received' posts a receivedBack entry immediately and nets the person's balance to zero", async () => {
    const { ledgerRepositoryFor, alex, personRepository } = await createSplitWithStatus("received");
    const entries = await ledgerRepositoryFor(alex.id).getAll();
    expect(entries.map((e) => e.type).sort()).toEqual(["gave", "receivedBack"]);
    const refreshed = await personRepository.getByKey(alex.id);
    expect(refreshed!.currentBalance).toBe(0); // 200 gave - 200 receivedBack
  });

  it("'Yet to Receive' leaves the amount outstanding — no receivedBack entry, balance stays positive", async () => {
    const { ledgerRepositoryFor, alex, personRepository } = await createSplitWithStatus("yetToReceive");
    const entries = await ledgerRepositoryFor(alex.id).getAll();
    expect(entries.map((e) => e.type)).toEqual(["gave"]);
    const refreshed = await personRepository.getByKey(alex.id);
    expect(refreshed!.currentBalance).toBe(200);
  });

  it("'Don't count in received' (excluded) keeps the ledger record but is not counted as received", async () => {
    const { ledgerRepositoryFor, alex, personRepository, expense } = await createSplitWithStatus("excluded");
    const entries = await ledgerRepositoryFor(alex.id).getAll();
    expect(entries.map((e) => e.type)).toEqual(["gave"]);
    const refreshed = await personRepository.getByKey(alex.id);
    expect(refreshed!.currentBalance).toBe(200);
    expect(expense.participants.find((p) => p.name === "Alex")?.receivedStatus).toBe("excluded");
  });

  it("editing from 'Yet to Receive' to 'Received' posts the missing receivedBack entry exactly once", async () => {
    const { expenseRepository, ledgerRepositoryFor, alex, expense, installmentRepositoryFor, personRepository } =
      await createSplitWithStatus("yetToReceive");
    const currentInstallments = await installmentRepositoryFor(expense.scheduleId!).getAll();

    const edited = await expenseRepository.editExpense({
      expense,
      currentInstallments,
      description: "Movie night",
      totalAmount: 400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: alex.id, name: "Alex", receivedStatus: "received" },
      ],
    });

    const entries = await ledgerRepositoryFor(alex.id).getAll();
    expect(entries.filter((e) => e.type === "receivedBack")).toHaveLength(1);
    const refreshed = await personRepository.getByKey(alex.id);
    expect(refreshed!.currentBalance).toBe(0);
    expect(edited.participants.find((p) => p.name === "Alex")?.receivedStatus).toBe("received");

    // Editing again with the same "received" status must not post a second receivedBack.
    const currentInstallments2 = await installmentRepositoryFor(expense.scheduleId!).getAll();
    await expenseRepository.editExpense({
      expense: edited,
      currentInstallments: currentInstallments2,
      description: "Movie night",
      totalAmount: 400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: alex.id, name: "Alex", receivedStatus: "received" },
      ],
    });
    const entriesAfterSecondSave = await ledgerRepositoryFor(alex.id).getAll();
    expect(entriesAfterSecondSave.filter((e) => e.type === "receivedBack")).toHaveLength(1);
  });

  it("editing from 'Received' back to 'Yet to Receive' reverses the receivedBack entry", async () => {
    const { expenseRepository, ledgerRepositoryFor, alex, expense, installmentRepositoryFor, personRepository } =
      await createSplitWithStatus("received");
    const currentInstallments = await installmentRepositoryFor(expense.scheduleId!).getAll();

    await expenseRepository.editExpense({
      expense,
      currentInstallments,
      description: "Movie night",
      totalAmount: 400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: alex.id, name: "Alex", receivedStatus: "yetToReceive" },
      ],
    });

    const entries = await ledgerRepositoryFor(alex.id).getAll(); // getAll = active only
    expect(entries.map((e) => e.type)).toEqual(["gave"]);
    const refreshed = await personRepository.getByKey(alex.id);
    expect(refreshed!.currentBalance).toBe(200);
  });
});

describe("Multiple people in one split", () => {
  it("mixes an existing Person and a custom name correctly, each getting their own ledger entry", async () => {
    const { accountRepository, expenseRepository, personRepository, ledgerRepositoryFor } = buildRepos();
    await seedAccount(accountRepository);
    const bob = await personRepository.createPerson({ name: "Bob", avatarColorValue: 0, openingBalance: 0 });

    const expense = await expenseRepository.createExpense({
      description: "Road trip gas",
      totalAmount: 300,
      date: new Date("2026-05-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Bob", personId: bob.id },
        { name: "Nina", personId: null },
      ],
    });

    const people = await personRepository.getAll();
    const nina = people.find((p) => p.name === "Nina")!;
    expect(nina).toBeDefined();

    const bobEntries = await ledgerRepositoryFor(bob.id).getAll();
    const ninaEntries = await ledgerRepositoryFor(nina.id).getAll();
    expect(bobEntries).toHaveLength(1);
    expect(ninaEntries).toHaveLength(1);
    expect(bobEntries[0].amount).toBe(100);
    expect(ninaEntries[0].amount).toBe(100);
    expect(expense.participants.filter((p) => !p.isMe)).toHaveLength(2);
  });
});

describe("Delete/restore reverses both 'gave' and 'receivedBack' entries", () => {
  it("deleteExpense soft-deletes both entries and restoreExpense brings both back", async () => {
    const { accountRepository, expenseRepository, personRepository, ledgerRepositoryFor } = buildRepos();
    await seedAccount(accountRepository);

    const expense = await expenseRepository.createExpense({
      description: "Concert tickets",
      totalAmount: 200,
      date: new Date("2026-06-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Tia", personId: null, receivedStatus: "received" },
      ],
    });
    const people = await personRepository.getAll();
    const tia = people.find((p) => p.name === "Tia")!;
    expect((await personRepository.getByKey(tia.id))!.currentBalance).toBe(0);

    await expenseRepository.deleteExpense(expense);
    const activeAfterDelete = await ledgerRepositoryFor(tia.id).getAll();
    expect(activeAfterDelete).toHaveLength(0);
    const trashAfterDelete = await ledgerRepositoryFor(tia.id).getTrash();
    expect(trashAfterDelete).toHaveLength(2);

    await expenseRepository.restoreExpense(expense);
    const activeAfterRestore = await ledgerRepositoryFor(tia.id).getAll();
    expect(activeAfterRestore).toHaveLength(2);
    expect((await personRepository.getByKey(tia.id))!.currentBalance).toBe(0);
  });
});

describe("Ledger sort order stays newest-first through add/edit/split/receive (SORT TRANSACTIONS & PEOPLE LEDGER task)", () => {
  it("a same-day 'receivedBack' settlement always sorts above the 'gave' entry it settles, and a later-added same-day split sorts above an earlier one", async () => {
    // Real writes a few minutes apart in a live app land at genuinely different
    // `createdAt` instants; a synchronous test executes fast enough that
    // `new Date()` can return the exact same millisecond for consecutive
    // writes, which would make this test's ordering assertion flaky rather
    // than meaningful. Fake timers, advanced explicitly between each write,
    // give each entry a distinct, deterministic `createdAt` instead.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
      const { accountRepository, expenseRepository, personRepository, ledgerRepositoryFor, installmentRepositoryFor } = buildRepos();
      await seedAccount(accountRepository);
      const day = new Date("2026-09-01T00:00:00Z"); // the shared, same-day `date` every entry below carries

      // Add: first split of the day, left Yet to Receive.
      const firstExpense = await expenseRepository.createExpense({
        description: "Lunch",
        totalAmount: 200,
        date: day,
        categoryId: "cat-1",
        accountId: "acc-a",
        splitType: "equal",
        participantInputs: [{ name: "Me", isMe: true }, { name: "Kim", personId: null }],
      });
      const people = await personRepository.getAll();
      const kim = people.find((p) => p.name === "Kim")!;

      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      // Add: second split of the same day, same person, marked Received immediately —
      // this posts both a "gave" and a "receivedBack" entry, both dated `day`. Advancing
      // the clock mid-call (via a one-off createdAt spy) isn't practical here, so the
      // assertion below only requires Coffee's two entries to each rank above Lunch's —
      // not a strict order between "gave" and its own immediate "receivedBack", which a
      // real app never needs to resolve since a settlement always reads as connected to
      // its originating entry regardless of which lands a millisecond first.
      await expenseRepository.createExpense({
        description: "Coffee",
        totalAmount: 100,
        date: day,
        categoryId: "cat-1",
        accountId: "acc-a",
        splitType: "equal",
        participantInputs: [{ name: "Me", isMe: true }, { personId: kim.id, name: "Kim", receivedStatus: "received" }],
      });

      const entriesAfterAdds = (await ledgerRepositoryFor(kim.id).getAll()).sort(compareLedgerEntriesNewestFirst);
      // Three entries, all dated the same day: Lunch's "gave" (created first, an hour
      // before Coffee) must rank last; Coffee's "gave" and its immediate "receivedBack"
      // (created within the same tick of each other, after Lunch) both rank above it.
      expect(entriesAfterAdds.map((e) => `${e.note}:${e.type}`).slice(0, 2).sort()).toEqual(
        ["Received: Coffee:receivedBack", "Split: Coffee:gave"].sort(),
      );
      expect(entriesAfterAdds[2]).toMatchObject({ note: "Split: Lunch" });

      vi.setSystemTime(new Date("2026-09-01T11:00:00Z"));
      // Edit: flip the Lunch split from Yet to Receive -> Received. This posts a brand
      // new receivedBack entry "just now" (last of all four by createdAt) — it must
      // immediately take the very top spot, even though its `date` (== day) ties with
      // every other entry here.
      const lunchInstallments = await installmentRepositoryFor(firstExpense.scheduleId!).getAll();
      await expenseRepository.editExpense({
        expense: firstExpense,
        currentInstallments: lunchInstallments,
        description: "Lunch",
        totalAmount: 200,
        splitType: "equal",
        participantInputs: [{ name: "Me", isMe: true }, { personId: kim.id, name: "Kim", receivedStatus: "received" }],
      });

      const entriesAfterEdit = (await ledgerRepositoryFor(kim.id).getAll()).sort(compareLedgerEntriesNewestFirst);
      // The just-posted "Received: Lunch" (T=11:00, an hour after everything else) must
      // rank strictly first. The middle two (Coffee's pair, T=10:00) rank above the last
      // (Lunch's original "gave", T=09:00) but their relative order between themselves is
      // the same same-tick tie already covered by the `entriesAfterAdds` assertion above.
      expect(entriesAfterEdit[0]).toMatchObject({ note: "Received: Lunch", type: "receivedBack" });
      expect(entriesAfterEdit.slice(1, 3).map((e) => `${e.note}:${e.type}`).sort()).toEqual(
        ["Received: Coffee:receivedBack", "Split: Coffee:gave"].sort(),
      );
      expect(entriesAfterEdit[3]).toMatchObject({ note: "Split: Lunch", type: "gave" });
    } finally {
      vi.useRealTimers();
    }
  });
});
