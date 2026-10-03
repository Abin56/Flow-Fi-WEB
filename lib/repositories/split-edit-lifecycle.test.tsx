// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { SettlementTable } from "@/features/people/components/workspace/settlement-table";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { statementView } from "@/features/people/lib/person-statement-pdf-model";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import { buildMySpendContext, myConsumptionAmount } from "@/lib/engines/my-spend";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { derivePendingSplitParticipants } from "@/lib/engines/person-pending-split-participants";
import { personBalanceBreakdown, personPosition, peopleDirectionSides } from "@/lib/engines/person-position";
import type { Account } from "@/lib/models/account";
import { isSplit, myShare, type Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import { signedAmount, type LedgerEntry, type Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { splitAllocation } from "@/lib/split/split-allocation";
import { AccountRepository } from "./account-repository";
import { ExpenseRepository } from "./expense-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Real split-edit lifecycle: a ₹4,000 four-way Dinner split is created and then edited through the
 * SAME calls the Transaction details modal makes on save (`ExpenseRepository.editExpense` with the
 * current installments, then `TransactionRepository.editTransaction`) — never by writing the final
 * documents directly. Real repositories over the in-memory fake of the modular Firestore API used by
 * `split-lifecycle-hardening.test.ts`. Every figure afterwards is read back from the stored documents
 * through the engines and the presentation the app uses.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

interface FakeDoc {
  id: string;
  collectionPath: string;
  data: unknown;
}

function makeFakeFirestore() {
  const docs = new Map<string, FakeDoc>();
  const reads = { getDoc: 0, getDocs: 0 };
  const keyOf = (collectionPath: string, id: string) => `${collectionPath}/${id}`;
  const collection = (pathSegments: string[]) => ({ __collectionPath: pathSegments.join("/"), firestore: {} }) as unknown as { __collectionPath: string };
  const doc = (coll: { __collectionPath: string }, id: string) => ({ __collectionPath: coll.__collectionPath, id });
  const getDoc = async (ref: { __collectionPath: string; id: string }) => {
    reads.getDoc += 1;
    const entry = docs.get(keyOf(ref.__collectionPath, ref.id));
    return { exists: () => entry !== undefined, data: () => entry?.data, id: ref.id };
  };
  const setDoc = async (ref: { __collectionPath: string; id: string }, value: unknown) => {
    docs.set(keyOf(ref.__collectionPath, ref.id), { id: ref.id, collectionPath: ref.__collectionPath, data: value });
  };
  const query = (coll: { __collectionPath: string }, ...clauses: unknown[]) => ({ __collectionPath: coll.__collectionPath, __clauses: clauses });
  const where = (field: string, op: string, value: unknown) => ({ field, op, value });
  const getDocs = async (q: { __collectionPath: string; __clauses?: { field: string; op: string; value: unknown }[] }) => {
    reads.getDocs += 1;
    const filtered = [...docs.values()]
      .filter((d) => d.collectionPath === q.__collectionPath)
      .filter((d) =>
        (q.__clauses ?? []).every((c) => {
          const value = (d.data as Record<string, unknown>)[c.field];
          if (c.op === "==") return value === c.value;
          if (c.op === "!=") return value !== c.value;
          return true;
        }),
      );
    return { docs: filtered.map((d) => ({ id: d.id, data: () => d.data })) };
  };
  const runTransaction = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
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
      const cut = key.lastIndexOf("/");
      docs.set(key, { id: key.slice(cut + 1), collectionPath: key.slice(0, cut), data: value });
    }
    return result;
  };
  return { docs, reads, collection, doc, getDoc, setDoc, query, where, getDocs, runTransaction };
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
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const NOW = new Date();
const DATE = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 10);
const NO_LOANS: ReadonlySet<string> = new Set();

const person = (id: string, name: string): Person => ({
  id,
  name,
  phone: null,
  email: null,
  notes: "",
  avatarColorValue: 0,
  openingBalance: 0,
  currentBalance: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
});

function buildRepos() {
  const accountRepository = new AccountRepository(fake.collection(["accounts"]) as never);
  const transactionRepository = new TransactionRepository(fake.collection(["transactions"]) as never, accountRepository);
  const personRepository = new PersonRepository(fake.collection(["people"]) as never);
  const paymentScheduleRepository = new PaymentScheduleRepository(fake.collection(["paymentSchedules"]) as never);
  const installmentRepositoryFor = (scheduleId: string) => new InstallmentRepository(fake.collection(["paymentSchedules", scheduleId, "installments"]) as never);
  const ledgerRepositoryFor = (personId: string) => new LedgerRepository(fake.collection(["people", personId, "ledger"]) as never, personRepository);
  const expenseRepository = new ExpenseRepository(
    fake.collection(["expenses"]) as never,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
  );
  return { transactionRepository, expenseRepository, installmentRepositoryFor };
}

// ---------- store readers ----------
const inCollection = <T,>(pred: (path: string) => boolean) => [...fake.docs.values()].filter((d) => pred(d.collectionPath)).map((d) => d.data as T);
const isActive = (v: { deletedAt?: Date | null }) => v.deletedAt == null;
const sbiBalance = () => inCollection<Account>((p) => p === "accounts").find((a) => a.id === "sbi")!.currentBalance;
const people = () => inCollection<Person>((p) => p === "people");
const balanceOf = (id: string) => people().find((p) => p.id === id)!.currentBalance;
const entriesOf = (personId: string) => inCollection<LedgerEntry>((p) => p === `people/${personId}/ledger`);
const activeEntriesOf = (personId: string) => entriesOf(personId).filter(isActive);
const transactions = () => inCollection<Transaction>((p) => p === "transactions");
const activeTransactions = () => transactions().filter(isActive);
const expenses = () => inCollection<Expense>((p) => p === "expenses");
const activeExpenses = () => expenses().filter(isActive);
const installmentsBySchedule = () => {
  const out: Record<string, Installment[]> = {};
  for (const i of inCollection<Installment>((p) => /^paymentSchedules\/[^/]+\/installments$/.test(p))) (out[i.scheduleId] ??= []).push(i);
  return out;
};
const activeInstallments = () => Object.values(installmentsBySchedule()).flat().filter(isActive);

function mySpend(): number {
  const ctx = buildMySpendContext({ expenses: expenses().map((e) => ({ transactionId: e.transactionId, totalAmount: e.totalAmount, myShare: myShare(e), deletedAt: e.deletedAt })) });
  return transactions().reduce((s, t) => s + myConsumptionAmount(t, ctx), 0);
}

const NAMES: Record<string, string> = { amma: "AMMA", tripthee: "TRIPTHEE", anu: "ANU" };

/** The People view of one person — statement, ledger rows and lookups, as `useSettlementLookups` builds them. */
function personView(id: string) {
  const entries = entriesOf(id);
  const statement = buildPersonCycleStatement({
    person: { id, name: NAMES[id], openingBalance: 0, createdAt: new Date("2026-01-01T00:00:00Z") },
    ledgerEntries: entries,
    loanIds: NO_LOANS,
    emis: [],
    loans: [],
    installments: [],
    cycle: cycleContaining(DATE),
    now: NOW,
  });
  const pending = derivePendingSplitParticipants(id, activeExpenses(), installmentsBySchedule());
  const rows = buildLedgerRows({ statement, history: statement, entries, pending, now: NOW });
  const expenseByTransactionId = new Map<string, Expense>();
  for (const e of activeExpenses()) if (isSplit(e)) expenseByTransactionId.set(e.transactionId, e);
  const lookups: SettlementLookups = { entriesById: new Map(entries.map((e) => [e.id, e])), expenseByTransactionId };
  const position = personPosition({
    personId: id,
    currentBalance: balanceOf(id),
    loans: [],
    ledgerEntries: entries.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
    loanIds: NO_LOANS,
  });
  const breakdown = personBalanceBreakdown(
    position,
    entries.map((e) => ({ id: e.id, type: e.type, amount: e.amount, parentEntryId: e.parentEntryId, transactionRef: e.transactionRef, isDeleted: e.deletedAt != null })),
    NO_LOANS,
  );
  const obligations = rows.filter((r) => r.statementRow?.kind === "obligation");
  return { statement, rows, obligations, lookups, entries, breakdown };
}

function monthCycle() {
  const sides = peopleDirectionSides(["amma", "tripthee", "anu"].map((id) => ({ id, breakdown: personView(id).breakdown })));
  return { toReceive: sides.totalToReceive, toGive: sides.totalToGive };
}

const DINNER = {
  description: "Dinner",
  totalAmount: 4000,
  date: DATE,
  categoryId: "food",
  accountId: "sbi",
  splitType: "custom" as const,
  participantInputs: [
    { name: "Me", isMe: true, value: 1000 },
    { name: "AMMA", personId: "amma", value: 1000 },
    { name: "TRIPTHEE", personId: "tripthee", value: 1000 },
    { name: "ANU", personId: "anu", value: 1000 },
  ],
};

const EDITED_INPUTS = [
  { name: "Me", isMe: true, value: 1500 },
  { name: "AMMA", personId: "amma", value: 500 },
  { name: "TRIPTHEE", personId: "tripthee", value: 1250 },
  { name: "ANU", personId: "anu", value: 750 },
];

/** Exactly what the Transaction details modal does on Save for an existing split (see its `splitOpen` branch). */
async function saveSplitEditLikeTheModal(repos: ReturnType<typeof buildRepos>, edit: { description: string; participantInputs: typeof EDITED_INPUTS }) {
  const expense = activeExpenses()[0];
  const transaction = activeTransactions()[0];
  const currentInstallments = expense.scheduleId == null ? [] : await repos.installmentRepositoryFor(expense.scheduleId).getAll();
  await repos.expenseRepository.editExpense({
    expense,
    currentInstallments,
    description: edit.description,
    totalAmount: 4000,
    date: DATE,
    categoryId: "food",
    accountId: "sbi",
    notes: "",
    splitType: "custom",
    participantInputs: edit.participantInputs,
  });
  await repos.transactionRepository.editTransaction(transaction, {
    amount: 4000,
    dateTime: DATE,
    accountId: "sbi",
    categoryId: "food",
    description: edit.description,
    notes: "",
    excludeFromCalculations: false,
    accountingMonth: null,
    clearAccountingMonth: true,
    clearLinkedPersonId: true,
    owesPersonToggle: false,
  });
}

/** The People Ledger for AMMA, expanded on the split row — re-rendered in place to mimic a live snapshot. */
function ledgerTable(v: ReturnType<typeof personView>) {
  return (
    <SettlementTable personId="amma" personName="AMMA" rows={v.rows} isLoading={false} lookups={v.lookups} accountForEntry={() => null} handlers={{} as never} empty={null} />
  );
}
const splitDetails = () => screen.getAllByText("Split details")[0].parentElement!;
/** The collapsed split summary (separate figures, not one sentence) — matched with whitespace ignored. */
const hasSplitSummary = (share: number) =>
  screen.queryAllByText((_, el) => el?.tagName === "P" && el.textContent?.replace(/\s/g, "") === `Split expense · 4 people Original ${money(4000)} AMMA's share ${money(share)}`.replace(/\s/g, "")).length > 0;
const cellAmount =(scope: HTMLElement, name: string) => within(scope).getByText(name).parentElement!.querySelector("dd")!.textContent;

beforeEach(async () => {
  fake.docs.clear();
  vi.restoreAllMocks();
  const sbi = { id: "sbi", name: "SBI", type: "bank", openingBalance: 10000, currentBalance: 10000, deletedAt: null, lastEditedAt: null, editHistory: [] } as unknown as Account;
  await fake.setDoc({ __collectionPath: "accounts", id: "sbi" }, sbi);
  for (const [id, name] of Object.entries(NAMES)) await fake.setDoc({ __collectionPath: "people", id }, person(id, name));
});

describe("Split edit lifecycle — the real editExpense path the Transaction details modal uses", () => {
  it("₹4,000 Dinner: 1,000×4 → You 1,500 / AMMA 500 / TRIPTHEE 1,250 / ANU 750, everywhere, exactly once", async () => {
    const repos = buildRepos();
    await repos.expenseRepository.createExpense(DINNER);

    // ---------------- before ----------------
    expect(activeExpenses()).toHaveLength(1);
    expect(activeTransactions()).toHaveLength(1);
    expect(activeTransactions()[0].amount).toBe(4000);
    expect(sbiBalance()).toBe(6000);
    expect({ amma: balanceOf("amma"), tripthee: balanceOf("tripthee"), anu: balanceOf("anu") }).toEqual({ amma: 1000, tripthee: 1000, anu: 1000 });
    expect(mySpend()).toBe(1000);
    expect(monthCycle()).toEqual({ toReceive: 3000, toGive: 0 });

    const before = personView("amma");
    expect(before.obligations).toHaveLength(1);
    expect(before.obligations[0]).toMatchObject({ amount: 1000, remaining: 1000, state: "open" });
    expect(splitAllocation(activeExpenses()[0], "amma")!.participants.map((p) => [p.label, p.amount])).toEqual([
      ["You", 1000],
      ["AMMA", 1000],
      ["TRIPTHEE", 1000],
      ["ANU", 1000],
    ]);

    // People Ledger (AMMA): compact line + expanded breakdown, mounted once and kept mounted.
    const { rerender } = render(ledgerTable(before));
    expect(hasSplitSummary(1000)).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    let details = splitDetails();
    expect(within(details).getByText(money(4000))).toBeTruthy();
    for (const n of ["You", "AMMA", "TRIPTHEE", "ANU"]) expect(cellAmount(details, n)).toContain(money(1000));

    // ---------------- the real edit ----------------
    const readsBefore = { ...fake.reads };
    await saveSplitEditLikeTheModal(repos, { description: "Dinner", participantInputs: EDITED_INPUTS });

    // 1–3. one logical expense, one source transaction, total unchanged.
    expect(activeExpenses()).toHaveLength(1);
    expect(expenses()).toHaveLength(1);
    expect(activeTransactions()).toHaveLength(1);
    expect(transactions()).toHaveLength(1);
    const edited = activeExpenses()[0];
    expect(edited.totalAmount).toBe(4000);
    expect(activeTransactions()[0].amount).toBe(4000);

    // 4, 8, 9. stored allocations — and they add up exactly to the stored total.
    const alloc = splitAllocation(edited, "amma")!;
    expect(alloc.participants.map((p) => [p.label, p.amount])).toEqual([
      ["You", 1500],
      ["AMMA", 500],
      ["TRIPTHEE", 1250],
      ["ANU", 750],
    ]);
    expect(alloc).toMatchObject({ myShare: 1500, focusShare: 500, allocated: 4000, reconciles: true });
    expect(myShare(edited)).toBe(1500);

    // 5–7, 10–12. each person: one active obligation at the new share, no old ₹1,000 ghost, balance once.
    for (const [id, share] of [["amma", 500], ["tripthee", 1250], ["anu", 750]] as const) {
      const active = activeEntriesOf(id);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ type: "gave", amount: share, transactionRef: edited.transactionId, note: "Split: Dinner" });
      expect(active.some((e) => e.amount === 1000)).toBe(false);
      expect(balanceOf(id)).toBe(share);
      const v = personView(id);
      expect(v.obligations).toHaveLength(1);
      expect(v.obligations[0]).toMatchObject({ amount: share, remaining: share, state: "open" });
      expect(v.breakdown.toReceive).toBe(share);
    }
    // One installment per other participant — re-sized in place, never duplicated.
    expect(activeInstallments().map((i) => i.amountDue).sort((a, b) => a - b)).toEqual([500, 750, 1250]);

    // 13. My Spend follows the stored share (existing canonical rule: my share of a split).
    expect(mySpend()).toBe(1500);
    // 14. the account moved once, for the purchase — not again for a re-allocation.
    expect(sbiBalance()).toBe(6000);
    // 15. Month Cycle: the same one purchase, receivables now 500 + 1,250 + 750.
    expect(monthCycle()).toEqual({ toReceive: 2500, toGive: 0 });

    // 17. the mounted People Ledger updates in place from the new data (as a live snapshot would).
    const after = personView("amma");
    rerender(ledgerTable(after));
    expect(hasSplitSummary(500)).toBe(true);
    details = splitDetails();
    expect(within(details).getByText(money(4000))).toBeTruthy();
    expect(cellAmount(details, "You")).toBe(money(1500));
    expect(cellAmount(details, "AMMA")).toContain(money(500));
    expect(cellAmount(details, "TRIPTHEE")).toBe(money(1250));
    expect(cellAmount(details, "ANU")).toBe(money(750));
    expect(within(details).queryByText(/Allocated/)).toBeNull();

    // 16. the owner-side breakdown (the one Transaction details renders) reads the edited Expense.
    cleanup();
    render(<SplitAllocationBreakdown allocation={splitAllocation(edited)!} />);
    const section = screen.getByText("Original total").closest("section")!;
    expect(cellAmount(section, "You")).toBe(money(1500));
    expect(cellAmount(section, "TRIPTHEE")).toBe(money(1250));

    // 18–20. statement / share statement / PDF from current data; recipient-only split context.
    const view = statementView(after.statement, { entries: after.entries, lookups: after.lookups, now: NOW });
    const row = view.rows.find((r) => r.kind === "split")!;
    expect(row.splitNote).toBe(`Total price ${money(4000)} · 4-way split · AMMA's share ${money(500)}`);
    expect(row).toMatchObject({ original: money(500), remaining: money(500) });
    const shared = JSON.stringify(view);
    // The shared statement shows this split's current (edited) allocation in full — and nothing else about the others.
    expect(row.allocation!.participants.map((p) => [p.label, p.amount])).toEqual([["Account holder", 1500], ["AMMA", 500], ["TRIPTHEE", 1250], ["ANU", 750]]);
    expect(shared).not.toMatch(/receivedStatus|installmentId|currentBalance/);
    const pdf = await renderPersonStatementPdf(after.statement, { entries: after.entries, lookups: after.lookups, now: NOW });
    expect(pdf.byteLength).toBeGreaterThan(1000);

    // 22. the edit itself is the only reader: rendering and statements above added no store reads.
    const readsAfterEdit = { ...fake.reads };
    expect(readsAfterEdit.getDocs).toBeGreaterThan(readsBefore.getDocs); // the edit path's own reads
    personView("amma");
    render(ledgerTable(personView("amma")));
    expect(fake.reads).toEqual(readsAfterEdit);
  });

  it("description edit Dinner → Birthday Dinner reaches transaction, ledger and statements; amounts untouched", async () => {
    const repos = buildRepos();
    await repos.expenseRepository.createExpense(DINNER);
    await saveSplitEditLikeTheModal(repos, { description: "Dinner", participantInputs: EDITED_INPUTS });
    const snapshot = { sbi: sbiBalance(), amma: balanceOf("amma"), spend: mySpend(), cycle: monthCycle(), shares: activeExpenses()[0].participants.map((p) => p.share) };

    await saveSplitEditLikeTheModal(repos, { description: "Birthday Dinner", participantInputs: EDITED_INPUTS });

    expect(activeTransactions()).toHaveLength(1);
    expect(activeTransactions()[0].description).toBe("Birthday Dinner");
    expect(activeExpenses()).toHaveLength(1);
    expect(activeExpenses()[0].description).toBe("Birthday Dinner");
    for (const id of ["amma", "tripthee", "anu"]) {
      expect(activeEntriesOf(id)).toHaveLength(1);
      expect(activeEntriesOf(id)[0].note).toBe("Split: Birthday Dinner");
    }
    expect({ sbi: sbiBalance(), amma: balanceOf("amma"), spend: mySpend(), cycle: monthCycle(), shares: activeExpenses()[0].participants.map((p) => p.share) }).toEqual(snapshot);

    const v = personView("amma");
    expect(v.obligations).toHaveLength(1);
    expect(v.obligations[0]).toMatchObject({ amount: 500, remaining: 500, state: "open" });
    render(ledgerTable(v));
    expect(screen.getAllByText(/Birthday Dinner/).length).toBeGreaterThan(0);
    const view = statementView(v.statement, { entries: v.entries, lookups: v.lookups, now: NOW });
    expect(view.rows.find((r) => r.kind === "split")!.title).toContain("Birthday Dinner");
  });

  it("delete and restore after the edit: no live breakdown while deleted; restored once with the edited allocation", async () => {
    const repos = buildRepos();
    await repos.expenseRepository.createExpense(DINNER);
    await saveSplitEditLikeTheModal(repos, { description: "Dinner", participantInputs: EDITED_INPUTS });

    await repos.expenseRepository.deleteExpense(activeExpenses()[0]);
    expect(activeExpenses()).toHaveLength(0);
    expect(activeTransactions()).toHaveLength(0);
    expect(splitAllocation(expenses()[0], "amma")).toBeNull();
    expect(personView("amma").lookups.expenseByTransactionId.size).toBe(0);
    for (const id of ["amma", "tripthee", "anu"]) {
      expect(activeEntriesOf(id)).toHaveLength(0);
      expect(balanceOf(id)).toBe(0);
    }
    expect(sbiBalance()).toBe(10000);
    expect(mySpend()).toBe(0);

    await repos.expenseRepository.restoreExpense(expenses()[0]);
    expect(activeExpenses()).toHaveLength(1);
    expect(activeTransactions()).toHaveLength(1);
    expect(sbiBalance()).toBe(6000);
    expect(mySpend()).toBe(1500);
    for (const [id, share] of [["amma", 500], ["tripthee", 1250], ["anu", 750]] as const) {
      expect(activeEntriesOf(id)).toHaveLength(1);
      expect(activeEntriesOf(id)[0].amount).toBe(share);
      expect(balanceOf(id)).toBe(share);
      expect(personView(id).obligations).toHaveLength(1);
    }
    expect(splitAllocation(activeExpenses()[0], "amma")!.participants.map((p) => p.amount)).toEqual([1500, 500, 1250, 750]);
  });
});
