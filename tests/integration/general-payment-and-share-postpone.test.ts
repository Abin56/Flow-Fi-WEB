/**
 * General payment (People "Reduce the overall balance") and the in-dialog Loan / EMI share postponement — real
 * Firestore emulator, real repositories, synthetic data only.
 *
 * SANJU owes ₹29,000 across three items and pays ₹20,000 now, the remaining ₹9,000 next month:
 *  - the payment is ONE cash leg and ONE settlement entry tied to no item (no `parentEntryId`, no `obligationRef`);
 *  - the account moves once, by ₹20,000; SANJU's balance is ₹9,000; every item keeps its own remaining;
 *  - a double submit with the same idempotency key writes nothing more; edit and revert stay exact;
 *  - money already in the account ("recorded earlier") moves no account.
 * EMI shares: AMMA and JOHN haven't given their share of one installment. "Postpone to next month" writes one
 * deferral per person — timing metadata only: no ledger entry, no transaction, no account or balance change, and
 * the lender installment (its due date and amount paid) is untouched. A retry is a no-op.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, setDoc, Timestamp, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { planSharePostpone } from "@/features/loans/lib/share-postpone-plan";
import { buildPersonCycleStatement, cycleContaining, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { defaultTargetCycle } from "@/lib/engines/person-payment-deferral";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { installmentFromFirestore, installmentPaymentFromFirestore, installmentPaymentToFirestore, installmentToFirestore } from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
} from "@/lib/models/person";
import { paymentDeferralFromData } from "@/lib/models/person-payment-deferral";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { InstallmentPaymentRepository, InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

// Distinct project id — concurrently-run integration files must not share one (clearFirestore cross-talk).
const PROJECT_ID = "flowfi-general-payment";
const UID = "general-payment-owner";
const SD = 18;
const NOW = new Date(2026, 9, 12);
const round = (v: number) => Math.round(v * 100) / 100;

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

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const col = (...path: string[]) => collection(db, "users", UID, ...(path as [string]));
  const accounts = new AccountRepository(col("accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(col("transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), accounts);
  const people = new PersonRepository(col("people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(col("people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const installments = (scheduleId: string) =>
    new InstallmentRepository(col("paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const paymentsFor = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: people,
      ledgerRepository: ledgerFor(personId),
      transactionRepository: transactions,
      advanceApplications: col("people", personId, "advanceApplications").withConverter({ toFirestore: advanceApplicationToFirestore, fromFirestore: advanceApplicationFromFirestore }),
      expenseDocRef: (id) => doc(col("expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore }), id),
      installmentDocRef: (scheduleId, id) => installments(scheduleId).docRef(id),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) =>
        new InstallmentPaymentRepository(
          col("paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
          installments(scheduleId),
        ).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
      purposeFunds: col("people", personId, "purposeFunds").withConverter({ toFirestore: purposeFundToFirestore, fromFirestore: purposeFundFromFirestore }),
    });
  return { db, accounts, transactions, people, ledgerFor, paymentsFor, deferrals: new PaymentDeferralRepository(db, UID) };
}
type R = ReturnType<typeof setup>;

const ITEMS = [
  ["rent", 12_000, new Date(2026, 8, 20, 10), "Rent share"],
  ["fees", 10_000, new Date(2026, 8, 25, 10), "College fees"],
  ["phone", 7_000, new Date(2026, 9, 2, 10), "Phone"],
] as const;

async function seed(r: R) {
  const bank = await r.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const sanju = await r.people.createPerson({ name: "SANJU", avatarColorValue: 0, openingBalance: 0 });
  const ids: Record<string, string> = {};
  for (const [name, amount, date, note] of ITEMS) {
    const person = (await r.people.getByKey(sanju.id))!;
    const { entry } = await r.ledgerFor(sanju.id).addEntryWithTransaction(person, { type: "gave", amount, date, note }, { type: "expense", accountId: bank.id, categoryId: "personal-loan" }, r.transactions);
    ids[name] = entry.id;
  }
  return { bank, sanju, ids };
}

const balanceOf = async (r: R, id: string) => (await r.accounts.getByKey(id))!.currentBalance;
const personBalance = async (r: R, id: string) => (await r.people.getByKey(id))!.currentBalance;
const ledger = async (r: R, personId: string) =>
  (await getDocs(collection(r.db, "users", UID, "people", personId, "ledger"))).docs.map((s) => ledgerEntryFromFirestore(s)).filter((e) => e.deletedAt == null);
const liveTransactions = async (r: R) => (await getDocs(collection(r.db, "users", UID, "transactions"))).docs.filter((s) => s.data().deletedAt == null).map((s) => s.data());

async function statementOf(r: R, personId: string) {
  return buildPersonCycleStatement({
    person: { id: personId, name: "SANJU", openingBalance: 0, createdAt: new Date(2026, 0, 1) },
    ledgerEntries: (await ledger(r, personId)) as StatementLedgerEntry[],
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: cycleContaining(NOW, SD),
    now: NOW,
  });
}

const general = (accountId: string, amount: number, extra: Partial<RecordPaymentInput> = {}): RecordPaymentInput => ({
  direction: "theyPaid",
  amount,
  date: new Date(2026, 9, 5, 9),
  accountId,
  lines: [{ key: "general", amount, route: { kind: "general" } }],
  extra: null,
  ...extra,
});

describe("General payment — ₹20,000 toward ₹29,000, no item chosen", () => {
  it("one cash leg, one unlinked entry; account +₹20,000 once; balance ₹9,000; every item keeps its remaining", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const bankBefore = await balanceOf(r, bank.id);
    const txBefore = (await liveTransactions(r)).length;
    expect(await personBalance(r, sanju.id)).toBe(29_000);

    const paymentId = await r.paymentsFor(sanju.id).recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 20_000));

    expect(await balanceOf(r, bank.id)).toBe(round(bankBefore + 20_000));
    expect(await personBalance(r, sanju.id)).toBe(9_000);
    const tx = await liveTransactions(r);
    expect(tx.length).toBe(txBefore + 1);
    const settlements = (await ledger(r, sanju.id)).filter((e) => e.paymentId === paymentId);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ type: "receivedBack", amount: 20_000, parentEntryId: null, obligationRef: null, sourceKind: "manual" });

    const s = await statementOf(r, sanju.id);
    expect([s.currentPending, s.toReceive, s.cashReceived]).toEqual([9_000, 9_000, 20_000]);
    expect(s.rows.filter((x) => x.kind === "obligation").map((x) => x.remainingNow)).toEqual([12_000, 10_000, 7_000]);
    expect(s.rows.find((x) => x.kind === "settlement")?.settlesKey).toBeUndefined();
  });

  it("double submit with the same idempotency key → one payment, one account movement", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const bankBefore = await balanceOf(r, bank.id);
    const input = general(bank.id, 20_000, { idempotencyKey: "general-sanju-1" });
    const first = await r.paymentsFor(sanju.id).recordPayment((await r.people.getByKey(sanju.id))!, input);
    // The retry is built from the screen as it was (stale balance) — the key catches it before anything else.
    const second = await r.paymentsFor(sanju.id).recordPayment({ ...(await r.people.getByKey(sanju.id))!, currentBalance: 29_000 }, input);
    expect(second).toBe(first);
    expect(await balanceOf(r, bank.id)).toBe(round(bankBefore + 20_000));
    expect(await personBalance(r, sanju.id)).toBe(9_000);
    expect((await ledger(r, sanju.id)).filter((e) => e.type === "receivedBack")).toHaveLength(1);
  });

  it("the remaining ₹9,000 next month settles the balance; items are still not marked paid one by one", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const pay = r.paymentsFor(sanju.id);
    await pay.recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 20_000));
    await pay.recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 9_000, { date: new Date(2026, 10, 5, 9) }));
    expect(await personBalance(r, sanju.id)).toBe(0);
    const s = buildPersonCycleStatement({
      person: { id: sanju.id, name: "SANJU", openingBalance: 0, createdAt: new Date(2026, 0, 1) },
      ledgerEntries: (await ledger(r, sanju.id)) as StatementLedgerEntry[],
      loanIds: new Set(),
      emis: [],
      loans: [],
      installments: [],
      cycle: cycleContaining(new Date(2026, 10, 10), SD),
      now: new Date(2026, 10, 10),
    });
    expect([s.direction, s.currentPending, s.toReceive]).toEqual(["settled", 0, 0]);
  });

  it("edit (₹20,000 → ₹25,000) and revert stay exact — the account and the balance follow, no ghost entries", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const bankBefore = await balanceOf(r, bank.id);
    const pay = r.paymentsFor(sanju.id);
    const id = await pay.recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 20_000));
    const edited = await pay.editPayment((await r.people.getByKey(sanju.id))!, id, general(bank.id, 25_000));
    expect(await balanceOf(r, bank.id)).toBe(round(bankBefore + 25_000));
    expect(await personBalance(r, sanju.id)).toBe(4_000);
    expect((await ledger(r, sanju.id)).filter((e) => e.type === "receivedBack").map((e) => [e.paymentId, e.amount])).toEqual([[edited, 25_000]]);
    await pay.revertPayment((await r.people.getByKey(sanju.id))!, edited);
    expect(await balanceOf(r, bank.id)).toBe(bankBefore);
    expect(await personBalance(r, sanju.id)).toBe(29_000);
    expect((await ledger(r, sanju.id)).filter((e) => e.type === "receivedBack")).toHaveLength(0);
  });

  it("money already in the account (recorded earlier): the balance drops, the account doesn't move", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const bankBefore = await balanceOf(r, bank.id);
    await r.paymentsFor(sanju.id).recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 20_000, { recordedEarlier: true }));
    expect(await balanceOf(r, bank.id)).toBe(bankBefore);
    expect(await personBalance(r, sanju.id)).toBe(9_000);
    expect((await ledger(r, sanju.id)).find((e) => e.type === "receivedBack")).toMatchObject({ recordedEarlier: true, parentEntryId: null, obligationRef: null });
  });

  it("only one general part per payment; money beyond the balance must still be classified (advance)", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const pay = r.paymentsFor(sanju.id);
    const two = general(bank.id, 20_000, {
      lines: [
        { key: "general", amount: 10_000, route: { kind: "general" } },
        { key: "general", amount: 10_000, route: { kind: "general" } },
      ],
    });
    await expect(pay.recordPayment((await r.people.getByKey(sanju.id))!, two)).rejects.toThrow(/one general part/);
    await expect(pay.recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 30_000, { lines: [{ key: "general", amount: 29_000, route: { kind: "general" } }] }))).rejects.toThrow(
      /Every rupee/,
    );
    await pay.recordPayment((await r.people.getByKey(sanju.id))!, general(bank.id, 30_000, { lines: [{ key: "general", amount: 29_000, route: { kind: "general" } }], extra: { kind: "advance", amount: 1_000 } }));
    // The cached person balance carries the advance (existing behaviour); the statement keeps it apart from what is owed.
    expect(await personBalance(r, sanju.id)).toBe(-1_000);
    const s = await statementOf(r, sanju.id);
    expect([s.currentPending, s.advanceBalance]).toEqual([0, -1_000]);
    expect((await ledger(r, sanju.id)).filter((e) => e.sourceKind === "advance").map((e) => e.amount)).toEqual([1_000]);
  });
});

describe("EMI shares — 'Not received yet — postpone to next month' from the Pay dialog", () => {
  it("one deferral per person; no ledger entry, no transaction, no balance; the lender installment is untouched; retry is a no-op", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
    const john = await r.people.createPerson({ name: "JOHN", avatarColorValue: 0, openingBalance: 0 });
    // The lender installment (as stored by the EMI schedule) — it must never change.
    const due = new Date(2026, 9, 10);
    const installmentRef = doc(r.db, "users", UID, "paymentSchedules", "emi-phone", "installments", "i1");
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, installmentRef.path), { id: "i1", scheduleId: "emi-phone", amountDue: 3_000, amountPaid: 0, dueDate: Timestamp.fromDate(due), sequenceNumber: 1, deletedAt: null });
    });

    const snapshot = async () =>
      JSON.stringify({
        installment: (await getDocs(collection(r.db, "users", UID, "paymentSchedules", "emi-phone", "installments"))).docs.map((s) => s.data()),
        tx: await liveTransactions(r),
        bank: await balanceOf(r, bank.id),
        people: [await personBalance(r, amma.id), await personBalance(r, john.id)],
        ledger: [...(await ledger(r, amma.id)), ...(await ledger(r, john.id))].length,
      });
    const before = await snapshot();

    const ids = new Map<string, string>();
    const people = [
      { personId: amma.id, personName: "AMMA", obligations: [{ key: "emi-inst:i1", title: "Phone EMI", remaining: 1_000 }] },
      { personId: john.id, personName: "JOHN", obligations: [{ key: "emi-inst:i1", title: "Phone EMI", remaining: 1_000 }] },
    ];
    const target = defaultTargetCycle(due, NOW, SD, null);
    const plan = () =>
      planSharePostpone({
        people,
        dateOf: () => due,
        deferralsByPerson: {},
        target,
        reminder: null,
        startDay: SD,
        now: NOW,
        requestIdFor: (personId, key) => ids.get(`${personId}|${key}`) ?? (ids.set(`${personId}|${key}`, `req-${personId}`), `req-${personId}`),
      });
    const requests = plan();
    expect(requests.map((q) => [q.personId, q.obligationKey])).toEqual([
      [amma.id, "emi-inst:i1"],
      [john.id, "emi-inst:i1"],
    ]);
    for (const q of requests) expect((await r.deferrals.apply(q)).outcome).toBe("written");

    // Next month (the cycle after this one), for both; nothing financial moved, the installment is as it was.
    for (const p of [amma.id, john.id]) {
      const snap = (await getDocs(collection(r.db, "users", UID, "people", p, "paymentDeferrals"))).docs.map((s) => paymentDeferralFromData(s.id, s.data()));
      expect(snap).toHaveLength(1);
      expect(snap[0].state).toBe("active");
      expect(snap[0].expected!.cycle.start.getTime()).toBe(target.start.getTime());
    }
    expect(target.start.getTime()).toBe(cycleContaining(new Date(2026, 9, 25), SD).start.getTime());
    expect(await snapshot()).toBe(before);

    // A retry of the same intent (lost response) writes nothing.
    for (const q of plan()) expect((await r.deferrals.apply(q)).outcome).toBe("noop");
    expect(await snapshot()).toBe(before);
  });
});
