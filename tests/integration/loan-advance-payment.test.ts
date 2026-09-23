/**
 * Emulator-backed regression coverage for `LoanAdvancePaymentRepository` —
 * the TS port of `Finance_App/lib/features/lending/data/
 * loan_advance_payment_repository.dart`. Mirrors that Dart file's own test
 * suite (`test/features/lending/loan_advance_payment_repository_test.dart`)
 * scenario-for-scenario, but against a REAL Firestore Emulator rather than a
 * fake — `fake_cloud_firestore`'s `runTransaction` has no true concurrency
 * (documented in `account_repository_test.dart`), so the concurrency
 * scenario here (§7) is a genuine proof this TS port's Firestore transaction
 * actually serializes concurrent payments, not just a sequential-stale-read
 * simulation.
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
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";

const PROJECT_ID = "flowfi-advance-payment-integration-test";
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
  return snap.docs.map((d) => d.data());
}

async function transactionsByLoanId(db: TestFirestore, loanId: string) {
  const { getDocs, query, where } = await import("firebase/firestore");
  const ref = collection(db, "users", UID, "transactions").withConverter({
    toFirestore: transactionToFirestore,
    fromFirestore: transactionFromFirestore,
  });
  const snap = await getDocs(query(ref, where("loanId", "==", loanId)));
  return snap.docs.map((d) => d.data());
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

describe("LoanAdvancePaymentRepository (real emulator)", () => {
  it("1. advance payment: writes payment + updates installment + creates Transaction + adjusts account balance", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2025-12-20T00:00:00Z"), // before installment 1's due date -> advance
      idempotencyKey: "k1",
    });

    expect(result.overallAllocationType).toBe("advanceEmi");
    expect(result.prepaymentPrincipalAmount).toBeNull();

    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed.find((i) => i.sequenceNumber === 1)?.amountPaid).toBeCloseTo(firstDue, 2);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - firstDue, 2);

    const txns = await transactionsByLoanId(db, loan.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("expense");
    expect(txns[0].amount).toBeCloseTo(firstDue, 2);
  });

  it("1b. a loan given (you lent money) credits the account on repayment", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 5000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "given",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "k-given",
    });

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(5000 + firstDue, 2);
  });

  it("4. partial EMI payment: correct remaining amount, no duplicate effect", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue / 2,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "partial-1",
    });
    const afterFirst = await installmentsFor(db, loan.scheduleId);
    expect(afterFirst.find((i) => i.sequenceNumber === 1)?.amountPaid).toBeCloseTo(firstDue / 2, 2);

    await repo.record({
      loan,
      scheduleInstallments: afterFirst,
      accountId: account.id,
      amount: firstDue / 2,
      date: new Date("2026-02-02T00:00:00Z"),
      idempotencyKey: "partial-2",
    });
    const afterSecond = await installmentsFor(db, loan.scheduleId);
    const completed = afterSecond.find((i) => i.sequenceNumber === 1)!;
    expect(completed.amountPaid).toBeCloseTo(firstDue, 2);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - firstDue, 2);
  });

  it("2&5. principal prepayment overflow reduces tenure at constant EMI amount, no money lost", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;
    const amount = firstDue + 5000;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount,
      date: new Date("2026-01-15T00:00:00Z"), // between installment 1 (Jan 1) and 2 (Feb 1)
      idempotencyKey: "prepay-1",
    });

    expect(result.overallAllocationType).toBe("principalPrepayment");
    expect(result.prepaymentPrincipalAmount).toBeCloseTo(5000, 2);
    expect(result.reamortization?.kind).toBe("solved");
    const solved = result.reamortization as { kind: "solved"; remainingInstallmentCount: number; installmentAmount: number };
    expect(solved.remainingInstallmentCount).toBeLessThan(11);
    expect(solved.installmentAmount).toBeLessThanOrEqual(firstDue + 0.01);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - amount, 2);

    const refreshedInstallments = await installmentsFor(db, loan.scheduleId);
    for (const i of refreshedInstallments) {
      expect(i.amountDue).toBeGreaterThanOrEqual(0);
    }

    const events = await reamortizationEventsFor(db, loan.id);
    expect(events).toHaveLength(1);
    expect(events[0].installmentCountAfter).toBeLessThan(events[0].installmentCountBefore);
  });

  it("6. duplicate/retried payment: same idempotencyKey is a no-op the second time", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const first = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "retry-key",
    });
    expect(first.alreadyRecorded).toBe(false);

    const afterFirst = await accounts.getByKey(account.id);
    expect(afterFirst?.currentBalance).toBeCloseTo(100000 - firstDue, 2);

    const second = await repo.record({
      loan,
      scheduleInstallments: await installmentsFor(db, loan.scheduleId),
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "retry-key",
    });
    expect(second.alreadyRecorded).toBe(true);

    const afterRetry = await accounts.getByKey(account.id);
    expect(afterRetry?.currentBalance).toBeCloseTo(100000 - firstDue, 2);
  });

  it("7. concurrent payments on the same loan both land (real emulator concurrency, no lost update)", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "Bank",
      interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;
    const secondDue = installments[1].amountDue;

    // Genuinely concurrent (Promise.all) against the real emulator — both
    // calls start from the SAME stale installments/account snapshot.
    await Promise.all([
      repo.record({
        loan,
        scheduleInstallments: installments,
        accountId: account.id,
        amount: firstDue,
        date: new Date("2026-02-01T00:00:00Z"),
        idempotencyKey: "concurrent-a",
      }),
      repo.record({
        loan,
        scheduleInstallments: installments,
        accountId: account.id,
        amount: secondDue,
        date: new Date("2026-03-01T00:00:00Z"),
        idempotencyKey: "concurrent-b",
      }),
    ]);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - firstDue - secondDue, 2);

    const refreshedInstallments = await installmentsFor(db, loan.scheduleId);
    expect(refreshedInstallments.find((i) => i.sequenceNumber === 1)?.amountPaid).toBeCloseTo(firstDue, 2);
    expect(refreshedInstallments.find((i) => i.sequenceNumber === 2)?.amountPaid).toBeCloseTo(secondDue, 2);
  });

  it(
    "REGRESSION (architecture review, fixed): a loanAmount change written to Firestore " +
      "AFTER the caller fetched its in-memory Loan is used correctly by re-amortization — " +
      "the FRESH Firestore value wins, not the stale caller value, and the write-back does " +
      "not regress it",
    async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      const accounts = accountRepositoryFor(db);
      const { loanRepository } = loanRepositoryFor(db);
      const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

      const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
      const loan = await loanRepository.createLoan({
        loanAmount: 12000,
        loanDate: new Date("2026-01-01T00:00:00Z"),
        repaymentType: "installment",
        direction: "taken",
        category: "institutional",
        institutionName: "Bank",
        interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
        installmentFrequency: "monthly",
        installmentCount: 12,
      });
      const installments = await installmentsFor(db, loan.scheduleId);
      const firstDue = installments[0].amountDue;

      // Simulate a concurrent write that changes loanAmount in Firestore
      // behind the in-memory `loan` object's back.
      const rawLoanRef = collection(db, "users", UID, "loans").withConverter({
        toFirestore: loanToFirestore,
        fromFirestore: loanFromFirestore,
      });
      const loanDocRef = doc(rawLoanRef, loan.id);
      const currentLoan = (await getDoc(loanDocRef)).data()!;
      await setDoc(loanDocRef, { ...currentLoan, loanAmount: 20000 }); // was 12000

      const amount = firstDue + 5000;
      const result = await repo.record({
        loan, // still holds loanAmount: 12000 in memory (stale)
        scheduleInstallments: installments,
        accountId: account.id,
        amount,
        date: new Date("2026-01-15T00:00:00Z"),
        idempotencyKey: "stale-loan-amount",
      });

      expect(result.reamortization?.kind).toBe("solved");

      const events = await reamortizationEventsFor(db, loan.id);
      // principalBefore = loanAmount - (installment 1's principal share paid off).
      // FRESH Firestore loanAmount (20000): 20000 - 946.19 = 19053.81.
      // The stale in-memory 12000 would have produced 11053.81 instead.
      expect(events[0].principalBefore).toBeCloseTo(19053.81, 2);

      // The write-back must not regress the concurrently-updated loanAmount.
      const reloadedLoan = await loanRepository.getByKey(loan.id);
      expect(reloadedLoan?.loanAmount).toBe(20000);
    },
  );

  it("validation: rejects a payment on a one-time loan", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 5000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "oneTime",
      category: "institutional",
      institutionName: "Bank",
      dueDate: new Date("2026-02-01T00:00:00Z"),
    });

    await expect(
      repo.record({
        loan,
        scheduleInstallments: [],
        accountId: account.id,
        amount: 100,
        date: new Date("2026-01-15T00:00:00Z"),
        idempotencyKey: "onetime",
      }),
    ).rejects.toThrow();
  });

  it("validation: rejects a payment when the loan is already fully paid", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await loanRepository.createLoan({
      loanAmount: 1000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      category: "institutional",
      institutionName: "Bank",
      installmentFrequency: "monthly",
      installmentCount: 1,
    });
    const installments = await installmentsFor(db, loan.scheduleId);

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: 1000,
      date: new Date("2026-01-05T00:00:00Z"),
      idempotencyKey: "full-1",
    });

    await expect(
      repo.record({
        loan,
        scheduleInstallments: await installmentsFor(db, loan.scheduleId),
        accountId: account.id,
        amount: 100,
        date: new Date("2026-01-06T00:00:00Z"),
        idempotencyKey: "full-2",
      }),
    ).rejects.toThrow();
  });
});
