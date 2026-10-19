/**
 * Historical participant reimbursement for a shared Loan / EMI (real Firestore emulator, real repositories).
 * The People side of "Mark an old EMI as paid": each person's share is settled through the ONE People write
 * (`PersonPaymentRepository.recordPayment`), either
 *  - "Already included in my account" (`recordedEarlier`): settles the share, the cash leg is posted
 *    `excludeFromCalculations` — the account never moves (posting, reverting or editing it); or
 *  - "Add money to my account": an ordinary receipt that credits the account once.
 * An idempotency key makes a double submit / retry write nothing twice; the stale-balance check refuses a
 * concurrent write from a screen that no longer matches.
 *
 * EMI ₹9,000 = me ₹3,000 + SANJU ₹3,000 + AMMA ₹3,000. Lender side is the installment's `amountPaid` only.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { planReimbursements, reimbursementLineKey as lk, reimbursementLines, runReimbursements, type ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import { buildPersonCycleStatement, type StatementEmiSource, type StatementInstallment, type StatementLedgerEntry } from "@/lib/engines/person-cycle-statement";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { installmentFromFirestore, installmentPaymentFromFirestore, installmentPaymentToFirestore, installmentToFirestore, type Installment } from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
  type Person,
} from "@/lib/models/person";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { InstallmentPaymentRepository, InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, StalePersonPaymentError, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { OwnedTransactionDeleteError, OwnedTransactionEditError, TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-historical-reimbursement";
const UID = "historical-reimbursement-owner";
const SEP_5 = new Date(2026, 8, 5, 12);
const OCT_5 = new Date(2026, 9, 5, 12);

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
  return { db, accounts, transactions, people, paymentsFor };
}
type R = ReturnType<typeof setup>;

const emi: StatementEmiSource = {
  id: "emi",
  name: "Phone EMI",
  scheduleId: "sch",
  ownershipShares: [
    { personId: null, amount: 30000 },
    { personId: "P_SANJU", amount: 30000 },
    { personId: "P_AMMA", amount: 30000 },
  ],
  isClosed: false,
  deletedAt: null,
} as unknown as StatementEmiSource;
const inst = (id: string, seq: number, due: Date, amountPaid: number) =>
  ({ id, scheduleId: "sch", sequenceNumber: seq, dueDate: due, amountDue: 9000, amountPaid, isSkipped: false, deletedAt: null, createdAt: new Date(2026, 0, 1) }) as unknown as Installment;

async function seed(r: R) {
  const bank = await r.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const sanju = await r.people.createPerson({ name: "SANJU", avatarColorValue: 0, openingBalance: 0 });
  const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  // The EMI's ownership names the real person ids.
  (emi as unknown as { ownershipShares: { personId: string | null; amount: number }[] }).ownershipShares = [
    { personId: null, amount: 30000 },
    { personId: sanju.id, amount: 30000 },
    { personId: amma.id, amount: 30000 },
  ];
  return { bank, sanju, amma };
}

const balanceOf = async (r: R, id: string) => (await r.accounts.getByKey(id))!.currentBalance;
const person = async (r: R, id: string) => (await r.people.getByKey(id))! as Person;
const entriesOf = async (r: R, personId: string) =>
  (await getDocs(collection(r.db, "users", UID, "people", personId, "ledger"))).docs.map((s) => ledgerEntryFromFirestore(s));

/** The People statements over the emulator's ledgers — the same engine the People Ledger reads. */
async function statements(r: R, people: Person[], installments: Installment[]) {
  const out = [];
  for (const p of people) {
    out.push(
      buildPersonCycleStatement({
        person: { id: p.id, name: p.name, openingBalance: 0, createdAt: new Date(2026, 0, 1) },
        ledgerEntries: (await entriesOf(r, p.id)) as StatementLedgerEntry[],
        loanIds: new Set(),
        emis: [emi],
        loans: [],
        installments: installments as unknown as StatementInstallment[],
        cycle: { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) },
        now: new Date(2026, 9, 13),
      }),
    );
  }
  return out;
}

const receipt = (key: string, amount: number, extra: Partial<RecordPaymentInput> = {}): RecordPaymentInput => ({
  direction: "theyPaid",
  amount,
  date: SEP_5,
  accountId: "",
  lines: [{ key, amount, route: { kind: "derived", obligationRef: key, sourceKind: "emiInstallment" } }],
  extra: null,
  ...extra,
});

describe("historical reimbursement — People settlement without double counting", () => {
  it("Lender paid earlier; SANJU paid earlier (already in my account), AMMA not: no account moves, statuses split correctly", async () => {
    const r = setup();
    const { bank, sanju, amma } = await seed(r);
    // Lender side: #1 fully paid earlier (₹9,000). People side is independent of it.
    const installments = [inst("i1", 1, SEP_5, 9000)];
    const before = await statements(r, [sanju, amma], installments);
    const lines = reimbursementLines({ statements: before, installments, installmentIds: ["i1"], sourceKind: "emi", source: emi });
    expect(lines.map((l) => [l.personName, l.share, l.remaining])).toEqual([
      ["AMMA", 3000, 3000],
      ["SANJU", 3000, 3000],
    ]);
    // My own share is never a receivable line.
    expect(lines.reduce((t, l) => t + l.share, 0)).toBe(6000);

    // Answered per person: SANJU in full, AMMA not yet (same installment, same obligation key).
    const plan = planReimbursements({
      lines,
      draft: {
        [lk({ personId: sanju.id, obligationKey: "emi-inst:i1" })]: { choice: "full", amount: "", treatment: "included", date: "2026-09-05" },
        [lk({ personId: amma.id, obligationKey: "emi-inst:i1" })]: { choice: "none", amount: "" },
      },
      batchId: "b1",
      today: new Date(2026, 9, 13),
    });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.items).toHaveLength(1);
    expect(plan.ok && plan.summary).toMatchObject({ total: 3000, balanceChange: 0 });
    expect(plan.ok && plan.summary.people.find((p) => p.personId === amma.id)).toMatchObject({ receivedNow: 0, remainingAfter: 3000 });
    const sanjuItem = plan.ok ? plan.items.find((i) => i.personId === sanju.id)! : null;
    expect(sanjuItem).toMatchObject({ amount: 3000, recordedEarlier: true, key: `hist_b1_${sanju.id}_i1` });

    await r.paymentsFor(sanju.id).recordPayment(await person(r, sanju.id), {
      ...receipt("emi-inst:i1", 3000),
      accountId: bank.id,
      recordedEarlier: true,
      idempotencyKey: sanjuItem!.key,
    });

    expect(await balanceOf(r, bank.id)).toBe(50_000); // never credited again
    const [entry] = (await entriesOf(r, sanju.id)).filter((e) => e.deletedAt == null);
    expect(entry).toMatchObject({ type: "receivedBack", amount: 3000, obligationRef: "emi-inst:i1", recordedEarlier: true });
    const leg = (await r.transactions.getByKey(entry.transactionRef!))!;
    expect(leg).toMatchObject({ isPersonLedgerMovement: true, excludeFromCalculations: true, amount: 3000 });

    const after = reimbursementLines({ statements: await statements(r, [sanju, amma], installments), installments, installmentIds: ["i1"], sourceKind: "emi", source: emi });
    expect(after.find((l) => l.personName === "SANJU")).toMatchObject({ received: 3000, remaining: 0 });
    expect(after.find((l) => l.personName === "AMMA")).toMatchObject({ received: 0, remaining: 3000 });
  });

  it("duplicate submission / retry with the same key writes nothing twice", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const input = { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true, idempotencyKey: "hist_b_x_i1" };
    const p = await person(r, sanju.id);
    const id1 = await r.paymentsFor(sanju.id).recordPayment(p, input);
    // Same stale person object (a double click) and a fresh one (retry after a lost response).
    const id2 = await r.paymentsFor(sanju.id).recordPayment(p, input);
    const id3 = await r.paymentsFor(sanju.id).recordPayment(await person(r, sanju.id), input);
    expect(new Set([id1, id2, id3]).size).toBe(1);
    expect((await entriesOf(r, sanju.id)).length).toBe(1);
    expect((await person(r, sanju.id)).currentBalance).toBe(-3000);
    expect(await balanceOf(r, bank.id)).toBe(50_000);
  });

  it("'Add money to my account' is the normal receipt: the account is credited exactly once", async () => {
    const r = setup();
    const { bank, amma } = await seed(r);
    await r.paymentsFor(amma.id).recordPayment(await person(r, amma.id), { ...receipt("emi-inst:i1", 1000), accountId: bank.id, idempotencyKey: "hist_b_a_i1" });
    await r.paymentsFor(amma.id).recordPayment(await person(r, amma.id), { ...receipt("emi-inst:i1", 1000), accountId: bank.id, idempotencyKey: "hist_b_a_i1" });
    expect(await balanceOf(r, bank.id)).toBe(51_000);
    const [entry] = await entriesOf(r, amma.id);
    expect(entry.recordedEarlier).toBeUndefined();
    // Partial: AMMA ₹1,000 of ₹3,000 received.
    const lines = reimbursementLines({ statements: await statements(r, [amma], [inst("i1", 1, SEP_5, 9000)]), installments: [inst("i1", 1, SEP_5, 9000)], installmentIds: ["i1"], sourceKind: "emi", source: emi });
    expect(lines[0]).toMatchObject({ share: 3000, received: 1000, remaining: 2000 });
  });

  it("reverting an 'already included' reimbursement subtracts nothing; reverting a real one reverses the credit", async () => {
    const r = setup();
    const { bank, sanju, amma } = await seed(r);
    const earlierId = await r.paymentsFor(sanju.id).recordPayment(await person(r, sanju.id), { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true });
    const realId = await r.paymentsFor(amma.id).recordPayment(await person(r, amma.id), { ...receipt("emi-inst:i1", 3000), accountId: bank.id });
    expect(await balanceOf(r, bank.id)).toBe(53_000);

    await r.paymentsFor(sanju.id).revertPayment(await person(r, sanju.id), earlierId);
    expect(await balanceOf(r, bank.id)).toBe(53_000);
    expect((await person(r, sanju.id)).currentBalance).toBe(0);
    await r.paymentsFor(amma.id).revertPayment(await person(r, amma.id), realId);
    expect(await balanceOf(r, bank.id)).toBe(50_000);

    const lines = reimbursementLines({ statements: await statements(r, [sanju, amma], [inst("i1", 1, SEP_5, 9000)]), installments: [inst("i1", 1, SEP_5, 9000)], installmentIds: ["i1"], sourceKind: "emi", source: emi });
    expect(lines.every((l) => l.remaining === 3000)).toBe(true);
  });

  it("editing an 'already included' reimbursement keeps it out of the account (no extra cash movement)", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const id = await r.paymentsFor(sanju.id).recordPayment(await person(r, sanju.id), { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true });
    // The caller omits the mark — the stored one is carried forward.
    await r.paymentsFor(sanju.id).editPayment(await person(r, sanju.id), id, { ...receipt("emi-inst:i1", 2000), accountId: bank.id });
    expect(await balanceOf(r, bank.id)).toBe(50_000);
    const live = (await entriesOf(r, sanju.id)).filter((e) => e.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ amount: 2000, recordedEarlier: true });
    expect((await r.transactions.getByKey(live[0].transactionRef!))!.excludeFromCalculations).toBe(true);
    expect((await person(r, sanju.id)).currentBalance).toBe(-2000);
  });

  it("an ordinary receipt can't be turned into 'already included' by editing", async () => {
    const r = setup();
    const { bank, amma } = await seed(r);
    const id = await r.paymentsFor(amma.id).recordPayment(await person(r, amma.id), { ...receipt("emi-inst:i1", 3000), accountId: bank.id });
    await r.paymentsFor(amma.id).editPayment(await person(r, amma.id), id, { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true });
    expect(await balanceOf(r, bank.id)).toBe(53_000);
    expect((await entriesOf(r, amma.id)).filter((e) => e.deletedAt == null)[0].recordedEarlier).toBeUndefined();
  });

  it("concurrent edit from a stale screen (different key) is refused — no over-settlement", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const stale = await person(r, sanju.id);
    await r.paymentsFor(sanju.id).recordPayment(stale, { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true, idempotencyKey: "tab-a" });
    await expect(
      r.paymentsFor(sanju.id).recordPayment(stale, { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true, idempotencyKey: "tab-b" }),
    ).rejects.toBeInstanceOf(StalePersonPaymentError);
    expect((await entriesOf(r, sanju.id)).length).toBe(1);
  });

  it("'already included' refuses a future date, money paid out, and any extra (advance/income) — nothing written", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    const p = await person(r, sanju.id);
    const future = new Date(Date.now() + 3 * 86_400_000);
    await expect(r.paymentsFor(sanju.id).recordPayment(p, { ...receipt("emi-inst:i1", 3000), date: future, accountId: bank.id, recordedEarlier: true })).rejects.toThrow(/future/);
    await expect(
      r.paymentsFor(sanju.id).recordPayment(p, { ...receipt("emi-inst:i1", 3000), amount: 3500, accountId: bank.id, recordedEarlier: true, extra: { kind: "advance", amount: 500 } }),
    ).rejects.toThrow(/only settle/);
    await expect(r.paymentsFor(sanju.id).recordPayment(p, { ...receipt("emi-inst:i1", 3000), direction: "iPaid", accountId: bank.id, recordedEarlier: true })).rejects.toThrow(/Only money received/);
    expect(await entriesOf(r, sanju.id)).toHaveLength(0);
    expect(await balanceOf(r, bank.id)).toBe(50_000);
  });

  it("multiple installments, different answers per person; retry after a partial failure re-runs only the failed item", async () => {
    const r = setup();
    const { bank, sanju, amma } = await seed(r);
    const installments = [inst("i1", 1, SEP_5, 9000), inst("i2", 2, OCT_5, 4500)]; // #2 lender only part paid
    const lines = reimbursementLines({ statements: await statements(r, [sanju, amma], installments), installments, installmentIds: ["i1", "i2"], sourceKind: "emi", source: emi });
    expect(lines).toHaveLength(4);
    const k = (personId: string, id: string) => lk({ personId, obligationKey: `emi-inst:${id}` });
    const plan = planReimbursements({
      lines,
      draft: {
        [k(sanju.id, "i1")]: { choice: "full", amount: "", treatment: "included", date: "2026-09-05" },
        [k(sanju.id, "i2")]: { choice: "some", amount: "1500", treatment: "included", date: "2026-10-05" },
        [k(amma.id, "i1")]: { choice: "none", amount: "" },
        [k(amma.id, "i2")]: { choice: "full", amount: "", treatment: "included", date: "2026-10-05" },
      },
      batchId: "b2",
      today: new Date(2026, 9, 13),
    });
    expect(plan.ok).toBe(true);
    const items: ReimbursementItem[] = plan.ok ? plan.items : [];
    expect(items.map((i) => [i.personName, i.installmentId, i.amount])).toEqual([
      ["AMMA", "i2", 3000],
      ["SANJU", "i1", 3000],
      ["SANJU", "i2", 1500],
    ]);

    const expected = new Map<string, Person>();
    let failOnce = true;
    const recordOne = async (item: ReimbursementItem) => {
      if (item.personName === "AMMA" && failOnce) {
        failOnce = false;
        throw new Error("network");
      }
      const p = expected.get(item.personId) ?? (await person(r, item.personId));
      await r.paymentsFor(item.personId).recordPayment(p, {
        ...receipt(item.obligationKey, item.amount),
        date: item.date,
        accountId: bank.id,
        recordedEarlier: item.recordedEarlier,
        idempotencyKey: item.key,
      });
      expected.set(item.personId, { ...p, currentBalance: p.currentBalance - item.amount });
    };
    const first = await runReimbursements(items, recordOne);
    expect(Object.values(first).filter((x) => x.status === "failed")).toHaveLength(1);
    const second = await runReimbursements(items, recordOne, first);
    expect(Object.values(second).every((x) => x.status === "recorded")).toBe(true);

    expect(await balanceOf(r, bank.id)).toBe(50_000);
    expect((await entriesOf(r, sanju.id)).length).toBe(2);
    expect((await entriesOf(r, amma.id)).length).toBe(1);
    const after = reimbursementLines({ statements: await statements(r, [sanju, amma], installments), installments, installmentIds: ["i1", "i2"], sourceKind: "emi", source: emi });
    const of = (n: string, id: string) => after.find((l) => l.personName === n && l.installmentId === id)!;
    expect(of("SANJU", "i1")).toMatchObject({ remaining: 0 });
    expect(of("SANJU", "i2")).toMatchObject({ received: 1500, remaining: 1500 });
    expect(of("AMMA", "i1")).toMatchObject({ received: 0, remaining: 3000 });
    expect(of("AMMA", "i2")).toMatchObject({ remaining: 0 });
    // Each item is its own payment, dated on its own installment's date.
    const sanjuDates = (await entriesOf(r, sanju.id)).map((e) => e.date.getMonth()).sort();
    expect(sanjuDates).toEqual([8, 9]);
    // Deterministic payment documents — the retry wrote the failed one only.
    expect((await getDoc(doc(r.db, "users", UID, "people", amma.id, "ledger", `pp_hist_b2_${amma.id}_i2_0`))).exists()).toBe(true);
  });
});

describe("mixed treatments, unknown dates, balances and reversals", () => {
  it("one batch, mixed per reimbursement: only 'Add to my account' items credit; reverting each restores exactly its own effect", async () => {
    const r = setup();
    const { bank, sanju, amma } = await seed(r);
    const installments = [inst("i1", 1, SEP_5, 9000), inst("i2", 2, OCT_5, 9000)];
    const lines = reimbursementLines({ statements: await statements(r, [sanju, amma], installments), installments, installmentIds: ["i1", "i2"], sourceKind: "emi", source: emi });
    const k = (personId: string, id: string) => lk({ personId, obligationKey: `emi-inst:${id}` });
    const plan = planReimbursements({
      lines,
      draft: {
        [k(sanju.id, "i1")]: { choice: "full", amount: "", treatment: "included", date: "2026-09-08" },
        [k(sanju.id, "i2")]: { choice: "full", amount: "", treatment: "addToAccount", date: "2026-10-08" },
        [k(amma.id, "i1")]: { choice: "some", amount: "1200", treatment: "addToAccount", date: "" },
        [k(amma.id, "i2")]: { choice: "full", amount: "", treatment: "included", date: "" },
      },
      batchId: "mix",
      today: new Date(2026, 9, 13),
    });
    expect(plan.ok && plan.summary).toMatchObject({ total: 10200, balanceChange: 4200 });
    const items = plan.ok ? plan.items : [];
    const expected = new Map<string, Person>();
    const results = await runReimbursements(items, async (item) => {
      const p = expected.get(item.personId) ?? (await person(r, item.personId));
      await r.paymentsFor(item.personId).recordPayment(p, {
        ...receipt(item.obligationKey, item.amount),
        date: item.date,
        accountId: bank.id,
        recordedEarlier: item.recordedEarlier,
        dateKnown: item.dateKnown,
        idempotencyKey: item.key,
      });
      expected.set(item.personId, { ...p, currentBalance: p.currentBalance - item.amount });
    });
    expect(Object.values(results).every((x) => x.status === "recorded")).toBe(true);
    // ₹3,000 (SANJU #2) + ₹1,200 (AMMA #1) credited; the two "already in my account" items move nothing.
    expect(await balanceOf(r, bank.id)).toBe(54_200);

    const live = async (id: string) => (await entriesOf(r, id)).filter((e) => e.deletedAt == null);
    const sanjuEntries = await live(sanju.id);
    const ammaEntries = await live(amma.id);
    const shape = (es: typeof sanjuEntries) => es.map((e) => [e.obligationRef, e.recordedEarlier ?? false, e.receivedDateKnown ?? true]).sort();
    expect(shape(sanjuEntries)).toEqual([
      ["emi-inst:i1", true, true],
      ["emi-inst:i2", false, true],
    ]);
    expect(shape(ammaEntries)).toEqual([
      ["emi-inst:i1", false, false],
      ["emi-inst:i2", true, false],
    ]);
    // Unknown dates: the stored date is the due-date placeholder, flagged — never the lender's payment date.
    expect(ammaEntries.find((e) => e.obligationRef === "emi-inst:i1")!.date.getTime()).toBe(SEP_5.getTime());

    // Reverse every one: only the credited items take money back out.
    for (const [personId, entries] of [[sanju.id, sanjuEntries], [amma.id, ammaEntries]] as const) {
      for (const e of entries) await r.paymentsFor(personId).revertPayment(await person(r, personId), e.paymentId!);
    }
    expect(await balanceOf(r, bank.id)).toBe(50_000);
    const after = reimbursementLines({ statements: await statements(r, [sanju, amma], installments), installments, installmentIds: ["i1", "i2"], sourceKind: "emi", source: emi });
    expect(after.every((l) => l.remaining === 3000)).toBe(true);
  });

  it("an unknown received date stays unknown through an edit that keeps the date; picking a real date makes it known", async () => {
    const r = setup();
    const { bank, amma } = await seed(r);
    const id = await r.paymentsFor(amma.id).recordPayment(await person(r, amma.id), {
      ...receipt("emi-inst:i1", 3000),
      accountId: bank.id,
      recordedEarlier: true,
      dateKnown: false,
    });
    const id2 = await r.paymentsFor(amma.id).editPayment(await person(r, amma.id), id, { ...receipt("emi-inst:i1", 2500), accountId: bank.id });
    let [e] = (await entriesOf(r, amma.id)).filter((x) => x.deletedAt == null);
    expect(e).toMatchObject({ amount: 2500, receivedDateKnown: false, recordedEarlier: true });
    await r.paymentsFor(amma.id).editPayment(await person(r, amma.id), id2, { ...receipt("emi-inst:i1", 2500), date: new Date(2026, 8, 20, 12), accountId: bank.id });
    [e] = (await entriesOf(r, amma.id)).filter((x) => x.deletedAt == null);
    expect(e.receivedDateKnown).toBeUndefined();
    expect(e.date.getDate()).toBe(20);
    expect(await balanceOf(r, bank.id)).toBe(50_000);
  });

  it("the 'already included' cash leg can't be counted from Transactions: un-ticking Don't count, editing or deleting it there is refused", async () => {
    const r = setup();
    const { bank, sanju } = await seed(r);
    await r.paymentsFor(sanju.id).recordPayment(await person(r, sanju.id), { ...receipt("emi-inst:i1", 3000), accountId: bank.id, recordedEarlier: true });
    const [e] = await entriesOf(r, sanju.id);
    const leg = (await r.transactions.getByKey(e.transactionRef!))!;
    await expect(r.transactions.editTransaction(leg, { excludeFromCalculations: false })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(r.transactions.editTransaction(leg, { amount: 5000 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(r.transactions.softDeleteTransaction(leg)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    expect(await balanceOf(r, bank.id)).toBe(50_000);
    expect((await r.transactions.getByKey(leg.id))!.excludeFromCalculations).toBe(true);
  });
});
