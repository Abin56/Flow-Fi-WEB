/**
 * Bill cycle creation under concurrency (real Firestore emulator, TWO independent clients = two tabs/devices).
 *
 * Synthetic data only. Proves the A1/A2 fixes in `BillOccurrenceRepository`:
 *   A1 — two clients opening the same bill at once create ONE cycle (first cycle, adopted legacy state and roll-forward);
 *   A2 — a roll-forward from a stale copy of the bill never overwrites a concurrent edit (name / amount / category / unknown fields);
 *   legacy random-id cycles are adopted as-is — never duplicated, rewritten, merged or deleted — even when the caller's list is stale;
 *   an existing cycle (with payment progress) is never overwritten by a second creator;
 *   Dashboard, My Money and Month Cycle (one shared obligation engine) show ONE obligation, not two;
 *   payments still post exactly once and balances do not drift.
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, Timestamp, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { dashboardBillRows } from "@/features/dashboard/lib/bill-obligation-items";
import { billObligationStats, billObligationsInCycle, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import {
  billFromFirestore,
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  billToFirestore,
  type Bill,
  type BillOccurrence,
} from "@/lib/models/bill";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { BillOccurrenceRepository, BillRepository, billCycleId } from "@/lib/repositories/bill-repository";

const PROJECT_ID = "flowfi-bill-cycle-concurrency";
const UID = "bill-cycle-owner";
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

/** One browser tab / device: its own Firestore instance and its own repositories. */
function client() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const billsCol = collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore });
  const occCol = collection(db, "users", UID, "bills", BILL, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore });
  const billRepo = new BillRepository(billsCol);
  const occRepo = new BillOccurrenceRepository(occCol, billRepo, doc(db, "users", UID, "bills", BILL), collection(db, "users", UID, "bills", BILL, "payments"));
  const rawBill = () => getDoc(doc(db, "users", UID, "bills", BILL));
  const rawOccurrences = async () => (await getDocs(collection(db, "users", UID, "bills", BILL, "occurrences"))).docs.map((d) => ({ id: d.id, ...d.data() }));
  /** What the Bills page does on open: read the bill and its cycles, then ensure the current one. */
  async function open(staleBill?: Bill, staleList?: BillOccurrence[]) {
    const bill = staleBill ?? (await billRepo.getByKey(BILL))!;
    return occRepo.ensureCurrentOccurrence(bill, staleList ?? (await occRepo.getAll()));
  }
  return { db, billsCol, occCol, billRepo, occRepo, rawBill, rawOccurrences, open };
}
type C = ReturnType<typeof client>;

function monthlyBill(over: Partial<Bill> = {}): Bill {
  return {
    id: BILL, name: "Electricity", amount: 1_000, nextDueDate: monthsAgo(2), recurrence: "monthly", accountId: null, categoryId: "utilities",
    customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}
const seedBill = (c: C, bill = monthlyBill()) => setDoc(doc(c.billsCol, BILL), bill);
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** A legacy cycle: random (non-deterministic) id, exactly as a pre-fix or Flutter client wrote it. */
function legacyCycle(id: string, dueDate: Date, over: Partial<BillOccurrence> = {}): BillOccurrence {
  return { id, billId: BILL, dueDate, amount: 1_000, amountPaid: 0, isSkipped: false, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...over };
}

describe("A1 — one cycle per bill per due day, however many tabs race", () => {
  it("two tabs opening a brand-new bill at once create ONE first cycle (repeated rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      await testEnv.clearFirestore();
      const a = client();
      const b = client();
      await seedBill(a);
      const [ra, rb] = await Promise.all([a.open(), b.open()]);
      const cycles = await a.occRepo.getAll();
      expect(cycles, `round ${round}`).toHaveLength(1);
      expect(ra.id).toBe(rb.id);
      expect(ra.id).toBe(billCycleId(BILL, monthsAgo(2)));
    }
  });

  it("two tabs rolling a settled cycle forward at once create ONE next cycle and advance the bill ONCE", async () => {
    for (let round = 0; round < 5; round++) {
      await testEnv.clearFirestore();
      const a = client();
      const b = client();
      await seedBill(a);
      const first = await a.open();
      await a.occRepo.markPaid(first);
      const [staleA, staleB] = await Promise.all([a.occRepo.getAll(), b.occRepo.getAll()]);
      const billA = (await a.billRepo.getByKey(BILL))!;
      const billB = (await b.billRepo.getByKey(BILL))!;

      const [ra, rb] = await Promise.all([a.open(billA, staleA), b.open(billB, staleB)]);

      expect(await a.rawOccurrences(), `round ${round}`).toHaveLength(2);
      expect(ra.id).toBe(rb.id);
      expect(dayKey(ra.dueDate)).toBe(dayKey(monthsAgo(1)));
      const bill = (await a.billRepo.getByKey(BILL))!;
      expect(dayKey(bill.nextDueDate)).toBe(dayKey(monthsAgo(1)));
      expect(bill.editHistory.filter((e) => e.field === "nextDueDate")).toHaveLength(1);
    }
  });

  it("a long chain of rolls from two tabs never branches: exactly one cycle per month", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    for (let i = 0; i < 3; i++) {
      const cur = await a.open();
      await a.occRepo.markPaid(cur);
      await Promise.all([a.open(), b.open()]);
    }
    const cycles = (await a.occRepo.getAll()).sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime());
    expect(cycles).toHaveLength(4);
    expect(new Set(cycles.map((c) => dayKey(c.dueDate))).size).toBe(4);
  });

  it("an existing cycle is never overwritten: a second creator holding a stale list gets the real one, progress intact", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const first = await a.open();
    await a.occRepo.markPaid(first);
    const staleB = await b.occRepo.getAll(); // B has only the settled first cycle
    const next = await a.open(); // A creates the next cycle...
    await a.occRepo.applyPayment(next, 300); // ...and records part-payment against it.

    const got = await b.open(undefined, staleB); // B, with a stale list, "rolls forward" the same cycle.

    expect(got.id).toBe(next.id);
    expect(got.amountPaid).toBe(300);
    const stored = (await a.occRepo.getByKey(next.id))!;
    expect(stored.amountPaid).toBe(300);
    expect(await a.rawOccurrences()).toHaveLength(2);
  });

  it("adopting a pre-migration bill's progress from two tabs yields ONE occurrence carrying the progress; payments point at it", async () => {
    const a = client();
    const b = client();
    // Pre-migration bill document: in-progress state lives ON the bill, not on an occurrence.
    await setDoc(doc(a.db, "users", UID, "bills", BILL), { ...billToFirestore(monthlyBill()), amountPaid: 400, isSkipped: false });
    const payment = { billId: BILL, amount: 400, date: Timestamp.fromDate(monthsAgo(2)), note: "", createdAt: Timestamp.fromDate(monthsAgo(2)), deletedAt: null, lastEditedAt: null, editHistory: [] };
    await setDoc(doc(a.db, "users", UID, "bills", BILL, "payments", "pay-legacy"), payment);
    const legacyPayments = [{ id: "pay-legacy", ...payment, occurrenceId: null, date: monthsAgo(2), createdAt: monthsAgo(2) }] as never;

    const [ra, rb] = await Promise.all([
      a.occRepo.ensureCurrentOccurrence((await a.billRepo.getByKey(BILL))!, [], { legacyPayments }),
      b.occRepo.ensureCurrentOccurrence((await b.billRepo.getByKey(BILL))!, [], { legacyPayments }),
    ]);

    expect(ra.id).toBe(rb.id);
    expect(await a.rawOccurrences()).toHaveLength(1);
    expect((await a.occRepo.getByKey(ra.id))!.amountPaid).toBe(400);
    expect((await getDoc(doc(a.db, "users", UID, "bills", BILL, "payments", "pay-legacy"))).data()!.occurrenceId).toBe(ra.id);
  });
});

describe("A2 — a roll-forward from a stale bill never overwrites concurrent edits", () => {
  it("amount, name, category and notes edited in another tab survive the roll; the new cycle uses the CURRENT amount", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const first = await a.open();
    await a.occRepo.markPaid(first);

    const staleBill = (await b.billRepo.getByKey(BILL))!; // B's copy: amount 1000, "Electricity", utilities
    const staleList = await b.occRepo.getAll();
    // A edits the bill after B loaded it.
    const current = (await a.billRepo.getByKey(BILL))!;
    await a.billRepo.update({ ...current, amount: 1_500, name: "Electricity (new meter)", categoryId: "bills-and-fees", notes: "revised" });

    const rolled = await b.open(staleBill, staleList);

    const bill = (await a.billRepo.getByKey(BILL))!;
    expect(bill.amount).toBe(1_500);
    expect(bill.name).toBe("Electricity (new meter)");
    expect(bill.categoryId).toBe("bills-and-fees");
    expect(bill.notes).toBe("revised");
    expect(dayKey(bill.nextDueDate)).toBe(dayKey(monthsAgo(1)));
    expect(rolled.amount).toBe(1_500);
    // Only the due-date audit entry was added by the roll; the edit's own history is still there.
    expect(bill.editHistory.filter((e) => e.field === "nextDueDate")).toHaveLength(1);
  });

  it("the roll patches only the due-date fields: a field the model does not parse (pre-migration) stays on the document", async () => {
    const a = client();
    await seedBill(a);
    await setDoc(doc(a.db, "users", UID, "bills", BILL), { ...billToFirestore(monthlyBill()), amountPaid: 0, isSkipped: false });
    const first = await a.open();
    await a.occRepo.markPaid(first);

    await a.open();

    const raw = (await a.rawBill()).data()!;
    expect(raw.amountPaid).toBe(0);
    expect(raw.isSkipped).toBe(false);
    expect(dayKey((await a.billRepo.getByKey(BILL))!.nextDueDate)).toBe(dayKey(monthsAgo(1)));
  });

  it("advanceNextDueDate never moves the due date backwards", async () => {
    const a = client();
    await seedBill(a, monthlyBill({ nextDueDate: monthsAgo(0) }));
    await a.billRepo.advanceNextDueDate((await a.billRepo.getByKey(BILL))!, monthsAgo(3));
    expect(dayKey((await a.billRepo.getByKey(BILL))!.nextDueDate)).toBe(dayKey(monthsAgo(0)));
  });
});

describe("Legacy random-id cycles are adopted, never duplicated or rewritten", () => {
  it("a legacy cycle already exists for the next due day but the caller's list is stale → no second cycle; legacy doc untouched", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const legacyFirst = legacyCycle("legacy-first-AAAA", monthsAgo(2), { amountPaid: 1_000 }); // settled
    const legacyNext = legacyCycle("legacy-next-BBBB", monthsAgo(1), { amountPaid: 250 }); // created by an old/Flutter client
    await setDoc(doc(a.occCol, legacyFirst.id), legacyFirst);
    await setDoc(doc(a.occCol, legacyNext.id), legacyNext);
    const before = await a.rawOccurrences();

    // B only knows the settled first cycle (list loaded before the legacy "next" was written).
    const got = await b.open(undefined, [legacyFirst]);

    expect(got.id).toBe("legacy-next-BBBB");
    expect(got.amountPaid).toBe(250);
    expect(await a.rawOccurrences()).toEqual(before); // nothing created, rewritten, merged or deleted
    expect(dayKey((await a.billRepo.getByKey(BILL))!.nextDueDate)).toBe(dayKey(monthsAgo(1))); // bill pointer caught up
  });

  it("a legacy first cycle with a stale EMPTY list → adopted, no deterministic twin created", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    await setDoc(doc(a.occCol, "legacy-only-CCCC"), legacyCycle("legacy-only-CCCC", monthsAgo(2), { amountPaid: 100 }));

    const got = await b.open(undefined, []);

    expect(got.id).toBe("legacy-only-CCCC");
    expect(await a.rawOccurrences()).toHaveLength(1);
  });

  it("existing legacy duplicates (from the old race) are left exactly as they are — no merge, no delete", async () => {
    const a = client();
    await seedBill(a);
    const d1 = legacyCycle("dup-1-DDDD", monthsAgo(2), { amountPaid: 1_000 });
    const d2 = legacyCycle("dup-2-EEEE", monthsAgo(2));
    await setDoc(doc(a.occCol, d1.id), d1);
    await setDoc(doc(a.occCol, d2.id), d2);
    const before = await a.rawOccurrences();

    await a.open();
    await a.open();

    expect(await a.rawOccurrences()).toEqual(before);
  });

  it("legacy payment history is intact after the new logic rolls past a legacy cycle", async () => {
    const a = client();
    await seedBill(a);
    const legacyFirst = legacyCycle("legacy-paid-FFFF", monthsAgo(2), { amountPaid: 1_000 });
    await setDoc(doc(a.occCol, legacyFirst.id), legacyFirst);
    await setDoc(doc(a.db, "users", UID, "bills", BILL, "payments", "p1"), {
      billId: BILL, occurrenceId: legacyFirst.id, amount: 1_000, date: Timestamp.fromDate(monthsAgo(2)), note: "", createdAt: Timestamp.fromDate(monthsAgo(2)), deletedAt: null, lastEditedAt: null, editHistory: [],
    });

    const next = await a.open();

    expect(dayKey(next.dueDate)).toBe(dayKey(monthsAgo(1)));
    expect((await a.occRepo.getByKey(legacyFirst.id))!.amountPaid).toBe(1_000);
    expect((await getDoc(doc(a.db, "users", UID, "bills", BILL, "payments", "p1"))).data()!.occurrenceId).toBe(legacyFirst.id);
  });
});

describe("Totals after concurrent opens: Dashboard, My Money and Month Cycle count ONE obligation", () => {
  it("two tabs racing a roll-forward leave one outstanding cycle (the old bug doubled it to 2,000)", async () => {
    const a = client();
    const b = client();
    await seedBill(a);
    const first = await a.open();
    await a.occRepo.markPaid(first);
    const [la, lb] = await Promise.all([a.occRepo.getAll(), b.occRepo.getAll()]);
    const [billA, billB] = [(await a.billRepo.getByKey(BILL))!, (await b.billRepo.getByKey(BILL))!];
    await Promise.all([a.open(billA, la), b.open(billB, lb)]);

    // Exactly what `useBillRows().cycles` feeds the three screens: every persisted cycle of the bill.
    const cycles = (await a.occRepo.getAll()).map((occurrence) => ({ billId: BILL, occurrence }));
    const outstanding = outstandingBillOccurrences(cycles, NOW);
    const stats = billObligationStats(outstanding, NOW);
    const month = billObligationsInCycle(outstanding, CYCLE, NOW);
    const rows = dashboardBillRows(outstanding, new Map([[BILL, "Electricity"]]), NOW);

    expect(outstanding).toHaveLength(1);
    expect(stats.outstandingTotal).toBe(1_000);
    expect(month.total).toBe(1_000); // Month Cycle
    expect(month.total).toBe(stats.outstandingTotal); // Bills Stats / My Money share this figure
    expect(rows).toHaveLength(1); // Dashboard shows one row, not two
  });

  it("paying the current cycle after a race posts ONE debit and the balance matches", async () => {
    const a = client();
    const b = client();
    const accounts = new AccountRepository(collection(a.db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
    const payments = new BillPaymentRepository(a.db, UID);
    const acct = await accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await seedBill(a);
    const [ra, rb] = await Promise.all([a.open(), b.open()]);
    expect(ra.id).toBe(rb.id);

    await payments.payFromAccount({ billId: BILL, occurrenceId: ra.id, accountId: acct.id, date: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12), idempotencyKey: "cycle-race-pay-1" });
    await payments.payFromAccount({ billId: BILL, occurrenceId: ra.id, accountId: acct.id, date: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12), idempotencyKey: "cycle-race-pay-1" });

    expect(Math.round((await accounts.getByKey(acct.id))!.currentBalance * 100)).toBe(400_000); // 5,000 − 1,000, once
    expect((await a.occRepo.getByKey(ra.id))!.amountPaid).toBe(1_000);
  });
});
