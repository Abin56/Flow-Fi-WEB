/**
 * Bill Skip / soft delete / duplicate-cycle payment safety (real Firestore emulator, TWO independent clients).
 *
 * Synthetic data only. Covers the audit findings:
 *   F1 — a PAID (or part-paid) cycle cannot be skipped; Skip/Unskip change only `isSkipped` against the CURRENT cycle, so they
 *        can never overwrite a payment's `amountPaid`; a pay/skip race ends in exactly one consistent state; skipping can no
 *        longer hide money that is owed after a payment is cancelled.
 *   F2 — soft-deleting a bill from a stale copy sets `deletedAt` only: concurrent edits, the rolled due date and the audit
 *        history survive.
 *   F3 — historical duplicate cycles (same bill, same due calendar day) BLOCK a bank debit / "paid earlier" record with a
 *        manual-review message; nothing is written, and the duplicate records are never merged, deleted, restored or rewritten.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { dashboardBillRows } from "@/features/dashboard/lib/bill-obligation-items";
import { billObligationStats, billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { billFromFirestore, billOccurrenceFromFirestore, billOccurrenceToFirestore, billToFirestore, type Bill, type BillOccurrence } from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { BillOccurrenceRepository, BillRepository } from "@/lib/repositories/bill-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-bill-skip-delete-dup";
const UID = "bill-safety-owner";
const BILL = "bill-1";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => testEnv.cleanup());
afterEach(async () => testEnv.clearFirestore());

const NOW = new Date();
const monthsAgo = (n: number) => new Date(NOW.getFullYear(), NOW.getMonth() - n, 1, 12);
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12);
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function client() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const billsCol = collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore });
  const occCol = collection(db, "users", UID, "bills", BILL, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore });
  const billRepo = new BillRepository(billsCol);
  const occRepo = new BillOccurrenceRepository(occCol, billRepo, doc(db, "users", UID, "bills", BILL), collection(db, "users", UID, "bills", BILL, "payments"));
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const txns = new TransactionRepository(collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), accounts);
  const pay = new BillPaymentRepository(db, UID);
  const open = async () => occRepo.ensureCurrentOccurrence((await billRepo.getByKey(BILL))!, await occRepo.getAll());
  const rawCycles = async () => (await getDocs(collection(db, "users", UID, "bills", BILL, "occurrences"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const rawPayments = async () => (await getDocs(collection(db, "users", UID, "bills", BILL, "payments"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const rawBill = async () => (await getDocs(collection(db, "users", UID, "bills"))).docs.map((d) => ({ id: d.id, ...d.data() }))[0];
  const bal = async (id: string) => (await accounts.getByKey(id))!.currentBalance;
  return { db, billsCol, occCol, billRepo, occRepo, accounts, txns, pay, open, rawCycles, rawPayments, rawBill, bal };
}
type C = ReturnType<typeof client>;

const monthly = (over: Partial<Bill> = {}): Bill => ({ id: BILL, name: "Electricity", amount: 1_000, nextDueDate: monthsAgo(0), recurrence: "monthly", accountId: null, categoryId: "utilities", customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [], ...over });
const dupCycle = (id: string, paid: number, due = monthsAgo(0)): BillOccurrence => ({ id, billId: BILL, dueDate: due, amount: 1_000, amountPaid: paid, isSkipped: false, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] });

async function world(c: C, over: Partial<Bill> = {}) {
  const acct = await c.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
  await setDoc(doc(c.billsCol, BILL), monthly(over));
  return acct;
}
const payArgs = (accountId: string, occurrenceId: string, key: string, amount?: number) => ({ billId: BILL, occurrenceId, accountId, amount, date: TODAY_NOON, idempotencyKey: key });

/** What Dashboard, My Money, Month Cycle and Bills each derive from the persisted cycles — one shared engine. */
function figures(cycles: BillOccurrence[]) {
  const out = outstandingBillOccurrences(cycles.map((occurrence) => ({ billId: BILL, occurrence })), NOW);
  return {
    billsStats: billObligationStats(out, NOW).outstandingTotal,
    monthCycleAndMyMoney: billObligationsInCycle(out, cycleRangeFor(1, NOW), NOW).total,
    dashboardRows: dashboardBillRows(out, new Map([[BILL, "Electricity"]]), NOW).length,
    outstanding: out.length,
  };
}

describe("F1 — Skip cannot touch a paid cycle, and cannot overwrite payments", () => {
  it("a fully PAID cycle cannot be skipped: refused, cycle and payment record untouched", async () => {
    const a = client();
    const acct = await world(a);
    const cycle = await a.open();
    await a.pay.payFromAccount(payArgs(acct.id, cycle.id, "skip-paid-0001"));
    const before = [await a.rawCycles(), await a.rawPayments()];

    await expect(a.occRepo.skipOccurrence((await a.occRepo.getAll())[0])).rejects.toThrow(/paid|payment/i);

    expect([await a.rawCycles(), await a.rawPayments()]).toEqual(before);
    expect(await a.bal(acct.id)).toBe(4_000);
  });

  it("a PART-paid cycle cannot be skipped either (the remainder would silently vanish from every total)", async () => {
    const a = client();
    const acct = await world(a);
    const cycle = await a.open();
    await a.pay.payFromAccount(payArgs(acct.id, cycle.id, "skip-part-0001", 400));
    await expect(a.occRepo.skipOccurrence((await a.occRepo.getAll())[0])).rejects.toThrow(/paid|payment/i);
    const occ = (await a.rawCycles())[0] as unknown as { amountPaid: number; isSkipped: boolean };
    expect([occ.amountPaid, occ.isSkipped]).toEqual([400, false]);
    expect(figures(await a.occRepo.getAll()).billsStats).toBe(600);
  });

  it("a STALE skip (the row was unpaid when loaded; another tab paid since) is refused and overwrites nothing", async () => {
    const a = client();
    const b = client();
    const acct = await world(a);
    const cycle = await a.open();
    const stale = (await b.occRepo.getAll())[0]; // B: amountPaid 0
    await a.pay.payFromAccount(payArgs(acct.id, cycle.id, "skip-stale-0001"));
    const before = [await a.rawCycles(), await a.rawPayments()];

    await expect(b.occRepo.skipOccurrence(stale)).rejects.toThrow(/paid|payment/i);

    expect([await a.rawCycles(), await a.rawPayments()]).toEqual(before);
    expect((await a.occRepo.getAll())[0].amountPaid).toBe(1_000);
    expect(await a.bal(acct.id)).toBe(4_000);
  });

  it("an UNPAID cycle can still be skipped and un-skipped; only isSkipped changes", async () => {
    const a = client();
    await world(a);
    const cycle = await a.open();
    await a.occRepo.skipOccurrence(cycle);
    const skipped = (await a.occRepo.getAll())[0];
    expect([skipped.isSkipped, skipped.amountPaid, skipped.amount]).toEqual([true, 0, 1_000]);
    expect(figures([skipped]).billsStats).toBe(0);
    await a.occRepo.unskip(skipped);
    const back = (await a.occRepo.getAll())[0];
    expect([back.isSkipped, back.amountPaid]).toEqual([false, 0]);
    expect(figures([back]).billsStats).toBe(1_000);
  });

  it("a STALE un-skip (cycle was un-skipped and PAID in another tab) overwrites nothing", async () => {
    const a = client();
    const b = client();
    const acct = await world(a);
    const cycle = await a.open();
    await a.occRepo.skipOccurrence(cycle);
    const staleSkipped = (await b.occRepo.getAll())[0]; // B still sees it skipped
    await a.occRepo.unskip((await a.occRepo.getAll())[0]);
    await a.pay.payFromAccount(payArgs(acct.id, cycle.id, "unskip-stale-0001"));

    await b.occRepo.unskip(staleSkipped);

    const occ = (await a.occRepo.getAll())[0];
    expect([occ.amountPaid, occ.isSkipped]).toEqual([1_000, false]);
    expect(await a.bal(acct.id)).toBe(4_000);
  });

  it("pay vs skip racing from two tabs always ends in ONE consistent state (never paid-and-skipped, never a lost payment)", async () => {
    for (let round = 0; round < 6; round++) {
      await testEnv.clearFirestore();
      const a = client();
      const b = client();
      const acct = await world(a);
      const cycle = await a.open();
      const stale = (await b.occRepo.getAll())[0];

      const results = await Promise.allSettled([a.pay.payFromAccount(payArgs(acct.id, cycle.id, `race-${round}-payxx`)), b.occRepo.skipOccurrence(stale)]);

      const occ = (await a.rawCycles())[0] as unknown as { amountPaid: number; isSkipped: boolean };
      const payments = (await a.rawPayments()).filter((p) => (p as unknown as { deletedAt: unknown }).deletedAt == null);
      const balance = await a.bal(acct.id);
      const paidWon = occ.amountPaid === 1_000 && !occ.isSkipped && payments.length === 1 && balance === 4_000;
      const skipWon = occ.amountPaid === 0 && occ.isSkipped && payments.length === 0 && balance === 5_000;
      expect(paidWon || skipWon, `round ${round}: ${JSON.stringify({ occ, payments: payments.length, balance, results: results.map((r) => r.status) })}`).toBe(true);
    }
  });

  it("the audit scenario no longer hides money: pay → (Skip refused) → cancel payment → the cycle is owed again everywhere", async () => {
    const a = client();
    const acct = await world(a);
    const cycle = await a.open();
    const paid = await a.pay.payFromAccount(payArgs(acct.id, cycle.id, "skip-cancel-0001"));
    await expect(a.occRepo.skipOccurrence((await a.occRepo.getAll())[0])).rejects.toThrow();

    await a.pay.reversePayment({ billId: BILL, paymentId: paid.paymentId });

    expect(await a.bal(acct.id)).toBe(5_000);
    const f = figures(await a.occRepo.getAll());
    expect(f).toEqual({ billsStats: 1_000, monthCycleAndMyMoney: 1_000, dashboardRows: 1, outstanding: 1 });
  });
});

describe("F2 — soft delete from a stale copy preserves concurrent edits and audit history", () => {
  it("only deletedAt is written: the rolled due date, a concurrent amount edit and the audit history survive", async () => {
    const a = client();
    const b = client();
    await setDoc(doc(a.billsCol, BILL), monthly({ nextDueDate: monthsAgo(2) }));
    const stale = (await b.billRepo.getByKey(BILL))!; // B's copy: due 2 months ago, amount 1,000
    const first = await a.open();
    await a.occRepo.markPaid(first);
    await a.open(); // A rolls forward
    await a.billRepo.editBill((await a.billRepo.getByKey(BILL))!, { amount: 1_500 }); // A edits
    const cyclesBefore = await a.rawCycles();

    await b.billRepo.softDelete(stale);

    const bill = await a.rawBill() as unknown as Record<string, unknown>;
    expect(bill.deletedAt).not.toBeNull();
    expect(bill.amount).toBe(1_500);
    expect(dayKey((await a.billRepo.getByKey(BILL))!.nextDueDate)).toBe(dayKey(monthsAgo(1)));
    const fields = ((bill.editHistory as { field: string }[]) ?? []).map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["nextDueDate", "amount"]));
    expect(await a.rawCycles()).toEqual(cyclesBefore);
    expect(await a.billRepo.getAll()).toHaveLength(0); // deleted bills leave every list
  });

  it("deleting a bill that no longer exists is refused instead of recreating it from the stale copy", async () => {
    const a = client();
    await world(a);
    const bill = (await a.billRepo.getByKey(BILL))!;
    await a.billRepo.permanentlyDelete(bill);
    await expect(a.billRepo.softDelete(bill)).rejects.toThrow(/no longer exists/i);
    expect(await a.billRepo.getByKey(BILL)).toBeNull();
  });
});

describe("F3 — historical duplicate cycles block payment (non-destructively)", () => {
  async function dupWorld(c: C, a: { id: string; paid: number }, z: { id: string; paid: number }) {
    const acct = await world(c);
    await setDoc(doc(c.occCol, a.id), dupCycle(a.id, a.paid));
    await setDoc(doc(c.occCol, z.id), dupCycle(z.id, z.paid));
    return acct;
  }

  for (const [label, pa, pz] of [["two unpaid twins", 0, 0], ["dup-a paid, dup-z phantom", 1_000, 0], ["dup-z paid, dup-a phantom", 0, 1_000]] as const) {
    it(`${label}: a bank debit against EITHER twin is refused with a manual-review message — no debit, no payment record, records untouched`, async () => {
      const c = client();
      const acct = await dupWorld(c, { id: "dup-a", paid: pa }, { id: "dup-z", paid: pz });
      const before = [await c.rawCycles(), await c.rawPayments()];

      for (const id of ["dup-a", "dup-z"]) {
        await expect(c.pay.payFromAccount(payArgs(acct.id, id, `dup-${id}-0001xx`))).rejects.toThrow(/duplicate/i);
      }

      expect(await c.bal(acct.id)).toBe(5_000);
      expect(await c.txns.getAll()).toHaveLength(0);
      expect([await c.rawCycles(), await c.rawPayments()]).toEqual(before); // never merged, deleted, restored or rewritten
    });
  }

  it("'Already paid earlier' is blocked on a duplicate cycle too (it would silently pick one twin)", async () => {
    const c = client();
    await dupWorld(c, { id: "dup-a", paid: 0 }, { id: "dup-z", paid: 0 });
    const before = await c.rawCycles();
    await expect(c.pay.recordPaidEarlier({ billId: BILL, occurrenceId: "dup-z", date: monthsAgo(1), idempotencyKey: "dup-early-0001" })).rejects.toThrow(/duplicate/i);
    expect(await c.rawCycles()).toEqual(before);
    expect(await c.rawPayments()).toHaveLength(0);
  });

  it("a duplicate pair on an OLDER day does not block paying the current, single cycle", async () => {
    const c = client();
    const acct = await world(c, { nextDueDate: monthsAgo(1) });
    await setDoc(doc(c.occCol, "old-a"), dupCycle("old-a", 1_000, monthsAgo(1)));
    await setDoc(doc(c.occCol, "old-z"), dupCycle("old-z", 1_000, monthsAgo(1)));
    const current = await c.open(); // both twins settled → rolls forward to ONE new cycle
    expect(dayKey(current.dueDate)).toBe(dayKey(monthsAgo(0)));

    await c.pay.payFromAccount(payArgs(acct.id, current.id, "dup-other-0001"));

    expect(await c.bal(acct.id)).toBe(4_000);
  });

  it("a payment recorded BEFORE duplicates appeared can still be retried idempotently (no false block, no second debit)", async () => {
    const c = client();
    const acct = await world(c);
    const cycle = await c.open();
    const first = await c.pay.payFromAccount(payArgs(acct.id, cycle.id, "dup-retry-0001"));
    await setDoc(doc(c.occCol, "late-twin"), dupCycle("late-twin", 0)); // an old client creates a twin afterwards

    const retry = await c.pay.payFromAccount(payArgs(acct.id, cycle.id, "dup-retry-0001"));

    expect(retry).toMatchObject({ alreadyRecorded: true, paymentId: first.paymentId });
    expect(await c.bal(acct.id)).toBe(4_000);
  });

  it("an ordinary, non-duplicate bill still pays normally and Bills / Month Cycle / My Money / Dashboard agree afterwards", async () => {
    const c = client();
    const acct = await world(c);
    const cycle = await c.open();
    expect(figures(await c.occRepo.getAll())).toEqual({ billsStats: 1_000, monthCycleAndMyMoney: 1_000, dashboardRows: 1, outstanding: 1 });
    await c.pay.payFromAccount(payArgs(acct.id, cycle.id, "plain-pay-0001"));
    expect(await c.bal(acct.id)).toBe(4_000);
    expect(figures(await c.occRepo.getAll())).toEqual({ billsStats: 0, monthCycleAndMyMoney: 0, dashboardRows: 0, outstanding: 0 });
  });
});
