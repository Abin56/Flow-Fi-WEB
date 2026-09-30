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
import { advanceSources, paymentLines, payableObligations } from "@/features/people/lib/person-payment-obligations";
import { planEntryDeletion } from "@/lib/engines/person-ledger-deletion";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Expense } from "@/lib/models/expense";

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
