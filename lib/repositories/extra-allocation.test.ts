import { beforeEach, describe, expect, it, vi } from "vitest";

type Doc = Record<string, unknown> & { id: string };
const store = new Map<string, Doc>();

vi.mock("firebase/firestore", () => {
  const doc = (collection: { path: string; firestore: unknown }, id: string) => ({ id, path: `${collection.path}/${id}`, firestore: collection.firestore });
  const getDocs = async (q: { collection: { path: string }; wheres: { field: string; value: unknown }[] }) => {
    const prefix = `${q.collection.path}/`;
    const docs = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map(([, v]) => v)
      .filter((v) => q.wheres.every((w) => w.field == null || (v as Record<string, unknown>)[w.field] === w.value));
    return { docs: docs.map((v) => ({ data: () => structuredClone(v) })) };
  };
  return {
    doc,
    query: (collection: { path: string }, ...wheres: { field: string; value: unknown }[]) => ({ collection, wheres }),
    where: (field: string, _op: string, value: unknown) => ({ field, value }),
    limit: () => ({}),
    getDocs,
    getDoc: async (ref: { path: string }) => {
      const v = store.get(ref.path);
      return { exists: () => v !== undefined, data: () => structuredClone(v) };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const pending = new Map<string, Doc>();
      let wrote = false;
      const tx = {
        get: async (ref: { path: string }) => {
          if (wrote) throw new Error("Firestore: read after write in a transaction");
          const v = store.get(ref.path);
          return { exists: () => v !== undefined, data: () => structuredClone(v) };
        },
        set: (ref: { path: string }, value: Doc) => {
          wrote = true;
          pending.set(ref.path, structuredClone(value));
        },
      };
      const result = await fn(tx);
      for (const [k, v] of pending) store.set(k, v);
      return result;
    },
  };
});

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

/**
 * Record Payment → the extra divided across Purpose / Income / Advance. The panel's own conversion
 * (`draftsToAllocations` → `planExtraAllocation`) feeds the real repositories over the atomic in-memory
 * fake Firestore, so these tests cover the editor's validation and the accounting it produces.
 *
 * AMMA owes ₹1,000 (KSEB). She sends ₹1,000 + an extra — the extra is what gets divided.
 */

import { AccountRepository } from "@/lib/repositories/account-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { PersonPaymentRepository, type PaymentExtraInput, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { PurposeFundRepository } from "@/lib/repositories/purpose-fund-repository";
import { buildPersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { summarizePurposes } from "@/lib/engines/purpose-funds";
import { addableKinds, planExtraAllocation, type ExtraAllocationPlan } from "@/lib/engines/extra-allocation";
import { paymentImpact } from "@/lib/engines/person-payment-impact";
import { draftsToAllocations, newAllocationDraft, type AllocationDraft } from "@/features/people/components/workspace/extra-allocation-editor";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { PurposeFund, PurposeLink } from "@/lib/models/purpose-fund";
import { isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";

const db = {};
const col = (path: string) => ({ path, firestore: db }) as never;
const U = "users/u";
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const ALL: StatementCycle = { start: new Date(1970, 0, 1), end: d(12, 31, 2027) };
const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };
const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

let payments: PersonPaymentRepository;
let purposes: PurposeFundRepository;

function setup() {
  store.clear();
  const accountRepository = new AccountRepository(col(`${U}/accounts`));
  const transactionRepository = new TransactionRepository(col(`${U}/transactions`), accountRepository);
  const personRepository = new PersonRepository(col(`${U}/people`));
  const ledgerRepository = new LedgerRepository(col(`${U}/people/amma/ledger`), personRepository);
  const purposeFunds = col(`${U}/people/amma/purposeFunds`);
  payments = new PersonPaymentRepository({
    personRepository,
    ledgerRepository,
    transactionRepository,
    advanceApplications: col(`${U}/people/amma/advanceApplications`),
    purposeFunds,
    expenseDocRef: (id) => ({ id, path: `${U}/expenses/${id}` }) as never,
    installmentDocRef: (s, i) => ({ id: i, path: `${U}/paymentSchedules/${s}/installments/${i}` }) as never,
    installmentPaymentDocRef: (s, i, p) => ({ id: p, path: `${U}/paymentSchedules/${s}/installments/${i}/payments/${p}` }) as never,
    cashLegCategoryId: "cat-people",
  });
  purposes = new PurposeFundRepository({ personRepository, ledgerRepository, transactionRepository, purposeFunds, cashLegCategoryId: "cat-people" });
  store.set(`${U}/accounts/sbi`, { id: "sbi", name: "SBI", currentBalance: 10_000, ...audit } as Doc);
  store.set(`${U}/people/amma`, { id: "amma", name: "Amma", openingBalance: 0, currentBalance: 1000, createdAt: d(1, 1), ...audit } as Doc);
  store.set(`${U}/people/amma/ledger/kseb`, {
    id: "kseb", personId: "amma", type: "gave", amount: 1000, date: d(9, 29), note: "KSEB bill", increasesBalance: true,
    transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 29), receivedStatus: "yetToReceive", ...audit,
  } as Doc);
}

const person = () => store.get(`${U}/people/amma`) as unknown as Person;
const sbi = () => (store.get(`${U}/accounts/sbi`) as unknown as { currentBalance: number }).currentBalance;
const ledger = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/ledger/`)).map(([, v]) => v as unknown as LedgerEntry);
const funds = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/purposeFunds/`)).map(([, v]) => v as unknown as PurposeFund);
const liveFunds = () => funds().filter((f) => f.deletedAt == null);
const txs = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/transactions/`)).map(([, v]) => v as unknown as Transaction);
const liveTx = () => txs().filter((t) => t.deletedAt == null);
const reportedIncome = () => liveTx().filter((t) => t.type === "income" && !isNonIncomeExpenseMovement(t) && !t.excludeFromCalculations).reduce((s, t) => s + t.amount, 0);
const advanceBalance = () =>
  buildPersonCycleStatement({
    person: { id: "amma", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: ledger(), loanIds: new Set(), emis: [], loans: [], installments: [], cycle: ALL, now: d(10, 3), advanceApplications: [] as AdvanceApplication[],
  }).advanceBalance;

const LINKS: PurposeLink[] = [
  { kind: "card", id: "octane", label: "OCTANE" },
  { kind: "loan", id: "loan1", label: "Home loan" },
  { kind: "emi", id: "emi1", label: "Phone EMI" },
  { kind: "bill", id: "bill1", label: "KSEB" },
];
const purpose = (title: string, amount: number, patch: Partial<AllocationDraft> = {}) => newAllocationDraft("purpose", amount, { title, ...patch });
const income = (amount: number) => newAllocationDraft("income", amount, { categoryId: "cat-gift", description: "Extra money from Amma" });
const advance = (amount: number) => newAllocationDraft("advance", amount);
const plan = (extra: number, drafts: AllocationDraft[]) => planExtraAllocation({ extra, direction: "theyPaid", allocations: draftsToAllocations(drafts, LINKS), money });

/** Exactly what the panel submits for a valid plan: KSEB ₹1,000 + the divided extra. */
function input(p: ExtraAllocationPlan): RecordPaymentInput {
  expect(p.error).toBeNull();
  const parts: PaymentExtraInput[] = [];
  if (p.advance > 0) parts.push({ kind: "advance", amount: p.advance });
  if (p.income) parts.push({ kind: "income", ...p.income });
  return {
    direction: "theyPaid",
    amount: 1000 + p.extra,
    date: d(10, 2),
    accountId: "sbi",
    lines: [{ key: "ledger:kseb", amount: 1000, route: { kind: "entry", parentEntryId: "kseb" } }],
    extra: parts[0] ?? null,
    ...(parts.length > 1 ? { extras: parts.slice(1) } : {}),
    ...(p.purposes.length > 0 ? { purposes: p.purposes } : {}),
  };
}

describe("Extra money divided across Purpose / Income / Advance", () => {
  beforeEach(setup);

  // ------------------------------------------------------------ the editor's plan

  it("13/15/16 — remaining recalculates; under-allocation shown; exact accepted", () => {
    const a = purpose("KSEB payment", 3000);
    let p = plan(5000, [a]);
    expect([p.assigned, p.left, p.status, p.error]).toEqual([3000, 2000, "under", "₹2,000 still needs a destination."]);
    p = plan(5000, [a, income(2000)]);
    expect([p.assigned, p.left, p.status, p.error]).toEqual([5000, 0, "full", null]);
  });

  it("14 — over-allocation is blocked with the exact excess", () => {
    const p = plan(5000, [purpose("KSEB", 4000), income(2000)]);
    expect([p.status, p.left, p.error]).toEqual(["over", -1000, "₹1,000 over the available amount."]);
  });

  it("paise-safe: ₹0.10 + ₹0.20 of ₹0.30 is exactly assigned", () => {
    expect(plan(0.3, [purpose("a", 0.1), purpose("b", 0.2)]).status).toBe("full");
  });

  it("11/12 — editing or removing an allocation before save just changes the plan", () => {
    let drafts = [purpose("KSEB", 3000), income(2000)];
    drafts = drafts.map((x) => (x.kind === "purpose" ? { ...x, amount: "2500" } : x)); // edit
    expect(plan(5000, drafts)).toMatchObject({ assigned: 4500, left: 500, status: "under" });
    drafts = drafts.filter((x) => x.kind !== "purpose"); // remove → back to "left to assign"
    expect(plan(5000, drafts)).toMatchObject({ assigned: 2000, left: 3000 });
    expect(sbi()).toBe(10_000); // allocation editing never touches cash
  });

  it("validates each destination: purpose needs a name, income a category; one income and one advance", () => {
    expect(plan(100, [purpose("", 100)]).error).toMatch(/say what this money is for/);
    expect(plan(100, [{ ...income(100), categoryId: "" }]).error).toMatch(/choose a category/);
    expect(plan(100, [income(50), income(50)]).error).toMatch(/Record income once/);
    expect(addableKinds("theyPaid", draftsToAllocations([income(1), advance(1)], LINKS))).toEqual(["purpose"]);
    expect(addableKinds("iPaid", [])).toEqual(["advance"]); // money I paid: advance only
  });

  it("5/6/7 — a purpose needs only a name and amount: no date → no due date, no connection → none", () => {
    const [noDate] = plan(3000, [purpose("School fees", 3000)]).purposes;
    expect(noDate).toMatchObject({ title: "School fees", amount: 3000, dueDate: null, link: null });
    const [dated] = plan(3000, [purpose("School fees", 3000, { due: "2026-10-15" })]).purposes;
    expect(dated.dueDate).toEqual(d(10, 15));
  });

  it("8/9/10 — connected purposes resolve to the chosen card / loan / EMI / bill", () => {
    const p = plan(4000, [
      purpose("Card", 1000, { connectKind: "card", link: "card:octane" }),
      purpose("Loan", 1000, { connectKind: "loanEmi", link: "loan:loan1" }),
      purpose("EMI", 1000, { connectKind: "loanEmi", link: "emi:emi1" }),
      purpose("Bill", 1000, { connectKind: "bill", link: "bill:bill1" }),
    ]);
    expect(p.purposes.map((x) => x.link?.label)).toEqual(["OCTANE", "Home loan", "Phone EMI", "KSEB"]);
    // A type picked but no item chosen yet is simply unconnected — never a half link.
    expect(plan(1000, [purpose("x", 1000, { connectKind: "card", link: "" })]).purposes[0].link).toBeNull();
  });

  // ------------------------------------------------------------ the accounting it produces

  it("1/17/18 — ₹5,000 extra → ₹3,000 purpose + ₹2,000 income: SBI +₹6,000 once in total, income ₹2,000 only", async () => {
    const id = await payments.recordPayment(person(), input(plan(5000, [purpose("KSEB payment", 3000), income(2000)])));
    expect(sbi()).toBe(16_000); // ₹1,000 settlement + ₹5,000 extra — never ₹21,000
    const people = liveTx().filter((t) => t.isPersonLedgerMovement);
    expect(people.map((t) => t.amount)).toEqual([4000]); // settlement + purpose ride in the one cash leg
    expect(reportedIncome()).toBe(2000); // the purpose is not income
    expect(liveFunds().map((f) => [f.title, f.amount, f.incomeTransactionRef != null])).toEqual([["KSEB payment", 3000, true]]);
    expect(advanceBalance()).toBe(0);
    expect(ledger().find((e) => e.paymentId === id)?.incomeTransactionRef).toBeTruthy();
  });

  it("2/19 — purpose + advance: advance keeps its existing meaning (held, not income)", async () => {
    await payments.recordPayment(person(), input(plan(5000, [purpose("KSEB", 3000), advance(2000)])));
    expect(sbi()).toBe(16_000);
    expect(liveTx()).toHaveLength(1);
    expect(advanceBalance()).toBe(-2000);
    expect(reportedIncome()).toBe(0);
  });

  it("3/4 — ₹10,000 extra: ₹5,000 + ₹2,000 purposes, ₹2,000 advance, ₹1,000 income", async () => {
    const p = plan(10_000, [purpose("External loan payment", 5000), purpose("KSEB", 2000), advance(2000), income(1000)]);
    const id = await payments.recordPayment(person(), input(p));
    expect(sbi()).toBe(21_000);
    expect(liveFunds().map((f) => [f.title, f.amount])).toEqual([["External loan payment", 5000], ["KSEB", 2000]]);
    expect(advanceBalance()).toBe(-2000);
    expect(reportedIncome()).toBe(1000);
    const impact = paymentImpact({
      paymentId: id,
      entries: ledger(),
      applications: [],
      transactionOf: (t) => txs().find((x) => x.id === t),
      purposeAmount: 7000,
    });
    expect(impact).toMatchObject({ received: 11_000, settled: 1000, advance: 2000, income: 1000, purposes: 7000, accounts: [{ accountId: "sbi", amount: 11_000 }] });
  });

  it("purposes + income with nothing owed: revert removes the income too (no orphan)", async () => {
    const p = plan(5000, [purpose("School fees", 3000), income(2000)]);
    const id = await payments.recordPayment(person(), { ...input(p), amount: 5000, lines: [] });
    expect(sbi()).toBe(15_000);
    expect(ledger().filter((e) => e.paymentId === id)).toHaveLength(0); // no ledger entry carries the income ref
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(sbi()).toBe(10_000);
    expect(liveTx()).toHaveLength(0);
    expect(liveFunds()).toHaveLength(0);
  });

  it("repository refuses two advance or two income parts on one receipt", async () => {
    const base = input(plan(2000, [advance(2000)]));
    await expect(payments.recordPayment(person(), { ...base, amount: 3000, extras: [{ kind: "advance", amount: 1000 }] })).rejects.toThrow(/one advance and one income/);
    expect(sbi()).toBe(10_000);
  });

  // ------------------------------------------------------------ Record use

  it("20/21 — record use: partial (₹2,000 used · ₹1,000 remaining), then complete; SBI −₹3,000 as the real outgoing", async () => {
    await payments.recordPayment(person(), input(plan(5000, [purpose("KSEB payment", 3000), income(2000)])));
    const f = liveFunds()[0];
    await purposes.recordUse(person(), f.id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 5), description: "KSEB", classification: "behalf" });
    let v = summarizePurposes(funds(), txs(), d(10, 6)).open[0];
    expect([v.status, v.used, v.remaining]).toEqual(["partial", 2000, 1000]);
    await purposes.recordUse(person(), f.id, { mode: "new", accountId: "sbi", amount: 1000, date: d(10, 7), description: "KSEB", classification: "behalf" });
    const s = summarizePurposes(funds(), txs(), d(10, 8));
    expect(s.open).toHaveLength(0);
    v = s.completed[0];
    expect([v.status, v.used]).toEqual(["completed", 3000]);
    expect(sbi()).toBe(13_000); // +₹6,000 receipt, −₹3,000 real use
  });
});
