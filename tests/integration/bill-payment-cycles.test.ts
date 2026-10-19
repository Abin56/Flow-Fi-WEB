/**
 * Recurring-bill payment history — edit / cancel a payment of an OLD billing cycle (real Firestore emulator).
 *
 * Synthetic data only. Proves that a payment is edited or cancelled against the cycle (occurrence) recorded ON the
 * payment — never the cycle the Bills page happens to show — and that doing so leaves the recurring schedule alone:
 * no cycle is created, deleted or reset, `Bill.nextDueDate` does not move, other cycles and their accounts keep
 * their exact figures, and every refund lands on the payment's own account exactly once.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InsufficientFundsError } from "@/lib/engines/payment-funding";
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
  type BillOccurrence,
} from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillOccurrenceRepository, BillRepository } from "@/lib/repositories/bill-repository";
import { BillPaymentError, BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-bill-cycles-integration";
const UID = "bill-cycles-owner";
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
  const payCol = collection(db, "users", UID, "bills", BILL, "payments").withConverter({ toFirestore: paymentRecordToFirestore, fromFirestore: paymentRecordFromFirestore });
  const billRepo = new BillRepository(billsCol);
  const occRepo = new BillOccurrenceRepository(occCol, billRepo, doc(db, "users", UID, "bills", BILL), collection(db, "users", UID, "bills", BILL, "payments"));

  /** A monthly bill whose first cycle is due two months ago, then the REAL roll-forward builds later cycles as each is paid. */
  async function makeMonthlyBill(amount = 1_000) {
    const bill: Bill = {
      id: BILL, name: "Electricity", amount, nextDueDate: monthsAgo(2), recurrence: "monthly", accountId: null, categoryId: "utilities",
      customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    await setDoc(doc(billsCol, BILL), bill);
    return bill;
  }
  const currentBill = async () => (await getDoc(doc(billsCol, BILL))).data()!;
  const cycles = async () => (await getDocs(occCol)).docs.map((d) => d.data()).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const livePayments = async () => (await getDocs(payCol)).docs.map((d) => d.data()).filter((p) => p.deletedAt == null);
  /** What the Bills page does on every open: materialise / roll forward, return the current cycle. */
  async function openBillsPage(): Promise<BillOccurrence> {
    return occRepo.ensureCurrentOccurrence(await currentBill(), await occRepo.getAll());
  }
  const bal = async (id: string) => paise((await accounts.getByKey(id))!.currentBalance);
  async function drift() {
    const all = [...(await transactions.getAll()), ...(await transactions.getTrash())];
    for (const a of await accounts.getAll()) expect(accountBalanceDrift(a, all), `account ${a.name}`).toBeNull();
  }
  /** Pay the current cycle from `accountId`, then "open the page" so the next cycle is materialised, as in the app. */
  async function payCurrent(accountId: string, key: string, amount?: number) {
    const current = await openBillsPage();
    const r = await bills.payFromAccount({ billId: BILL, occurrenceId: current.id, accountId, amount, date: current.dueDate, idempotencyKey: key });
    await openBillsPage();
    return { cycle: current, paymentId: r.paymentId };
  }
  return { db, accounts, transactions, bills, makeMonthlyBill, currentBill, cycles, livePayments, openBillsPage, bal, drift, payCurrent };
}

type S = ReturnType<typeof setup>;
/** Three real cycles: cycle 1 paid from A, cycle 2 paid from B, cycle 3 open. */
async function threeCycles(s: S) {
  const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
  const b = await s.accounts.createAccount({ name: "B", type: "cash", openingBalance: 3_000, colorValue: 0 });
  await s.makeMonthlyBill(1_000);
  const c1 = await s.payCurrent(a.id, "cycle-pay-0001");
  const c2 = await s.payCurrent(b.id, "cycle-pay-0002");
  const current = await s.openBillsPage();
  return { a, b, c1, c2, current };
}

describe("History of a recurring bill", () => {
  it("each payment keeps the identity of its own cycle; the Bills page moves on to the next cycle", async () => {
    const s = setup();
    const { a, b, c1, c2, current } = await threeCycles(s);
    const cycles = await s.cycles();
    expect(cycles).toHaveLength(3);
    expect(cycles.map((c) => c.amountPaid)).toEqual([1_000, 1_000, 0]);
    expect(current.id).toBe(cycles[2].id);
    const pays = await s.livePayments();
    expect(pays.find((p) => p.id === c1.paymentId)).toMatchObject({ occurrenceId: c1.cycle.id, accountId: a.id });
    expect(pays.find((p) => p.id === c2.paymentId)).toMatchObject({ occurrenceId: c2.cycle.id, accountId: b.id });
    expect(await s.bal(a.id)).toBe(paise(4_000));
    expect(await s.bal(b.id)).toBe(paise(2_000));
    await s.drift();
  });
});

describe("Editing a payment of an old cycle", () => {
  it("changes only that cycle and its accounts; the schedule, later cycles and the open cycle are untouched", async () => {
    const s = setup();
    const { a, b, c1, c2, current } = await threeCycles(s);
    const nextDueBefore = (await s.currentBill()).nextDueDate.getTime();
    const cycle2Before = (await s.cycles())[1];

    // Cycle 1 (A, 1,000) → 800 from B. Bills page is currently showing cycle 3.
    await s.bills.editPayment({ billId: BILL, paymentId: c1.paymentId, accountId: b.id, amount: 800, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-001" });

    const cycles = await s.cycles();
    expect(cycles).toHaveLength(3); // no cycle created or deleted
    expect(cycles[0]).toMatchObject({ id: c1.cycle.id, amountPaid: 800 });
    expect(cycles[1]).toMatchObject({ id: c2.cycle.id, amountPaid: cycle2Before.amountPaid }); // other paid cycle untouched
    expect(cycles[2]).toMatchObject({ id: current.id, amountPaid: 0 }); // open cycle is NOT the target
    expect((await s.currentBill()).nextDueDate.getTime()).toBe(nextDueBefore);
    expect(await s.bal(a.id)).toBe(paise(5_000)); // refunded in full
    expect(await s.bal(b.id)).toBe(paise(1_200)); // 3,000 − cycle 2 (1,000) − corrected 800
    expect((await s.livePayments()).filter((p) => p.occurrenceId === c2.cycle.id)).toHaveLength(1);
    await s.drift();
  });

  it("a stale edit (payment already edited or cancelled elsewhere) is refused and writes nothing", async () => {
    const s = setup();
    const { a, b, c1 } = await threeCycles(s);
    await s.bills.editPayment({ billId: BILL, paymentId: c1.paymentId, accountId: a.id, amount: 900, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-002" });
    const snap = { a: await s.bal(a.id), b: await s.bal(b.id), cycles: (await s.cycles()).map((c) => c.amountPaid) };
    // Same stale payment id, different action key: the original was replaced by the first edit.
    await expect(s.bills.editPayment({ billId: BILL, paymentId: c1.paymentId, accountId: a.id, amount: 700, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-003" })).rejects.toBeInstanceOf(BillPaymentError);
    expect({ a: await s.bal(a.id), b: await s.bal(b.id), cycles: (await s.cycles()).map((c) => c.amountPaid) }).toEqual(snap);
    await s.drift();
  });

  it("a duplicate edit (same action key, double click / retry) applies once", async () => {
    const s = setup();
    const { a, c1 } = await threeCycles(s);
    const p = { billId: BILL, paymentId: c1.paymentId, accountId: a.id, amount: 600, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-004" };
    await s.bills.editPayment(p);
    await Promise.allSettled([s.bills.editPayment(p), s.bills.editPayment(p)]);
    expect(await s.bal(a.id)).toBe(paise(4_400));
    expect((await s.cycles())[0].amountPaid).toBe(600);
    expect((await s.livePayments()).filter((x) => x.occurrenceId === c1.cycle.id)).toHaveLength(1);
    await s.drift();
  });

  it("moving an old payment to an account that can't cover it is refused in the write", async () => {
    const s = setup();
    const { a, b, c1 } = await threeCycles(s);
    const poor = await s.accounts.createAccount({ name: "Poor", type: "bank", openingBalance: 100, colorValue: 0 });
    await expect(s.bills.editPayment({ billId: BILL, paymentId: c1.paymentId, accountId: poor.id, amount: 1_000, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-005" })).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await s.bal(a.id)).toBe(paise(4_000));
    expect(await s.bal(b.id)).toBe(paise(2_000));
    expect(await s.bal(poor.id)).toBe(paise(100));
    expect((await s.cycles())[0].amountPaid).toBe(1_000);
    await s.drift();
  });

  it("cannot raise an old cycle's payment above that cycle's own amount", async () => {
    const s = setup();
    const { a, c1 } = await threeCycles(s);
    await expect(s.bills.editPayment({ billId: BILL, paymentId: c1.paymentId, accountId: a.id, amount: 1_500, date: c1.cycle.dueDate, idempotencyKey: "cycle-edit-006" })).rejects.toThrow(/more than the bill/);
    expect(await s.bal(a.id)).toBe(paise(4_000));
  });
});

describe("Cancelling a payment of an old cycle", () => {
  it("cancelling the FIRST cycle refunds ITS account once, reopens only that cycle, keeps the rest and the schedule", async () => {
    const s = setup();
    const { a, b, c1, c2, current } = await threeCycles(s);
    const nextDueBefore = (await s.currentBill()).nextDueDate.getTime();

    expect((await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId })).alreadyReversed).toBe(false);
    // Repeat and concurrent cancels are no-ops: the refund happens exactly once.
    expect((await s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId })).alreadyReversed).toBe(true);
    await Promise.allSettled([1, 2, 3].map(() => s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId })));

    expect(await s.bal(a.id)).toBe(paise(5_000)); // A refunded once
    expect(await s.bal(b.id)).toBe(paise(2_000)); // B (cycle 2's account) untouched
    const cycles = await s.cycles();
    expect(cycles).toHaveLength(3);
    expect(cycles.map((c) => [c.id, c.amountPaid])).toEqual([[c1.cycle.id, 0], [c2.cycle.id, 1_000], [current.id, 0]]);
    expect((await s.currentBill()).nextDueDate.getTime()).toBe(nextDueBefore);
    expect((await s.livePayments()).map((p) => p.occurrenceId)).toEqual([c2.cycle.id]);

    // Opening the Bills page again neither duplicates cycles nor moves the schedule.
    expect((await s.openBillsPage()).id).toBe(current.id);
    expect(await s.cycles()).toHaveLength(3);
    expect((await s.currentBill()).nextDueDate.getTime()).toBe(nextDueBefore);

    // The reopened cycle can be paid again, as itself.
    await s.bills.payFromAccount({ billId: BILL, occurrenceId: c1.cycle.id, accountId: a.id, date: TODAY_NOON, idempotencyKey: "cycle-repay-001" });
    expect((await s.cycles())[0].amountPaid).toBe(1_000);
    expect(await s.bal(a.id)).toBe(paise(4_000));
    await s.drift();
  });

  it("cancelling the LATEST paid cycle refunds its account once and preserves earlier paid cycles", async () => {
    const s = setup();
    const { a, b, c1, c2, current } = await threeCycles(s);
    await s.bills.reversePayment({ billId: BILL, paymentId: c2.paymentId });
    expect(await s.bal(b.id)).toBe(paise(3_000));
    expect(await s.bal(a.id)).toBe(paise(4_000));
    expect((await s.cycles()).map((c) => [c.id, c.amountPaid])).toEqual([[c1.cycle.id, 1_000], [c2.cycle.id, 0], [current.id, 0]]);
    expect(await s.cycles()).toHaveLength(3);
    await s.drift();
  });

  it("a historical 'already paid earlier' payment cancels without any account refund", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await s.makeMonthlyBill(1_000);
    const first = await s.openBillsPage();
    const r = await s.bills.recordPaidEarlier({ billId: BILL, occurrenceId: first.id, date: first.dueDate, idempotencyKey: "cycle-early-001" });
    await s.openBillsPage(); // rolls to the next cycle
    expect(await s.cycles()).toHaveLength(2);
    expect(await s.bal(a.id)).toBe(paise(5_000));

    await s.bills.reversePayment({ billId: BILL, paymentId: r.paymentId });
    await Promise.allSettled([s.bills.reversePayment({ billId: BILL, paymentId: r.paymentId }), s.bills.reversePayment({ billId: BILL, paymentId: r.paymentId })]);
    expect(await s.bal(a.id)).toBe(paise(5_000)); // nothing refunded, nothing debited
    expect((await s.cycles())[0].amountPaid).toBe(0);
    expect(await s.transactions.getAll()).toHaveLength(0);
    expect(await s.cycles()).toHaveLength(2);
    await s.drift();
  });

  it("an old cycle's payment cannot be cancelled twice by racing tabs: one refund, cycle 2 unaffected", async () => {
    const s = setup();
    const { a, b, c1 } = await threeCycles(s);
    const results = await Promise.allSettled([
      s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId }),
      s.bills.reversePayment({ billId: BILL, paymentId: c1.paymentId }),
    ]);
    expect(results.every((r) => r.status === "fulfilled" || r.reason instanceof Error)).toBe(true);
    expect(await s.bal(a.id)).toBe(paise(5_000));
    expect(await s.bal(b.id)).toBe(paise(2_000));
    await s.drift();
  });
});
