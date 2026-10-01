import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Purpose money — end to end. Real repositories over the same in-memory fake Firestore the Record
 * Payment suite uses (atomic: a transaction's writes land only if its callback resolves); the results are
 * read back through the real statement engine and the purpose engine.
 *
 * Acceptance case: AMMA owes ₹1,000 (KSEB). AMMA sends ₹10,000. ₹1,000 settles KSEB; ₹9,000 is kept for
 * purposes — ₹5,000 AMMA's external loan, ₹2,000 KSEB (next), ₹2,000 next month.
 */

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

import { AccountRepository } from "@/lib/repositories/account-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { PersonPaymentRepository, type PurposeInput, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { PurposeFundRepository } from "@/lib/repositories/purpose-fund-repository";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { purposesDueIn, receiptBreakdown, summarizePurposes } from "@/lib/engines/purpose-funds";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { PurposeFund } from "@/lib/models/purpose-fund";
import { isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";

const db = {};
const col = (path: string) => ({ path, firestore: db }) as never;
const U = "users/u";
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const ALL: StatementCycle = { start: new Date(1970, 0, 1), end: d(12, 31, 2027) };
const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };

let payments: PersonPaymentRepository;
let purposes: PurposeFundRepository;
let transactionRepository: TransactionRepository;
let ledgerRepository: LedgerRepository;
let personRepository: PersonRepository;

function setup() {
  store.clear();
  const accountRepository = new AccountRepository(col(`${U}/accounts`));
  transactionRepository = new TransactionRepository(col(`${U}/transactions`), accountRepository);
  personRepository = new PersonRepository(col(`${U}/people`));
  ledgerRepository = new LedgerRepository(col(`${U}/people/amma/ledger`), personRepository);
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
  store.set(`${U}/accounts/octane`, { id: "octane", name: "OCTANE card", currentBalance: -5_000, ...audit } as Doc);
  store.set(`${U}/people/amma`, { id: "amma", name: "Amma", openingBalance: 0, currentBalance: 1000, createdAt: d(1, 1), ...audit } as Doc);
  // AMMA owes me ₹1,000 — the KSEB bill I paid for her.
  const kseb: LedgerEntry = {
    id: "kseb", personId: "amma", type: "gave", amount: 1000, date: d(9, 29), note: "KSEB bill", increasesBalance: true,
    transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 29), receivedStatus: "yetToReceive", ...audit,
  };
  store.set(`${U}/people/amma/ledger/kseb`, kseb as unknown as Doc);
}

const person = () => store.get(`${U}/people/amma`) as unknown as Person;
const balance = (id: string) => (store.get(`${U}/accounts/${id}`) as unknown as { currentBalance: number }).currentBalance;
const ledger = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/ledger/`)).map(([, v]) => v as unknown as LedgerEntry);
const funds = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/purposeFunds/`)).map(([, v]) => v as unknown as PurposeFund);
const liveFunds = () => funds().filter((f) => f.deletedAt == null);
const txs = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/transactions/`)).map(([, v]) => v as unknown as Transaction);
const liveTx = () => txs().filter((t) => t.deletedAt == null);
const fund = (title: string) => liveFunds().find((f) => f.title === title && f.state === "active")!;
const summary = (now = d(10, 3)) => summarizePurposes(funds(), txs(), now);
/** Income/expense totals — what every report counts (non-income movements excluded, as in `isNonIncomeExpenseMovement`). */
const reported = (type: "income" | "expense") =>
  liveTx().filter((t) => t.type === type && !isNonIncomeExpenseMovement(t) && !t.excludeFromCalculations).reduce((s, t) => s + t.amount, 0);

function statement() {
  return buildPersonCycleStatement({
    person: { id: "amma", name: "Amma", openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: ledger(),
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: ALL,
    now: d(10, 3),
    advanceApplications: [] as AdvanceApplication[],
  });
}

const P = (title: string, amount: number, dueDate: Date | null = null, link: PurposeInput["link"] = null): PurposeInput => ({ title, amount, dueDate, note: "", link });
const ksebLine = { key: "ledger:kseb", amount: 1000, route: { kind: "entry" as const, parentEntryId: "kseb" } };

function receipt(extra: RecordPaymentInput["extra"] = null, list: PurposeInput[] = [P("Pay AMMA's other loan", 5000, d(10, 10)), P("KSEB bill", 2000, d(10, 15)), P("Next month's bill", 2000, d(11, 5))]): RecordPaymentInput {
  return { direction: "theyPaid", amount: 10_000, date: d(10, 2), accountId: "sbi", lines: [ksebLine], extra, purposes: list };
}

describe("Purpose money — AMMA sends ₹10,000 while owing ₹1,000", () => {
  beforeEach(setup);

  it("receipt: +₹10,000 once, ₹1,000 settled, ₹9,000 kept for purposes, income ₹0, advance ₹0", async () => {
    const paymentId = await payments.recordPayment(person(), receipt());
    expect(balance("sbi")).toBe(20_000);
    expect(liveTx()).toHaveLength(1);
    const [cashLeg] = liveTx();
    expect(cashLeg.amount).toBe(10_000);
    expect(cashLeg.isPersonLedgerMovement).toBe(true);
    expect(reported("income")).toBe(0);
    expect(reported("expense")).toBe(0);
    // People: KSEB settled, nothing pending, no advance — purposes never touch the balance.
    expect(person().currentBalance).toBe(0);
    const s = statement();
    expect(s.currentPending).toBe(0);
    expect(s.advanceBalance).toBe(0);
    expect(ledger().filter((e) => e.paymentId === paymentId).map((e) => [e.sourceKind, e.amount])).toEqual([["manual", 1000]]);
    // Purposes
    expect(liveFunds()).toHaveLength(3);
    expect(liveFunds().every((f) => f.receiptTransactionRef === cashLeg.id && f.paymentId === paymentId)).toBe(true);
    expect(summary().stillToUse).toBe(9000);
    expect(receiptBreakdown({ paymentId, entries: ledger(), funds: funds(), incomeAmounts: [] })).toEqual({ paymentId, received: 10_000, settled: 1000, advance: 0, income: 0, purposes: 9000 });
  });

  it("exact payment with no extra still writes no purposes", async () => {
    await payments.recordPayment(person(), { direction: "theyPaid", amount: 1000, date: d(10, 2), accountId: "sbi", lines: [ksebLine], extra: null });
    expect(funds()).toHaveLength(0);
    expect(balance("sbi")).toBe(11_000);
    expect(person().currentBalance).toBe(0);
  });

  it("extra → advance and extra → income are unchanged", async () => {
    await payments.recordPayment(person(), { direction: "theyPaid", amount: 3000, date: d(10, 2), accountId: "sbi", lines: [ksebLine], extra: { kind: "advance", amount: 2000 } });
    expect(statement().advanceBalance).toBe(-2000); // signed: an advance they paid me
    expect(funds()).toHaveLength(0);
    setup();
    await payments.recordPayment(person(), {
      direction: "theyPaid", amount: 3000, date: d(10, 2), accountId: "sbi", lines: [ksebLine], extra: { kind: "income", amount: 2000, categoryId: "cat-gift", description: "Gift" },
    });
    expect(reported("income")).toBe(2000);
    expect(balance("sbi")).toBe(13_000);
  });

  it("one purpose + remainder as advance (mixed): one cash leg, advance only for the remainder", async () => {
    await payments.recordPayment(person(), receipt({ kind: "advance", amount: 4000 }, [P("Pay AMMA's other loan", 5000)]));
    expect(balance("sbi")).toBe(20_000);
    expect(liveTx()).toHaveLength(1);
    expect(liveTx()[0].amount).toBe(10_000);
    expect(statement().advanceBalance).toBe(-4000);
    expect(summary().stillToUse).toBe(5000);
    expect(reported("income")).toBe(0);
  });

  it("purposes + remainder as income: account still +₹10,000 in total; only the remainder is income", async () => {
    await payments.recordPayment(person(), receipt({ kind: "income", amount: 4000, categoryId: "cat-gift", description: "Gift" }, [P("Loan", 5000)]));
    expect(balance("sbi")).toBe(20_000);
    expect(reported("income")).toBe(4000);
    expect(summary().stillToUse).toBe(5000);
  });

  it("a receipt kept entirely for purposes (nothing owed) is allowed and revertible", async () => {
    const paymentId = await payments.recordPayment(person(), { direction: "theyPaid", amount: 3000, date: d(10, 2), accountId: "sbi", lines: [], extra: null, purposes: [P("School fees", 3000)] });
    expect(balance("sbi")).toBe(13_000);
    expect(person().currentBalance).toBe(1000); // untouched — not an advance
    await payments.revertPayment(person(), paymentId);
    expect(balance("sbi")).toBe(10_000);
    expect(liveFunds()).toHaveLength(0);
  });

  it("rejects unexplained remainders and purposes on money I paid", async () => {
    await expect(payments.recordPayment(person(), receipt(null, [P("Loan", 5000)]))).rejects.toThrow(/Every rupee/);
    await expect(
      payments.recordPayment(person(), { direction: "iPaid", amount: 500, date: d(10, 2), accountId: "sbi", lines: [], extra: null, purposes: [P("x", 500)] }),
    ).rejects.toThrow(/Only money received/);
    expect(txs()).toHaveLength(0);
  });

  it("record use (KSEB ₹2,000, paid with AMMA's money): SBI −₹2,000 once, completed, not my expense, ₹7,000 left", async () => {
    await payments.recordPayment(person(), receipt());
    const id = await purposes.recordUse(person(), fund("KSEB bill").id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 14), description: "KSEB", classification: "behalf" });
    expect(balance("sbi")).toBe(18_000);
    const use = liveTx().find((t) => t.id === id)!;
    expect(use.type).toBe("expense");
    expect(isNonIncomeExpenseMovement(use)).toBe(true);
    expect(reported("expense")).toBe(0);
    expect(reported("income")).toBe(0);
    const s = summary();
    expect(s.stillToUse).toBe(7000);
    expect(s.completed.map((v) => v.fund.title)).toEqual(["KSEB bill"]);
    expect(person().currentBalance).toBe(0); // no automatic People netting
  });

  it("record use as my own expense counts once in expense totals", async () => {
    await payments.recordPayment(person(), receipt());
    await purposes.recordUse(person(), fund("KSEB bill").id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 14), description: "KSEB", classification: "expense", categoryId: "cat-power" });
    expect(reported("expense")).toBe(2000);
    expect(balance("sbi")).toBe(18_000);
  });

  it("partial use, then completion; never beyond what is left", async () => {
    await payments.recordPayment(person(), receipt());
    const loan = fund("Pay AMMA's other loan");
    await purposes.recordUse(person(), loan.id, { mode: "new", accountId: "sbi", amount: 3000, date: d(10, 5), description: "Loan", classification: "behalf" });
    let v = summary().open.find((x) => x.fund.id === loan.id)!;
    expect([v.used, v.remaining, v.status]).toEqual([3000, 2000, "partial"]);
    await expect(purposes.recordUse(person(), loan.id, { mode: "new", accountId: "sbi", amount: 2500, date: d(10, 6), description: "Loan", classification: "behalf" })).rejects.toThrow(/Only ₹2000/);
    await purposes.recordUse(person(), loan.id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 9), description: "Loan", classification: "behalf" });
    v = summary().completed.find((x) => x.fund.id === loan.id)!;
    expect(v.status).toBe("completed");
    expect(balance("sbi")).toBe(15_000);
    expect(liveTx().filter((t) => t.amount === 10_000)).toHaveLength(1); // the receipt is never recreated
  });

  it("deleting the use transaction reopens the purpose; undoing a created use deletes its payment", async () => {
    await payments.recordPayment(person(), receipt());
    const k = fund("KSEB bill");
    const id = await purposes.recordUse(person(), k.id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 14), description: "KSEB", classification: "behalf" });
    await transactionRepository.softDeleteTransaction(liveTx().find((t) => t.id === id)!);
    expect(balance("sbi")).toBe(20_000);
    expect(summary().stillToUse).toBe(9000);
    // Record again, then undo through the purpose
    await purposes.recordUse(person(), k.id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 14), description: "KSEB", classification: "behalf" });
    const live = liveFunds().find((f) => f.id === k.id)!;
    const lastUse = live.uses[live.uses.length - 1];
    await purposes.undoUse(k.id, lastUse.id);
    expect(balance("sbi")).toBe(20_000);
    expect(summary().stillToUse).toBe(9000);
  });

  it("card link: pays the card through its own rule (a transfer into the card); undo removes both legs", async () => {
    await payments.recordPayment(person(), receipt(null, [P("Pay OCTANE card bill", 3000, null, { kind: "card", id: "octane", label: "OCTANE card" }), P("Rest", 6000)]));
    const card = fund("Pay OCTANE card bill");
    await purposes.recordUse(person(), card.id, { mode: "card", accountId: "sbi", cardAccountId: "octane", amount: 3000, date: d(10, 8), description: "OCTANE bill" });
    expect(balance("sbi")).toBe(17_000);
    expect(balance("octane")).toBe(-2000);
    const legs = liveTx().filter((t) => t.transferId != null);
    expect(legs).toHaveLength(2);
    expect(reported("expense")).toBe(0);
    await purposes.undoUse(card.id, liveFunds().find((f) => f.id === card.id)!.uses[0].id);
    expect(balance("sbi")).toBe(20_000);
    expect(balance("octane")).toBe(-5000);
    expect(liveTx().filter((t) => t.transferId != null)).toHaveLength(0);
  });

  it.each([
    ["loan", { loanId: "loan1" }],
    ["emi", { emiId: "emi1" }],
    ["person", { isPersonLedgerMovement: true, linkedPersonId: "ravi" }],
  ] as const)("%s link: the payment recorded through its own flow is linked — no second cash event", async (kind, extraFields) => {
    await payments.recordPayment(person(), receipt(null, [P(`Pay ${kind}`, 5000, null, { kind, id: "x", label: kind }), P("Rest", 4000)]));
    // Paid through the Loan / EMI / People flow — its own transaction:
    const paid = await transactionRepository.createTransaction({ type: "expense", amount: 5000, dateTime: d(10, 9), accountId: "sbi", categoryId: "cat", ...extraFields });
    const before = balance("sbi");
    const count = liveTx().length;
    await purposes.recordUse(person(), fund(`Pay ${kind}`).id, { mode: "link", transactionId: paid.id, amount: 5000 });
    expect(balance("sbi")).toBe(before);
    expect(liveTx()).toHaveLength(count);
    expect(summary().stillToUse).toBe(4000);
    // The same payment can't be counted again by another purpose.
    await expect(purposes.recordUse(person(), fund("Rest").id, { mode: "link", transactionId: paid.id, amount: 1 })).rejects.toThrow(/more than is left/);
    // Unlinking never deletes a payment that belongs to another flow.
    const f = liveFunds().find((x) => x.title === `Pay ${kind}`)!;
    await purposes.undoUse(f.id, f.uses[0].id);
    expect(liveTx().some((t) => t.id === paid.id)).toBe(true);
    expect(balance("sbi")).toBe(before);
  });

  it("bill link: the purpose records the one real cash event (Bills never post cash)", async () => {
    await payments.recordPayment(person(), receipt(null, [P("KSEB", 9000, null, { kind: "bill", id: "bill-kseb", label: "KSEB" })]));
    await purposes.recordUse(person(), fund("KSEB").id, { mode: "new", accountId: "sbi", amount: 9000, date: d(10, 9), description: "KSEB", classification: "behalf" });
    expect(balance("sbi")).toBe(11_000);
    expect(liveFunds()[0].link).toEqual({ kind: "bill", id: "bill-kseb", label: "KSEB" });
    expect(summary().completed).toHaveLength(1);
  });

  it("edit: details freely; amount down frees money as unassigned; up only from unassigned; never below used", async () => {
    await payments.recordPayment(person(), receipt());
    const loan = fund("Pay AMMA's other loan");
    await purposes.editFund(loan.id, { title: "Bank loan", dueDate: d(10, 12), note: "SBI loan", amount: 4000 });
    let s = summary();
    expect(s.open.find((v) => v.fund.id === loan.id)!.fund).toMatchObject({ title: "Bank loan", amount: 4000, note: "SBI loan" });
    expect(s.unassignedTotal).toBe(1000);
    await purposes.editFund(loan.id, { amount: 4500 });
    s = summary();
    expect(s.unassignedTotal).toBe(500);
    await expect(purposes.editFund(loan.id, { amount: 6000 })).rejects.toThrow(/unassigned/);
    await purposes.recordUse(person(), loan.id, { mode: "new", accountId: "sbi", amount: 3000, date: d(10, 5), description: "x", classification: "behalf" });
    await expect(purposes.editFund(loan.id, { amount: 2000 })).rejects.toThrow(/already used/);
    expect(balance("sbi")).toBe(17_000); // edits never move cash
  });

  it("cancel → unassigned (never income); then advance or income, account unchanged", async () => {
    await payments.recordPayment(person(), receipt());
    await purposes.cancelFund(fund("Next month's bill").id);
    expect(summary().unassignedTotal).toBe(2000);
    expect(reported("income")).toBe(0);
    const [piece] = summary().unassigned;
    await purposes.releaseUnassigned(person(), piece.fund.id, { kind: "advance" });
    expect(statement().advanceBalance).toBe(-2000); // signed: an advance they paid me
    expect(person().currentBalance).toBe(-2000);
    expect(balance("sbi")).toBe(20_000);

    await purposes.cancelFund(fund("KSEB bill").id);
    const [p2] = summary().unassigned;
    await purposes.releaseUnassigned(person(), p2.fund.id, { kind: "income", categoryId: "cat-gift", description: "Keep it" });
    expect(reported("income")).toBe(2000);
    expect(balance("sbi")).toBe(20_000);
    expect(liveTx().find((t) => t.isPersonLedgerMovement)!.amount).toBe(8000);
    expect(summary().stillToUse).toBe(5000);
  });

  it("cancel after partial use keeps the used part; the rest becomes unassigned", async () => {
    await payments.recordPayment(person(), receipt());
    const loan = fund("Pay AMMA's other loan");
    await purposes.recordUse(person(), loan.id, { mode: "new", accountId: "sbi", amount: 3000, date: d(10, 5), description: "x", classification: "behalf" });
    await purposes.cancelFund(loan.id);
    const s = summary();
    expect(s.completed.find((v) => v.fund.id === loan.id)!.used).toBe(3000);
    expect(s.unassignedTotal).toBe(2000);
  });

  it("income release of a whole purpose-only receipt is refused (revert + record instead)", async () => {
    await payments.recordPayment(person(), { direction: "theyPaid", amount: 3000, date: d(10, 2), accountId: "sbi", lines: [], extra: null, purposes: [P("x", 3000)] });
    await purposes.cancelFund(liveFunds()[0].id);
    const [piece] = summary().unassigned;
    await expect(purposes.releaseUnassigned(person(), piece.fund.id, { kind: "income", categoryId: "c", description: "" })).rejects.toThrow(/whole payment/);
  });

  it("revert receipt: blocked while purpose money is used; afterwards everything goes, no orphans", async () => {
    const paymentId = await payments.recordPayment(person(), receipt());
    await purposes.cancelFund(fund("Next month's bill").id);
    await purposes.releaseUnassigned(person(), summary().unassigned[0].fund.id, { kind: "income", categoryId: "cat-gift", description: "" });
    const k = fund("KSEB bill");
    await purposes.recordUse(person(), k.id, { mode: "new", accountId: "sbi", amount: 2000, date: d(10, 14), description: "KSEB", classification: "behalf" });
    await expect(payments.revertPayment(person(), paymentId)).rejects.toThrow(/already used/);
    await purposes.undoUse(k.id, liveFunds().find((f) => f.id === k.id)!.uses[0].id);
    await payments.revertPayment(person(), paymentId);
    expect(balance("sbi")).toBe(10_000);
    expect(liveTx()).toHaveLength(0);
    expect(liveFunds()).toHaveLength(0);
    expect(ledger().filter((e) => e.deletedAt == null && e.paymentId === paymentId)).toHaveLength(0);
    expect(person().currentBalance).toBe(1000);
    expect(reported("income")).toBe(0);
  });

  it("editing a payment that kept purposes is refused; revert + record instead", async () => {
    const paymentId = await payments.recordPayment(person(), receipt());
    await expect(payments.editPayment(person(), paymentId, receipt())).rejects.toThrow(/revert it and record it again/);
  });

  it("deleting a purpose-only receipt from Transactions reverts it (no orphan purposes)", async () => {
    await payments.recordPayment(person(), { direction: "theyPaid", amount: 3000, date: d(10, 2), accountId: "sbi", lines: [], extra: null, purposes: [P("x", 3000)] });
    const cashLeg = { ...liveTx()[0], linkedPersonId: "amma" };
    await deletePersonCashLegTransaction({
      transaction: cashLeg,
      transactionRepository,
      personRepository,
      ledgerRepositoryFor: () => ledgerRepository,
      revertPayment: (p, id) => payments.revertPayment(p, id),
      purposePaymentIdFor: async (_pid, txId) => liveFunds().find((f) => f.receiptTransactionRef === txId)?.paymentId ?? null,
    });
    expect(balance("sbi")).toBe(10_000);
    expect(liveFunds()).toHaveLength(0);
  });

  it("a next-month purpose stays reserved — AMMA does not owe less next month", async () => {
    await payments.recordPayment(person(), receipt());
    const oct = cycleContaining(d(10, 3));
    const nov = shiftCycle(oct, 1);
    const s = summary();
    expect(purposesDueIn(s, oct).map((v) => v.fund.title)).toEqual(["Pay AMMA's other loan", "KSEB bill"]);
    expect(purposesDueIn(s, nov).map((v) => v.fund.title)).toEqual(["Next month's bill"]);
    expect(person().currentBalance).toBe(0);
    expect(statement().advanceBalance).toBe(0);
  });

  it("overdue purposes sort first", async () => {
    await payments.recordPayment(person(), receipt());
    const s = summary(d(10, 12));
    expect(s.open[0]).toMatchObject({ overdue: true });
    expect(s.open[0].fund.title).toBe("Pay AMMA's other loan");
  });
});
