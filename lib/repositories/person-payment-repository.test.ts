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

import { AccountRepository } from "@/lib/repositories/account-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { PersonPaymentRepository, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { allocatePayment, advanceRemaining, drawAdvance, planAdvanceApplication, reconcilePayment } from "@/lib/engines/person-payment";
import { buildPersonCycleStatement, cycleContaining, shiftCycle, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { advanceSources, obligationSourceLabel, paymentLines, payableObligations, settlementProjection } from "@/features/people/lib/person-payment-obligations";
import { planEntryDeletion } from "@/lib/engines/person-ledger-deletion";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Expense } from "@/lib/models/expense";
import { isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";
import { round2 } from "@/lib/engines/person-payment";
import { computeLinkedFunds, linkedFundsForInstallment, linkedPendingForAccount } from "@/lib/engines/linked-funds";

const db = {};
const col = (path: string) => ({ path, firestore: db }) as never;
const U = "users/u";
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);
const SEP = cycleContaining(d(9, 20)); // 18 Sep – 17 Oct
const OCT = shiftCycle(SEP, 1); //        18 Oct – 17 Nov
const ALL: StatementCycle = { start: new Date(1970, 0, 1), end: shiftCycle(SEP, 3).end };

const audit = { deletedAt: null, lastEditedAt: null, editHistory: [] };

function setup() {
  store.clear();
  const accountRepository = new AccountRepository(col(`${U}/accounts`));
  const transactionRepository = new TransactionRepository(col(`${U}/transactions`), accountRepository);
  const personRepository = new PersonRepository(col(`${U}/people`));
  const ledgerRepository = new LedgerRepository(col(`${U}/people/amma/ledger`), personRepository);
  const payments = new PersonPaymentRepository({
    personRepository,
    ledgerRepository,
    transactionRepository,
    advanceApplications: col(`${U}/people/amma/advanceApplications`),
    expenseDocRef: (id) => ({ id, path: `${U}/expenses/${id}` }) as never,
    installmentDocRef: (s, i) => ({ id: i, path: `${U}/paymentSchedules/${s}/installments/${i}` }) as never,
    installmentPaymentDocRef: (s, i, p) => ({ id: p, path: `${U}/paymentSchedules/${s}/installments/${i}/payments/${p}` }) as never,
    cashLegCategoryId: "cat-people",
  });

  store.set(`${U}/accounts/sbi`, { id: "sbi", name: "SBI Savings", currentBalance: 10_000, ...audit } as Doc);
  store.set(`${U}/people/amma`, { id: "amma", name: "Amma", openingBalance: 0, currentBalance: 0, createdAt: d(1, 1), ...audit } as Doc);
  return { payments, ledgerRepository };
}

const person = () => store.get(`${U}/people/amma`) as unknown as Person;
const account = () => (store.get(`${U}/accounts/sbi`) as unknown as { currentBalance: number }).currentBalance;
const ledger = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/ledger/`)).map(([, v]) => v as unknown as LedgerEntry);
const applications = () =>
  [...store.entries()].filter(([k]) => k.startsWith(`${U}/people/amma/advanceApplications/`)).map(([, v]) => v as unknown as AdvanceApplication);
const transactions = () => [...store.entries()].filter(([k]) => k.startsWith(`${U}/transactions/`)).map(([, v]) => v as Doc);

// The EMI Amma repays me: installment #1 due 30 Sep ₹2,000 (and #2 due 30 Oct ₹1,200 — the "next cycle" obligation).
const phoneEmi = { id: "emi1", name: "Phone EMI", scheduleId: "sch-emi", beneficiaryPersonId: "amma", beneficiaryRepaysInstallments: true, isClosed: false, deletedAt: null };
const emiInst = (id: string, seq: number, due: Date, amount: number) => ({
  id, scheduleId: "sch-emi", sequenceNumber: seq, dueDate: due, amountDue: amount, amountPaid: 0, isSkipped: false, deletedAt: null, createdAt: d(9, 1),
});
let installments = [emiInst("i1", 1, d(9, 30), 2000)];

function seedKseb() {
  const kseb: LedgerEntry = {
    id: "kseb", personId: "amma", type: "gave", amount: 1000, date: d(9, 29), note: "KSEB bill", increasesBalance: true,
    transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 29), receivedStatus: "yetToReceive", ...audit,
  };
  store.set(`${U}/people/amma/ledger/kseb`, kseb as unknown as Doc);
  const p = person();
  store.set(`${U}/people/amma`, { ...p, currentBalance: p.currentBalance + 1000 } as unknown as Doc);
}

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

function rows(cycle: StatementCycle) {
  return buildLedgerRows({ statement: statement(cycle), history: statement(ALL), entries: ledger(), pending: [], advanceApplications: applications() });
}

/** What the Record Payment workspace would submit: automatic allocation over every open obligation. */
function paymentInput(cycle: StatementCycle, amount: number, extra: RecordPaymentInput["extra"] = null, date = d(10, 2)): RecordPaymentInput {
  const obligations = payableObligations(rows(cycle)).filter((o) => o.side === "theyOwe");
  const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount });
  return { direction: "theyPaid", amount, date, accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra };
}

/**
 * Every rupee has one meaning: the cached ledger balance plus the derived EMI obligations (which live on
 * the EMI, never in the ledger — exactly `PersonPosition.emiReceivable`) equals pending + advance.
 */
function expectConsistent() {
  const s = statement(ALL);
  const emiObligations = s.rows.filter((r) => r.kind === "obligation" && r.category === "emi").reduce((sum, r) => sum + r.signedAmount, 0);
  expect(person().currentBalance + emiObligations).toBeCloseTo(s.currentPending + s.advanceBalance, 2);
}

describe("Record Payment — AMMA (KSEB ₹1,000 + EMI ₹2,000)", () => {
  let payments: PersonPaymentRepository;
  beforeEach(() => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    ({ payments } = setup());
    seedKseb();
  });

  it("starts with ₹3,000 outstanding this cycle", () => {
    const s = statement(SEP);
    expect(s.previousPending).toBe(0);
    expect(s.cycleActivity).toBe(3000);
    expect(s.currentPending).toBe(3000);
    expect(payableObligations(rows(SEP)).map((o) => [o.title, o.outstanding])).toEqual([
      ["KSEB bill", 1000],
      ["Phone EMI", 2000],
    ]);
  });

  it("Case A — pays ₹3,000: both settled, pending ₹0, no advance, one cash movement", async () => {
    await payments.recordPayment(person(), paymentInput(SEP, 3000));
    const s = statement(SEP);
    expect(s.cashReceived).toBe(3000);
    expect(s.currentPending).toBe(0);
    expect(s.advanceBalance).toBe(0);
    expect(account()).toBe(13_000);
    expect(transactions()).toHaveLength(1); // one real payment = one account movement
    const r = rows(SEP).filter((x) => x.statementRow?.kind === "obligation");
    expect(r.map((x) => [x.title, x.paid, x.remaining, x.state])).toEqual([
      ["Phone EMI", 2000, 0, "settled"],
      ["KSEB bill", 1000, 0, "settled"],
    ]);
    expectConsistent();
  });

  it("Case B — pays ₹2,500: oldest first — KSEB settled, EMI partially paid, pending ₹500", async () => {
    await payments.recordPayment(person(), paymentInput(SEP, 2500));
    const s = statement(SEP);
    expect(s.cashReceived).toBe(2500);
    expect(s.currentPending).toBe(500);
    const byTitle = Object.fromEntries(rows(SEP).filter((x) => x.statementRow?.kind === "obligation").map((x) => [x.title, x]));
    expect([byTitle["KSEB bill"].paid, byTitle["KSEB bill"].remaining, byTitle["KSEB bill"].state]).toEqual([1000, 0, "settled"]);
    expect([byTitle["Phone EMI"].paid, byTitle["Phone EMI"].remaining, byTitle["Phone EMI"].state]).toEqual([1500, 500, "partial"]);
    // Next cycle: the ₹500 is carried forward, not re-created as a new transaction.
    const oct = statement(OCT);
    expect(oct.previousPending).toBe(500);
    expect(oct.rows.filter((r) => r.kind === "obligation")).toHaveLength(0);
    expectConsistent();
  });

  it("Case C — pays ₹5,000: ₹3,000 settles, the extra ₹2,000 is never silently classified", async () => {
    const obligations = payableObligations(rows(SEP));
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 5000 });
    expect([alloc.allocated, alloc.extra, alloc.outcome]).toEqual([3000, 2000, "over"]);
    // Without a choice for the extra, the payment can't be recorded.
    await expect(payments.recordPayment(person(), paymentInput(SEP, 5000, null))).rejects.toThrow(/allocated or explicitly classified/);
    expect(account()).toBe(10_000);

    // "Keep as advance".
    await payments.recordPayment(person(), paymentInput(SEP, 5000, { kind: "advance", amount: 2000 }));
    const s = statement(SEP);
    expect(s.currentPending).toBe(0);
    expect(s.advanceBalance).toBe(-2000); // they paid me ahead: ₹2,000 held for Amma
    expect(s.cashReceived).toBe(5000);
    expect(account()).toBe(15_000);
    expect(transactions()).toHaveLength(1); // advance is part of the same People receipt — not income
    expect(transactions()[0].type).toBe("income");
    expect(transactions()[0].isPersonLedgerMovement).toBe(true);
    expectConsistent();

    // Next cycle: a new ₹1,200 obligation. Advance is available but not applied until confirmed.
    installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
    let oct = statement(OCT);
    expect([oct.previousPending, oct.previousAdvance, oct.currentPending]).toEqual([0, -2000, 1200]);

    const available = advanceRemaining(advanceSources(ledger()), applications());
    await payments.applyAdvance(person(), { targets: [{ obligationKey: "emi-inst:i2", uses: drawAdvance(available, "theyOwe", 1200) }], date: d(10, 30) });
    oct = statement(OCT);
    expect(oct.currentPending).toBe(0);
    expect(oct.advanceBalance).toBe(-800);
    expect(oct.cashReceived).toBe(0); // applying advance moves no money
    expect(account()).toBe(15_000);
    const inst2 = rows(OCT).find((r) => r.key === "emi-inst:i2")!;
    expect([inst2.paid, inst2.remaining, inst2.state]).toEqual([1200, 0, "settled"]);
    expect(inst2.payments.map((p) => [p.source, p.amount])).toEqual([["advance", 1200]]);
    expectConsistent();

    // Can't apply more than what is left.
    expect(() => drawAdvance(advanceRemaining(advanceSources(ledger()), applications()), "theyOwe", 900)).toThrow(/Not enough advance/);
  });

  it("edit payment ₹600 → ₹500 recalculates cash, allocation, remaining and balance together", async () => {
    const id = await payments.recordPayment(person(), paymentInput(SEP, 600));
    expect(rows(SEP).find((r) => r.title === "KSEB bill")!.remaining).toBe(400);
    expect(account()).toBe(10_600);

    const obligations = payableObligations(rows(SEP)); // KSEB 400 open + EMI 2,000
    const edited = { direction: "theyPaid" as const, amount: 500, date: d(10, 2), accountId: "sbi", extra: null, lines: paymentLines(obligations, [{ key: "ledger:kseb", amount: 500 }]) };
    // The KSEB line was 600 before; reverting in the same transaction frees it, so ₹500 fits.
    edited.lines[0].amount = 500;
    await payments.editPayment(person(), id, edited);

    const kseb = rows(SEP).find((r) => r.title === "KSEB bill")!;
    expect([kseb.paid, kseb.remaining, kseb.state]).toEqual([500, 500, "partial"]);
    expect(account()).toBe(10_500);
    expect(transactions().filter((t) => t.deletedAt == null)).toHaveLength(1);
    expect(statement(SEP).currentPending).toBe(2500);
    expectConsistent();
  });

  it("revert restores exactly the previous state: unpaid, balance, account", async () => {
    const before = { pending: statement(SEP).currentPending, account: account(), balance: person().currentBalance };
    const id = await payments.recordPayment(person(), paymentInput(SEP, 5000, { kind: "advance", amount: 2000 }));
    installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
    await payments.applyAdvance(person(), { targets: [{ obligationKey: "emi-inst:i2", uses: drawAdvance(advanceRemaining(advanceSources(ledger()), applications()), "theyOwe", 1200) }], date: d(10, 30) });

    await payments.revertPayment(person(), id);
    expect(statement(SEP).currentPending).toBe(before.pending);
    expect(account()).toBe(before.account);
    expect(person().currentBalance).toBe(before.balance);
    // The advance application drawn from the reverted advance goes with it — the ₹1,200 is open again.
    expect(rows(OCT).find((r) => r.key === "emi-inst:i2")!.remaining).toBe(1200);
    expect(statement(ALL).advanceBalance).toBe(0);
    expect(rows(SEP).filter((r) => r.state != null).every((r) => r.state === "open")).toBe(true);
    expectConsistent();
    await expect(payments.revertPayment(person(), id)).rejects.toThrow();
  });

  it("an obligation paid by a recorded payment can't be deleted until the payment is reverted", async () => {
    const id = await payments.recordPayment(person(), paymentInput(SEP, 1000));
    expect(planEntryDeletion("kseb", ledger())).toEqual({ ok: false, reason: "payment" });
    const paymentEntry = ledger().find((e) => e.paymentId === id)!;
    expect(planEntryDeletion(paymentEntry.id, ledger())).toEqual({ ok: false, reason: "payment" });
    await payments.revertPayment(person(), id);
    expect(planEntryDeletion("kseb", ledger()).ok).toBe(true);
  });

  it("source obligation deleted elsewhere: advance applied to it becomes available again (never stranded)", async () => {
    await payments.recordPayment(person(), paymentInput(SEP, 5000, { kind: "advance", amount: 2000 }));
    installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
    await payments.applyAdvance(person(), { targets: [{ obligationKey: "emi-inst:i2", uses: drawAdvance(advanceRemaining(advanceSources(ledger()), applications()), "theyOwe", 1200) }], date: d(10, 30) });
    expect(statement(ALL).advanceBalance).toBe(-800);
    installments = installments.filter((i) => i.id !== "i2"); // EMI installment removed at the source
    expect(statement(ALL).advanceBalance).toBe(-2000);
    expectConsistent();
  });

  it("extra recorded as income: one receipt, split into the settlement and a separate Income — never both", async () => {
    await payments.recordPayment(person(), paymentInput(SEP, 5000, { kind: "income", amount: 2000, categoryId: "cat-gift", description: "Gift" }));
    const s = statement(SEP);
    expect(s.currentPending).toBe(0);
    expect(s.advanceBalance).toBe(0);
    expect(s.cashReceived).toBe(3000); // only the settlement is a People receipt
    expect(account()).toBe(15_000); // the account still received all ₹5,000 — once
    const live = transactions().filter((t) => t.deletedAt == null);
    expect(live.map((t) => [t.amount, t.isPersonLedgerMovement, t.categoryId])).toEqual(
      expect.arrayContaining([
        [3000, true, "cat-people"],
        [2000, false, "cat-gift"],
      ]),
    );
    expectConsistent();
  });

  it("I paid them: the account decreases and only what I owe can be settled", async () => {
    const borrowed: LedgerEntry = {
      id: "loan-from-amma", personId: "amma", type: "borrowed", amount: 800, date: d(9, 25), note: "Cash from Amma", increasesBalance: true,
      transactionRef: null, parentEntryId: null, sourceKind: "manual", obligationRef: null, createdAt: d(9, 25), receivedStatus: "yetToReceive", ...audit,
    };
    store.set(`${U}/people/amma/ledger/${borrowed.id}`, borrowed as unknown as Doc);
    store.set(`${U}/people/amma`, { ...person(), currentBalance: person().currentBalance - 800 } as unknown as Doc);

    const obligations = payableObligations(rows(SEP)).filter((o) => o.side === "iOwe");
    expect(obligations.map((o) => o.title)).toEqual(["Cash from Amma"]);
    const alloc = allocatePayment({ obligations, selectedKeys: ["ledger:loan-from-amma"], amount: 800 });
    await payments.recordPayment(person(), { direction: "iPaid", amount: 800, date: d(10, 1), accountId: "sbi", extra: null, lines: paymentLines(obligations, alloc.lines) });
    expect(account()).toBe(9_200);
    expect(rows(SEP).find((r) => r.key === "ledger:loan-from-amma")!.state).toBe("settled");
    expect(statement(SEP).cashPaid).toBe(800);
    expectConsistent();
  });
});

describe("Record Payment — split-expense share", () => {
  it("writes the expense's installment payment and marks the share received; revert reverses both", async () => {
    const { payments } = setup();
    const installment: Installment = {
      id: "si1", scheduleId: "sch-split", ownerType: "splitExpense", ownerId: "exp1", sequenceNumber: 1, dueDate: d(9, 25), amountDue: 1500,
      amountPaid: 0, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: d(9, 25), ...audit,
    };
    store.set(`${U}/paymentSchedules/sch-split/installments/si1`, installment as unknown as Doc);
    const participant = { personId: "amma", name: "Amma", isMe: false, shareAmount: 1500, installmentId: "si1", receivedStatus: "yetToReceive" };
    store.set(`${U}/expenses/exp1`, { id: "exp1", transactionId: "tx-exp1", description: "Dinner", participants: [participant], ...audit } as unknown as Doc);
    const share: LedgerEntry = {
      id: "share", personId: "amma", type: "gave", amount: 1500, date: d(9, 25), note: "Split: Dinner", increasesBalance: true,
      transactionRef: "tx-exp1", parentEntryId: null, sourceKind: "splitExpense", obligationRef: null, createdAt: d(9, 25), receivedStatus: "yetToReceive", ...audit,
    };
    store.set(`${U}/people/amma/ledger/share`, share as unknown as Doc);
    store.set(`${U}/people/amma`, { ...person(), currentBalance: 1500 } as unknown as Doc);

    const pending = [{ expense: store.get(`${U}/expenses/exp1`) as unknown as Expense, participant, installment }] as never;
    const splitRows = () => buildLedgerRows({ statement: statement(SEP), history: statement(ALL), entries: ledger(), pending, advanceApplications: applications() });
    const obligations = payableObligations(splitRows());
    expect(obligations.map((o) => o.key)).toContain("ledger:share");

    const id = await payments.recordPayment(person(), {
      direction: "theyPaid", amount: 1500, date: d(9, 28), accountId: "sbi", extra: null,
      lines: paymentLines(obligations, [{ key: "ledger:share", amount: 1500 }]),
    });
    const inst = () => store.get(`${U}/paymentSchedules/sch-split/installments/si1`) as unknown as Installment;
    const status = () => (store.get(`${U}/expenses/exp1`) as unknown as Expense).participants[0].receivedStatus;
    expect(inst().amountPaid).toBe(1500);
    expect(status()).toBe("received");
    expect(splitRows().find((r) => r.key === "ledger:share")!.state).toBe("settled");
    expect(account()).toBe(11_500);

    await payments.revertPayment(person(), id);
    expect(inst().amountPaid).toBe(0);
    expect(status()).toBe("yetToReceive");
    expect(account()).toBe(10_000);
    expect(person().currentBalance).toBe(1500);
  });
});

/**
 * Overpayment / advance edge cases. Each case asserts the receipt reconciles (received = allocated +
 * advance + income + unallocated), the account moves once, and the statement/rows agree after a
 * "reload" (every figure is re-derived from the stored documents).
 */
describe("Record Payment — overpayment and advance", () => {
  let payments: PersonPaymentRepository;
  beforeEach(() => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    ({ payments } = setup());
    seedKseb();
  });

  /** What the workspace would submit: oldest-first over the chosen keys, extra resolved as given. */
  function submit(amount: number, keys: string[] | null, extraKind: "advance" | "income" | null, manual?: Record<string, number>, cycle = SEP) {
    const obligations = payableObligations(rows(cycle)).filter((o) => o.side === "theyOwe");
    const alloc = allocatePayment({ obligations, selectedKeys: keys ?? obligations.map((o) => o.key), amount, manual });
    const extra: RecordPaymentInput["extra"] =
      alloc.extra > 0 && extraKind === "advance"
        ? { kind: "advance", amount: alloc.extra }
        : alloc.extra > 0 && extraKind === "income"
          ? { kind: "income", amount: alloc.extra, categoryId: "cat-gift", description: "Extra amount from Amma" }
          : null;
    const recon = reconcilePayment({
      received: amount,
      allocated: alloc.allocated,
      advance: extra?.kind === "advance" ? extra.amount : 0,
      income: extra?.kind === "income" ? extra.amount : 0,
    });
    return { alloc, recon, input: { direction: "theyPaid" as const, amount, date: d(10, 2), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra } };
  }
  const liveTx = () => transactions().filter((t) => t.deletedAt == null);
  const available = () => advanceRemaining(advanceSources(ledger()), applications());
  const applyPlan = (cycle: StatementCycle, keys: string[]) =>
    planAdvanceApplication({ available: available(), obligations: payableObligations(rows(cycle)), side: "theyOwe", selectedKeys: keys });

  it("1 — due ₹3,000 / received ₹3,000: exact settlement, nothing extra", async () => {
    const { alloc, recon, input } = submit(3000, null, null);
    expect([alloc.allocated, alloc.extra, alloc.outcome]).toEqual([3000, 0, "full"]);
    expect(recon.balanced).toBe(true);
    await payments.recordPayment(person(), input);
    expect([statement(SEP).currentPending, statement(SEP).advanceBalance, account()]).toEqual([0, 0, 13_000]);
  });

  it("2 — due ₹3,000 / received ₹2,000: partial, ₹1,000 remains", async () => {
    const { alloc, input } = submit(2000, null, null);
    expect([alloc.allocated, alloc.unpaid, alloc.outcome]).toEqual([2000, 1000, "partial"]);
    await payments.recordPayment(person(), input);
    expect(statement(SEP).currentPending).toBe(1000);
    expect(statement(SEP).advanceBalance).toBe(0);
    expectConsistent();
  });

  it("3 — due ₹3,000 / received ₹3,200: ₹3,000 settled + ₹200 advance, ONE ₹3,200 cash movement", async () => {
    const { alloc, recon, input } = submit(3200, null, "advance");
    expect([alloc.allocated, alloc.extra, alloc.outcome]).toEqual([3000, 200, "over"]);
    expect(recon).toMatchObject({ received: 3200, allocated: 3000, advance: 200, income: 0, unallocated: 0, balanced: true });
    await payments.recordPayment(person(), input);
    expect(liveTx()).toHaveLength(1);
    expect(liveTx()[0]).toMatchObject({ amount: 3200, isPersonLedgerMovement: true });
    expect(account()).toBe(13_200);
    const s = statement(SEP);
    expect([s.currentPending, s.advanceBalance, s.cashReceived]).toEqual([0, -200, 3200]);
    // Settlements and the advance share one paymentId and the one cash leg — auditable back to the receipt.
    const adv = ledger().find((e) => e.sourceKind === "advance")!;
    const group = ledger().filter((e) => e.paymentId === adv.paymentId);
    expect(group).toHaveLength(3);
    expect(new Set(group.map((e) => e.transactionRef))).toEqual(new Set([liveTx()[0].id]));
    expectConsistent();
  });

  it("4/11 — due ₹3,000 / received ₹5,000: ₹2,000 advance carried across cycles untouched", async () => {
    await payments.recordPayment(person(), submit(5000, null, "advance").input);
    const oct = statement(OCT);
    const nov = statement(shiftCycle(OCT, 1));
    expect([oct.previousAdvance, oct.advanceBalance]).toEqual([-2000, -2000]);
    expect([nov.previousAdvance, nov.advanceBalance]).toEqual([-2000, -2000]);
    // A cycle change creates no rows, no transactions, no income.
    expect(oct.rows).toHaveLength(0);
    expect(nov.rows).toHaveLength(0);
    expect(liveTx()).toHaveLength(1);
  });

  it("5 — ₹2,000 advance + ₹2,500 new obligation: apply ₹2,000, ₹500 remains due", async () => {
    await payments.recordPayment(person(), submit(5000, null, "advance").input);
    installments = [...installments, emiInst("i2", 2, d(10, 30), 2500)];
    expect(statement(OCT).currentPending).toBe(2500); // advance is NOT consumed on its own
    const plan = applyPlan(OCT, ["emi-inst:i2"]);
    expect([plan.availableTotal, plan.allocation.allocated, plan.allocation.unpaid, plan.error]).toEqual([2000, 2000, 500, null]);
    await payments.applyAdvance(person(), { targets: plan.targets, date: d(10, 30) });
    const oct = statement(OCT);
    expect([oct.currentPending, oct.advanceBalance, oct.cashReceived]).toEqual([500, 0, 0]);
    expect(account()).toBe(15_000); // applying advance moves no money
    const inst2 = rows(OCT).find((r) => r.key === "emi-inst:i2")!;
    expect([inst2.paid, inst2.remaining, inst2.state]).toEqual([2000, 500, "partial"]);
    expectConsistent();
  });

  it("6 — an advance is never income: one People receipt, no Income transaction", async () => {
    await payments.recordPayment(person(), submit(3200, null, "advance").input);
    expect(liveTx().filter((t) => !t.isPersonLedgerMovement)).toHaveLength(0);
  });

  it("7 — extra explicitly recorded as income: ₹3,000 People receipt + ₹200 Income, account +₹3,200 once", async () => {
    const { recon, input } = submit(3200, null, "income");
    expect(recon).toMatchObject({ allocated: 3000, advance: 0, income: 200, balanced: true });
    const id = await payments.recordPayment(person(), input);
    expect(account()).toBe(13_200);
    const byLeg = Object.fromEntries(liveTx().map((t) => [t.isPersonLedgerMovement ? "people" : "income", [t.amount, t.type, t.categoryId]]));
    expect(byLeg).toEqual({ people: [3000, "income", "cat-people"], income: [200, "income", "cat-gift"] });
    expect(statement(SEP).advanceBalance).toBe(0);
    // Reverting removes both — the income never outlives its receipt.
    await payments.revertPayment(person(), id);
    expect(liveTx()).toHaveLength(0);
    expect(account()).toBe(10_000);
  });

  it("8 — extra applied to another outstanding item (next EMI) instead of held", async () => {
    installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
    const { alloc, input } = submit(3200, ["ledger:kseb", "emi-inst:i1", "emi-inst:i2"], null, undefined, ALL);
    expect([alloc.allocated, alloc.extra]).toEqual([3200, 0]);
    await payments.recordPayment(person(), input);
    const inst2 = rows(OCT).find((r) => r.key === "emi-inst:i2")!;
    expect([inst2.paid, inst2.remaining]).toEqual([200, 1000]);
    expect(statement(ALL).advanceBalance).toBe(0);
    expect(liveTx()).toHaveLength(1);
    expectConsistent();
  });

  it("10 — partial EMI allocation by hand: ₹1,000 KSEB + ₹1,200 of the EMI, ₹800 stays open", async () => {
    const { alloc, input } = submit(2200, null, null, { "ledger:kseb": 1000, "emi-inst:i1": 1200 });
    expect([alloc.allocated, alloc.extra, alloc.unpaid]).toEqual([2200, 0, 800]);
    await payments.recordPayment(person(), input);
    const emi = rows(SEP).find((r) => r.key === "emi-inst:i1")!;
    expect([emi.paid, emi.remaining, emi.state]).toEqual([1200, 800, "partial"]);
  });

  it("13 — undoing a later advance application reopens the obligation and restores the advance; no money moves", async () => {
    await payments.recordPayment(person(), submit(5000, null, "advance").input);
    installments = [...installments, emiInst("i2", 2, d(10, 30), 2500)];
    await payments.applyAdvance(person(), { targets: applyPlan(OCT, ["emi-inst:i2"]).targets, date: d(10, 30) });
    await payments.removeAdvanceApplications(applications());
    expect(statement(OCT).currentPending).toBe(2500);
    expect(statement(ALL).advanceBalance).toBe(-2000);
    expect(account()).toBe(15_000);
    expectConsistent();
  });

  it("applying advance is all-or-nothing across obligations and can never over-draw", async () => {
    await payments.recordPayment(person(), submit(3200, null, "advance").input);
    installments = [...installments, emiInst("i2", 2, d(10, 30), 150), emiInst("i3", 3, d(11, 30), 150)];
    const plan = applyPlan(ALL, ["emi-inst:i2", "emi-inst:i3"]);
    expect(plan.targets.map((t) => [t.obligationKey, t.uses[0].amount])).toEqual([
      ["emi-inst:i2", 150],
      ["emi-inst:i3", 50],
    ]);
    await payments.applyAdvance(person(), { targets: plan.targets, date: d(10, 30) });
    // A stale screen replays the same plan: rejected inside the transaction, nothing written.
    await expect(payments.applyAdvance(person(), { targets: plan.targets, date: d(10, 30) })).rejects.toThrow(/Not enough advance/);
    expect(applications().filter((a) => a.deletedAt == null)).toHaveLength(2);
    expect(statement(ALL).advanceBalance).toBe(0);
  });

  it("12 — reverting the receipt undoes settlement, advance and the later application together", async () => {
    const id = await payments.recordPayment(person(), submit(3200, null, "advance").input);
    installments = [...installments, emiInst("i2", 2, d(10, 30), 1200)];
    await payments.applyAdvance(person(), { targets: applyPlan(OCT, ["emi-inst:i2"]).targets, date: d(10, 30) });
    await payments.revertPayment(person(), id);
    expect(statement(SEP).currentPending).toBe(3000);
    expect(statement(OCT).currentPending).toBe(4200);
    expect(statement(ALL).advanceBalance).toBe(0);
    expect(account()).toBe(10_000);
    expect(liveTx()).toHaveLength(0);
    expect(applications().every((a) => a.deletedAt != null)).toBe(true);
    expectConsistent();
  });

  it("17 — ₹1 overpayment stays fully auditable as advance", async () => {
    const { alloc, recon, input } = submit(3001, null, "advance");
    expect([alloc.extra, recon.advance, recon.balanced]).toEqual([1, 1, true]);
    await payments.recordPayment(person(), input);
    expect(statement(ALL).advanceBalance).toBe(-1);
    expect(account()).toBe(13_001);
    expect(ledger().find((e) => e.sourceKind === "advance")!.amount).toBe(1);
  });

  it("an extra without a decision is rejected — money never disappears", async () => {
    const { recon, input } = submit(3200, null, null);
    expect(recon).toMatchObject({ unallocated: 200, balanced: false });
    await expect(payments.recordPayment(person(), input)).rejects.toThrow(/explicitly classified/);
    expect(account()).toBe(10_000);
  });
});

describe("Record Payment — mixed obligation types in one receipt", () => {
  it("9 — manual + EMI + split share settled by one ₹4,700 payment (₹200 advance); revert reverses all", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    const { payments } = setup();
    seedKseb();
    const installment: Installment = {
      id: "si1", scheduleId: "sch-split", ownerType: "splitExpense", ownerId: "exp1", sequenceNumber: 1, dueDate: d(9, 25), amountDue: 1500,
      amountPaid: 0, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: d(9, 25), ...audit,
    };
    store.set(`${U}/paymentSchedules/sch-split/installments/si1`, installment as unknown as Doc);
    const participant = { personId: "amma", name: "Amma", isMe: false, shareAmount: 1500, installmentId: "si1", receivedStatus: "yetToReceive" };
    store.set(`${U}/expenses/exp1`, { id: "exp1", transactionId: "tx-exp1", description: "Dinner", participants: [participant], ...audit } as unknown as Doc);
    store.set(`${U}/people/amma/ledger/share`, {
      id: "share", personId: "amma", type: "gave", amount: 1500, date: d(9, 25), note: "Split: Dinner", increasesBalance: true,
      transactionRef: "tx-exp1", parentEntryId: null, sourceKind: "splitExpense", obligationRef: null, createdAt: d(9, 25), receivedStatus: "yetToReceive", ...audit,
    } as unknown as Doc);
    store.set(`${U}/people/amma`, { ...person(), currentBalance: person().currentBalance + 1500 } as unknown as Doc);
    const pending = [{ expense: store.get(`${U}/expenses/exp1`) as unknown as Expense, participant, installment }] as never;
    const mixedRows = () => buildLedgerRows({ statement: statement(SEP), history: statement(ALL), entries: ledger(), pending, advanceApplications: applications() });
    const splitPaid = () => (store.get(`${U}/paymentSchedules/sch-split/installments/si1`) as unknown as Installment).amountPaid;

    const obligations = payableObligations(mixedRows());
    expect(obligations.map((o) => o.key).sort()).toEqual(["emi-inst:i1", "ledger:kseb", "ledger:share"]);
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 4700 });
    expect([alloc.allocated, alloc.extra]).toEqual([4500, 200]);
    const id = await payments.recordPayment(person(), {
      direction: "theyPaid", amount: 4700, date: d(10, 2), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra: { kind: "advance", amount: 200 },
    });
    expect(transactions().filter((t) => t.deletedAt == null)).toHaveLength(1);
    expect(account()).toBe(14_700);
    expect(splitPaid()).toBe(1500);
    expect(statement(SEP).currentPending).toBe(0);
    expect(statement(SEP).advanceBalance).toBe(-200);

    await payments.revertPayment(person(), id);
    expect(account()).toBe(10_000);
    expect(splitPaid()).toBe(0);
    expect(statement(SEP).currentPending).toBe(4500);
    expect(statement(ALL).advanceBalance).toBe(0);
  });
});

/**
 * Record Payment reads ONE obligation projection (`settlementProjection`) over the same ledger rows the
 * statement produces — so every open obligation is either selectable or listed as settled elsewhere.
 */
describe("Record Payment — every eligible obligation, not only EMIs", () => {
  let payments: PersonPaymentRepository;
  const tracked = new Set<string>(); // no split/assigned share tracked by an installment unless a test adds one

  function seedEntry(id: string, type: "gave" | "borrowed", amount: number, date: Date, extra: Partial<LedgerEntry> = {}) {
    const e = {
      id, personId: "amma", type, amount, date, note: id, increasesBalance: true, transactionRef: null, parentEntryId: null,
      sourceKind: "manual", obligationRef: null, createdAt: date, receivedStatus: "yetToReceive", ...audit, ...extra,
    } as LedgerEntry;
    store.set(`${U}/people/amma/ledger/${id}`, e as unknown as Doc);
    const p = person();
    store.set(`${U}/people/amma`, { ...p, currentBalance: p.currentBalance + (type === "gave" ? amount : -amount) } as unknown as Doc);
  }
  const projRows = (cycle = SEP, pending: never[] = []) =>
    buildLedgerRows({ statement: statement(cycle), history: statement(ALL), entries: ledger(), pending, advanceApplications: applications(), trackedShareRefs: tracked });
  const project = (cycle = SEP) => settlementProjection(buildLedgerRows({ statement: statement(ALL), entries: ledger(), pending: [], advanceApplications: applications(), trackedShareRefs: tracked }), cycle);

  beforeEach(() => {
    installments = [emiInst("i1", 1, d(9, 30), 1667), emiInst("i2", 2, d(10, 30), 1667), emiInst("i3", 3, d(11, 30), 1667)];
    ({ payments } = setup());
    tracked.clear();
    seedKseb(); // KSEB ₹1,000 (manual "gave"), 29 Sep
  });

  it("1/4/6 — manual, legacy person-linked and EMI obligations all appear together; later EMIs are 'later'", () => {
    // A "gave" linked to a normal (non-People) transaction — previously dropped from Record Payment.
    seedEntry("legacy", "gave", 500, d(10, 10), { transactionRef: "tx-normal-expense" });
    const { payable, elsewhere } = project();
    expect(payable.map((o) => [o.key, o.outstanding, o.timing])).toEqual([
      ["ledger:kseb", 1000, "cycle"],
      ["emi-inst:i1", 1667, "cycle"],
      ["ledger:legacy", 500, "cycle"],
      ["emi-inst:i2", 1667, "later"],
      ["emi-inst:i3", 1667, "later"],
    ]);
    expect(elsewhere).toEqual([]);
    expect(obligationSourceLabel(payable[0], "Amma")).toBe("Money you gave Amma");
    expect(obligationSourceLabel(payable[1], "Amma")).toBe("EMI installment");
  });

  it("7 — opening balance (previous pending) is settleable and reconciles; revert reopens it", async () => {
    store.set(`${U}/people/amma`, { ...person(), openingBalance: 300, currentBalance: person().currentBalance + 300 } as unknown as Doc);
    const withOpening = () =>
      buildPersonCycleStatement({
        person: { id: "amma", name: "Amma", openingBalance: 300, createdAt: d(1, 1) }, ledgerEntries: ledger(), loanIds: new Set(), emis: [phoneEmi], loans: [],
        installments, cycle: ALL, now: d(10, 1), advanceApplications: applications(),
      });
    const rowsNow = () => buildLedgerRows({ statement: withOpening(), entries: ledger(), pending: [], advanceApplications: applications(), trackedShareRefs: tracked });
    const opening = settlementProjection(rowsNow(), SEP).payable.find((o) => o.key === "opening:amma")!;
    expect([opening.outstanding, opening.timing, obligationSourceLabel(opening, "Amma")]).toEqual([300, "carried", "Previous pending"]);

    const obligations = settlementProjection(rowsNow(), SEP).payable.filter((o) => o.timing !== "later");
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 2967 });
    expect([alloc.allocated, alloc.extra, alloc.unpaid]).toEqual([2967, 0, 0]);
    const id = await payments.recordPayment(person(), { direction: "theyPaid", amount: 2967, date: d(10, 2), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra: null });
    expect(rowsNow().find((r) => r.key === "opening:amma")!.state).toBe("settled");
    expect(transactions().filter((t) => t.deletedAt == null)).toHaveLength(1); // 21: one cash movement for 3 obligations
    await payments.revertPayment(person(), id);
    expect(rowsNow().find((r) => r.key === "opening:amma")!.remaining).toBe(300);
    expect(account()).toBe(10_000);
  });

  it("3 — a split/assigned share with no tracking installment settles as a ledger settlement; unknown tracking stays conservative", () => {
    seedEntry("assigned", "gave", 1000, d(9, 29), { sourceKind: "assignedExpense", transactionRef: "tx-kseb" });
    const row = () => projRows().find((r) => r.key === "ledger:assigned")!;
    expect(row().settle?.kind).toBe("entry");
    expect(obligationSourceLabel(payableObligations(projRows()).find((o) => o.key === "ledger:assigned")!, "Amma")).toBe("You paid for Amma");
    // Installment tracking exists but isn't loaded/open → not settled here (would desync the expense).
    tracked.add("tx-kseb");
    expect(row().settle).toBeNull();
    const rowsUnknown = buildLedgerRows({ statement: statement(SEP), entries: ledger(), pending: [] });
    expect(rowsUnknown.find((r) => r.key === "ledger:assigned")!.settle).toBeNull();
    // ...and it is then listed as outstanding elsewhere, so the totals still reconcile.
    expect(project().elsewhere.map((e) => e.key)).toEqual(["ledger:assigned"]);
  });

  it("5 — a person-counterparty Loan installment is listed with its reason (paid on the Loan), never silently dropped", () => {
    const loan = { id: "loan1", personId: "amma", direction: "given", scheduleId: "sch-loan", name: "Hand loan", isClosed: false, deletedAt: null };
    const s = buildPersonCycleStatement({
      person: { id: "amma", name: "Amma", openingBalance: 0, createdAt: d(1, 1) }, ledgerEntries: ledger(), loanIds: new Set(["loan1"]), emis: [phoneEmi],
      loans: [loan] as never, installments: [...installments, { ...emiInst("L1", 1, d(10, 5), 800), scheduleId: "sch-loan" }], cycle: ALL, now: d(10, 1),
    });
    const { elsewhere } = settlementProjection(buildLedgerRows({ statement: s, entries: ledger(), pending: [] }), SEP);
    expect(elsewhere.map((e) => [e.key, e.outstanding, e.loanId])).toEqual([["loan-inst:L1", 800, "loan1"]]);
    expect(elsewhere[0].reason).toMatch(/paid on the Loan/);
  });

  it("CRITICAL — statement outstanding = selectable + elsewhere, per side", () => {
    seedEntry("legacy", "gave", 500, d(10, 10), { transactionRef: "tx-normal-expense" });
    seedEntry("assigned", "gave", 1000, d(9, 29), { sourceKind: "assignedExpense", transactionRef: "tx-kseb" });
    tracked.add("tx-kseb");
    const s = statement(ALL);
    const { payable, elsewhere } = project();
    const sum = (xs: { outstanding: number; side: string }[]) => xs.filter((x) => x.side === "theyOwe").reduce((a, x) => a + x.outstanding, 0);
    expect(sum(payable) + sum(elsewhere)).toBeCloseTo(s.currentPending, 2);
  });

  it("8/9/10 — select one; mixed partial/full: ₹2,000 → KSEB paid in full, EMI ₹667 left, money given still pending", async () => {
    seedEntry("given", "gave", 500, d(10, 10));
    const obligations = project().payable.filter((o) => o.timing !== "later");
    // Select only one.
    expect(allocatePayment({ obligations, selectedKeys: ["ledger:given"], amount: 500 }).lines.map((l) => l.key)).toEqual(["ledger:given"]);
    const alloc = allocatePayment({ obligations, selectedKeys: ["ledger:kseb", "emi-inst:i1"], amount: 2000 });
    await payments.recordPayment(person(), { direction: "theyPaid", amount: 2000, date: d(10, 12), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra: null });
    const byKey = Object.fromEntries(projRows(ALL).map((r) => [r.key, r]));
    expect([byKey["ledger:kseb"].state, byKey["emi-inst:i1"].state, byKey["emi-inst:i1"].remaining, byKey["ledger:given"].state]).toEqual(["settled", "partial", 667, "open"]);
    // 17/23: history stays linked, no duplicate primary rows.
    expect(byKey["emi-inst:i1"].payments.map((p) => p.amount)).toEqual([1000]);
    const keys = projRows(ALL).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("13 — I pay them: only what I owe is offered and the account goes down", async () => {
    seedEntry("borrowed", "borrowed", 700, d(10, 3));
    const iOwe = project().payable.filter((o) => o.side === "iOwe");
    expect(iOwe.map((o) => [o.key, obligationSourceLabel(o, "Amma")])).toEqual([["ledger:borrowed", "Money borrowed from Amma"]]);
    const alloc = allocatePayment({ obligations: iOwe, selectedKeys: ["ledger:borrowed"], amount: 700 });
    await payments.recordPayment(person(), { direction: "iPaid", amount: 700, date: d(10, 5), accountId: "sbi", lines: paymentLines(iOwe, alloc.lines), extra: null });
    expect(account()).toBe(9_300);
  });

  it("19/20 — cycle navigation: last cycle's open item becomes 'carried', next cycle's EMI becomes due", () => {
    const oct = project(OCT);
    expect(oct.payable.find((o) => o.key === "ledger:kseb")!.timing).toBe("carried");
    expect(oct.payable.find((o) => o.key === "emi-inst:i2")!.timing).toBe("cycle");
    expect(oct.payable.find((o) => o.key === "emi-inst:i3")!.timing).toBe("later");
  });

  it("12/24 — overpayment + advance across mixed items; revert leaves no orphan allocations", async () => {
    seedEntry("given", "gave", 500, d(10, 10));
    const obligations = project().payable.filter((o) => o.timing !== "later");
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 3500 });
    expect([alloc.allocated, alloc.extra]).toEqual([3167, 333]);
    const id = await payments.recordPayment(person(), {
      direction: "theyPaid", amount: 3500, date: d(10, 12), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra: { kind: "advance", amount: 333 },
    });
    expect(ledger().filter((e) => e.paymentId === id)).toHaveLength(4); // 3 allocations + 1 advance, one cash leg
    await payments.revertPayment(person(), id);
    expect(ledger().filter((e) => e.paymentId === id && e.deletedAt == null)).toHaveLength(0);
    expect(transactions().filter((t) => t.deletedAt == null)).toHaveLength(0);
    expect(account()).toBe(10_000);
  });
});

/**
 * People repayment ≠ income. Three facts stay separate: the cash receipt (moves the account once), the
 * People settlement (reduces what Amma owes) and the onward payment (card bill / lender EMI — changes
 * the external liability only when I actually pay it). Linked funds are derived from stable IDs only.
 */
describe("People repayment ≠ income — source-linked funds awaiting onward payment", () => {
  let payments: PersonPaymentRepository;
  let txRepo: TransactionRepository;
  let kseb: { id: string };
  const hdfc = () => (store.get(`${U}/accounts/hdfc`) as unknown as { currentBalance: number }).currentBalance;
  const liveTx = () => transactions().filter((t) => t.deletedAt == null) as unknown as Transaction[];
  /** The one income rule every total (Dashboard, Cash Flow, Analytics, Budgets, Month Cycle) applies. */
  const income = () => liveTx().filter((t) => t.type === "income" && !isNonIncomeExpenseMovement(t)).reduce((s, t) => s + t.amount, 0);
  const funds = () =>
    computeLinkedFunds({
      entries: ledger(),
      persons: [{ id: "amma", name: "Amma" }],
      transactions: liveTx(),
      creditCardAccountIds: new Set(["hdfc"]),
      emis: [phoneEmi],
      loans: [],
      installments,
    });
  const pendingInSbi = () => linkedPendingForAccount(funds(), "sbi").total;
  /** Record Payment's automatic allocation; the card share has no expense-side tracking installment. */
  function pay(amount: number, extra: RecordPaymentInput["extra"] = null): RecordPaymentInput {
    const r = buildLedgerRows({ statement: statement(SEP), history: statement(ALL), entries: ledger(), pending: [], advanceApplications: applications(), trackedShareRefs: new Set() });
    const obligations = payableObligations(r).filter((o) => o.side === "theyOwe");
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount });
    return { direction: "theyPaid", amount, date: d(10, 2), accountId: "sbi", lines: paymentLines(obligations, alloc.lines), extra };
  }

  async function seedCardKseb() {
    // HDFC card pays KSEB ₹1,000 for Amma: card liability +₹1,000, Amma owes +₹1,000.
    kseb = await txRepo.createTransaction({ type: "expense", amount: 1000, dateTime: d(9, 26), accountId: "hdfc", categoryId: "cat-util", description: "KSEB" });
    const share: LedgerEntry = {
      id: "kseb-share", personId: "amma", type: "gave", amount: 1000, date: d(9, 26), note: "KSEB", increasesBalance: true,
      transactionRef: kseb.id, parentEntryId: null, sourceKind: "assignedExpense", obligationRef: null, createdAt: d(9, 26), receivedStatus: "yetToReceive", ...audit,
    };
    store.set(`${U}/people/amma/ledger/kseb-share`, share as unknown as Doc);
    store.set(`${U}/people/amma`, { ...person(), currentBalance: person().currentBalance + 1000 } as unknown as Doc);
  }

  /** The authoritative lender payment result: SBI −₹amount and the installment's `amountPaid` — never a People entry. */
  async function payEmiFromSbi(amount: number) {
    await txRepo.createTransaction({ type: "expense", amount, dateTime: d(10, 5), accountId: "sbi", categoryId: "cat-emi", description: "Phone EMI" });
    installments = installments.map((i) => (i.id === "i1" ? { ...i, amountPaid: i.amountPaid + amount } : i));
  }

  beforeEach(() => {
    ({ payments } = setup());
    txRepo = new TransactionRepository(col(`${U}/transactions`), new AccountRepository(col(`${U}/accounts`)));
    store.set(`${U}/accounts/hdfc`, { id: "hdfc", name: "HDFC Card", openingBalance: 0, currentBalance: 0, ...audit } as Doc);
  });

  it("CASE A — credit card: reimbursement is not income, card liability stays until the card is paid", async () => {
    installments = [];
    await seedCardKseb();
    expect(hdfc()).toBe(-1000);
    expect(person().currentBalance).toBe(1000);

    await payments.recordPayment(person(), pay(1000));
    expect(account()).toBe(11_000);
    expect(person().currentBalance).toBe(0);
    expect(income()).toBe(0);
    expect(hdfc()).toBe(-1000); // the person reimbursing me does not pay my card
    const [f] = funds();
    expect(f).toMatchObject({
      title: "KSEB", amount: 1000, pendingAmount: 1000, status: "pending", receivedAccountId: "sbi",
      destination: { kind: "card", accountId: "hdfc", sourceTransactionId: kseb.id },
    });
    expect(pendingInSbi()).toBe(1000);

    // Pay the card bill from SBI: a transfer — a liability settlement, not a second expense.
    await txRepo.createTransferPair({ amount: 1000, dateTime: d(10, 10), sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer" });
    expect(account()).toBe(10_000);
    expect(hdfc()).toBe(0);
    expect(pendingInSbi()).toBe(0);
    expect(funds()[0].status).toBe("completed");
    expect(income()).toBe(0);
    // KSEB is the only counted expense — never recreated, and the card payment is not a second one.
    expect(liveTx().filter((t) => t.type === "expense" && !isNonIncomeExpenseMovement(t)).map((t) => t.id)).toEqual([kseb.id]);
    expect(person().currentBalance).toBe(0);
  });

  it("CASE B — EMI: the person's settlement leaves the lender unpaid until I pay it; paying never re-charges the person", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await payments.recordPayment(person(), pay(2000));
    expect(account()).toBe(12_000);
    expect(statement(SEP).currentPending).toBe(0);
    expect(income()).toBe(0);
    expect(installments[0].amountPaid).toBe(0); // lender EMI still unpaid
    expect(funds()).toEqual([
      expect.objectContaining({ title: "Phone EMI #1", amount: 2000, pendingAmount: 2000, status: "pending", destination: expect.objectContaining({ kind: "emi", installmentId: "i1" }) }),
    ]);
    expect(linkedFundsForInstallment(funds(), "i1")).toHaveLength(1);

    const ledgerBefore = ledger().length;
    await payEmiFromSbi(2000);
    expect(account()).toBe(10_000);
    expect(pendingInSbi()).toBe(0);
    expect(funds()[0].status).toBe("completed");
    expect(ledger()).toHaveLength(ledgerBefore); // the lender payment is not a second People settlement
    expect(statement(SEP).currentPending).toBe(0);
    expect(income()).toBe(0);
  });

  it("CASE C — mixed: ONE ₹3,000 receipt, allocated KSEB ₹1,000 + EMI ₹2,000, both awaiting onward payment", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await seedCardKseb();
    await payments.recordPayment(person(), pay(3000));
    expect(liveTx().filter((t) => t.isPersonLedgerMovement).map((t) => [t.amount, t.accountId])).toEqual([[3000, "sbi"]]);
    expect(account()).toBe(13_000);
    expect(income()).toBe(0);
    const f = funds();
    expect(new Set(f.map((x) => x.paymentId)).size).toBe(1);
    expect(f.map((x) => [x.destination.kind, x.pendingAmount]).sort()).toEqual([
      ["card", 1000],
      ["emi", 2000],
    ]);
    expect(pendingInSbi()).toBe(3000);

    await payEmiFromSbi(2000);
    expect(pendingInSbi()).toBe(1000);
  });

  it("CASE D — overpayment held as advance: account +₹3,200 once, income ₹0, the advance is never a linked fund", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await seedCardKseb();
    await payments.recordPayment(person(), pay(3200, { kind: "advance", amount: 200 }));
    expect(account()).toBe(13_200);
    expect(liveTx().filter((t) => t.isPersonLedgerMovement)).toHaveLength(1);
    expect(income()).toBe(0);
    expect(statement(ALL).advanceBalance).toBe(-200);
    expect(pendingInSbi()).toBe(3000);
  });

  it("CASE E — extra explicitly recorded as income: only the ₹200 is income; the account receives ₹3,200 once", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await seedCardKseb();
    await payments.recordPayment(person(), pay(3200, { kind: "income", amount: 200, categoryId: "cat-gift", description: "Extra" }));
    expect(account()).toBe(13_200);
    // ₹3,000 settlement + ₹200 income = the one ₹3,200 receipt; no further deposit.
    expect(liveTx().filter((t) => t.accountId === "sbi").reduce((s, t) => s + t.amount, 0)).toBe(3200);
    expect(income()).toBe(200);
    expect(pendingInSbi()).toBe(3000);
  });

  it("revert reverses the receipt once, restores the obligations, clears linked funds; an independent card payment stays", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await seedCardKseb();
    const id = await payments.recordPayment(person(), pay(3000));
    await txRepo.createTransferPair({ amount: 1000, dateTime: d(10, 10), sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer" });
    await payments.revertPayment(person(), id);
    expect(account()).toBe(9_000); // only the receipt was reversed; my card payment is my own
    expect(hdfc()).toBe(0);
    expect(person().currentBalance).toBe(1000);
    expect(statement(SEP).currentPending).toBe(3000);
    expect(funds()).toEqual([]);
    expect(income()).toBe(0);
  });

  it("edit ₹3,000 → ₹2,500 re-allocates through the engine; linked funds follow the new allocation", async () => {
    installments = [emiInst("i1", 1, d(9, 30), 2000)];
    await seedCardKseb();
    const edited = pay(2500); // allocated over the same open obligations the edit screen shows
    const id = await payments.recordPayment(person(), pay(3000));
    await payments.editPayment(person(), id, edited);
    expect(account()).toBe(12_500);
    expect(liveTx().filter((t) => t.isPersonLedgerMovement)).toHaveLength(1);
    expect(round2(funds().reduce((s, f) => s + f.amount, 0))).toBe(2500);
    expect(pendingInSbi()).toBe(2500);
    expect(statement(SEP).currentPending).toBe(500);
    expect(income()).toBe(0);
  });

  it("a card already paid before the reimbursement is completed at once — nothing awaits", async () => {
    installments = [];
    await seedCardKseb();
    await txRepo.createTransferPair({ amount: 1000, dateTime: d(9, 28), sourceAccountId: "sbi", destinationAccountId: "hdfc", categoryId: "cat-transfer" });
    await payments.recordPayment(person(), pay(1000));
    expect(funds().map((f) => f.status)).toEqual(["completed"]);
    expect(pendingInSbi()).toBe(0);
  });
});
