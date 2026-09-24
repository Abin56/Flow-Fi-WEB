/**
 * Emulator-backed regression coverage for
 * `LoanAdvancePaymentRepository.recordAdditionalDisbursement`/
 * `reverseAdditionalDisbursement` — the TS port of
 * `Finance_App/lib/features/lending/data/loan_advance_payment_repository.dart`'s
 * additional-disbursement feature (`HoldTenurePolicy`). Mirrors that Dart
 * file's own test suite
 * (`test/features/lending/loan_additional_disbursement_test.dart`)
 * scenario-for-scenario, but against a REAL Firestore Emulator — §8
 * (concurrent request) is a genuine proof of transaction serialization
 * here, not just a sequential-stale-read simulation, since
 * `fake_cloud_firestore` has no true concurrency.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { loanReamortizationEventFromFirestore } from "@/lib/models/loan-reamortization-event";
import { loanAdditionalDisbursementFromFirestore } from "@/lib/models/loan-additional-disbursement";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";

const PROJECT_ID = "flowfi-additional-disbursement-integration-test";
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

function accountRepositoryFor(db: TestFirestore) {
  const ref = collection(db, "users", UID, "accounts").withConverter({
    toFirestore: accountToFirestore,
    fromFirestore: accountFromFirestore,
  });
  return new AccountRepository(ref);
}

function loanRepositoryFor(db: TestFirestore) {
  const loanRef = collection(db, "users", UID, "loans").withConverter({
    toFirestore: loanToFirestore,
    fromFirestore: loanFromFirestore,
  });
  const scheduleRef = collection(db, "users", UID, "paymentSchedules").withConverter({
    toFirestore: paymentScheduleToFirestore,
    fromFirestore: paymentScheduleFromFirestore,
  });
  const scheduleRepository = new PaymentScheduleRepository(scheduleRef);
  const installmentRepositoryFor = (scheduleId: string) => {
    const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });
    return new InstallmentRepository(ref);
  };
  return {
    loanRepository: new LoanRepository(loanRef, scheduleRepository, installmentRepositoryFor),
    installmentRepositoryFor,
  };
}

async function installmentsFor(db: TestFirestore, scheduleId: string) {
  const { getDocs, query, where } = await import("firebase/firestore");
  const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
    toFirestore: installmentToFirestore,
    fromFirestore: installmentFromFirestore,
  });
  const snap = await getDocs(query(ref, where("deletedAt", "==", null)));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

async function getTransaction(db: TestFirestore, transactionId: string) {
  const ref = collection(db, "users", UID, "transactions").withConverter({
    toFirestore: transactionToFirestore,
    fromFirestore: transactionFromFirestore,
  });
  const snap = await getDoc(doc(ref, transactionId));
  return snap.exists() ? snap.data() : null;
}

async function getDisbursement(db: TestFirestore, loanId: string, disbursementId: string) {
  const ref = collection(db, "users", UID, "loans", loanId, "additionalDisbursements").withConverter({
    toFirestore: (d: never) => d,
    fromFirestore: loanAdditionalDisbursementFromFirestore,
  });
  const snap = await getDoc(doc(ref, disbursementId));
  return snap.exists() ? snap.data() : null;
}

async function reamortizationEventsFor(db: TestFirestore, loanId: string) {
  const { getDocs } = await import("firebase/firestore");
  const ref = collection(db, "users", UID, "loans", loanId, "reamortizationEvents").withConverter({
    toFirestore: (e: never) => e,
    fromFirestore: loanReamortizationEventFromFirestore,
  });
  const snap = await getDocs(ref);
  return snap.docs.map((d) => d.data());
}

function repoFor(db: TestFirestore) {
  return new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);
}

async function baseLoan(
  loanRepository: LoanRepository,
  overrides: {
    loanAmount?: number;
    installmentCount?: number;
    direction?: "given" | "taken";
    interest?: { type: "reducingBalance" | "flat"; ratePercent: number; period: "monthly" | "yearly" } | null;
  } = {},
) {
  return loanRepository.createLoan({
    loanAmount: overrides.loanAmount ?? 12000,
    loanDate: new Date("2026-01-01T00:00:00Z"),
    repaymentType: "installment",
    direction: overrides.direction ?? "taken",
    category: "institutional",
    institutionName: "Bank",
    interest:
      overrides.interest === null
        ? null
        : (overrides.interest ?? {
            type: "reducingBalance",
            ratePercent: 12,
            period: "yearly",
          }),
    installmentFrequency: "monthly",
    installmentCount: overrides.installmentCount ?? 12,
  });
}

describe("LoanAdvancePaymentRepository.recordAdditionalDisbursement (real emulator)", () => {
  it("1. given-loan disbursement: more money given increases loanAmount and is an EXPENSE from the account", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { direction: "given", loanAmount: 12000 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "given-1",
    });

    expect(result.alreadyRecorded).toBe(false);

    const txn = await getTransaction(db, result.transactionId);
    expect(txn?.type).toBe("expense");
    expect(txn?.loanId).toBe(loan.id);
    expect(txn?.paymentAllocationType).toBe("additionalDisbursement");

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(98000, 2);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(14000, 2);
  });

  it("2. taken-loan disbursement: more money borrowed increases loanAmount and is INCOME into the account", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { direction: "taken", loanAmount: 12000 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "taken-1",
    });

    const txn = await getTransaction(db, result.transactionId);
    expect(txn?.type).toBe("income");

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(102000, 2);
  });

  it("3. zero-interest loan: holdTenurePolicy solves via direct division across the held-constant tenure", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, interest: null });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 1200,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "zero-1",
    });

    expect(result.reamortization?.kind).toBe("solved");
    const solved = result.reamortization as { kind: "solved"; remainingInstallmentCount: number; installmentAmount: number };
    expect(solved.remainingInstallmentCount).toBe(12);
    expect(solved.installmentAmount).toBeCloseTo(1100, 2);

    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed).toHaveLength(12);
  });

  it("4. normal reducing-balance loan: installment amount increases, tenure held constant, principal grows exactly", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const originalAmount = installments[0].amountDue;

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 5000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "normal-1",
    });

    expect(result.reamortization?.kind).toBe("solved");
    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed).toHaveLength(12);
    expect(refreshed[0].amountDue).toBeGreaterThan(originalAmount);

    const events = await reamortizationEventsFor(db, loan.id);
    expect(events[0].triggerType).toBe("additionalDisbursement");
    expect(events[0].principalAfter - events[0].principalBefore).toBeCloseTo(5000, 2);
    expect(events[0].installmentCountBefore).toBe(events[0].installmentCountAfter);
  });

  it("5. disbursement after several EMIs: already-settled installments untouched, only unpaid tail reshapes", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "emi-before-disb",
    });

    const afterEmi = await installmentsFor(db, loan.scheduleId);
    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: afterEmi,
      accountId: account.id,
      amount: 3000,
      date: new Date("2026-02-05T00:00:00Z"),
      idempotencyKey: "disb-after-emi",
    });

    const refreshed = await installmentsFor(db, loan.scheduleId);
    const firstInstallment = refreshed.find((i) => i.sequenceNumber === 1)!;
    expect(firstInstallment.amountPaid).toBeCloseTo(firstDue, 2);
    expect(refreshed).toHaveLength(12);
    expect(result.reamortization?.kind).toBe("solved");
  });

  it("6. disbursement after principal prepayment: composes correctly, holds the ALREADY-reduced tenure", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const prepayResult = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue + 5000,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "prepay-before-disb",
    });
    expect(prepayResult.overallAllocationType).toBe("principalPrepayment");
    const afterPrepay = await installmentsFor(db, loan.scheduleId);
    const tenureAfterPrepay = afterPrepay.length;

    const disbResult = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: afterPrepay,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-20T00:00:00Z"),
      idempotencyKey: "disb-after-prepay",
    });

    const afterDisb = await installmentsFor(db, loan.scheduleId);
    expect(afterDisb).toHaveLength(tenureAfterPrepay);
    expect(disbResult.reamortization?.kind).toBe("solved");
  });

  it("7. repeated/idempotent request: retrying with the same idempotencyKey does not double-apply", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);

    const first = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "retry-disb-1",
    });
    expect(first.alreadyRecorded).toBe(false);

    const second = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: await installmentsFor(db, loan.scheduleId),
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "retry-disb-1",
    });
    expect(second.alreadyRecorded).toBe(true);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(102000, 2);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(14000, 2);
  });

  it("8. concurrent request (real emulator concurrency): two genuinely-parallel calls both apply, no lost update", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000 });
    const installments = await installmentsFor(db, loan.scheduleId);

    // Genuinely concurrent (Promise.all) against the real emulator — both
    // calls start from the SAME stale installments/loan snapshot.
    await Promise.all([
      repo.recordAdditionalDisbursement({
        loan,
        scheduleInstallments: installments,
        accountId: account.id,
        amount: 2000,
        date: new Date("2026-01-10T00:00:00Z"),
        idempotencyKey: "concurrent-disb-a",
      }),
      repo.recordAdditionalDisbursement({
        loan,
        scheduleInstallments: installments,
        accountId: account.id,
        amount: 3000,
        date: new Date("2026-01-11T00:00:00Z"),
        idempotencyKey: "concurrent-disb-b",
      }),
    ]);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(17000, 2); // both applied, no lost update
  });

  it("9. stale caller Loan: financial state comes from fresh reads, not the stale in-memory Loan", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const rawLoanRef = collection(db, "users", UID, "loans").withConverter({
      toFirestore: loanToFirestore,
      fromFirestore: loanFromFirestore,
    });
    const loanDocRef = doc(rawLoanRef, loan.id);
    const currentLoan = (await getDoc(loanDocRef)).data()!;
    await setDoc(loanDocRef, { ...currentLoan, loanAmount: 20000 });

    const result = await repo.recordAdditionalDisbursement({
      loan, // still holds loanAmount: 12000 in memory (stale)
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 5000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "stale-disb-1",
    });

    expect(result.alreadyRecorded).toBe(false);

    // FRESH Firestore loanAmount (20000) + 5000 = 25000, NOT stale 12000 + 5000 = 17000.
    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(25000, 2);
  });

  it("10. reversal: reverses loanAmount, Transaction, account balance, and restores the pre-disbursement schedule", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const originalTailIds = new Set(installments.map((i) => i.id));

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 5000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "reversal-disb-1",
    });
    expect(result.reamortization?.kind).toBe("solved");

    const afterDisb = await installmentsFor(db, loan.scheduleId);
    const regeneratedIds = new Set(afterDisb.map((i) => i.id));
    for (const id of regeneratedIds) expect(originalTailIds.has(id)).toBe(false);

    const reversal = await repo.reverseAdditionalDisbursement({
      loan,
      transactionId: result.transactionId,
      disbursementId: result.disbursementId,
      reversalIdempotencyKey: "reversal-disb-key-1",
    });

    expect(reversal.alreadyReversed).toBe(false);
    expect(reversal.scheduleRestored).toBe(true);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(12000, 2);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);

    const afterReversal = await installmentsFor(db, loan.scheduleId);
    const afterReversalIds = new Set(afterReversal.map((i) => i.id));
    expect(afterReversalIds).toEqual(originalTailIds);

    const txn = await getTransaction(db, result.transactionId);
    expect(txn?.deletedAt).not.toBeNull();

    const disbursement = await getDisbursement(db, loan.id, result.disbursementId);
    expect(disbursement?.deletedAt).not.toBeNull();
  });

  it("10b. reversal is idempotent: reversing twice does not double-move loanAmount or balance", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "idempotent-disb-1",
    });

    const first = await repo.reverseAdditionalDisbursement({
      loan,
      transactionId: result.transactionId,
      disbursementId: result.disbursementId,
      reversalIdempotencyKey: "idem-rev-a",
    });
    expect(first.alreadyReversed).toBe(false);

    const second = await repo.reverseAdditionalDisbursement({
      loan,
      transactionId: result.transactionId,
      disbursementId: result.disbursementId,
      reversalIdempotencyKey: "idem-rev-b",
    });
    expect(second.alreadyReversed).toBe(true);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(12000, 2);
  });

  it("11a. blocked reversal after dependent payment: reversing a disbursement is blocked once a payment lands on its regenerated tail", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const disbResult = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 5000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "blocked-disb-1",
    });

    const afterDisb = await installmentsFor(db, loan.scheduleId);
    await repo.record({
      loan,
      scheduleInstallments: afterDisb,
      accountId: account.id,
      amount: afterDisb[0].amountDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "followup-after-disb",
    });

    await expect(
      repo.reverseAdditionalDisbursement({
        loan,
        transactionId: disbResult.transactionId,
        disbursementId: disbResult.disbursementId,
        reversalIdempotencyKey: "blocked-rev-1",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);
  });

  it("11b. blocked reversal after another disbursement: reversing a disbursement is blocked once another disbursement follows it", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const firstDisb = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 3000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "chained-disb-a",
    });

    const afterFirst = await installmentsFor(db, loan.scheduleId);
    await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: afterFirst,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "chained-disb-b",
    });

    await expect(
      repo.reverseAdditionalDisbursement({
        loan,
        transactionId: firstDisb.transactionId,
        disbursementId: firstDisb.disbursementId,
        reversalIdempotencyKey: "blocked-rev-chained",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);
  });

  it("12. legacy Firestore document: a legacy re-amortization event with no reversal-tracking fields is not safely reversible", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 5000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "legacy-disb-1",
    });

    const { getDocs } = await import("firebase/firestore");
    const eventsRef = collection(db, "users", UID, "loans", loan.id, "reamortizationEvents");
    const eventsSnap = await getDocs(eventsRef);
    const eventDoc = eventsSnap.docs[0];
    await setDoc(eventDoc.ref, { ...eventDoc.data(), retiredInstallmentIds: [], generatedInstallmentIds: [] });

    await expect(
      repo.reverseAdditionalDisbursement({
        loan,
        transactionId: result.transactionId,
        disbursementId: result.disbursementId,
        reversalIdempotencyKey: "legacy-rev-1",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);
  });

  it("13. unsolvable holdTenurePolicy case: a fully-paid-off loan records the disbursement but skips re-amortization", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 1000, installmentCount: 1 });
    const installments = await installmentsFor(db, loan.scheduleId);

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 1000,
      date: new Date("2026-01-05T00:00:00Z"),
      idempotencyKey: "full-payoff",
    });

    const afterPayoff = await installmentsFor(db, loan.scheduleId);
    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: afterPayoff,
      accountId: account.id,
      amount: 500,
      date: new Date("2026-01-06T00:00:00Z"),
      idempotencyKey: "disb-nothing-to-reamortize",
    });

    expect(result.alreadyRecorded).toBe(false);
    expect(result.reamortization).toBeNull();

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(1500, 2);
  });

  it("14. generic delete/restore guard covers an additional-disbursement Transaction too", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);
    const { TransactionRepository, LoanPaymentTransactionRestrictedError: GuardError } = await import(
      "@/lib/repositories/transaction-repository"
    );
    const transactionRef = collection(db, "users", UID, "transactions").withConverter({
      toFirestore: transactionToFirestore,
      fromFirestore: transactionFromFirestore,
    });
    const transactionRepository = new TransactionRepository(
      transactionRef,
      new AccountRepository(
        collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }),
      ),
    );

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000 });
    const installments = await installmentsFor(db, loan.scheduleId);

    const result = await repo.recordAdditionalDisbursement({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 2000,
      date: new Date("2026-01-10T00:00:00Z"),
      idempotencyKey: "guard-disb-1",
    });

    const txn = await getTransaction(db, result.transactionId);
    expect(txn).not.toBeNull();

    await expect(transactionRepository.softDeleteTransaction(txn!)).rejects.toThrow(GuardError);

    // No partial effect.
    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(102000, 2);
    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBeCloseTo(14000, 2);
  });
});
