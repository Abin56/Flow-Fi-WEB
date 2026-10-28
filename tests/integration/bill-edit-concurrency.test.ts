/**
 * Bill EDIT concurrency (real Firestore emulator, TWO independent clients = two tabs/devices).
 *
 * Synthetic data only. The Bills edit form is seeded from the bill when it opens and submits EVERY field on save
 * (including `nextDueDate`, which the user usually did not touch). Before the fix, `editBill` wrote that stale copy back
 * whole, so:
 *   - an edit form opened before another tab rolled the recurring bill forward reverted `nextDueDate` (and the roll's
 *     audit entry);
 *   - two tabs editing DIFFERENT fields lost one of the edits.
 * Proves, after the fix:
 *   - only the fields the user actually changed are written, against the CURRENT bill, in one transaction;
 *   - a stale untouched `nextDueDate` never reverts a newer one;
 *   - simultaneous edits of different fields both survive; the same field with different values is a CONFLICT error
 *     (nothing is applied, nothing silently discarded); the same value is a no-op;
 *   - a deliberate schedule change is applied when nobody else moved the schedule, and is a conflict when someone did;
 *   - cycles and payment history are never touched; Bills / Dashboard / Month Cycle totals stay consistent.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, Timestamp, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { dashboardBillRows } from "@/features/dashboard/lib/bill-obligation-items";
import { billObligationStats, billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import {
  billFromFirestore,
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  billToFirestore,
  type Bill,
} from "@/lib/models/bill";
import { BillOccurrenceRepository, BillRepository, type EditBillParams } from "@/lib/repositories/bill-repository";

const PROJECT_ID = "flowfi-bill-edit-concurrency";
const UID = "bill-edit-owner";
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

const NOW = new Date();
const monthsAgo = (n: number) => new Date(NOW.getFullYear(), NOW.getMonth() - n, 1, 12);
const CYCLE = { start: new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 0, 0), end: new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0, 23, 59, 59) };
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** One browser tab / device. */
function client() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const billsCol = collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore });
  const occCol = collection(db, "users", UID, "bills", BILL, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore });
  const billRepo = new BillRepository(billsCol);
  const occRepo = new BillOccurrenceRepository(occCol, billRepo, doc(db, "users", UID, "bills", BILL), collection(db, "users", UID, "bills", BILL, "payments"));
  const bill = async () => (await billRepo.getByKey(BILL))!;
  const rawBill = async () => (await getDoc(doc(db, "users", UID, "bills", BILL))).data()!;
  const rawCycles = async () => (await getDocs(collection(db, "users", UID, "bills", BILL, "occurrences"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const rawPayments = async () => (await getDocs(collection(db, "users", UID, "bills", BILL, "payments"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  /** What the Bills page does on open. */
  const open = async () => occRepo.ensureCurrentOccurrence(await bill(), await occRepo.getAll());
  return { db, billsCol, occCol, billRepo, occRepo, bill, rawBill, rawCycles, rawPayments, open };
}
type C = ReturnType<typeof client>;

function monthlyBill(over: Partial<Bill> = {}): Bill {
  return {
    id: BILL, name: "Electricity", amount: 1_000, nextDueDate: monthsAgo(2), recurrence: "monthly", accountId: null, categoryId: "utilities",
    customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}
const seedBill = (c: C, bill = monthlyBill()) => setDoc(doc(c.billsCol, BILL), bill);

/**
 * Exactly what `BillsWorkspace.handleSave` sends for an edit: the form is seeded from `base` (date as a UTC `YYYY-MM-DD`
 * string, parsed back as UTC midnight), every field is submitted, `over` is what the user actually typed.
 */
function formParams(base: Bill, over: Partial<{ name: string; amount: number; dueDate: Date; recurrence: Bill["recurrence"]; categoryId: string | null; accountId: string | null; customIntervalDays: number; notes: string }> = {}): EditBillParams {
  const recurrence = over.recurrence ?? base.recurrence;
  const dueDate = over.dueDate ?? new Date(base.nextDueDate.toISOString().slice(0, 10));
  return {
    name: over.name ?? base.name,
    amount: over.amount ?? base.amount,
    nextDueDate: dueDate,
    recurrence,
    accountId: over.accountId !== undefined ? over.accountId : base.accountId,
    categoryId: over.categoryId !== undefined ? over.categoryId : base.categoryId,
    customIntervalDays: recurrence === "custom" ? (over.customIntervalDays ?? base.customIntervalDays ?? 30) : null,
    notes: over.notes ?? base.notes,
  };
}

/** Settled first cycle + a roll to the next one. Returns the bill as it was BEFORE the roll (what a stale form holds). */
async function openFormThenRoll(a: C) {
  await seedBill(a);
  const first = await a.open();
  await a.occRepo.markPaid(first);
  const staleBase = await a.bill(); // B opens the edit form here: nextDueDate = 2 months ago
  await a.open(); // A (another tab) opens Bills: rolls to last month
  return staleBase;
}

describe("reverse-A2 — a stale edit form never reverts a newer recurring due date", () => {
  it("edit form opened BEFORE another tab rolled the bill: saving a new name keeps the rolled due date, the roll's audit entry and the new cycle", async () => {
    const a = client();
    const b = client();
    const staleBase = await openFormThenRoll(a);
    expect(dayKey((await a.bill()).nextDueDate)).toBe(dayKey(monthsAgo(1))); // precondition: rolled

    await b.billRepo.editBill(staleBase, formParams(staleBase, { name: "Electricity (renamed)" }));

    const bill = await a.bill();
    expect(bill.name).toBe("Electricity (renamed)");
    expect(dayKey(bill.nextDueDate)).toBe(dayKey(monthsAgo(1))); // NOT reverted to 2 months ago
    expect(bill.editHistory.filter((e) => e.field === "nextDueDate")).toHaveLength(1); // roll's audit entry survived
    expect(bill.editHistory.filter((e) => e.field === "name")).toHaveLength(1);
    expect(await a.rawCycles()).toHaveLength(2);
  });

  it("the same, for every field the form can send: amount, category, notes and recurrence changes apply; the date stays rolled", async () => {
    const a = client();
    const b = client();
    const staleBase = await openFormThenRoll(a);

    await b.billRepo.editBill(staleBase, formParams(staleBase, { amount: 1_200, categoryId: "rent", notes: "new tariff", recurrence: "weekly" }));

    const bill = await a.bill();
    expect([bill.amount, bill.categoryId, bill.notes, bill.recurrence]).toEqual([1_200, "rent", "new tariff", "weekly"]);
    expect(dayKey(bill.nextDueDate)).toBe(dayKey(monthsAgo(1)));
  });
});

describe("simultaneous edits", () => {
  it("two tabs edit DIFFERENT fields from the same starting bill: both edits survive", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const base = await a.bill();

    await a.billRepo.editBill(base, formParams(base, { amount: 1_500 }));
    await b.billRepo.editBill(base, formParams(base, { name: "Power bill" })); // B's form still shows amount 1,000

    const bill = await a.bill();
    expect(bill.amount).toBe(1_500);
    expect(bill.name).toBe("Power bill");
  });

  it("two tabs edit the SAME field to DIFFERENT values: the second gets a conflict error and nothing of it is applied", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const base = await a.bill();
    await a.billRepo.editBill(base, formParams(base, { amount: 1_500 }));

    await expect(b.billRepo.editBill(base, formParams(base, { amount: 1_800, name: "Should not apply" }))).rejects.toThrow(/changed in another tab/i);

    const bill = await a.bill();
    expect(bill.amount).toBe(1_500); // first writer kept
    expect(bill.name).toBe("Electricity"); // the whole save is refused, not half-applied
  });

  it("two tabs edit the same field to the SAME value: no error, one audit entry", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const base = await a.bill();
    await a.billRepo.editBill(base, formParams(base, { amount: 1_500 }));
    await b.billRepo.editBill(base, formParams(base, { amount: 1_500 }));
    expect((await a.bill()).editHistory.filter((e) => e.field === "amount")).toHaveLength(1);
  });

  it("truly concurrent edits of different fields (Promise.all) both land", async () => {
    for (let round = 0; round < 4; round++) {
      await testEnv.clearFirestore();
      const a = client();
      const b = client();
      await seedBill(a);
      const base = await a.bill();
      await Promise.all([a.billRepo.editBill(base, formParams(base, { amount: 1_500 })), b.billRepo.editBill(base, formParams(base, { notes: "n" }))]);
      const bill = await a.bill();
      expect([bill.amount, bill.notes], `round ${round}`).toEqual([1_500, "n"]);
    }
  });
});

describe("deliberate schedule changes vs accidental stale overwrites", () => {
  it("the user moves the due date and nobody else touched the schedule: applied, one audit entry", async () => {
    const a = client();
    await seedBill(a);
    const base = await a.bill();
    const moved = new Date(2026, 5, 15, 12);

    await a.billRepo.editBill(base, formParams(base, { dueDate: new Date("2026-06-15") }));

    const bill = await a.bill();
    expect(dayKey(bill.nextDueDate)).toBe(dayKey(moved));
    expect(bill.editHistory.filter((e) => e.field === "nextDueDate")).toHaveLength(1);
  });

  it("the user moves the due date but ANOTHER tab rolled the bill meanwhile: conflict error, nothing applied, nothing discarded silently", async () => {
    const a = client();
    const b = client();
    const staleBase = await openFormThenRoll(a);
    const rolled = await a.bill();

    await expect(b.billRepo.editBill(staleBase, formParams(staleBase, { dueDate: new Date("2026-06-15"), amount: 2_000 }))).rejects.toThrow(/due date/i);

    const bill = await a.bill();
    expect(dayKey(bill.nextDueDate)).toBe(dayKey(rolled.nextDueDate));
    expect(bill.amount).toBe(1_000);
  });

  it("saving the form untouched writes nothing (no audit noise, no date rewrite)", async () => {
    const a = client();
    await seedBill(a);
    const base = await a.bill();
    const before = await a.rawBill();

    await a.billRepo.editBill(base, formParams(base));

    expect(await a.rawBill()).toEqual(before);
  });

  it("changing recurrence to custom needs a positive interval, checked against the CURRENT bill", async () => {
    const a = client();
    await seedBill(a);
    const base = await a.bill();
    await expect(a.billRepo.editBill(base, { recurrence: "custom", customIntervalDays: 0 })).rejects.toThrow(/interval/i);
    await a.billRepo.editBill(base, formParams(base, { recurrence: "custom", customIntervalDays: 10 }));
    const bill = await a.bill();
    expect([bill.recurrence, bill.customIntervalDays]).toEqual(["custom", 10]);
  });
});

describe("history, unknown fields and totals", () => {
  it("cycles and payment history are byte-for-byte unchanged by a stale edit", async () => {
    const a = client();
    const b = client();
    const staleBase = await openFormThenRoll(a);
    await setDoc(doc(a.db, "users", UID, "bills", BILL, "payments", "p1"), {
      billId: BILL, occurrenceId: "x", amount: 1_000, date: Timestamp.fromDate(monthsAgo(2)), note: "", createdAt: Timestamp.fromDate(monthsAgo(2)), deletedAt: null, lastEditedAt: null, editHistory: [],
    });
    const [cyclesBefore, paymentsBefore] = [await a.rawCycles(), await a.rawPayments()];

    await b.billRepo.editBill(staleBase, formParams(staleBase, { name: "Renamed", amount: 1_100 }));

    expect(await a.rawCycles()).toEqual(cyclesBefore);
    expect(await a.rawPayments()).toEqual(paymentsBefore);
  });

  it("a pre-migration field the model does not parse stays on the bill document after an edit", async () => {
    const a = client();
    await setDoc(doc(a.db, "users", UID, "bills", BILL), { ...billToFirestore(monthlyBill()), amountPaid: 0, isSkipped: false });
    const base = await a.bill();
    await a.billRepo.editBill(base, formParams(base, { name: "Renamed" }));
    const raw = await a.rawBill();
    expect([raw.amountPaid, raw.isSkipped, raw.name]).toEqual([0, false, "Renamed"]);
  });

  it("after an edit-vs-roll race Bills, Month Cycle and the Dashboard still count ONE outstanding obligation; the edit applies to future cycles only", async () => {
    const a = client();
    const b = client();
    const staleBase = await openFormThenRoll(a);
    await b.billRepo.editBill(staleBase, formParams(staleBase, { amount: 1_400 }));
    await Promise.all([a.open(), b.open()]); // both tabs reopen Bills afterwards

    const cycles = (await a.occRepo.getAll()).map((occurrence) => ({ billId: BILL, occurrence }));
    const outstanding = outstandingBillOccurrences(cycles, NOW);
    const stats = billObligationStats(outstanding, NOW);
    const month = billObligationsInCycle(outstanding, CYCLE, NOW);
    const rows = dashboardBillRows(outstanding, new Map([[BILL, "Electricity"]]), NOW);

    expect(cycles).toHaveLength(2);
    expect(outstanding).toHaveLength(1);
    expect(stats.outstandingTotal).toBe(1_000); // the already-created cycle keeps its own amount
    expect(month.total).toBe(stats.outstandingTotal);
    expect(rows).toHaveLength(1);
    expect((await a.bill()).amount).toBe(1_400); // the edit is on the template for cycles created from now on
  });
});
