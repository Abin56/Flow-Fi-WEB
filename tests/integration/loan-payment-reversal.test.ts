/**
 * Emulator-backed regression coverage for
 * `LoanAdvancePaymentRepository.reversePayment` — the TS port of
 * `Finance_App/lib/features/lending/data/loan_advance_payment_repository.dart`'s
 * `reversePayment`. Mirrors that Dart file's own reversal test suite
 * (`test/features/lending/loan_advance_payment_reversal_test.dart`)
 * scenario-for-scenario, but against a REAL Firestore Emulator — `§7`
 * (concurrent reversal attempts) is a genuine proof of transaction
 * serialization here, not just a sequential-stale-read simulation, since
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
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";

const PROJECT_ID = "flowfi-payment-reversal-integration-test";
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

async function baseLoan(loanRepository: LoanRepository, overrides: { loanAmount?: number; installmentCount?: number } = {}) {
  return loanRepository.createLoan({
    loanAmount: overrides.loanAmount ?? 12000,
    loanDate: new Date("2026-01-01T00:00:00Z"),
    repaymentType: "installment",
    direction: "taken",
    category: "institutional",
    institutionName: "Bank",
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    installmentFrequency: "monthly",
    installmentCount: overrides.installmentCount ?? 12,
  });
}

describe("LoanAdvancePaymentRepository.reversePayment (real emulator)", () => {
  it("1. regular EMI reversal: restores installment amountPaid, deletes payment, deletes Transaction, restores account balance", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "regular-1",
    });

    const reversal = await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-1",
    });

    expect(reversal.alreadyReversed).toBe(false);

    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed[0].amountPaid).toBe(0);

    const txn = await getTransaction(db, result.transactionId);
    expect(txn?.deletedAt).not.toBeNull();

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("2. partial payment reversal: restores exactly the partial amount, not the full amountDue", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue / 3,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "partial-1",
    });

    const afterPayment = await installmentsFor(db, loan.scheduleId);
    expect(afterPayment[0].amountPaid).toBeCloseTo(firstDue / 3, 2);

    await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-partial",
    });

    const afterReversal = await installmentsFor(db, loan.scheduleId);
    expect(afterReversal[0].amountPaid).toBe(0);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("3. advance EMI reversal: reverses an early payment the same way as a regular one", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2025-12-20T00:00:00Z"),
      idempotencyKey: "advance-1",
    });
    expect(result.overallAllocationType).toBe("advanceEmi");

    await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-advance",
    });

    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed[0].amountPaid).toBe(0);
    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("4. one logical payment spanning multiple installments: reversal undoes ALL portions together", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;
    const secondDue = installments[1].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue + secondDue,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "multi-1",
      includeUpcomingInstallments: true,
    });
    expect(result.paymentIds).toHaveLength(2);

    await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-multi",
    });

    const refreshed = await installmentsFor(db, loan.scheduleId);
    expect(refreshed.find((i) => i.sequenceNumber === 1)?.amountPaid).toBe(0);
    expect(refreshed.find((i) => i.sequenceNumber === 2)?.amountPaid).toBe(0);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("5. principal-prepayment reversal: restores original tail, retires regenerated tail, reverts loan state, marks event reversed", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;
    const originalTailIds = new Set(installments.slice(1).map((i) => i.id));

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue + 5000,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "prepay-rev-1",
    });
    expect(result.overallAllocationType).toBe("principalPrepayment");
    expect(result.reamortization?.kind).toBe("solved");

    const afterPrepay = await installmentsFor(db, loan.scheduleId);
    const regeneratedTailIds = new Set(afterPrepay.filter((i) => i.sequenceNumber > 1).map((i) => i.id));
    for (const id of regeneratedTailIds) expect(originalTailIds.has(id)).toBe(false);

    const reversal = await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      overflowPaymentId: result.overflowPaymentId ?? undefined,
      overflowInstallmentId: result.overflowInstallmentId ?? undefined,
      reversalIdempotencyKey: "reversal-prepay-1",
    });

    expect(reversal.scheduleRestored).toBe(true);

    const afterReversal = await installmentsFor(db, loan.scheduleId);
    const afterReversalIds = new Set(afterReversal.map((i) => i.id));
    for (const id of originalTailIds) expect(afterReversalIds.has(id)).toBe(true);
    for (const id of regeneratedTailIds) expect(afterReversalIds.has(id)).toBe(false);
    expect(afterReversal).toHaveLength(12);

    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.installmentCount).toBe(12);

    const events = await reamortizationEventsFor(db, loan.id);
    expect(events[0].reversed).toBe(true);
    expect(events[0].reversedAt).not.toBeNull();
    expect(events[0].reversalId).toBe("reversal-prepay-1");

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("6. retry/idempotent reversal: reversing the same transaction twice does not double-move the balance", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "retry-rev-1",
    });

    const first = await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-retry-a",
    });
    expect(first.alreadyReversed).toBe(false);

    const second = await repo.reversePayment({
      loan,
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      reversalIdempotencyKey: "reversal-retry-b", // even a DIFFERENT key must be a no-op
    });
    expect(second.alreadyReversed).toBe(true);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2); // not 100000 + firstDue
  });

  it("7. concurrent reversal attempts (real emulator concurrency): two genuinely-parallel calls do not double-restore the balance", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "concurrent-rev-1",
    });

    // Genuinely concurrent (Promise.all) against the real emulator — proves
    // the transaction actually serializes rather than merely being
    // sequential-stale-read safe.
    await Promise.all([
      repo.reversePayment({
        loan,
        transactionId: result.transactionId,
        paymentIds: result.paymentIds,
        installmentIds: result.installmentIds,
        reversalIdempotencyKey: "reversal-concurrent-a",
      }),
      repo.reversePayment({
        loan,
        transactionId: result.transactionId,
        paymentIds: result.paymentIds,
        installmentIds: result.installmentIds,
        reversalIdempotencyKey: "reversal-concurrent-b",
      }),
    ]);

    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000, 2);
  });

  it("8. reversal with stale caller-supplied Loan state: financial state comes from fresh reads, not the stale in-memory Loan", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue + 5000,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "stale-rev-1",
    });

    // Simulate a concurrent loanAmount edit behind the stale `loan` object's back.
    const rawLoanRef = collection(db, "users", UID, "loans").withConverter({
      toFirestore: loanToFirestore,
      fromFirestore: loanFromFirestore,
    });
    const loanDocRef = doc(rawLoanRef, loan.id);
    const currentLoan = (await getDoc(loanDocRef)).data()!;
    await setDoc(loanDocRef, { ...currentLoan, loanAmount: 20000 });

    const reversal = await repo.reversePayment({
      loan, // still holds loanAmount: 12000 in memory (stale)
      transactionId: result.transactionId,
      paymentIds: result.paymentIds,
      installmentIds: result.installmentIds,
      overflowPaymentId: result.overflowPaymentId ?? undefined,
      overflowInstallmentId: result.overflowInstallmentId ?? undefined,
      reversalIdempotencyKey: "reversal-stale-1",
    });

    expect(reversal.scheduleRestored).toBe(true);

    // The write-back must not regress the concurrently-updated loanAmount.
    const refreshedLoan = await loanRepository.getByKey(loan.id);
    expect(refreshedLoan?.loanAmount).toBe(20000);
  });

  it("9. legacy re-amortization event without reversal metadata is blocked, not silently mis-reversed", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { loanAmount: 12000, installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue + 5000,
      date: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: "legacy-1",
    });

    // Simulate a legacy event by wiping the new tracking fields directly in Firestore.
    const { getDocs } = await import("firebase/firestore");
    const eventsRef = collection(db, "users", UID, "loans", loan.id, "reamortizationEvents");
    const eventsSnap = await getDocs(eventsRef);
    const eventDoc = eventsSnap.docs[0];
    await setDoc(eventDoc.ref, { ...eventDoc.data(), retiredInstallmentIds: [], generatedInstallmentIds: [] });

    await expect(
      repo.reversePayment({
        loan,
        transactionId: result.transactionId,
        paymentIds: result.paymentIds,
        installmentIds: result.installmentIds,
        overflowPaymentId: result.overflowPaymentId ?? undefined,
        overflowInstallmentId: result.overflowInstallmentId ?? undefined,
        reversalIdempotencyKey: "reversal-legacy-1",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);

    // Confirm nothing was mutated — the block happens before any write.
    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - (firstDue + 5000), 2);
  });

  it("10a. reversal blocked by later dependent activity: reversing payment A after a later payment B is blocked", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const resultA = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "chrono-a",
    });

    const afterA = await installmentsFor(db, loan.scheduleId);
    await repo.record({
      loan,
      scheduleInstallments: afterA,
      accountId: account.id,
      amount: afterA[1].amountDue,
      date: new Date("2026-03-01T00:00:00Z"),
      idempotencyKey: "chrono-b",
    });

    await expect(
      repo.reversePayment({
        loan,
        transactionId: resultA.transactionId,
        paymentIds: resultA.paymentIds,
        installmentIds: resultA.installmentIds,
        reversalIdempotencyKey: "reversal-chrono-a",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);
  });

  it("10b. reversing the LATEST payment (B) when an earlier one (A) exists is allowed", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, { installmentCount: 12 });
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "chrono2-a",
    });

    const afterA = await installmentsFor(db, loan.scheduleId);
    const resultB = await repo.record({
      loan,
      scheduleInstallments: afterA,
      accountId: account.id,
      amount: afterA[1].amountDue,
      date: new Date("2026-03-01T00:00:00Z"),
      idempotencyKey: "chrono2-b",
    });

    const reversal = await repo.reversePayment({
      loan,
      transactionId: resultB.transactionId,
      paymentIds: resultB.paymentIds,
      installmentIds: resultB.installmentIds,
      reversalIdempotencyKey: "reversal-chrono2-b",
    });
    expect(reversal.alreadyReversed).toBe(false);
  });

  it("10c. reversing a principal prepayment is blocked once a payment lands on its regenerated tail", async () => {
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
      idempotencyKey: "chrono3-prepay",
    });

    const afterPrepay = await installmentsFor(db, loan.scheduleId);
    const regeneratedFirst = afterPrepay.find((i) => i.sequenceNumber === 2)!;
    await repo.record({
      loan,
      scheduleInstallments: afterPrepay,
      accountId: account.id,
      amount: regeneratedFirst.amountDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "chrono3-followup",
    });

    await expect(
      repo.reversePayment({
        loan,
        transactionId: prepayResult.transactionId,
        paymentIds: prepayResult.paymentIds,
        installmentIds: prepayResult.installmentIds,
        overflowPaymentId: prepayResult.overflowPaymentId ?? undefined,
        overflowInstallmentId: prepayResult.overflowInstallmentId ?? undefined,
        reversalIdempotencyKey: "reversal-chrono3",
      }),
    ).rejects.toThrow(PaymentReversalBlockedError);
  });

  it("11. generic delete/restore guard: softDeleteTransaction/restoreTransaction refuse a loan-linked Transaction", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const accounts = accountRepositoryFor(db);
    const { loanRepository } = loanRepositoryFor(db);
    const repo = repoFor(db);
    const { TransactionRepository } = await import("@/lib/repositories/transaction-repository");
    const { LoanPaymentTransactionRestrictedError } = await import("@/lib/repositories/transaction-repository");
    const transactionRef = collection(db, "users", UID, "transactions").withConverter({
      toFirestore: transactionToFirestore,
      fromFirestore: transactionFromFirestore,
    });
    const transactionRepository = new TransactionRepository(transactionRef, new AccountRepository(collection(db, "users", UID, "accounts").withConverter({
      toFirestore: accountToFirestore,
      fromFirestore: accountFromFirestore,
    })));

    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository);
    const installments = await installmentsFor(db, loan.scheduleId);
    const firstDue = installments[0].amountDue;

    const result = await repo.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: firstDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "guard-1",
    });

    const txn = await getTransaction(db, result.transactionId);
    expect(txn).not.toBeNull();

    await expect(transactionRepository.softDeleteTransaction(txn!)).rejects.toThrow(LoanPaymentTransactionRestrictedError);

    // Confirm nothing was mutated — no partial-effect corruption.
    const refreshedAccount = await accounts.getByKey(account.id);
    expect(refreshedAccount?.currentBalance).toBeCloseTo(100000 - firstDue, 2);
    const refreshedInstallments = await installmentsFor(db, loan.scheduleId);
    expect(refreshedInstallments[0].amountPaid).toBeCloseTo(firstDue, 2);

    // restoreTransaction is equally blocked (even though this txn isn't soft-deleted).
    await expect(transactionRepository.restoreTransaction(txn!)).rejects.toThrow(LoanPaymentTransactionRestrictedError);
  });
});
