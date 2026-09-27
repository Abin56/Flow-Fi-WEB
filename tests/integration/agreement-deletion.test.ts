/**
 * Emulator-backed coverage for permanently deleting a Loan/EMI entered by mistake
 * (`lib/repositories/agreement-deletion.ts`): every financial effect the agreement owns is reversed
 * — creation money, payments, extra principal, card-EMI charges, People entries — nothing else is
 * touched, nothing is reversed twice, and no record of the agreement is left behind.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildEmiPaymentWrites, planEmiPaymentAllocation } from "@/features/emi/lib/emi-payment-allocation";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { emiFromFirestore, emiPaymentBreakdownToFirestore, emiToFirestore } from "@/lib/models/emi";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { permanentlyDeleteAgreement, previewAgreementDeletion, resumePendingAgreementPurges } from "@/lib/repositories/agreement-deletion";
import { EmiRepository } from "@/lib/repositories/emi-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-agreement-deletion-integration-test";
const UID = "e2e-owner-uid";

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
  const user = ["users", UID] as const;
  const accounts = new AccountRepository(collection(db, ...user, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(
    collection(db, ...user, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  );
  const schedules = new PaymentScheduleRepository(
    collection(db, ...user, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }),
  );
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(
      collection(db, ...user, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }),
    );
  const loans = new LoanRepository(collection(db, ...user, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }), schedules, installmentRepositoryFor);
  const emis = new EmiRepository(collection(db, ...user, "emis").withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }), schedules, installmentRepositoryFor);
  const people = new PersonRepository(collection(db, ...user, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(
      collection(db, ...user, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }),
      people,
    );
  const payments = new LoanAdvancePaymentRepository(db, UID);
  return { db, accounts, transactions, loans, emis, people, ledgerFor, payments, installmentRepositoryFor };
}

type Env = ReturnType<typeof setup>;

const balance = async (env: Env, id: string) => (await env.accounts.getByKey(id))?.currentBalance;
const liveInstallments = async (env: Env, scheduleId: string) =>
  (await env.installmentRepositoryFor(scheduleId).getAll()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
/** Every installment id on a schedule, active and retired — captured before deleting, to prove none survive. */
const allInstallmentIds = async (env: Env, scheduleId: string) =>
  (await getDocs(collection(env.db, "users", UID, "paymentSchedules", scheduleId, "installments"))).docs.map((d) => d.id);
const onDue = (i: { dueDate: Date }) => new Date(i.dueDate.getTime() + 12 * 3600 * 1000);

/** Nothing of the agreement is left: owner doc, schedule, installments, payments, sub-records, Transactions. */
async function expectNoTrace(env: Env, kind: "loan" | "emi", id: string, scheduleId: string, installmentIds: string[]) {
  const { db } = env;
  expect((await getDoc(doc(db, "users", UID, kind === "loan" ? "loans" : "emis", id))).exists()).toBe(false);
  expect((await getDoc(doc(db, "users", UID, "paymentSchedules", scheduleId))).exists()).toBe(false);
  expect((await getDocs(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments"))).size).toBe(0);
  expect(installmentIds.length).toBeGreaterThan(0);
  for (const installmentId of installmentIds) {
    expect((await getDocs(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments", installmentId, "payments"))).size).toBe(0);
  }
  for (const sub of kind === "loan" ? ["reamortizationEvents", "additionalDisbursements"] : ["paymentBreakdowns", "reamortizationEvents"]) {
    expect((await getDocs(collection(db, "users", UID, kind === "loan" ? "loans" : "emis", id, sub))).size).toBe(0);
  }
  const linked = await getDocs(query(collection(db, "users", UID, "transactions"), where(kind === "loan" ? "loanId" : "emiId", "==", id)));
  expect(linked.size).toBe(0);
}

describe("permanently deleting a Loan (real emulator)", () => {
  it("9/4/5. ₹1,00,000 received into HDFC, ₹20,000 then ₹5,000 paid back → HDFC returns to where it was; unrelated spending stays", async () => {
    const env = setup();
    const hdfc = await env.accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 50000, colorValue: 0 });
    const groceries = await env.transactions.createTransaction({ type: "expense", amount: 20000, dateTime: new Date("2026-02-10"), accountId: hdfc.id, categoryId: "food" });
    const created = await env.loans.createAgreementWithOrigination({
      idempotencyKey: "accident-0001",
      agreementKind: "borrowedMoney",
      loanAmount: 100000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 5,
      movementAccountId: hdfc.id,
    } as never);
    const loan = created.loan;
    expect(await balance(env, hdfc.id)).toBe(130000); // 50,000 − 20,000 groceries + 1,00,000 received
    const installments = await liveInstallments(env, loan.scheduleId);
    await env.payments.record({ loan, scheduleInstallments: installments, accountId: hdfc.id, amount: 20000, date: onDue(installments[0]), idempotencyKey: "p1" });
    await env.payments.record({ loan, scheduleInstallments: await liveInstallments(env, loan.scheduleId), accountId: hdfc.id, amount: 5000, date: onDue(installments[1]), idempotencyKey: "p2" });
    expect(await balance(env, hdfc.id)).toBe(105000);

    const impact = await previewAgreementDeletion(env.db, UID, "loan", loan.id);
    expect(impact).toMatchObject({ installmentCount: 5, paymentCount: 2, hasFinancialActivity: true });
    expect(impact!.accountEffects).toEqual([{ accountId: hdfc.id, accountName: "HDFC", delta: -75000 }]);

    const stages: string[] = [];
    const installmentIds = await allInstallmentIds(env, loan.scheduleId);
    const result = await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id, { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["checking", "reversing", "removing"]);
    expect(result).toMatchObject({ resumed: false, reversedTransactionCount: 3, accountDeltas: { [hdfc.id]: -75000 } });

    // Exactly the state had the loan never existed: 50,000 − 20,000 groceries.
    expect(await balance(env, hdfc.id)).toBe(30000);
    expect((await env.transactions.getByKey(groceries.id))?.deletedAt).toBeNull();
    await expectNoTrace(env, "loan", loan.id, loan.scheduleId, installmentIds);
  });

  it("6/14/17. a fully-paid, closed loan can still be explicitly deleted — every payment reversed", async () => {
    const env = setup();
    const hdfc = await env.accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await env.loans.createLoan({
      loanAmount: 20000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, // 8. interest-bearing
      installmentFrequency: "monthly",
      installmentCount: 4,
    });
    const installments = await liveInstallments(env, loan.scheduleId);
    const total = Math.round(installments.reduce((s, i) => s + i.amountDue, 0) * 100) / 100;
    await env.payments.record({ loan, scheduleInstallments: installments, accountId: hdfc.id, amount: total, date: onDue(installments[0]), idempotencyKey: "all", includeUpcomingInstallments: true });
    expect((await liveInstallments(env, loan.scheduleId)).every((i) => i.amountPaid === i.amountDue)).toBe(true);
    await env.loans.closeLoan((await env.loans.getByKey(loan.id))!);
    expect(await balance(env, hdfc.id)).toBeCloseTo(100000 - total, 2);

    const installmentIds = await allInstallmentIds(env, loan.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id);
    expect(await balance(env, hdfc.id)).toBeCloseTo(100000, 2);
    await expectNoTrace(env, "loan", loan.id, loan.scheduleId, installmentIds);
  });

  it("an extra-principal payment that re-planned the schedule: its money and its re-plan records all go", async () => {
    const env = setup();
    const hdfc = await env.accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await env.loans.createLoan({
      loanAmount: 20000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 4,
    });
    const installments = await liveInstallments(env, loan.scheduleId);
    const paid = await env.payments.record({ loan, scheduleInstallments: installments, accountId: hdfc.id, amount: 8000, date: onDue(installments[0]), idempotencyKey: "pre" });
    expect(paid.overallAllocationType).toBe("principalPrepayment");
    expect(await balance(env, hdfc.id)).toBe(92000);

    const installmentIds = await allInstallmentIds(env, loan.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id);
    expect(await balance(env, hdfc.id)).toBe(100000);
    await expectNoTrace(env, "loan", loan.id, loan.scheduleId, installmentIds);
  });

  it("15. no double reversal: a payment already marked unpaid moves nothing again, and a repeated delete changes nothing", async () => {
    const env = setup();
    const hdfc = await env.accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await env.loans.createLoan({
      loanAmount: 20000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 4,
    });
    const installments = await liveInstallments(env, loan.scheduleId);
    const first = await env.payments.record({ loan, scheduleInstallments: installments, accountId: hdfc.id, amount: 5000, date: onDue(installments[0]), idempotencyKey: "a" });
    await env.payments.reversePayment({ loan, transactionId: first.transactionId, paymentIds: first.paymentIds, installmentIds: first.installmentIds, reversalIdempotencyKey: "undo" });
    await env.payments.record({ loan, scheduleInstallments: await liveInstallments(env, loan.scheduleId), accountId: hdfc.id, amount: 5000, date: onDue(installments[0]), idempotencyKey: "b" });
    expect(await balance(env, hdfc.id)).toBe(95000);

    const installmentIds = await allInstallmentIds(env, loan.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id);
    expect(await balance(env, hdfc.id)).toBe(100000);
    const again = await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id);
    expect(again).toMatchObject({ resumed: true, reversedTransactionCount: 0 });
    expect(await balance(env, hdfc.id)).toBe(100000);
    await expectNoTrace(env, "loan", loan.id, loan.scheduleId, installmentIds);
  });

  it("11. People-linked loan: its own ledger entries are reversed once; the Person and unrelated entries stay", async () => {
    const env = setup();
    const ravi = await env.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const loan = await env.loans.createLoan({
      loanAmount: 25000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "personal",
      personId: ravi.id,
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 5,
    });
    const ledger = env.ledgerFor(ravi.id);
    // Legacy Loan-generated entries (transactionRef = loan id) + one unrelated manual entry.
    await ledger.addEntry((await env.people.getByKey(ravi.id))!, { type: "borrowed", amount: 25000, date: new Date("2026-01-01"), note: "Loan", transactionRef: loan.id });
    await ledger.addEntry((await env.people.getByKey(ravi.id))!, { type: "repaid", amount: 5000, date: new Date("2026-02-01"), note: "Loan payment", transactionRef: loan.id });
    await ledger.addEntry((await env.people.getByKey(ravi.id))!, { type: "gave", amount: 700, date: new Date("2026-02-05"), note: "Dinner" });
    expect((await env.people.getByKey(ravi.id))?.currentBalance).toBe(-19300);

    const installmentIds = await allInstallmentIds(env, loan.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "loan", loan.id);
    const after = await env.people.getByKey(ravi.id);
    expect(after?.deletedAt).toBeNull();
    expect(after?.currentBalance).toBe(700); // only the dinner remains
    const entries = (await getDocs(collection(env.db, "users", UID, "people", ravi.id, "ledger"))).docs.map((d) => d.data());
    expect(entries.map((e) => e.note)).toEqual(["Dinner"]);
    await expectNoTrace(env, "loan", loan.id, loan.scheduleId, installmentIds);
  });

  it("18. an interrupted cleanup is not success — the marker lets it finish, and a live loan's schedule is never touched", async () => {
    const env = setup();
    const keep = await env.loans.createLoan({
      loanAmount: 10000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 2,
    });
    const gone = await env.loans.createLoan({
      loanAmount: 10000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 3,
    });
    // State right after the money step committed and before cleanup: owner gone, schedule stamped.
    const scheduleRef = doc(env.db, "users", UID, "paymentSchedules", gone.scheduleId).withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore });
    await setDoc(scheduleRef, { ...(await getDoc(scheduleRef)).data()!, deletedAt: new Date() });
    await env.loans.permanentlyDelete(gone);
    // A soft-deleted schedule whose owner still exists must be left alone.
    const keepRef = doc(env.db, "users", UID, "paymentSchedules", keep.scheduleId).withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore });
    await setDoc(keepRef, { ...(await getDoc(keepRef)).data()!, deletedAt: new Date() });

    const installmentIds = await allInstallmentIds(env, gone.scheduleId);
    expect(await resumePendingAgreementPurges(env.db, UID)).toBe(1);
    await expectNoTrace(env, "loan", gone.id, gone.scheduleId, installmentIds);
    expect((await liveInstallments(env, keep.scheduleId)).length).toBe(2);
    expect((await getDoc(keepRef)).exists()).toBe(true);
  });
});

describe("permanently deleting an EMI (real emulator)", () => {
  it("2. an EMI with no activity: removed with its schedule, nothing else moves", async () => {
    const env = setup();
    const emi = await env.emis.createEmi({ name: "Phone", principalAmount: 20000, startDate: new Date("2026-01-05"), installmentFrequency: "monthly", installmentCount: 4, interest: null });
    const impact = await previewAgreementDeletion(env.db, UID, "emi", emi.id);
    expect(impact).toMatchObject({ installmentCount: 4, paymentCount: 0, hasFinancialActivity: false, accountEffects: [] });
    const installmentIds = await allInstallmentIds(env, emi.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "emi", emi.id);
    await expectNoTrace(env, "emi", emi.id, emi.scheduleId, installmentIds);
  });

  it("7/10. card-linked EMI with an advance payment: its card charges are reversed; the card purchase stays", async () => {
    const env = setup();
    const card = await env.accounts.createAccount({ name: "HDFC Card", type: "bank", openingBalance: 0, colorValue: 0 });
    const purchase = await env.transactions.createTransaction({ type: "expense", amount: 40000, dateTime: new Date("2026-01-02"), accountId: card.id, categoryId: "shopping" });
    const emi = await env.emis.createEmi({
      name: "Laptop",
      principalAmount: 40000,
      startDate: new Date("2026-01-05"),
      installmentFrequency: "monthly",
      installmentCount: 4,
      interest: null,
      linkedCreditCardId: "card-1",
      purchaseTransactionId: purchase.id,
    });
    expect(await balance(env, card.id)).toBe(-40000);

    // Record ₹15,000 = installment #1 + ₹5,000 advance on #2, exactly as `useEmiActions().recordPayment` writes it.
    const installments = await liveInstallments(env, emi.scheduleId);
    const allocation = planEmiPaymentAllocation({ installments, amount: 15000, date: installments[0].dueDate });
    if (!allocation.ok) throw new Error(allocation.error);
    const writes = buildEmiPaymentWrites({ portions: allocation.portions, idempotencyKey: "k1", date: installments[0].dueDate });
    for (const i of writes.installments) await setDoc(doc(env.db, "users", UID, "paymentSchedules", emi.scheduleId, "installments", i.id).withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }), i);
    for (const p of writes.payments)
      await setDoc(doc(env.db, "users", UID, "paymentSchedules", emi.scheduleId, "installments", p.installmentId, "payments", p.id), installmentPaymentToFirestore(p));
    for (const b of writes.breakdowns) await setDoc(doc(env.db, "users", UID, "emis", emi.id, "paymentBreakdowns", b.id), emiPaymentBreakdownToFirestore(b));
    await env.transactions.createTransaction({
      type: "expense",
      amount: 15000,
      dateTime: installments[0].dueDate,
      accountId: card.id,
      categoryId: "loan_payment",
      emiId: emi.id,
      installmentId: writes.payments[0].installmentId,
      installmentPaymentId: writes.payments[0].id,
      paymentAllocationType: "regularEmi",
    });
    expect(await balance(env, card.id)).toBe(-55000);

    const installmentIds = await allInstallmentIds(env, emi.scheduleId);
    await permanentlyDeleteAgreement(env.db, UID, "emi", emi.id);
    // The EMI's own ₹15,000 charge is gone; the ₹40,000 purchase it was set up on is the user's real history.
    expect(await balance(env, card.id)).toBe(-40000);
    expect((await env.transactions.getByKey(purchase.id))?.deletedAt).toBeNull();
    await expectNoTrace(env, "emi", emi.id, emi.scheduleId, installmentIds);
  });
});
