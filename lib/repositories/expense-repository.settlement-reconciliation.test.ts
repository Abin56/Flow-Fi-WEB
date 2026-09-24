import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { ExpenseRepository } from "./expense-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import {
  InstallmentPaymentRepository,
  InstallmentRepository,
  PaymentScheduleRepository,
} from "./payment-schedule-repository";

/**
 * Regression coverage for the People Ledger backend audit's findings, all of
 * which live in `ExpenseRepository`'s received-status reconciliation and
 * settlement fan-out:
 *
 *  1. The reconciliation matched its "did I already post a status entry?"
 *     guard on `type === "receivedBack"` alone. A *settlement* entry
 *     (`settleParticipant`/`settleAcrossPending`) is also a "receivedBack" on
 *     the same `transactionRef`, so a partially-settled participant later
 *     marked Received matched the settlement entry and posted nothing —
 *     leaving the share permanently short in the ledger. The same collision
 *     could soft-delete a real settlement record on the reverse transition,
 *     or inflate a partial payment's amount up to the full share on an
 *     amount edit.
 *  2. Marking Received credited the *full* share on top of any settlement
 *     already recorded, double-counting that payment and driving the balance
 *     negative.
 *  3. A participant dropped from a split by an edit kept their "gave" entry
 *     and their balance forever — a debt with nobody owing it.
 *  4. `settleAcrossPending` chose the remainder entry's direction from the
 *     caller's pre-loop `person` copy, after the loop had already moved that
 *     balance.
 *
 * Uses the same in-memory Firestore fake as
 * `expense-repository.split-ledger.test.ts` (`doc`/`getDoc`/`getDocs`/
 * `setDoc`/`query`/`where`/`runTransaction`), so the real
 * `PersonRepository`/`LedgerRepository` balance-sync logic runs for real.
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
    return { __collectionPath: pathSegments.join("/"), firestore: {} } as unknown as { __collectionPath: string };
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
  function query(coll: { __collectionPath: string }, ...clauses: unknown[]) {
    return { __collectionPath: coll.__collectionPath, __clauses: clauses };
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
      docs.set(key, {
        id: key.slice(key.lastIndexOf("/") + 1),
        collectionPath: key.slice(0, key.lastIndexOf("/")),
        data: value,
      });
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

function account(): Account {
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
  };
}

function buildRepos() {
  const personRepository = new PersonRepository(fake.collection(["people"]) as never);
  const accountRepository = new AccountRepository(fake.collection(["accounts"]) as never);
  const transactionRepository = new TransactionRepository(fake.collection(["transactions"]) as never, accountRepository);
  const paymentScheduleRepository = new PaymentScheduleRepository(fake.collection(["paymentSchedules"]) as never);
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(fake.collection(["paymentSchedules", scheduleId, "installments"]) as never);
  const ledgerRepositoryFor = (personId: string) =>
    new LedgerRepository(fake.collection(["people", personId, "ledger"]) as never, personRepository);
  const installmentPaymentRepositoryFor = (scheduleId: string, installmentId: string) =>
    new InstallmentPaymentRepository(
      fake.collection(["paymentSchedules", scheduleId, "installments", installmentId, "payments"]) as never,
      installmentRepositoryFor(scheduleId),
    );
  const expenseRepository = new ExpenseRepository(
    fake.collection(["expenses"]) as never,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
  );
  return {
    personRepository,
    expenseRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
    installmentPaymentRepositoryFor,
  };
}

beforeEach(async () => {
  fake.docs.clear();
  await fake.setDoc({ __collectionPath: "accounts", id: "acc-a" }, account());
});

/** A 2-way equal split of `total` between "Me" and one custom-name participant. */
async function splitWith(
  repos: ReturnType<typeof buildRepos>,
  name: string,
  total: number,
  receivedStatus?: "received" | "yetToReceive" | "excluded",
) {
  const expense = await repos.expenseRepository.createExpense({
    description: "Trip",
    totalAmount: total,
    date: new Date("2026-04-01T00:00:00Z"),
    categoryId: "cat-1",
    accountId: "acc-a",
    splitType: "equal",
    participantInputs: [
      { name: "Me", isMe: true },
      { name, personId: null, receivedStatus },
    ],
  });
  const person = (await repos.personRepository.getAll()).find((p) => p.name === name)!;
  const installments = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
  const participant = expense.participants.find((p) => p.name === name)!;
  return { expense, person, installments, participant };
}

describe("Status entry vs. settlement entry must never be confused", () => {
  it("marking a partially-settled participant 'Received' credits only the unsettled remainder, netting the balance to exactly zero", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Zed", 400);

    // 200 owed; settle 50 of it for real.
    await repos.expenseRepository.settleParticipant({
      expense,
      participant,
      installment: installments[0],
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
      amount: 50,
      date: new Date("2026-04-05T00:00:00Z"),
    });
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(150);

    // Now flip the participant to "Received".
    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    await repos.expenseRepository.editExpense({
      expense,
      currentInstallments: current,
      description: "Trip",
      totalAmount: 400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: person.id, name: "Zed", receivedStatus: "received" },
      ],
    });

    const entries = await repos.ledgerRepositoryFor(person.id).getAll();
    // The real 50 settlement survives untouched, and the status entry credits
    // only the outstanding 150 — not the full 200 on top of it.
    expect(entries.find((e) => e.note === "Split settlement: Trip")?.amount).toBe(50);
    expect(entries.find((e) => e.note === "Received: Trip")?.amount).toBe(150);
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(0);
  });

  it("un-marking 'Received' removes the status entry and leaves a real settlement entry intact", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Zed", 400, "received");

    await repos.expenseRepository.settleParticipant({
      expense,
      participant,
      installment: installments[0],
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
      amount: 50,
      date: new Date("2026-04-05T00:00:00Z"),
    });

    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    await repos.expenseRepository.editExpense({
      expense,
      currentInstallments: current,
      description: "Trip",
      totalAmount: 400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: person.id, name: "Zed", receivedStatus: "yetToReceive" },
      ],
    });

    const entries = await repos.ledgerRepositoryFor(person.id).getAll();
    // Only the status entry is retired; the user's recorded 50 payment stays.
    expect(entries.map((e) => e.note).sort()).toEqual(["Split settlement: Trip", "Split: Trip"]);
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(150);
  });

  it("an amount edit while 'Received' rewrites the status entry only, never a settlement entry's amount", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Ana", 400, "received");

    await repos.expenseRepository.settleParticipant({
      expense,
      participant,
      installment: installments[0],
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
      amount: 50,
      date: new Date("2026-04-05T00:00:00Z"),
    });

    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    await repos.expenseRepository.editExpense({
      expense,
      currentInstallments: current,
      description: "Trip",
      totalAmount: 600, // Ana's share 200 -> 300
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: person.id, name: "Ana", receivedStatus: "received" },
      ],
    });

    const entries = await repos.ledgerRepositoryFor(person.id).getAll();
    expect(entries.find((e) => e.note === "Split settlement: Trip")?.amount).toBe(50); // untouched
    expect(entries.find((e) => e.note === "Received: Trip")?.amount).toBe(250); // 300 share - 50 settled
    expect(entries.find((e) => e.type === "gave")?.amount).toBe(300);
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(0);
  });

  it("re-saving the same 'Received' status never posts a second status entry (idempotent)", async () => {
    const repos = buildRepos();
    const { expense, person } = await splitWith(repos, "Ivy", 400, "received");

    for (let i = 0; i < 3; i++) {
      const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
      await repos.expenseRepository.editExpense({
        expense,
        currentInstallments: current,
        description: "Trip",
        totalAmount: 400,
        splitType: "equal",
        participantInputs: [
          { name: "Me", isMe: true },
          { personId: person.id, name: "Ivy", receivedStatus: "received" },
        ],
      });
    }

    const entries = await repos.ledgerRepositoryFor(person.id).getAll();
    expect(entries.filter((e) => e.type === "receivedBack")).toHaveLength(1);
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(0);
  });
});

describe("Participants removed from a split are reconciled, not orphaned", () => {
  it("dropping a participant on edit soft-deletes their ledger entry and zeroes their balance", async () => {
    const repos = buildRepos();
    const expense = await repos.expenseRepository.createExpense({
      description: "Z",
      totalAmount: 300,
      date: new Date("2026-04-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Ka", personId: null },
        { name: "La", personId: null },
      ],
    });
    const people = await repos.personRepository.getAll();
    const ka = people.find((p) => p.name === "Ka")!;
    const la = people.find((p) => p.name === "La")!;
    expect((await repos.personRepository.getByKey(la.id))!.currentBalance).toBe(100);

    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    const edited = await repos.expenseRepository.editExpense({
      expense,
      currentInstallments: current,
      description: "Z",
      totalAmount: 300,
      splitType: "custom",
      participantInputs: [
        { name: "Me", isMe: true, value: 150 },
        { personId: ka.id, name: "Ka", value: 150 },
      ],
    });

    // La is gone from the expense, and from her own ledger/balance too.
    expect(edited.participants.some((p) => p.name === "La")).toBe(false);
    expect(await repos.ledgerRepositoryFor(la.id).getAll()).toHaveLength(0);
    expect((await repos.personRepository.getByKey(la.id))!.currentBalance).toBe(0);
    // Ka is unaffected apart from her own share change.
    expect((await repos.personRepository.getByKey(ka.id))!.currentBalance).toBe(150);
  });

  it("also retires the removed participant's status entry, so a 'Received' participant leaves nothing behind", async () => {
    const repos = buildRepos();
    const expense = await repos.expenseRepository.createExpense({
      description: "Z",
      totalAmount: 300,
      date: new Date("2026-04-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Ka", personId: null },
        { name: "Mo", personId: null, receivedStatus: "received" },
      ],
    });
    const people = await repos.personRepository.getAll();
    const ka = people.find((p) => p.name === "Ka")!;
    const mo = people.find((p) => p.name === "Mo")!;
    expect(await repos.ledgerRepositoryFor(mo.id).getAll()).toHaveLength(2);

    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    await repos.expenseRepository.editExpense({
      expense,
      currentInstallments: current,
      description: "Z",
      totalAmount: 300,
      splitType: "custom",
      participantInputs: [
        { name: "Me", isMe: true, value: 150 },
        { personId: ka.id, name: "Ka", value: 150 },
      ],
    });

    expect(await repos.ledgerRepositoryFor(mo.id).getAll()).toHaveLength(0);
    expect((await repos.personRepository.getByKey(mo.id))!.currentBalance).toBe(0);
  });

  it("refuses to drop a participant who has already paid, rather than silently discarding their payment", async () => {
    const repos = buildRepos();
    const expense = await repos.expenseRepository.createExpense({
      description: "Z",
      totalAmount: 300,
      date: new Date("2026-04-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { name: "Ka", personId: null },
        { name: "La", personId: null },
      ],
    });
    const people = await repos.personRepository.getAll();
    const ka = people.find((p) => p.name === "Ka")!;
    const installments = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    const laParticipant = expense.participants.find((p) => p.name === "La")!;
    const laInstallment = installments.find((i) => i.id === laParticipant.installmentId)!;

    await repos.expenseRepository.settleParticipant({
      expense,
      participant: laParticipant,
      installment: laInstallment,
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, laInstallment.id),
      amount: 40,
      date: new Date("2026-04-05T00:00:00Z"),
    });

    const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    await expect(
      repos.expenseRepository.editExpense({
        expense,
        currentInstallments: current,
        description: "Z",
        totalAmount: 300,
        splitType: "custom",
        participantInputs: [
          { name: "Me", isMe: true, value: 150 },
          { personId: ka.id, name: "Ka", value: 150 },
        ],
      }),
    ).rejects.toThrow(/already paid/);
  });
});

describe("settleAcrossPending", () => {
  it("fans a lump sum across pending installments oldest-first and posts the remainder once", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Rem", 200);

    await repos.expenseRepository.settleAcrossPending({
      person,
      pending: [{ expense, participant, installment: installments[0] }],
      amount: 150, // 100 owed + 50 over
      date: new Date("2026-04-10T00:00:00Z"),
      installmentPaymentRepositoryFor: repos.installmentPaymentRepositoryFor,
    });

    const entries = await repos.ledgerRepositoryFor(person.id).getAll();
    expect(entries.find((e) => e.note === "Split settlement: Trip")?.amount).toBe(100);
    const remainder = entries.find((e) => e.note === "Settled all")!;
    expect(remainder.amount).toBe(50);
    // Direction is chosen from the balance as it stands *after* the loop's
    // settlements (here 0 — the 100 settlement cleared the debt), not from
    // the caller's pre-loop copy (+100, which would have said "receivedBack").
    // Pinning the post-loop read is the point of this assertion; see the
    // audit note about what "over-settling" should mean directionally.
    expect(remainder.type).toBe("repaid");
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(50);
  });

  it("repeated partial settlements sum to the full share without double-crediting", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Pat", 200);

    for (const amount of [25, 25, 50]) {
      const current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
      await repos.expenseRepository.settleParticipant({
        expense,
        participant,
        installment: current.find((i) => i.id === installments[0].id)!,
        installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
        amount,
        date: new Date("2026-04-05T00:00:00Z"),
      });
    }

    const final = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    expect(final[0].amountPaid).toBe(100);
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(0);
  });

  it("a partial settlement leaves the installment open; a full one closes it", async () => {
    const repos = buildRepos();
    const { expense, person, installments, participant } = await splitWith(repos, "Sal", 200);

    await repos.expenseRepository.settleParticipant({
      expense,
      participant,
      installment: installments[0],
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
      amount: 30,
      date: new Date("2026-04-05T00:00:00Z"),
    });
    let current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    expect(current[0].amountPaid).toBe(30);
    expect(current[0].amountPaid).toBeLessThan(current[0].amountDue); // still open
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(70);

    await repos.expenseRepository.settleParticipant({
      expense,
      participant,
      installment: current[0],
      installmentPaymentRepository: repos.installmentPaymentRepositoryFor(expense.scheduleId!, installments[0].id),
      amount: 70,
      date: new Date("2026-04-06T00:00:00Z"),
    });
    current = await repos.installmentRepositoryFor(expense.scheduleId!).getAll();
    expect(current[0].amountPaid).toBe(current[0].amountDue); // closed
    expect((await repos.personRepository.getByKey(person.id))!.currentBalance).toBe(0);
  });
});

describe("Mixed statuses across participants resolve independently", () => {
  it("received / yetToReceive / excluded in one split each get exactly their own ledger effect", async () => {
    const repos = buildRepos();
    await repos.expenseRepository.createExpense({
      description: "Mixed",
      totalAmount: 300,
      date: new Date("2026-04-01T00:00:00Z"),
      categoryId: "cat-1",
      accountId: "acc-a",
      splitType: "custom",
      participantInputs: [
        { name: "Rey", personId: null, value: 100, receivedStatus: "received" },
        { name: "Yui", personId: null, value: 100, receivedStatus: "yetToReceive" },
        { name: "Exa", personId: null, value: 100, receivedStatus: "excluded" },
      ],
    });
    const people = await repos.personRepository.getAll();
    const byName = (n: string) => people.find((p) => p.name === n)!;

    const rey = await repos.ledgerRepositoryFor(byName("Rey").id).getAll();
    expect(rey.map((e) => e.type).sort()).toEqual(["gave", "receivedBack"]);
    expect((await repos.personRepository.getByKey(byName("Rey").id))!.currentBalance).toBe(0);

    const yui = await repos.ledgerRepositoryFor(byName("Yui").id).getAll();
    expect(yui.map((e) => e.type)).toEqual(["gave"]);
    expect((await repos.personRepository.getByKey(byName("Yui").id))!.currentBalance).toBe(100);

    // "excluded" has the same ledger effect as yetToReceive — never a receivedBack.
    const exa = await repos.ledgerRepositoryFor(byName("Exa").id).getAll();
    expect(exa.map((e) => e.type)).toEqual(["gave"]);
    expect((await repos.personRepository.getByKey(byName("Exa").id))!.currentBalance).toBe(100);
  });
});
