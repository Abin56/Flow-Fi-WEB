import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Record Payment — end to end. The real repositories run against an in-memory fake Firestore (atomic:
 * a transaction's writes land only if its callback resolves), then the resulting documents are fed to
 * the real statement engine and People Ledger rows — the same numbers the UI, share text and PDF read.
 *
 * Scenario (the approved acceptance case): AMMA, September cycle obligations KSEB ₹1,000 + EMI ₹2,000.
 */

type Doc = Record<string, unknown> & { id: string };
const store = new Map<string, Doc>();

vi.mock("firebase/firestore", () => {
  const doc = (collection: { path: string; firestore: unknown }, id: string) => ({ id, path: `${collection.path}/${id}`, firestore: collection.firestore });
  return {
    doc,
    query: (collection: { path: string }, ...wheres: { field: string; value: unknown }[]) => ({ collection, wheres }),
    where: (field: string, _op: string, value: unknown) => ({ field, value }),
    getDocs: async (q: { collection: { path: string }; wheres: { field: string; value: unknown }[] }) => {
      const prefix = `${q.collection.path}/`;
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([, v]) => v)
        .filter((v) => q.wheres.every((w) => (v as Record<string, unknown>)[w.field] === w.value));
      return { docs: docs.map((v) => ({ data: () => structuredClone(v) })) };
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

/**
 * Edit / Revert of an existing Record Payment — the People Ledger's Edit and Revert payment actions.
 * Same in-memory atomic fake Firestore as `person-payment-repository.test.ts`; results are read back
 * through the real statement engine, ledger rows and `paymentImpact` (the revert preview).
 *
 * AMMA owes KSEB ₹1,000 (manual entry) + Phone EMI ₹2,000 (installment she repays).
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { AccountRepository } from "@/lib/repositories/account-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { PersonPaymentRepository, type PaymentExtraInput, type PaymentLineInput, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { advanceRemaining, drawAdvance } from "@/lib/engines/person-payment";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { advanceSources } from "@/features/people/lib/person-payment-obligations";
import { paymentInitialFor } from "@/features/people/components/workspace/record-payment-panel";
import { paymentImpact } from "@/lib/engines/person-payment-impact";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";

const db = {};
const col = (path: string) => ({ path, firestore: db }) as never;
const U = "users/u";
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const SEP = cycleContaining(d(9, 20));
const OCT = shiftCycle(SEP, 1);
const ALL: StatementCycle = { start: new Date(1970, 0, 1), end: shiftCycle(SEP, 3).end };
const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };

const emiInst = (id: string, seq: number, due: Date, amount: number) => ({
  id, scheduleId: "sch-emi", sequenceNumber: seq, dueDate: due, amountDue: amount, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(9, 1),
});
const phoneEmi = { id: "emi1", name: "Phone EMI", scheduleId: "sch-emi", beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
let installments = [emiInst("i1", 1, d(9, 30), 2000)];

let payments: PersonPaymentRepository;
function setup() {
  store.clear();
  const accountRepository = new AccountRepository(col(`${U}/accounts`));
  const transactionRepository = new TransactionRepository(col(`${U}/transactions`), accountRepository);
  const personRepository = new PersonRepository(col(`${U}/people`));
  const ledgerRepository = new LedgerRepository(col(`${U}/people/amma/ledger`), personRepository);
  payments = new PersonPaymentRepository({
    personRepository,
    ledgerRepository,
    transactionRepository,
    advanceApplications: col(`${U}/people/amma/advanceApplications`),
    expenseDocRef: (id) => ({ id, path: `${U}/expenses/${id}` }) as never,
    installmentDocRef: (s, i) => ({ id: i, path: `${U}/paymentSchedules/${s}/installments/${i}` }) as never,
    installmentPaymentDocRef: (s, i, p) => ({ id: p, path: `${U}/paymentSchedules/${s}/installments/${i}/payments/${p}` }) as never,
    cashLegCategoryId: "cat-people",
  });
  store.set(`${U}/accounts/sbi`, { id: "sbi", name: "SBI", currentBalance: 10_000, ...audit } as Doc);
  store.set(`${U}/accounts/fed`, { id: "fed", name: "Federal Bank", currentBalance: 0, ...audit } as Doc);
  store.set(`${U}/people/amma`, { id: "amma", name: "Amma", openingBalance: 0, currentBalance: 1000, createdAt: d(1, 1), ...audit } as Doc);
  store.set(`${U}/people/amma/ledger/kseb`, {
    id: "kseb", personId: "amma", type: "gave", amount: 1000, date: d(9, 29), note: "KSEB bill", increasesBalance: true,
    transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 29), receivedStatus: "yetToReceive", ...audit,
  } as Doc);
}

const person = () => store.get(`${U}/people/amma`) as unknown as Person;
const balanceOf = (id: string) => (store.get(`${U}/accounts/${id}`) as unknown as { currentBalance: number }).currentBalance;
const ledger = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/ledger/`)).map(([, v]) => v as unknown as LedgerEntry);
const applications = () =>
  [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/advanceApplications/`)).map(([, v]) => v as unknown as AdvanceApplication);
const liveTx = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/transactions/`)).map(([, v]) => v as Doc).filter((t) => t.deletedAt == null);
type Tx = { id: string; accountId: string; amount: number; deletedAt: Date | null; categoryId: string; description: string };
const txOf = (id: string) => (store.get(`${U}/transactions/${id}`) as unknown as Tx | undefined) ?? null;

function statement(cycle: StatementCycle) {
  return buildPersonCycleStatement({
    person: { id: "amma", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: ledger(),
    loanIds: new Set(),
    emis: [phoneEmi],
    loans: [],
    installments,
    cycle,
    now: d(10, 1),
    advanceApplications: applications(),
  });
}
const rows = (cycle: StatementCycle) =>
  buildLedgerRows({ statement: statement(cycle), history: statement(ALL), entries: ledger(), pending: [], advanceApplications: applications() });
const row = (key: string, cycle = SEP) => rows(cycle).find((r) => r.key === key)!;

const KSEB = (amount: number): PaymentLineInput => ({ key: "ledger:kseb", amount, route: { kind: "entry", parentEntryId: "kseb" } });
const EMI = (amount: number): PaymentLineInput => ({ key: "emi-inst:i1", amount, route: { kind: "derived", obligationRef: "emi-inst:i1", sourceKind: "emiInstallment" } });
const ADV = (amount: number): PaymentExtraInput => ({ kind: "advance", amount });
const INC = (amount: number): PaymentExtraInput => ({ kind: "income", amount, categoryId: "cat-gift", description: "Gift" });
function input(lines: PaymentLineInput[], extra: PaymentExtraInput | null = null, accountId = "sbi"): RecordPaymentInput {
  const amount = lines.reduce((s, l) => s + l.amount, 0) + (extra?.amount ?? 0);
  return { direction: "theyPaid", amount, date: d(10, 2), accountId, lines, extra };
}

/** Cached balance + derived EMI obligations = pending + advance — every rupee has one meaning. */
function expectConsistent() {
  const s = statement(ALL);
  const emi = s.rows.filter((r) => r.kind === "obligation" && r.category === "emi").reduce((sum, r) => sum + r.signedAmount, 0);
  expect(person().currentBalance + emi).toBeCloseTo(s.currentPending + s.advanceBalance, 2);
}
const impact = (paymentId: string) => paymentImpact({ paymentId, entries: ledger(), applications: applications(), transactionOf: txOf });
const snapshot = () => ({ sbi: balanceOf("sbi"), ledger: JSON.stringify(ledger()), apps: JSON.stringify(applications()), tx: JSON.stringify(liveTx()) });
async function useAdvance(amount: number) {
  installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
  const available = advanceRemaining(advanceSources(ledger()), applications());
  await payments.applyAdvance(person(), { targets: [{ obligationKey: "emi-inst:i2", uses: drawAdvance(available, "theyOwe", amount) }], date: d(10, 30) });
}

describe("Edit / Revert a recorded People payment", () => {
  beforeEach(() => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    setup();
  });

  // ---------------------------------------------------------------- Edit

  it("edit amount ₹5,000 → ₹4,500 (advance ₹2,000 → ₹1,500): SBI +₹4,500 once, no orphan", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    expect(balanceOf("sbi")).toBe(15_000);
    await payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], ADV(1500)));
    expect(balanceOf("sbi")).toBe(14_500);
    expect(liveTx()).toHaveLength(1);
    expect(liveTx()[0].amount).toBe(4500);
    expect(statement(ALL).advanceBalance).toBe(-1500);
    expect(statement(SEP).currentPending).toBe(0);
    expectConsistent();
  });

  it("edit receiving account SBI → Federal Bank: cash moves, never duplicated", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)]));
    await payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], null, "fed"));
    expect(balanceOf("sbi")).toBe(10_000);
    expect(balanceOf("fed")).toBe(3000);
    expect(liveTx().map((t) => [t.accountId, t.amount])).toEqual([["fed", 3000]]);
    expectConsistent();
  });

  it("edit allocation KSEB ₹1,000 / EMI ₹1,500 → KSEB ₹500 / EMI ₹2,000: remainings move, cash stays ₹2,500", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(1500)]));
    expect([row("ledger:kseb").remaining, row("emi-inst:i1").remaining]).toEqual([0, 500]);
    await payments.editPayment(person(), id, input([KSEB(500), EMI(2000)]));
    expect([row("ledger:kseb").remaining, row("emi-inst:i1").remaining]).toEqual([500, 0]);
    expect(balanceOf("sbi")).toBe(12_500);
    expect(liveTx()).toHaveLength(1);
    expect(statement(SEP).currentPending).toBe(500);
    expectConsistent();
  });

  it("Income ₹2,000 → Advance ₹2,000: income removed, advance held, SBI stays +₹5,000", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], INC(2000)));
    expect(liveTx().filter((t) => !t.isPersonLedgerMovement).map((t) => t.amount)).toEqual([2000]);
    await payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], ADV(2000)));
    expect(balanceOf("sbi")).toBe(15_000);
    expect(liveTx().filter((t) => !t.isPersonLedgerMovement)).toHaveLength(0); // no orphan income
    expect(liveTx().filter((t) => t.isPersonLedgerMovement).map((t) => t.amount)).toEqual([5000]);
    expect(statement(ALL).advanceBalance).toBe(-2000);
    expectConsistent();
  });

  it("Advance ₹2,000 → Income ₹2,000: advance removed, one Income, SBI unchanged", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    await payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], INC(2000)));
    expect(balanceOf("sbi")).toBe(15_000);
    expect(statement(ALL).advanceBalance).toBe(0);
    const kinds = liveTx().map((t) => `${t.isPersonLedgerMovement ? "people" : "income"}:${t.amount}`).sort();
    expect(kinds).toEqual(["income:2000", "people:3000"]);
    expectConsistent();
  });

  it("edit unused advance ₹2,000 → ₹1,500", async () => {
    const id = await payments.recordPayment(person(), input([], ADV(2000)));
    await payments.editPayment(person(), id, input([], ADV(1500)));
    expect(statement(ALL).advanceBalance).toBe(-1500);
    expect(balanceOf("sbi")).toBe(11_500);
    expectConsistent();
  });

  it("blocks editing an advance below what a later settlement used (and Advance → Income); nothing changes", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    await useAdvance(1000);
    const before = snapshot();
    await expect(payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], ADV(500)))).rejects.toThrow(/already applied/);
    await expect(payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], INC(2000)))).rejects.toThrow(/already applied/);
    expect(snapshot()).toEqual(before);
    // An edit that keeps enough advance is allowed — the use is re-pointed, its history unchanged.
    await payments.editPayment(person(), id, input([KSEB(1000), EMI(2000)], ADV(1500)));
    expect(row("emi-inst:i2", OCT).remaining).toBe(200);
    expect(statement(ALL).advanceBalance).toBe(-500);
    expectConsistent();
  });

  it("editing twice never duplicates records; the superseded id can't be reverted", async () => {
    const id1 = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)]));
    const id2 = await payments.editPayment(person(), id1, input([KSEB(1000), EMI(1500)]));
    await payments.editPayment(person(), id2, input([KSEB(800), EMI(1500)]));
    expect(liveTx()).toHaveLength(1);
    expect(balanceOf("sbi")).toBe(12_300);
    expect(ledger().filter((e) => e.deletedAt == null && e.paymentId != null)).toHaveLength(2);
    await expect(payments.revertPayment(person(), id1)).rejects.toThrow();
    expect(balanceOf("sbi")).toBe(12_300);
    expectConsistent();
  });

  // ---------------------------------------------------------------- Revert

  it("revert a full settlement: SBI −₹3,000, AMMA owes ₹3,000 again", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)]));
    expect(statement(SEP).currentPending).toBe(0);
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(balanceOf("sbi")).toBe(10_000);
    expect(statement(SEP).currentPending).toBe(3000);
    expect(person().currentBalance).toBe(1000);
    expect(liveTx()).toHaveLength(0);
    expectConsistent();
  });

  it("revert a partial settlement reopens only what it paid", async () => {
    await payments.recordPayment(person(), input([KSEB(500)]));
    const id = await payments.recordPayment(person(), input([KSEB(300)]));
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(row("ledger:kseb").remaining).toBe(500);
    expect(balanceOf("sbi")).toBe(10_500);
    expectConsistent();
  });

  it("revert settlement + income: preview from records, both undone, cash reversed exactly once", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], INC(2000)));
    expect(impact(id)).toMatchObject({ received: 5000, settled: 3000, income: 2000, advance: 0, accounts: [{ accountId: "sbi", amount: 5000 }], canRevert: true });
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(balanceOf("sbi")).toBe(10_000);
    expect(liveTx()).toHaveLength(0);
    expect(statement(SEP).currentPending).toBe(3000);
    expectConsistent();
  });

  it("revert settlement + unused advance", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    expect(impact(id)).toMatchObject({ received: 5000, settled: 3000, advance: 2000, advanceUnused: 2000, canRevert: true });
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(balanceOf("sbi")).toBe(10_000);
    expect(statement(ALL).advanceBalance).toBe(0);
    expect(statement(SEP).currentPending).toBe(3000);
    expectConsistent();
  });

  it("blocks revert while a later settlement uses the advance; undoing that use unblocks it", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    await useAdvance(1000);
    const imp = impact(id)!;
    expect([imp.canRevert, imp.advanceUsed, imp.advanceUnused]).toEqual([false, 1000, 1000]);
    expect(imp.dependencies.map((x) => [x.obligationKey, x.amount])).toEqual([["emi-inst:i2", 1000]]);

    const before = snapshot();
    await expect(payments.revertPayment(person(), id, { blockIfAdvanceUsed: true })).rejects.toThrow(/already been used in a later settlement/);
    expect(snapshot()).toEqual(before); // atomic: nothing written

    await payments.removeAdvanceApplications(applications().filter((a) => a.deletedAt == null));
    expect(impact(id)!.canRevert).toBe(true);
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(balanceOf("sbi")).toBe(10_000);
    expect(row("emi-inst:i2", OCT).remaining).toBe(1200);
    expectConsistent();
  });

  it("legacy behaviour kept: revert without the guard still un-applies used advance (Transactions page path)", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], ADV(2000)));
    await useAdvance(1000);
    await payments.revertPayment(person(), id);
    expect(row("emi-inst:i2", OCT).remaining).toBe(1200);
    expect(balanceOf("sbi")).toBe(10_000);
  });

  it("edit → revert, and a second revert can't double-reverse", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)]));
    const edited = await payments.editPayment(person(), id, input([KSEB(1000)], null, "fed"));
    expect([balanceOf("sbi"), balanceOf("fed")]).toEqual([10_000, 1000]);
    await payments.revertPayment(person(), edited, { blockIfAdvanceUsed: true });
    expect([balanceOf("sbi"), balanceOf("fed")]).toEqual([10_000, 0]);
    await expect(payments.revertPayment(person(), edited, { blockIfAdvanceUsed: true })).rejects.toThrow();
    expect([balanceOf("sbi"), balanceOf("fed")]).toEqual([10_000, 0]);
    expect(statement(SEP).currentPending).toBe(3000);
    expectConsistent();
  });

  it("both directions stay separate: reverting a receipt never touches what I owe", async () => {
    // I owe Amma ₹700 (she lent it to me) — an obligation on the other side.
    store.set(`${U}/people/amma/ledger/lent`, {
      id: "lent", personId: "amma", type: "borrowed", amount: 700, date: d(9, 25), note: "Borrowed", increasesBalance: false,
      transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 25), receivedStatus: "yetToReceive", ...audit,
    } as Doc);
    store.set(`${U}/people/amma`, { ...(person() as unknown as Doc), currentBalance: 300 });
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)]));
    expect(row("ledger:lent").remaining).toBe(700);
    await payments.revertPayment(person(), id, { blockIfAdvanceUsed: true });
    expect(row("ledger:lent").remaining).toBe(700);
    expect(row("ledger:kseb").remaining).toBe(1000);
    expect(row("emi-inst:i1").remaining).toBe(2000);
    expectConsistent();
  });

  // ---------------------------------------------------------------- Edit pre-fill

  it("the edit pre-fill reads the recorded payment, including an income part; unknown groups stay readable", async () => {
    const id = await payments.recordPayment(person(), input([KSEB(1000), EMI(2000)], INC(2000)));
    const incomeOf = (t: string) => {
      const x = txOf(t);
      return x ? { amount: x.amount, categoryId: x.categoryId, description: x.description } : null;
    };
    const initial = paymentInitialFor(id, ledger(), (t) => txOf(t)?.accountId ?? null, undefined, incomeOf);
    expect(initial).toMatchObject({ amount: 5000, accountId: "sbi", lines: { "ledger:kseb": 1000, "emi-inst:i1": 2000 }, advance: 0, income: { amount: 2000, categoryId: "cat-gift" } });
    // Without a way to read the income transaction it's not offered for edit (never pre-filled wrong).
    expect(paymentInitialFor(id, ledger(), () => "sbi")).toBeNull();
    expect(paymentInitialFor("missing", ledger(), () => null)).toBeNull();
    expect(impact("missing")).toBeNull();
  });
});
