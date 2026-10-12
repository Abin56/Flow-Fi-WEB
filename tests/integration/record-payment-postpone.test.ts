/**
 * Record Payment → "postpone what stays unpaid" (real Firestore emulator, real repositories). The panel runs two
 * EXISTING writes in order — `PersonPaymentRepository.recordPayment` (the receipt), then one
 * `PaymentDeferralRepository.apply` per item left unpaid, with that item's remaining AFTER the receipt. They are
 * not atomic; this pins what the UI relies on:
 *  - the receipt moves the account exactly once, by the received amount (income and purposes ride inside it);
 *  - a deferral written after it changes no financial document and no balance;
 *  - retrying a deferral with the same request id is a no-op — and never touches the receipt;
 *  - reverting the payment restores every balance; the deferral (timing metadata) is left alone.
 *
 * AMMA owes ₹30,744.06; ₹29,444 is received; ₹15,436.06 settles three items; ₹444 income; ₹13,563.94 set aside.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, Timestamp, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPersonCycleStatement, cycleContaining, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import type { PostponeRequest } from "@/lib/engines/person-payment-deferral";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
} from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
} from "@/lib/models/person";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { InstallmentPaymentRepository, InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

// Distinct project id — concurrently-run integration files must not share one (clearFirestore cross-talk).
const PROJECT_ID = "flowfi-record-payment-postpone";
const UID = "record-postpone-owner";
const SD = 18;
const NOW = new Date(2026, 9, 12);
const NOV = cycleContaining(new Date(2026, 10, 1), SD);

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
          col("paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({
            toFirestore: installmentPaymentToFirestore,
            fromFirestore: installmentPaymentFromFirestore,
          }),
          installments(scheduleId),
        ).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
      purposeFunds: col("people", personId, "purposeFunds").withConverter({ toFirestore: purposeFundToFirestore, fromFirestore: purposeFundFromFirestore }),
    });
  return { db, accounts, transactions, people, ledgerFor, paymentsFor, deferrals: new PaymentDeferralRepository(db, UID) };
}
type R = ReturnType<typeof setup>;

const ITEMS = [
  ["power", 5000, new Date(2026, 8, 20, 10), "Electricity"],
  ["phone", 436.06, new Date(2026, 8, 22, 10), "Phone recharge"],
  ["grocery", 10000, new Date(2026, 8, 25, 10), "Groceries"],
  ["rent", 8000, new Date(2026, 9, 1, 10), "Rent share"],
  ["meds", 7308, new Date(2026, 9, 3, 10), "Medicine"],
] as const;

/** AMMA owes ₹30,744.06 — five amounts paid for her from the bank. */
async function seed(r: R) {
  const bank = await r.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const ids: Record<string, string> = {};
  for (const [name, amount, date, note] of ITEMS) {
    const person = (await r.people.getByKey(amma.id))!;
    const { entry } = await r.ledgerFor(amma.id).addEntryWithTransaction(person, { type: "gave", amount, date, note }, { type: "expense", accountId: bank.id, categoryId: "personal-loan" }, r.transactions);
    ids[name] = entry.id;
  }
  return { bank, amma, ids };
}

const balanceOf = async (r: R, id: string) => (await r.accounts.getByKey(id))!.currentBalance;
const personBalance = async (r: R, id: string) => (await r.people.getByKey(id))!.currentBalance;

/** Live remaining per item from the real statement engine over the emulator's ledger. */
async function remaining(r: R, personId: string) {
  const entries = (await getDocs(collection(r.db, "users", UID, "people", personId, "ledger"))).docs.map((s) => ledgerEntryFromFirestore(s)) as StatementLedgerEntry[];
  const s = buildPersonCycleStatement({
    person: { id: personId, name: "AMMA", openingBalance: 0, createdAt: new Date(2026, 0, 1) },
    ledgerEntries: entries,
    loanIds: new Set(),
    emis: [],
    loans: [],
    installments: [],
    cycle: { start: new Date(1970, 0, 1), end: cycleContaining(NOW, SD).end },
    now: NOW,
  });
  return (entryId: string) => s.rows.find((x) => x.key === `ledger:${entryId}`)?.remainingNow ?? 0;
}

/** Every financial document, serialized — everything except the deferral / follow-up metadata. */
async function financialSnapshot(r: R, personId: string) {
  const out: Record<string, unknown> = {};
  for (const path of [["accounts"], ["transactions"], ["people"], ["people", personId, "ledger"], ["people", personId, "purposeFunds"], ["people", personId, "advanceApplications"]]) {
    const snap = await getDocs(collection(r.db, "users", UID, ...(path as [string])));
    for (const s of snap.docs) out[[...path, s.id].join("/")] = JSON.parse(JSON.stringify(s.data(), (_k, v) => (v instanceof Timestamp ? `ts:${v.toMillis()}` : v)));
  }
  return out;
}

const liveTransactions = async (r: R) => (await getDocs(collection(r.db, "users", UID, "transactions"))).docs.filter((s) => s.data().deletedAt == null).length;

function postpone(personId: string, key: string, title: string, date: Date, left: number, requestId: string): PostponeRequest {
  return {
    action: "postpone",
    requestId,
    expectedRevision: 0,
    personId,
    obligationKey: `ledger:${key}`,
    obligationTitle: title,
    now: NOW,
    startDay: SD,
    obligationDate: date,
    remaining: left,
    target: NOV,
    reason: null,
    note: null,
    reminder: null,
  };
}

describe("AMMA — receipt, then postponing what stays unpaid", () => {
  it("₹29,444 received once; three items settled; ₹444 income + ₹13,563.94 set aside; deferrals change no money; retry is a no-op; revert restores", async () => {
    const r = setup();
    const { bank, amma, ids } = await seed(r);
    const bankBefore = await balanceOf(r, bank.id);
    expect(bankBefore).toBe(round(100_000 - 30_744.06));
    expect(await personBalance(r, amma.id)).toBe(30_744.06);
    const txBefore = await liveTransactions(r);

    // 1. The receipt — exactly the input the panel builds for the AMMA case.
    const person = (await r.people.getByKey(amma.id))!;
    const paymentId = await r.paymentsFor(amma.id).recordPayment(person, {
      direction: "theyPaid",
      amount: 29_444,
      date: new Date(2026, 9, 12, 9),
      accountId: bank.id,
      lines: (["power", "phone", "grocery"] as const).map((k) => ({
        key: `ledger:${ids[k]}`,
        amount: ITEMS.find((i) => i[0] === k)![1],
        route: { kind: "entry" as const, parentEntryId: ids[k] },
      })),
      extra: { kind: "income", amount: 444, categoryId: "pocket", description: "Pocket money" },
      purposes: [
        { title: "SBI EMI", amount: 9_500, dueDate: null, note: "", link: null },
        { title: "Monthly needs", amount: 4_063.94, dueDate: null, note: "", link: null },
      ],
    });

    // The account moves once, by exactly what was received; AMMA's balance drops only by what settled.
    expect(await balanceOf(r, bank.id)).toBe(round(bankBefore + 29_444));
    expect(await personBalance(r, amma.id)).toBe(15_308);
    const left = await remaining(r, amma.id);
    expect([left(ids.power), left(ids.phone), left(ids.grocery), left(ids.rent), left(ids.meds)]).toEqual([0, 0, 0, 8_000, 7_308]);
    const funds = (await getDocs(collection(r.db, "users", UID, "people", amma.id, "purposeFunds"))).docs.map((s) => s.data());
    expect(funds.map((f) => [f.title, f.amount]).sort()).toEqual([["Monthly needs", 4_063.94], ["SBI EMI", 9_500]]);
    const txAfterPayment = await liveTransactions(r);
    expect(txAfterPayment).toBeGreaterThan(txBefore);

    // 2. Postpone the unpaid items — remaining AFTER the receipt. Only timing metadata is written.
    const afterPayment = await financialSnapshot(r, amma.id);
    const rentReq = postpone(amma.id, ids.rent, "Rent share", ITEMS[3][2], left(ids.rent), "req-rent");
    expect((await r.deferrals.apply(rentReq)).outcome).toBe("written");
    expect((await r.deferrals.apply(postpone(amma.id, ids.meds, "Medicine", ITEMS[4][2], left(ids.meds), "req-meds"))).outcome).toBe("written");
    expect(await financialSnapshot(r, amma.id)).toEqual(afterPayment);

    // 3. A retry of the same postponement (lost response) is a no-op — no receipt, no money, no second deferral.
    expect((await r.deferrals.apply(rentReq)).outcome).toBe("noop");
    expect(await financialSnapshot(r, amma.id)).toEqual(afterPayment);
    expect(await liveTransactions(r)).toBe(txAfterPayment);
    expect(await balanceOf(r, bank.id)).toBe(round(bankBefore + 29_444));

    // 4. Reverting the payment restores every balance; the postponements stay as timing metadata only.
    await r.paymentsFor(amma.id).revertPayment((await r.people.getByKey(amma.id))!, paymentId);
    expect(await balanceOf(r, bank.id)).toBe(bankBefore);
    expect(await personBalance(r, amma.id)).toBe(30_744.06);
    expect(await liveTransactions(r)).toBe(txBefore);
    const restored = await remaining(r, amma.id);
    expect(restored(ids.grocery)).toBe(10_000);
    const deferrals = (await getDocs(collection(r.db, "users", UID, "people", amma.id, "paymentDeferrals"))).docs.map((s) => s.data().state);
    expect(deferrals).toEqual(["active", "active"]);
  });

  it("partial payment + postpone the rest: the deferral is accepted at the post-payment remaining; a fully paid item is refused", async () => {
    const r = setup();
    const { bank, amma, ids } = await seed(r);
    const person = (await r.people.getByKey(amma.id))!;
    await r.paymentsFor(amma.id).recordPayment(person, {
      direction: "theyPaid",
      amount: 8_000,
      date: new Date(2026, 9, 12, 9),
      accountId: bank.id,
      lines: [
        { key: `ledger:${ids.power}`, amount: 5_000, route: { kind: "entry", parentEntryId: ids.power } },
        { key: `ledger:${ids.meds}`, amount: 3_000, route: { kind: "entry", parentEntryId: ids.meds } },
      ],
      extra: null,
    });
    const left = await remaining(r, amma.id);
    expect(left(ids.meds)).toBe(4_308);
    const before = await financialSnapshot(r, amma.id);
    expect((await r.deferrals.apply(postpone(amma.id, ids.meds, "Medicine", ITEMS[4][2], left(ids.meds), "req-meds-part"))).outcome).toBe("written");
    expect(await financialSnapshot(r, amma.id)).toEqual(before);
    await expect(r.deferrals.apply(postpone(amma.id, ids.power, "Electricity", ITEMS[0][2], left(ids.power), "req-power"))).rejects.toThrow(/already fully paid/);
  });
});

function round(v: number) {
  return Math.round(v * 100) / 100;
}
