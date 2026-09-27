/**
 * Emulator-backed coverage for `LoanAdvancePaymentRepository.editPayment` — correcting a recorded Loan
 * payment. Proves against a real Firestore Emulator that the edit replaces the original's effect
 * (schedule, Transaction, account balance) instead of stacking on it, on both write paths (one atomic
 * transaction, and reverse-then-record when a schedule re-plan is involved), and that it's idempotent.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";

const PROJECT_ID = "flowfi-payment-edit-integration-test";
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

type TestFirestore = ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = new AccountRepository(
    collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }),
  );
  const scheduleRepository = new PaymentScheduleRepository(
    collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }),
  );
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(
      collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
        toFirestore: installmentToFirestore,
        fromFirestore: installmentFromFirestore,
      }),
    );
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    scheduleRepository,
    installmentRepositoryFor,
  );
  const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);
  return { db, accounts, loans, repo };
}

async function liveInstallments(db: TestFirestore, scheduleId: string) {
  const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
    toFirestore: installmentToFirestore,
    fromFirestore: installmentFromFirestore,
  });
  const snap = await getDocs(query(ref, where("deletedAt", "==", null)));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

async function txn(db: TestFirestore, id: string) {
  const ref = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const snap = await getDoc(doc(ref, id));
  return snap.exists() ? snap.data() : null;
}

/** ₹20,000, no interest, 4 × ₹5,000 monthly. */
async function bikeLoan(loans: LoanRepository) {
  return loans.createLoan({
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
}

/** Noon on installment #1's own due day — only #1 is currently due. */
const onDue = (i: { dueDate: Date }) => new Date(i.dueDate.getTime() + 12 * 3600 * 1000);

describe("LoanAdvancePaymentRepository.editPayment (real emulator)", () => {
  it("₹8,000 advance corrected to ₹5,000: one atomic replace — schedule, Transaction and account net", async () => {
    const { db, accounts, loans, repo } = setup();
    const account = await accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await bikeLoan(loans);
    const installments = await liveInstallments(db, loan.scheduleId);
    const ON_FIRST_DUE = onDue(installments[0]);
    expect(installments.map((i) => i.amountDue)).toEqual([5000, 5000, 5000, 5000]);

    const original = await repo.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 8000, date: ON_FIRST_DUE, idempotencyKey: "orig", includeUpcomingInstallments: true });
    expect((await liveInstallments(db, loan.scheduleId)).map((i) => i.amountPaid)).toEqual([5000, 3000, 0, 0]);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(92000);

    const result = await repo.editPayment({
      loan,
      scheduleInstallments: installments,
      original: { transactionId: original.transactionId, paymentIds: original.paymentIds, installmentIds: original.installmentIds },
      accountId: account.id,
      amount: 5000,
      date: ON_FIRST_DUE,
      idempotencyKey: "fix",
      includeUpcomingInstallments: true,
    });
    expect(result).toMatchObject({ alreadyRecorded: false, atomic: true, overallAllocationType: "regularEmi" });

    expect((await liveInstallments(db, loan.scheduleId)).map((i) => i.amountPaid)).toEqual([5000, 0, 0, 0]);
    expect((await txn(db, original.transactionId))?.deletedAt).not.toBeNull();
    expect(await txn(db, "adv_fix_txn")).toMatchObject({ amount: 5000, deletedAt: null, accountId: account.id });
    // Not 100000 − 8000 − 5000: the original movement is undone, the correction applied once.
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(95000);

    // Retrying the same edit is a no-op.
    const again = await repo.editPayment({
      loan,
      scheduleInstallments: installments,
      original: { transactionId: original.transactionId, paymentIds: original.paymentIds, installmentIds: original.installmentIds },
      accountId: account.id,
      amount: 5000,
      date: ON_FIRST_DUE,
      idempotencyKey: "fix",
    });
    expect(again.alreadyRecorded).toBe(true);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(95000);
  });

  it("correcting the source account moves each account once", async () => {
    const { db, accounts, loans, repo } = setup();
    const hdfc = await accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const icici = await accounts.createAccount({ name: "ICICI", type: "bank", openingBalance: 50000, colorValue: 0 });
    const loan = await bikeLoan(loans);
    const installments = await liveInstallments(db, loan.scheduleId);
    const ON_FIRST_DUE = onDue(installments[0]);
    const original = await repo.record({ loan, scheduleInstallments: installments, accountId: hdfc.id, amount: 5000, date: ON_FIRST_DUE, idempotencyKey: "o" });

    await repo.editPayment({
      loan,
      scheduleInstallments: installments,
      original: { transactionId: original.transactionId, paymentIds: original.paymentIds, installmentIds: original.installmentIds },
      accountId: icici.id,
      amount: 5000,
      date: ON_FIRST_DUE,
      idempotencyKey: "f",
    });
    expect((await accounts.getByKey(hdfc.id))?.currentBalance).toBe(100000);
    expect((await accounts.getByKey(icici.id))?.currentBalance).toBe(45000);
    expect((await liveInstallments(db, loan.scheduleId)).map((i) => i.amountPaid)).toEqual([5000, 0, 0, 0]);
  });

  it("an extra-principal payment corrected to a plain installment: re-plan undone, schedule and account restored", async () => {
    const { db, accounts, loans, repo } = setup();
    const account = await accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await bikeLoan(loans);
    const installments = await liveInstallments(db, loan.scheduleId);
    const ON_FIRST_DUE = onDue(installments[0]);
    const original = await repo.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 8000, date: ON_FIRST_DUE, idempotencyKey: "pre" });
    expect(original.overallAllocationType).toBe("principalPrepayment");
    expect(original.reamortization?.kind).toBe("solved");

    const stages: string[] = [];
    const result = await repo.editPayment({
      loan,
      scheduleInstallments: await liveInstallments(db, loan.scheduleId),
      original: {
        transactionId: original.transactionId,
        paymentIds: original.paymentIds,
        installmentIds: original.installmentIds,
        overflowPaymentId: original.overflowPaymentId,
        overflowInstallmentId: original.overflowInstallmentId,
      },
      accountId: account.id,
      amount: 5000,
      date: ON_FIRST_DUE,
      idempotencyKey: "fix-pre",
      onStage: (s) => stages.push(s),
    });
    expect(result.atomic).toBe(false);
    expect(stages).toEqual(["reversing", "recording"]);

    const after = await liveInstallments(db, loan.scheduleId);
    expect(after.map((i) => [i.amountDue, i.amountPaid])).toEqual([
      [5000, 5000],
      [5000, 0],
      [5000, 0],
      [5000, 0],
    ]);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(95000);
  });

  it("an older payment can't be edited once a later one exists — nothing changes", async () => {
    const { db, accounts, loans, repo } = setup();
    const account = await accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await bikeLoan(loans);
    const installments = await liveInstallments(db, loan.scheduleId);
    const ON_FIRST_DUE = onDue(installments[0]);
    const first = await repo.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 5000, date: ON_FIRST_DUE, idempotencyKey: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await repo.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 5000, date: onDue(installments[1]), idempotencyKey: "b" });

    await expect(
      repo.editPayment({
        loan,
        scheduleInstallments: installments,
        original: { transactionId: first.transactionId, paymentIds: first.paymentIds, installmentIds: first.installmentIds },
        accountId: account.id,
        amount: 4000,
        date: ON_FIRST_DUE,
        idempotencyKey: "c",
      }),
    ).rejects.toBeInstanceOf(PaymentReversalBlockedError);
    expect((await liveInstallments(db, loan.scheduleId)).map((i) => i.amountPaid)).toEqual([5000, 5000, 0, 0]);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(90000);
  });
});
