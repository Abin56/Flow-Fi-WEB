/**
 * Outstanding bill obligations vs cash — recurring cycles reopened by a cancelled payment (real Firestore emulator).
 *
 * Synthetic data only. Runs the REAL payment + occurrence repositories, then feeds the persisted cycles to the shared
 * obligation engine that Bills Stats, Month Cycle and My Money all use, and proves:
 *   - every unpaid cycle is outstanding, whichever cycle of the bill it is (an older one reopened by a cancel included);
 *   - Bills Stats and Month Cycle show the SAME overdue / outstanding figures;
 *   - obligations are not cash: cancelling a payment that moved no money changes no balance and no Money Out, and
 *     re-paying creates exactly one debit through the existing repository;
 *   - no cycle is ever generated or duplicated by any of this.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { dashboardBillAttention, dashboardBillRows } from "@/features/dashboard/lib/bill-obligation-items";
import { billObligationStats, billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import {
  billFromFirestore,
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  billToFirestore,
  type Bill,
  type BillOccurrence,
} from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillOccurrenceRepository, BillRepository } from "@/lib/repositories/bill-repository";
import { BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-bill-obligations-integration";
const UID = "bill-obligations-owner";
const BILL = "bill-1";

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
const NOW = new Date();
const monthsAgo = (n: number) => new Date(NOW.getFullYear(), NOW.getMonth() - n, 1, 12);
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12);
/** The calendar month Month Cycle shows: it carries every earlier cycle that is still past due. */
const CYCLE = { start: new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 0, 0), end: new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0, 23, 59, 59) };

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  );
  const bills = new BillPaymentRepository(db, UID);
  const billsCol = collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore });
  const occCol = collection(db, "users", UID, "bills", BILL, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore });
  const occRepo = new BillOccurrenceRepository(occCol, new BillRepository(billsCol), doc(db, "users", UID, "bills", BILL), collection(db, "users", UID, "bills", BILL, "payments"));

  async function makeMonthlyBill(amount = 1_000) {
    const bill: Bill = {
      id: BILL, name: "Electricity", amount, nextDueDate: monthsAgo(2), recurrence: "monthly", accountId: null, categoryId: "utilities",
      customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    await setDoc(doc(billsCol, BILL), bill);
  }
  const cycles = async () => (await getDocs(occCol)).docs.map((d) => d.data()).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  /** What the Bills page does on every open; returns the cycle it would show. */
  async function openBillsPage(): Promise<BillOccurrence> {
    const bill = (await getDocs(billsCol)).docs[0].data();
    return occRepo.ensureCurrentOccurrence(bill, await occRepo.getAll());
  }
  /** Exactly what `useBillRows().cycles` feeds the reporting: every persisted cycle, the current one included once. */
  async function reportingCycles() {
    const current = await openBillsPage();
    const all = await occRepo.getAll();
    const withCurrent = all.some((o) => o.id === current.id) ? all : [...all, current];
    return withCurrent.map((occurrence) => ({ billId: BILL, occurrence }));
  }
  /** Bills Stats and Month Cycle, computed the way the two screens do — same engine, same cycles. */
  async function figures() {
    const outstanding = outstandingBillOccurrences(await reportingCycles(), NOW);
    return { stats: billObligationStats(outstanding, NOW), month: billObligationsInCycle(outstanding, CYCLE, NOW) };
  }
  /** What Dashboard shows: Upcoming payments (bill rows) and Needs your attention, from the same persisted cycles. */
  async function dashboard() {
    const outstanding = outstandingBillOccurrences(await reportingCycles(), NOW);
    const rows = dashboardBillRows(outstanding, new Map([[BILL, "Electricity"]]), NOW);
    return { rows, attention: dashboardBillAttention(rows, outstanding, NOW, (d) => d.toDateString()), stats: billObligationStats(outstanding, NOW) };
  }
  async function payCurrent(accountId: string, key: string, amount?: number) {
    const current = await openBillsPage();
    const r = await bills.payFromAccount({ billId: BILL, occurrenceId: current.id, accountId, amount, date: TODAY_NOON, idempotencyKey: key });
    await openBillsPage();
    return { cycle: current, paymentId: r.paymentId };
  }
  const bal = async (id: string) => paise((await accounts.getByKey(id))!.currentBalance);
  /** Actual cash movement as Dashboard / Month Cycle report it — bills count ONLY through their transactions. */
  async function cash() {
    const txns = await transactions.getAll();
    const cf = cashFlowThisMonth({ transactions: cashFlowTransactions(txns, new Set()), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: TODAY_NOON });
    const outflow = monthCycleDashboardTransactions(txns, new Set()).filter((t) => t.type === "expense" && !t.isTransfer).reduce((s, t) => s + paise(t.amount), 0);
    return { moneyOut: paise(cf.moneyOut), cycleOutflow: outflow, txns: txns.length };
  }
  async function drift() {
    const all = [...(await transactions.getAll()), ...(await transactions.getTrash())];
    for (const a of await accounts.getAll()) expect(accountBalanceDrift(a, all), `account ${a.name}`).toBeNull();
  }
  return { accounts, bills, makeMonthlyBill, cycles, openBillsPage, figures, dashboard, payCurrent, bal, cash, drift };
}
type S = ReturnType<typeof setup>;

/** Cycle 1 (due 2 months ago) and cycle 2 (1 month ago) paid from the account; cycle 3 (1st of this month) open and overdue. */
async function threeCycles(s: S) {
  const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
  await s.makeMonthlyBill(1_000);
  const c1 = await s.payCurrent(a.id, "obl-pay-0001");
  const c2 = await s.payCurrent(a.id, "obl-pay-0002");
  const c3 = await s.openBillsPage();
  return { a, c1, c2, c3 };
}

/** The two screens must agree with each other and with the persisted cycles. */
function expectMatching(f: Awaited<ReturnType<S["figures"]>>, expected: { overdueCount: number; overdueAmount: number }) {
  expect(f.stats.overdueCount).toBe(expected.overdueCount);
  expect(f.stats.overdueAmount).toBe(expected.overdueAmount);
  expect(f.month.overdueCount).toBe(f.stats.overdueCount);
  expect(f.month.overdueTotal).toBe(f.stats.overdueAmount);
  expect(f.month.total).toBe(f.stats.outstandingTotal); // the cycle range covers everything outstanding here
  expect(f.month.items.reduce((sum, i) => sum + i.remaining, 0)).toBe(f.month.total);
}

describe("Bills Stats and Month Cycle share one occurrence-level obligation figure", () => {
  it("multiple paid cycles: only the latest, still-unpaid cycle is outstanding", async () => {
    const s = setup();
    await threeCycles(s);
    expectMatching(await s.figures(), { overdueCount: 1, overdueAmount: 1_000 });
  });

  it("cancelling an OLDER paid cycle reopens it: overdue count and amount grow, current cycle untouched, no cycle generated", async () => {
    const s = setup();
    const { a, c1, c3 } = await threeCycles(s);
    const before = await s.cycles();
    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });

    const f = await s.figures();
    expectMatching(f, { overdueCount: 2, overdueAmount: 2_000 });
    expect(f.month.items.map((i) => i.occurrence.id)).toEqual([c1.cycle.id, c3.id]);
    expect(f.month.items[0].carriedForward).toBe(true);
    // Schedule untouched: same cycles, none generated or duplicated, other cycles' status unchanged.
    const after = await s.cycles();
    expect(after).toHaveLength(before.length);
    expect(after.map((o) => [o.id, o.amountPaid])).toEqual(before.map((o) => [o.id, o.id === c1.cycle.id ? 0 : o.amountPaid]));
    await s.drift();
    expect(await s.bal(a.id)).toBe(paise(4_000)); // 5,000 − cycle 2 only
  });

  it("cancelling the LATEST paid cycle, then re-paying an old one, keeps both screens equal at every step", async () => {
    const s = setup();
    const { a, c1, c2 } = await threeCycles(s);
    await s.bills.reversePayment({ billId: BILL, paymentId: c2.paymentId });
    expectMatching(await s.figures(), { overdueCount: 2, overdueAmount: 2_000 });

    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });
    expectMatching(await s.figures(), { overdueCount: 3, overdueAmount: 3_000 }); // multiple overdue cycles

    // Re-pay the oldest cycle as itself.
    await s.bills.payFromAccount({ billId: BILL, occurrenceId: c1.cycle.id, accountId: a.id, date: TODAY_NOON, idempotencyKey: "obl-repay-001" });
    const f = await s.figures();
    expectMatching(f, { overdueCount: 2, overdueAmount: 2_000 });
    expect(f.month.items.map((i) => i.occurrence.id)).not.toContain(c1.cycle.id);
    expect(await s.cycles()).toHaveLength(3);
    await s.drift();
  });

  it("a partially paid old cycle owes only its remainder and still counts as overdue", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeMonthlyBill(1_000);
    const first = await s.payCurrent(a.id, "obl-part-001", 400); // current cycle only 400 paid → does not roll
    expect(first.cycle.amountPaid).toBe(0);
    const f = await s.figures();
    expectMatching(f, { overdueCount: 1, overdueAmount: 600 });
    expect(f.month.items[0]).toMatchObject({ remaining: 600 });
    await s.drift();
  });
});

describe("Obligation reporting is not cash", () => {
  it("cancelling a historical account-neutral payment restores the obligation without moving cash", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeMonthlyBill(1_000);
    const first = await s.openBillsPage();
    const early = await s.bills.recordPaidEarlier({ billId: BILL, occurrenceId: first.id, date: first.dueDate, idempotencyKey: "obl-early-001" });
    await s.openBillsPage(); // rolls to cycle 2 (one cycle is generated at a time): overdue and open
    const beforeCash = await s.cash();
    const beforeBal = await s.bal(a.id);
    expectMatching(await s.figures(), { overdueCount: 1, overdueAmount: 1_000 }); // only cycle 2 is open

    await s.bills.reversePayment({ billId: BILL, paymentId: early.paymentId });
    const f = await s.figures();
    expectMatching(f, { overdueCount: 2, overdueAmount: 2_000 }); // obligation grew by the reopened cycle…
    expect(await s.cash()).toEqual(beforeCash); // …but no transaction, no Money Out, no cycle outflow
    expect(await s.bal(a.id)).toBe(beforeBal);
    expect(await s.cash()).toEqual({ moneyOut: 0, cycleOutflow: 0, txns: 0 });
    await s.drift();
  });

  it("an account-funded payment: cancel removes its one debit, re-pay adds exactly one — obligations never create expenses", async () => {
    const s = setup();
    const { a, c1 } = await threeCycles(s);
    expect(await s.cash()).toMatchObject({ moneyOut: paise(2_000), txns: 2 });

    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });
    expect(await s.cash()).toMatchObject({ moneyOut: paise(1_000), txns: 1 }); // the refunded debit is gone — nothing new appears
    await s.figures(); // reporting is read-only: running it any number of times changes nothing
    await s.figures();
    expect(await s.cash()).toMatchObject({ moneyOut: paise(1_000), txns: 1 });

    await s.bills.payFromAccount({ billId: BILL, occurrenceId: c1.cycle.id, accountId: a.id, date: TODAY_NOON, idempotencyKey: "obl-repay-002" });
    expect(await s.cash()).toMatchObject({ moneyOut: paise(2_000), txns: 2 });
    expect(await s.bal(a.id)).toBe(paise(3_000));
    await s.drift();
  });

  it("unrelated accounts keep their balances through cancel and re-pay of an old cycle", async () => {
    const s = setup();
    const { a, c1 } = await threeCycles(s);
    const other = await s.accounts.createAccount({ name: "Other", type: "cash", openingBalance: 777, colorValue: 0 });
    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });
    await s.bills.payFromAccount({ billId: BILL, occurrenceId: c1.cycle.id, accountId: a.id, date: TODAY_NOON, idempotencyKey: "obl-repay-003" });
    expect(await s.bal(other.id)).toBe(paise(777));
    await s.drift();
  });
});

describe("Dashboard Upcoming payments and Needs your attention follow the same cycles", () => {
  it("cancelling an older paid cycle adds an overdue row and alert with its actual amount; Dashboard agrees with Bills Stats", async () => {
    const s = setup();
    const { c1, c3 } = await threeCycles(s);
    const before = await s.dashboard();
    expect(before.rows.map((r) => r.id)).toEqual([`bill-${BILL}:${c3.id}`]);

    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });
    const after = await s.dashboard();
    expect(after.rows.map((r) => [r.id, r.overdue, r.amount])).toEqual([[`bill-${BILL}:${c1.cycle.id}`, true, 1_000], [`bill-${BILL}:${c3.id}`, true, 1_000]]);
    expect(after.attention).toHaveLength(1);
    expect(after.attention[0]).toMatchObject({ title: "Overdue Bill", subtitle: "2 bills overdue", amount: 2_000 });
    // One source of truth: the Dashboard overdue total equals Bills Stats and Month Cycle.
    const f = await s.figures();
    expect(after.attention[0].amount).toBe(f.stats.overdueAmount);
    expect(after.attention[0].amount).toBe(f.month.overdueTotal);
  });

  it("cancelling creates no cash outflow; re-paying removes exactly the repaid cycle and adds exactly one debit", async () => {
    const s = setup();
    const { a, c1, c3 } = await threeCycles(s);
    await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId });
    const cashAfterCancel = await s.cash();
    await s.dashboard();
    await s.dashboard(); // reading the Dashboard writes nothing
    expect(await s.cash()).toEqual(cashAfterCancel);

    await s.bills.payFromAccount({ billId: BILL, occurrenceId: c1.cycle.id, accountId: a.id, date: TODAY_NOON, idempotencyKey: "obl-dash-001" });
    const d = await s.dashboard();
    expect(d.rows.map((r) => r.id)).toEqual([`bill-${BILL}:${c3.id}`]); // the repaid cycle is gone, the other overdue cycle stays
    expect(d.attention[0]).toMatchObject({ amount: 1_000 });
    expect(await s.cash()).toMatchObject({ moneyOut: cashAfterCancel.moneyOut + paise(1_000), txns: cashAfterCancel.txns + 1 });
    expect(await s.cycles()).toHaveLength(3);
    await s.drift();
  });

  it("a cancelled account-neutral payment re-appears as overdue on the Dashboard without moving cash", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeMonthlyBill(1_000);
    const first = await s.openBillsPage();
    const early = await s.bills.recordPaidEarlier({ billId: BILL, occurrenceId: first.id, date: first.dueDate, idempotencyKey: "obl-dash-002" });
    await s.openBillsPage();
    const cashBefore = await s.cash();
    expect((await s.dashboard()).rows).toHaveLength(1);

    await s.bills.reversePayment({ billId: BILL, paymentId: early.paymentId });
    const d = await s.dashboard();
    expect(d.rows).toHaveLength(2);
    expect(d.attention[0]).toMatchObject({ title: "Overdue Bill", amount: 2_000 });
    expect(await s.cash()).toEqual(cashBefore);
    expect(await s.bal(a.id)).toBe(paise(5_000));
  });

  it("a part-paid old cycle shows only its remainder on the Dashboard and in the overdue total", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeMonthlyBill(1_000);
    await s.payCurrent(a.id, "obl-dash-003", 400);
    const d = await s.dashboard();
    expect(d.rows[0]).toMatchObject({ amount: 600, overdue: true, partPaid: true });
    expect(d.attention[0]).toMatchObject({ title: "Overdue Bill", amount: 600 });
    expect((await s.figures()).stats.overdueAmount).toBe(600);
  });
});
