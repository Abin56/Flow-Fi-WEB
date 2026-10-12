/**
 * People "Postpone payment" (real Firestore emulator, real `PaymentDeferralRepository` transaction).
 * Proves the deferral writes ONLY timing metadata (`paymentDeferrals`, and the obligation's own
 * `followUps` reminder) — every financial document (accounts, transactions, expenses, people, ledger,
 * installments) is byte-identical before and after — and that concurrent, stale, repeated and retried
 * writes can never double-apply or overwrite newer state.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPersonCycleStatement, cycleContaining, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { deferralView, type PostponeRequest, type UndoRequest } from "@/lib/engines/person-payment-deferral";
import { ledgerEntryFromFirestore } from "@/lib/models/person";
import { paymentDeferralFromData } from "@/lib/models/person-payment-deferral";
import { PaymentDeferralError, PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";

const PROJECT_ID = "flowfi-payment-deferral-test";
const UID = "deferral-owner";
const SD = 18;
const d = (month: number, day: number, year = 2026) => new Date(year, month - 1, day);
const NOW = d(10, 12);
const NOV = cycleContaining(d(11, 1), SD); // 18 Oct – 17 Nov
const DEC = cycleContaining(d(12, 1), SD);
const JAN = cycleContaining(d(1, 1, 2027), SD);

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const ts = (x: Date) => Timestamp.fromDate(x);

function ledgerDoc(personId: string, type: string, amount: number, date: Date, patch: Record<string, unknown> = {}) {
  return {
    personId,
    type,
    amount,
    date: ts(date),
    note: "",
    transactionRef: null,
    parentEntryId: null,
    increasesBalance: true,
    createdAt: ts(date),
    receivedStatus: "yetToReceive",
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...patch,
  };
}

function personDoc(name: string, currentBalance: number) {
  return { name, phone: null, email: null, notes: "", avatarColorValue: 0, openingBalance: 0, currentBalance, createdAt: ts(d(1, 1)), deletedAt: null, lastEditedAt: null, editHistory: [] };
}

/**
 * A ₹6,000 dinner paid from my bank account, split three ways: SHAMBU (A) and B each owe ₹2,000, my share
 * ₹2,000. Plus an EMI where A repays my installments (share of a lender installment).
 */
async function seed() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const u = (...p: string[]) => doc(db, "users", UID, ...p);
  await setDoc(u("accounts", "bank"), { name: "Bank", balance: 44000, openingBalance: 50000, deletedAt: null });
  await setDoc(u("transactions", "txn-6000"), { accountId: "bank", amount: 6000, type: "expense", dateTime: ts(d(10, 5)), categoryId: "food", description: "Trip dinner", deletedAt: null });
  await setDoc(u("expenses", "exp-6000"), { transactionId: "txn-6000", totalAmount: 6000, participants: [{ personId: "A", share: 2000 }, { personId: "B", share: 2000 }], myShare: 2000, deletedAt: null });
  await setDoc(u("people", "A"), personDoc("SHAMBU", 3500));
  await setDoc(u("people", "B"), personDoc("B", 2000));
  await setDoc(u("people", "A", "ledger", "share-a"), ledgerDoc("A", "gave", 2000, d(10, 5), { transactionRef: "txn-6000", sourceKind: "splitExpense", note: "Split: Trip dinner" }));
  await setDoc(u("people", "B", "ledger", "share-b"), ledgerDoc("B", "gave", 2000, d(10, 5), { transactionRef: "txn-6000", sourceKind: "splitExpense", note: "Split: Trip dinner" }));
  // Legacy entry: no sourceKind, no newer fields.
  await setDoc(u("people", "A", "ledger", "legacy-gave"), ledgerDoc("A", "gave", 1500, d(9, 20), { note: "Cash lent" }));
  await setDoc(u("paymentSchedules", "S1", "installments", "I1"), { scheduleId: "S1", sequenceNumber: 1, dueDate: ts(d(10, 10)), amountDue: 1500, amountPaid: 1500, isSkipped: false, deletedAt: null, createdAt: ts(d(1, 1)) });
  return { db, repo: new PaymentDeferralRepository(db, UID) };
}

/** Every financial document, serialized — everything except the two metadata subcollections. */
async function financialSnapshot(db: Firestore) {
  const out: Record<string, unknown> = {};
  const read = async (...path: string[]) => {
    const snap = await getDocs(collection(db, "users", UID, ...(path as [string])));
    for (const s of snap.docs) out[[...path, s.id].join("/")] = JSON.parse(JSON.stringify(s.data(), (_k, v) => (v instanceof Timestamp ? `ts:${v.toMillis()}` : v)));
  };
  await read("accounts");
  await read("transactions");
  await read("expenses");
  await read("people");
  await read("people", "A", "ledger");
  await read("people", "B", "ledger");
  await read("paymentSchedules", "S1", "installments");
  return out;
}

async function deferralOf(db: Firestore, personId: string, key: string) {
  const snap = await getDoc(doc(db, "users", UID, "people", personId, "paymentDeferrals", encodeURIComponent(key)));
  return snap.exists() ? paymentDeferralFromData(snap.id, snap.data()) : null;
}

/** Live remaining from the real statement engine over the emulator's ledger. */
async function remainingOf(db: Firestore, personId: string, entryId: string, now: Date) {
  const entries = (await getDocs(collection(db, "users", UID, "people", personId, "ledger"))).docs.map((s) => ledgerEntryFromFirestore(s)) as StatementLedgerEntry[];
  const s = buildPersonCycleStatement({
    person: { id: personId, name: personId, openingBalance: 0, createdAt: d(1, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: { start: d(1, 1, 1970), end: cycleContaining(now, SD).end },
    now,
  });
  return { remaining: s.rows.find((r) => r.key === `ledger:${entryId}`)?.remainingNow ?? 0, toReceive: s.toReceive };
}

let n = 0;
function postpone(patch: Partial<PostponeRequest> = {}): PostponeRequest {
  return {
    action: "postpone",
    requestId: `r${++n}`,
    expectedRevision: 0,
    personId: "A",
    obligationKey: "ledger:share-a",
    obligationTitle: "Trip dinner",
    now: NOW,
    startDay: SD,
    obligationDate: d(10, 5),
    remaining: 2000,
    target: NOV,
    reason: "moreTime",
    note: null,
    reminder: null,
    ...patch,
  };
}
const undo = (patch: Partial<UndoRequest> = {}): UndoRequest => ({
  action: "undo",
  requestId: `r${++n}`,
  expectedRevision: 1,
  personId: "A",
  obligationKey: "ledger:share-a",
  obligationTitle: "Trip dinner",
  now: NOW,
  startDay: SD,
  ...patch,
});

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("Postpone payment — accounting integrity", () => {
  it("SHAMBU's ₹2,000: only timing metadata is written; every financial document is unchanged", async () => {
    const { db, repo } = await seed();
    const before = await financialSnapshot(db);
    const receivableBefore = await remainingOf(db, "A", "share-a", NOW);

    const res = await repo.apply(postpone());
    expect(res.outcome).toBe("written");

    expect(await financialSnapshot(db)).toEqual(before); // accounts, transactions, expense split, people balances, ledger, installments
    const after = await remainingOf(db, "A", "share-a", NOW);
    expect(after).toEqual(receivableBefore);
    expect(after.remaining).toBe(2000);

    const stored = (await getDoc(doc(db, "users", UID, "people", "A", "paymentDeferrals", encodeURIComponent("ledger:share-a")))).data()!;
    expect(JSON.stringify(stored)).not.toMatch(/"amount"|remaining/);
    const deferral = paymentDeferralFromData("x", stored);
    expect(deferral.expected!.cycle.start).toEqual(d(10, 18));
    expect(deferral.revision).toBe(1);
    // No new ledger row, no duplicate receivable, no reminder invented.
    expect((await getDocs(collection(db, "users", UID, "people", "A", "followUps"))).size).toBe(0);
  });

  it("shared expense: postponing A leaves B's share, my share and the ₹6,000 expense untouched", async () => {
    const { db, repo } = await seed();
    await repo.apply(postpone());
    expect((await getDocs(collection(db, "users", UID, "people", "B", "paymentDeferrals"))).size).toBe(0);
    expect(await deferralOf(db, "B", "ledger:share-b")).toBeNull();
    const expense = (await getDoc(doc(db, "users", UID, "expenses", "exp-6000"))).data()!;
    expect(expense.totalAmount).toBe(6000);
    expect(expense.participants).toEqual([{ personId: "A", share: 2000 }, { personId: "B", share: 2000 }]);
  });

  it("EMI participant share: the person's reimbursement timing moves; the lender installment never changes", async () => {
    const { db, repo } = await seed();
    const before = await financialSnapshot(db);
    await repo.apply(postpone({ obligationKey: "emi-inst:I1", obligationTitle: "Phone EMI", obligationDate: d(10, 10), remaining: 1500 }));
    expect(await financialSnapshot(db)).toEqual(before);
    expect((await deferralOf(db, "A", "emi-inst:I1"))!.state).toBe("active");
  });

  it("legacy obligation without sourceKind / deferral metadata can be postponed", async () => {
    const { db, repo } = await seed();
    await repo.apply(postpone({ obligationKey: "ledger:legacy-gave", obligationDate: d(9, 20), remaining: 1500 }));
    expect((await deferralOf(db, "A", "ledger:legacy-gave"))!.expected!.cycle.end).toEqual(NOV.end);
  });
});

describe("Postpone payment — partial payments", () => {
  it("₹800 received, ₹1,200 postponed; ₹500 more → ₹700 expected; fully paid → resolved; revert → open again", async () => {
    const { db, repo } = await seed();
    const ledger = (id: string) => doc(db, "users", UID, "people", "A", "ledger", id);
    await setDoc(ledger("pay-800"), ledgerDoc("A", "receivedBack", 800, d(10, 8), { parentEntryId: "share-a" }));
    const { remaining } = await remainingOf(db, "A", "share-a", NOW);
    expect(remaining).toBe(1200);
    await repo.apply(postpone({ remaining }));

    await setDoc(ledger("pay-500"), ledgerDoc("A", "receivedBack", 500, d(10, 20), { parentEntryId: "share-a" }));
    const later = d(10, 21);
    const deferral = (await deferralOf(db, "A", "ledger:share-a"))!;
    const r1 = await remainingOf(db, "A", "share-a", later);
    expect(r1.remaining).toBe(700);
    expect(deferralView(deferral, r1.remaining, SD, later)).toMatchObject({ status: "expectedNow", remaining: 700 });

    await setDoc(ledger("pay-700"), ledgerDoc("A", "receivedBack", 700, d(10, 22), { parentEntryId: "share-a" }));
    const r2 = await remainingOf(db, "A", "share-a", d(10, 23));
    expect(r2.remaining).toBe(0);
    expect(deferralView(deferral, r2.remaining, SD, d(10, 23))!.status).toBe("resolved");
    // A fully paid obligation can't be postponed again.
    expect(await rejection(repo.apply(postpone({ expectedRevision: 1, remaining: 0, target: DEC })))).toMatchObject({ code: "invalid" });

    await updateDoc(ledger("pay-700"), { deletedAt: ts(d(10, 24)) }); // payment reverted
    const r3 = await remainingOf(db, "A", "share-a", d(10, 24));
    expect(r3.remaining).toBe(700);
    expect(deferralView(deferral, r3.remaining, SD, d(10, 24))!.status).toBe("expectedNow");
  });
});

describe("Postpone payment — concurrency, stale writes, retries", () => {
  it("two tabs postponing the same obligation at once: exactly one wins, the other gets a conflict", async () => {
    const { db, repo } = await seed();
    const results = await Promise.allSettled([repo.apply(postpone({ target: NOV })), repo.apply(postpone({ target: JAN }))]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(PaymentDeferralError);
    expect(failed[0].reason.code).toBe("conflict");
    const stored = (await deferralOf(db, "A", "ledger:share-a"))!;
    expect(stored.revision).toBe(1);
    expect(stored.history).toHaveLength(1);
  });

  it("double-click (same request twice, concurrently): one write, the second is a no-op", async () => {
    const { db, repo } = await seed();
    const req = postpone();
    const [a, b] = await Promise.all([repo.apply(req), repo.apply(req)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["noop", "written"]);
    const stored = (await deferralOf(db, "A", "ledger:share-a"))!;
    expect(stored.revision).toBe(1);
    expect(stored.frames).toHaveLength(1);
  });

  it("retry after a lost response is idempotent", async () => {
    const { db, repo } = await seed();
    const req = postpone();
    await repo.apply(req);
    expect((await repo.apply(req)).outcome).toBe("noop");
    expect((await deferralOf(db, "A", "ledger:share-a"))!.revision).toBe(1);
  });

  it("a stale tab can't overwrite a newer move, nor undo from an old revision", async () => {
    const { db, repo } = await seed();
    await repo.apply(postpone({ target: NOV }));
    await repo.apply(postpone({ expectedRevision: 1, target: DEC }));
    expect(await rejection(repo.apply(postpone({ expectedRevision: 1, target: JAN })))).toMatchObject({ code: "conflict" });
    expect(await rejection(repo.apply(undo({ expectedRevision: 1 })))).toMatchObject({ code: "conflict" });
    expect((await deferralOf(db, "A", "ledger:share-a"))!.expected!.cycle.end).toEqual(DEC.end);
  });

  it("deleted obligation can't be postponed; restoring it brings the existing deferral back", async () => {
    const { db, repo } = await seed();
    await repo.apply(postpone());
    const share = doc(db, "users", UID, "people", "A", "ledger", "share-a");
    await updateDoc(share, { deletedAt: ts(d(10, 13)) });
    expect(await rejection(repo.apply(postpone({ expectedRevision: 1, target: DEC })))).toMatchObject({ code: "invalid" });
    await updateDoc(share, { deletedAt: null });
    expect((await deferralOf(db, "A", "ledger:share-a"))!.state).toBe("active");
    expect((await repo.apply(postpone({ expectedRevision: 1, target: DEC }))).outcome).toBe("written");
  });

  it("delete racing a postpone: either the postpone is rejected, or it committed before the delete — never a write against a deleted entry", async () => {
    const { db, repo } = await seed();
    const share = doc(db, "users", UID, "people", "A", "ledger", "share-a");
    const [p] = await Promise.allSettled([repo.apply(postpone()), updateDoc(share, { deletedAt: ts(d(10, 13)) })]);
    const stored = await deferralOf(db, "A", "ledger:share-a");
    if (p.status === "rejected") expect(stored).toBeNull();
    else expect(stored!.revision).toBe(1);
    // Either way the deleted obligation has no live remaining, so nothing is shown as expected.
    expect((await remainingOf(db, "A", "share-a", NOW)).remaining).toBe(0);
  });

  it("a deleted person can't be postponed against", async () => {
    const { db, repo } = await seed();
    await updateDoc(doc(db, "users", UID, "people", "A"), { deletedAt: ts(d(10, 12)) });
    expect(await rejection(repo.apply(postpone()))).toMatchObject({ code: "invalid" });
  });
});

describe("Postpone payment — reminders", () => {
  it("an old reminder no longer reads overdue after postponing; undo restores it exactly", async () => {
    const { db, repo } = await seed();
    const ref = doc(db, "users", UID, "people", "A", "followUps", encodeURIComponent("ledger:share-a"));
    await setDoc(ref, { personId: "A", obligationKey: "ledger:share-a", obligationTitle: "Trip dinner", kind: "date", remindOn: ts(d(10, 10)), state: "active", createdAt: ts(d(10, 1)), updatedAt: ts(d(10, 1)), dismissedAt: null });

    await repo.apply(postpone());
    let f = (await getDoc(ref)).data()!;
    expect(f.remindOn.toDate()).toEqual(d(10, 18));
    expect(f.kind).toBe("nextCycle");
    expect((await getDocs(collection(db, "users", UID, "people", "A", "followUps"))).size).toBe(1); // no duplicate reminder

    await repo.apply(undo());
    f = (await getDoc(ref)).data()!;
    expect(f.remindOn.toDate()).toEqual(d(10, 10));
    expect(f.kind).toBe("date");
    expect((await deferralOf(db, "A", "ledger:share-a"))!.state).toBe("cleared");
  });

  it("an explicit reminder date is used as-is and removed again by undo", async () => {
    const { db, repo } = await seed();
    const ref = doc(db, "users", UID, "people", "A", "followUps", encodeURIComponent("ledger:share-a"));
    await repo.apply(postpone({ reminder: { kind: "date", remindOn: d(10, 25) } }));
    expect((await getDoc(ref)).data()!.remindOn.toDate()).toEqual(d(10, 25));
    await repo.apply(undo());
    expect((await getDoc(ref)).exists()).toBe(false);
  });
});
