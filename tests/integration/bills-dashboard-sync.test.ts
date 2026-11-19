/**
 * Bills dashboard ⇄ real money (Firestore emulator). Synthetic data only.
 *
 * Runs the REAL bill + payment + occurrence repositories, then feeds exactly what the Bills page reads (every persisted
 * cycle, each bill's payment records) through the shared builders (`buildCycleObligations` / `buildCompletedEvents` →
 * `buildBillsOverview`) and checks every headline against figures worked out by hand from the records:
 *   - pay in full / part-pay / cancel a payment / record "already paid": Due, Overdue, Paid, the paying account's balance
 *     and the transaction count all agree at EVERY step, and a cancelled payment is refunded exactly once;
 *   - one payment is one debit — a repeated key never debits twice, two simultaneous payments of one cycle debit once;
 *   - "already paid earlier" moves no money at all (no transaction, balance untouched) yet leaves Due immediately;
 *   - cycles follow the Month Cycle start day (17th vs 18th) and anything unpaid is carried forward, never dropped;
 *   - Bills' bill figures are the SAME numbers Month Cycle derives (`billObligationsInCycle`) from the same cycles.
 * Fixed dates (not "now") keep the expected rupees stable. Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { BillCycleRef, BillRow } from "@/features/bills/hooks/use-bills-data";
import { buildBillsOverview } from "@/features/bills/lib/bills-overview";
import { buildCompletedEvents, buildCycleObligations, makeCardLookup } from "@/features/my-money/lib/cycle-obligations";
import { groupCompleted } from "@/features/my-money/lib/my-money";
import { billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { adjacentCycleRange, cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import {
  billFromFirestore,
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  billToFirestore,
  paymentRecordFromFirestore,
  paymentRecordToFirestore,
  type Bill,
  type PaymentRecord,
} from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillOccurrenceRepository, BillRepository } from "@/lib/repositories/bill-repository";
import { BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-bills-dashboard-sync";
const UID = "bills-dashboard-owner";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const paise = (n: number) => Math.round(n * 100);
const at = (m: number, d: number) => new Date(2026, m - 1, d, 12);
/** "Today" for every figure: 25 Oct 2026 — inside the 18 Oct → 17 Nov cycle (and inside October for a calendar cycle). */
const NOW = at(10, 25);
const NO_CARD_LOOKUP = makeCardLookup({ accounts: [], cards: [], transactions: [] });

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  );
  const payments = new BillPaymentRepository(db, UID);
  const billsCol = collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore });
  const billRepo = new BillRepository(billsCol);
  const occRepoFor = (billId: string) =>
    new BillOccurrenceRepository(
      collection(db, "users", UID, "bills", billId, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore }),
      billRepo,
      doc(db, "users", UID, "bills", billId),
      collection(db, "users", UID, "bills", billId, "payments"),
    );
  const paymentsOf = async (billId: string): Promise<PaymentRecord[]> =>
    (await getDocs(collection(db, "users", UID, "bills", billId, "payments").withConverter({ toFirestore: paymentRecordToFirestore, fromFirestore: paymentRecordFromFirestore }))).docs.map((d) => d.data());

  async function makeBill(id: string, name: string, amount: number, due: Date, recurrence: Bill["recurrence"] = "monthly") {
    const bill: Bill = { id, name, amount, nextDueDate: due, recurrence, accountId: null, categoryId: "utilities", customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [] };
    await setDoc(doc(billsCol, id), bill);
    return bill;
  }
  const cyclesOf = async (billId: string) =>
    (await getDocs(collection(db, "users", UID, "bills", billId, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore })))
      .docs.map((d) => d.data())
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  /** What the Bills page loads: every bill, its current cycle (materialised / rolled as needed), every cycle, every payment record. */
  async function load() {
    const bills = (await getDocs(billsCol)).docs.map((d) => d.data()).filter((b) => b.deletedAt == null);
    const rows: BillRow[] = [];
    const cycles: BillCycleRef[] = [];
    const paymentsByBillId: Record<string, PaymentRecord[]> = {};
    for (const bill of bills) {
      const repo = occRepoFor(bill.id);
      const existing = await repo.getAll();
      const current = await repo.ensureCurrentOccurrence(bill, existing);
      const all = (existing.some((o) => o.id === current.id) ? existing : [...existing, current]).filter((o) => o.deletedAt == null);
      rows.push({ bill, occurrence: current, account: undefined, category: undefined });
      for (const occurrence of all) cycles.push({ billId: bill.id, occurrence });
      paymentsByBillId[bill.id] = await paymentsOf(bill.id);
    }
    return { rows, cycles, paymentsByBillId };
  }

  /** The Bills overview for the cycle containing `now`, computed from the persisted records the way the page does. */
  async function overview(startDay: number, now = NOW) {
    const { rows, cycles, paymentsByBillId } = await load();
    const cycleRange = cycleRangeFor(startDay, now);
    const nextRange = adjacentCycleRange(startDay, cycleRange, 1);
    const base = { cards: [], transactions: [], statements: [], accounts: [], loanRows: [], emiRows: [], billRows: rows, billCycles: cycles, now, lookup: NO_CARD_LOOKUP };
    const events = buildCompletedEvents({
      cards: [],
      transactions: [],
      lookup: NO_CARD_LOOKUP,
      loanRows: [],
      loanPayments: [],
      emiRows: [],
      emiPayments: [],
      billRows: rows,
      billOccurrences: cycles.map((c) => c.occurrence),
      billPaymentsByBillId: paymentsByBillId,
    });
    const o = buildBillsOverview({
      cycleObligations: buildCycleObligations({ ...base, cycleRange }),
      nextCycleObligations: buildCycleObligations({ ...base, cycleRange: nextRange }),
      completed: groupCompleted(events, cycleRange),
    });
    // The same cycles through Month Cycle's own engine — must agree with Bills to the rupee.
    const monthCycle = billObligationsInCycle(outstandingBillOccurrences(cycles, now), cycleRange, now);
    return { o, monthCycle, cycles, rows };
  }

  const bal = async (id: string) => paise((await accounts.getByKey(id))!.currentBalance);
  async function drift() {
    const all = [...(await transactions.getAll()), ...(await transactions.getTrash())];
    for (const a of await accounts.getAll()) expect(accountBalanceDrift(a, all), `account ${a.name}`).toBeNull();
  }
  const liveTxns = async () => (await transactions.getAll()).length;
  const currentCycle = async (billId: string) => {
    const bill = (await getDocs(billsCol)).docs.map((d) => d.data()).find((b) => b.id === billId)!;
    const repo = occRepoFor(billId);
    return repo.ensureCurrentOccurrence(bill, await repo.getAll());
  };
  return { accounts, payments, billRepo, makeBill, cyclesOf, paymentsOf, overview, bal, drift, liveTxns, currentCycle };
}

describe("Bills dashboard figures follow real payments, step by step", () => {
  it("part-pay → pay the rest → cancel → pay again: Due, Overdue, Paid, balance and transactions agree at every step", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeBill("elec", "Electricity", 1_000, at(10, 20)); // due 20 Oct — 5 days overdue on 25 Oct

    // 1. Nothing paid.
    let { o, monthCycle } = await s.overview(18);
    expect(o.summary).toMatchObject({ dueThisCycle: 1_000, overdue: 1_000, overdueCount: 1, upcoming: 0, paid: 0 });
    expect(monthCycle.total).toBe(o.summary.dueThisCycle);
    const first = await s.currentCycle("elec");

    // 2. Part payment ₹400 (debit once, ₹600 still owed, the paid part counted in this cycle).
    const part = await s.payments.payFromAccount({ billId: "elec", occurrenceId: first.id, accountId: bank.id, amount: 400, date: at(10, 24), idempotencyKey: "dash-part-0001" });
    ({ o, monthCycle } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 600, overdue: 600, paid: 400 });
    expect(o.toPay.next?.amountPaid).toBe(400);
    expect(monthCycle.total).toBe(600);
    expect(await s.bal(bank.id)).toBe(paise(4_600));
    expect(await s.liveTxns()).toBe(1);

    // 3. Pay the rest → nothing owed here; the bill rolls to ITS next cycle (20 Nov) which is Upcoming — created once.
    const rest = await s.payments.payFromAccount({ billId: "elec", occurrenceId: first.id, accountId: bank.id, date: at(10, 25), idempotencyKey: "dash-rest-0002" });
    ({ o, monthCycle } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 0, overdue: 0, dueThisCycleCount: 0, paid: 1_000, upcoming: 1_000, upcomingCount: 1 });
    expect(monthCycle.total).toBe(0);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect(await s.liveTxns()).toBe(2);
    expect(await s.cyclesOf("elec")).toHaveLength(2);

    // 4. Cancel the last payment → ₹600 is owed AGAIN, refunded exactly once; the Nov cycle is not duplicated.
    expect(await s.payments.reversePayment({ billId: "elec", paymentId: rest.paymentId })).toEqual({ alreadyReversed: false });
    expect(await s.payments.reversePayment({ billId: "elec", paymentId: rest.paymentId })).toEqual({ alreadyReversed: true });
    ({ o, monthCycle } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 600, overdue: 600, paid: 400, upcoming: 1_000 });
    expect(monthCycle.total).toBe(600);
    expect(await s.bal(bank.id)).toBe(paise(4_600));
    expect(await s.liveTxns()).toBe(1);
    expect(await s.cyclesOf("elec")).toHaveLength(2);

    // 5. Pay again with a fresh key → settled once more; every module's balance matches the live debits.
    await s.payments.payFromAccount({ billId: "elec", occurrenceId: first.id, accountId: bank.id, date: at(10, 25), idempotencyKey: "dash-again-0003" });
    ({ o } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 0, paid: 1_000 });
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect(await s.liveTxns()).toBe(2);
    expect(part.alreadyRecorded).toBe(false);
    await s.drift();
  });

  it("a repeated key never debits twice, and a payment beyond what is owed is refused with nothing written", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeBill("elec", "Electricity", 1_000, at(10, 20));
    const cycle = await s.currentCycle("elec");
    const params = { billId: "elec", occurrenceId: cycle.id, accountId: bank.id, amount: 1_000, date: at(10, 24), idempotencyKey: "dash-idem-0001" };
    const a = await s.payments.payFromAccount(params);
    const b = await s.payments.payFromAccount(params); // a double click / retry
    expect(a.alreadyRecorded).toBe(false);
    expect(b.alreadyRecorded).toBe(true);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect(await s.liveTxns()).toBe(1);

    await expect(s.payments.payFromAccount({ ...params, amount: 1, idempotencyKey: "dash-over-0002" })).rejects.toThrow(/already paid/i);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect(await s.liveTxns()).toBe(1);
    await s.drift();
  });

  it("two simultaneous full payments of one cycle (two tabs) debit once", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeBill("rent", "Rent", 2_000, at(10, 30));
    const cycle = await s.currentCycle("rent");
    const attempts = await Promise.allSettled(
      ["dash-race-000a", "dash-race-000b"].map((key) => s.payments.payFromAccount({ billId: "rent", occurrenceId: cycle.id, accountId: bank.id, date: at(10, 25), idempotencyKey: key })),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await s.bal(bank.id)).toBe(paise(3_000));
    expect(await s.liveTxns()).toBe(1);
    const { o } = await s.overview(18);
    expect(o.summary.dueThisCycle).toBe(0);
    expect(o.summary.paid).toBe(2_000);
    await s.drift();
  });

  it("'already paid earlier' leaves Due immediately and moves NO money — no transaction, balance untouched", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeBill("water", "Water", 500, at(10, 22), "oneTime");
    const cycle = await s.currentCycle("water");
    let { o } = await s.overview(18);
    expect(o.summary.dueThisCycle).toBe(500);

    await s.payments.recordPaidEarlier({ billId: "water", occurrenceId: cycle.id, date: at(10, 21), idempotencyKey: "dash-early-0001" });
    ({ o } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 0, overdue: 0, paid: 500 });
    expect(o.paid[0]).toMatchObject({ key: "bill:water", amount: 500, payments: 1 });
    expect(o.paid[0]!.lastDate).toEqual(at(10, 21)); // its REAL date, not the due date
    expect(await s.bal(bank.id)).toBe(paise(5_000));
    expect(await s.liveTxns()).toBe(0);
    await s.drift();
  });

  it("the Month Cycle start day decides the cycle: 17 Oct is the previous cycle's, 18 Oct this one's — and unpaid never disappears", async () => {
    const s = setup();
    await s.makeBill("a", "Internet", 700, at(10, 17), "oneTime"); // last day of the 18 Sep → 17 Oct cycle
    await s.makeBill("b", "Rent", 9_000, at(10, 18), "oneTime"); // first day of the 18 Oct → 17 Nov cycle

    // Cycle starting on the 18th, today 25 Oct: Rent belongs here; the 17 Oct bill is from the earlier cycle and carried (still overdue).
    let { o, monthCycle } = await s.overview(18);
    expect(o.summary).toMatchObject({ dueThisCycle: 9_700, overdue: 9_700 });
    expect(o.overdue.find((i) => i.sourceId === "a")!.carriedForward).toBe(true);
    expect(o.overdue.find((i) => i.sourceId === "b")!.carriedForward).toBe(false);
    expect(monthCycle.total).toBe(9_700);

    // The calendar-month cycle (start day 1) holds both in October — nothing carried.
    ({ o, monthCycle } = await s.overview(1));
    expect(o.summary.dueThisCycle).toBe(9_700);
    expect(o.overdue.every((i) => !i.carriedForward)).toBe(true);
    expect(monthCycle.total).toBe(9_700);

    // Standing on the PREVIOUS 18th-cycle (12 Oct): only the 17 Oct bill is in it.
    ({ o } = await s.overview(18, at(10, 12)));
    expect(o.summary.dueThisCycle).toBe(700);
    // …and the NEXT cycle after that one is the current: Rent is Upcoming there.
    expect(o.upcoming.map((i) => i.sourceId)).toEqual(["b"]);
    expect(o.summary.upcoming).toBe(9_000);
  });
});

const edit = (bill: Bill, nextDueDate: Date) => ({
  name: bill.name,
  amount: bill.amount,
  nextDueDate,
  recurrence: bill.recurrence,
  accountId: bill.accountId,
  categoryId: bill.categoryId,
  customIntervalDays: null,
  notes: bill.notes,
});

describe("editing a bill due date moves the cycle that is open", () => {
  it("an unpaid cycle moves to the cycle of its NEW due date — Bills and Month Cycle agree, nothing duplicated", async () => {
    const s = setup();
    await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const bill = await s.makeBill("elec", "Electricity", 1_000, at(10, 20));
    const opened = await s.currentCycle("elec"); // page open: the cycle is materialised at 20 Oct
    expect(opened.dueDate).toEqual(at(10, 20));
    let { o } = await s.overview(18);
    expect(o.summary).toMatchObject({ dueThisCycle: 1_000, overdue: 1_000 }); // 5 days past due

    // The user moves the due date to 5 Nov (still unpaid).
    await s.billRepo.editBill(bill, edit(bill, at(11, 5)));

    const afterMove = await s.overview(18);
    o = afterMove.o;
    const monthCycle = afterMove.monthCycle;
    const row = [...o.overdue, ...o.dueThisCycle].find((i) => i.sourceId === "elec")!;
    expect(row.dueDate).toEqual(at(11, 5));
    expect(row.status).not.toBe("overdue"); // 5 Nov is not past due on 25 Oct
    expect(o.summary).toMatchObject({ dueThisCycle: 1_000, overdue: 0 });
    expect(monthCycle.total).toBe(1_000);
    const cycles = await s.cyclesOf("elec");
    expect(cycles).toHaveLength(1); // moved, not duplicated
    expect(cycles[0]!.editHistory.some((e) => e.field === "dueDate")).toBe(true); // audited

    // Moved to 18 Dec -> it belongs to a later cycle: not owed now, and not Upcoming (the next cycle) either.
    const moved = (await s.billRepo.getByKey("elec"))!;
    await s.billRepo.editBill(moved, edit(moved, at(12, 18)));
    ({ o } = await s.overview(18));
    expect(o.summary).toMatchObject({ dueThisCycle: 0, upcoming: 0 });
    expect((await s.cyclesOf("elec"))[0]!.dueDate).toEqual(at(12, 18));
  });

  it("a part-paid cycle moves too - payments and balance untouched - and the bill still rolls forward from the new date", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const bill = await s.makeBill("elec", "Electricity", 1_000, at(10, 20));
    const cycle = await s.currentCycle("elec");
    await s.payments.payFromAccount({ billId: "elec", occurrenceId: cycle.id, accountId: bank.id, amount: 400, date: at(10, 24), idempotencyKey: "dash-move-0001" });

    await s.billRepo.editBill(bill, edit(bill, at(11, 5)));
    const [moved] = await s.cyclesOf("elec");
    expect(moved!.dueDate).toEqual(at(11, 5));
    expect(moved!.amountPaid).toBe(400);
    expect(await s.bal(bank.id)).toBe(paise(4_600));
    expect(await s.liveTxns()).toBe(1);
    expect((await s.paymentsOf("elec")).filter((p) => p.deletedAt == null)).toHaveLength(1);
    let { o } = await s.overview(18);
    expect(o.summary).toMatchObject({ dueThisCycle: 600, overdue: 0, paid: 400 });

    // Pay the rest -> the bill rolls from the NEW date (5 Dec), once.
    await s.payments.payFromAccount({ billId: "elec", occurrenceId: cycle.id, accountId: bank.id, date: at(10, 25), idempotencyKey: "dash-move-0002" });
    ({ o } = await s.overview(18));
    const cycles = await s.cyclesOf("elec");
    expect(cycles.map((c) => c.dueDate.getTime())).toEqual([at(11, 5).getTime(), at(12, 5).getTime()]);
    expect(o.summary).toMatchObject({ dueThisCycle: 0, paid: 1_000 });
    await s.drift();
  });

  it("a PAID cycle is history: its date is not rewritten (the edit stays on the template)", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const bill = await s.makeBill("elec", "Electricity", 1_000, at(10, 20), "oneTime");
    const cycle = await s.currentCycle("elec");
    await s.payments.payFromAccount({ billId: "elec", occurrenceId: cycle.id, accountId: bank.id, date: at(10, 24), idempotencyKey: "dash-paid-0001" });
    await s.billRepo.editBill(bill, edit(bill, at(11, 5)));
    const cycles = await s.cyclesOf("elec");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.dueDate).toEqual(at(10, 20)); // unchanged
    expect(cycles[0]!.amountPaid).toBe(1_000);
  });

  it("a date another cycle of the bill already uses is refused - nothing is written", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeBill("elec", "Electricity", 1_000, at(10, 20));
    const first = await s.currentCycle("elec");
    await s.payments.payFromAccount({ billId: "elec", occurrenceId: first.id, accountId: bank.id, date: at(10, 24), idempotencyKey: "dash-dup-0001" });
    await s.currentCycle("elec"); // rolls to 20 Nov
    const fresh = (await s.billRepo.getByKey("elec"))!;
    await expect(s.billRepo.editBill(fresh, edit(fresh, at(10, 20)))).rejects.toThrow(/already has a cycle due on/i);
    expect((await s.cyclesOf("elec")).map((c) => c.dueDate.getTime())).toEqual([at(10, 20).getTime(), at(11, 20).getTime()]);
    expect((await s.billRepo.getByKey("elec"))!.nextDueDate).toEqual(at(11, 20)); // template untouched too
  });

  it("moving back by exactly one repeat - which would make the bill roll onto its own record - is refused, nothing written", async () => {
    const s = setup();
    const bill = await s.makeBill("elec", "Electricity", 1_000, at(11, 5)); // monthly
    await s.currentCycle("elec");
    await expect(s.billRepo.editBill(bill, edit(bill, at(10, 5)))).rejects.toThrow(/repeat onto the day/i);
    expect((await s.cyclesOf("elec"))[0]!.dueDate).toEqual(at(11, 5));
    expect((await s.billRepo.getByKey("elec"))!.nextDueDate).toEqual(at(11, 5));
    // ...while a one-time bill has no roll, so the same move is fine.
    const once = await s.makeBill("once", "Fine", 100, at(11, 5), "oneTime");
    await s.currentCycle("once");
    await s.billRepo.editBill(once, edit(once, at(10, 5)));
    expect((await s.cyclesOf("once"))[0]!.dueDate).toEqual(at(10, 5));
  });

  it("a bill whose cycle has not been materialised yet just takes the new date (the first cycle is created there)", async () => {
    const s = setup();
    const bill = await s.makeBill("elec", "Electricity", 1_000, at(10, 20));
    await s.billRepo.editBill(bill, edit(bill, at(11, 5)));
    expect((await s.currentCycle("elec")).dueDate).toEqual(at(11, 5));
    expect(await s.cyclesOf("elec")).toHaveLength(1);
  });
});
