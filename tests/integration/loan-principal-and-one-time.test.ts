/**
 * Real-emulator regression tests for the Phase 1 financial-integrity gate:
 *  - Decision 5: every re-plan subtracts ALL active extra principal, derived from persisted payment
 *    records. Before: a second extra-principal payment (or a Borrow More / Edit terms after one) gave
 *    the earlier extra principal back — ₹12,000 − 1,000 − 3,000 − 1,000 − 2,000 re-planned to ₹8,000
 *    (tenure 9 → 10) instead of ₹5,000. Same numbers as Flutter's `loan_principal_prepayment_test.dart`.
 *  - D: one-time loans are paid through `LoanAdvancePaymentRepository.record` (account + Transaction +
 *    idempotency + reversal), both directions; paying more than is owed is refused.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";

const PROJECT_ID = "flowfi-loan-principal-one-time-integration-test";
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
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = new AccountRepository(
    collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }),
  );
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    new PaymentScheduleRepository(
      collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }),
    ),
    (scheduleId) => new InstallmentRepository(installmentsRef(scheduleId)),
  );
  const payments = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);
  const live = async (loan: Loan): Promise<Installment[]> =>
    (await getDocs(query(installmentsRef(loan.scheduleId), where("deletedAt", "==", null)))).docs
      .map((d) => d.data())
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const transactionsFor = async (loan: Loan) =>
    (await getDocs(query(collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), where("loanId", "==", loan.id)))).docs.map((d) => d.data());
  return { accounts, loans, payments, live, transactionsFor };
}

const unpaidTail = (installments: Installment[]) => installments.filter((i) => i.amountPaid === 0).reduce((s, i) => s + i.amountDue, 0);

describe("Decision 5 — extra principal is never given back by a later re-plan", () => {
  async function loanWithTwoExtraPayments() {
    const s = setup();
    const account = await s.accounts.createAccount({ name: "W", type: "bank", openingBalance: 1_000_000, colorValue: 0 });
    const loan = await s.loans.createLoan({
      loanAmount: 12000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "installment",
      direction: "taken",
      category: "institutional",
      institutionName: "B",
      interest: null,
      installmentFrequency: "monthly",
      installmentCount: 12,
    });
    await s.payments.record({ loan, scheduleInstallments: await s.live(loan), accountId: account.id, amount: 1000 + 3000, date: new Date("2026-01-15T00:00:00Z"), idempotencyKey: "p1" });
    const installments = await s.live(loan);
    const due = installments.find((i) => i.amountPaid === 0)!.amountDue;
    expect(due).toBe(1000);
    const second = await s.payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: due + 2000, date: new Date("2026-01-16T00:00:00Z"), idempotencyKey: "p2" });
    return { ...s, account, loan, second };
  }

  it("second extra-principal payment: ₹5,000 left (was ₹8,000), tenure goes down (was 9 → 10)", async () => {
    const { loans, live, loan } = await loanWithTwoExtraPayments();
    expect(unpaidTail(await live(loan))).toBeCloseTo(5000, 2);
    const fresh = (await loans.getByKey(loan.id))!;
    expect(fresh.installmentCount).toBe(7);
    expect(fresh.loanAmount).toBe(12000);
  });

  it("Borrow More after extra principal adds on top of the reduced principal (₹5,000 + ₹4,000)", async () => {
    const { loans, live, loan, payments, account } = await loanWithTwoExtraPayments();
    const fresh = (await loans.getByKey(loan.id))!;
    await payments.recordAdditionalDisbursement({ loan: fresh, scheduleInstallments: await live(loan), accountId: account.id, amount: 4000, date: new Date("2026-01-20T00:00:00Z"), idempotencyKey: "d1" });
    expect(unpaidTail(await live(loan))).toBeCloseTo(9000, 2);
  });

  it("Edit terms after extra principal re-plans from the reduced principal", async () => {
    const { loans, live, loan } = await loanWithTwoExtraPayments();
    const fresh = (await loans.getByKey(loan.id))!;
    await loans.editLoanTerms(fresh, { currentInstallments: await live(loan), interest: null, installmentFrequency: "monthly", newInstallmentCount: 12 });
    expect(unpaidTail(await live(loan))).toBeCloseTo(5000, 2);
  });

  it("reversing the second extra-principal payment restores the pre-payment balance and principal", async () => {
    const { live, loan, payments, second, accounts, account } = await loanWithTwoExtraPayments();
    await payments.reversePayment({
      loan,
      transactionId: second.transactionId,
      paymentIds: second.paymentIds,
      installmentIds: second.installmentIds,
      overflowPaymentId: second.overflowPaymentId ?? undefined,
      overflowInstallmentId: second.overflowInstallmentId ?? undefined,
      reversalIdempotencyKey: "p2-undo",
    });
    expect(unpaidTail(await live(loan))).toBeCloseTo(8000, 2);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(1_000_000 - 4000, 2);
  });
});

describe("D — one-time loans are paid through the financial repository", () => {
  async function oneTime(direction: "taken" | "given") {
    const s = setup();
    const account = await s.accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 50000, colorValue: 0 });
    const loan = await s.loans.createLoan({
      loanAmount: 20000,
      loanDate: new Date("2026-01-01T00:00:00Z"),
      repaymentType: "oneTime",
      direction,
      category: "institutional",
      institutionName: "Rahul",
      dueDate: new Date("2026-06-01T00:00:00Z"),
    });
    return { ...s, account, loan };
  }

  it("borrowed: ₹5,000 then ₹3,000 → ₹12,000 owed, account −₹8,000, two expense Transactions, one installment", async () => {
    const { payments, live, loan, account, accounts, transactionsFor } = await oneTime("taken");
    await payments.record({ loan, scheduleInstallments: await live(loan), accountId: account.id, amount: 5000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "ot-1" });
    await payments.record({ loan, scheduleInstallments: await live(loan), accountId: account.id, amount: 3000, date: new Date("2026-03-01T00:00:00Z"), idempotencyKey: "ot-2" });
    const installments = await live(loan);
    expect(installments).toHaveLength(1);
    expect(installments[0].amountDue - installments[0].amountPaid).toBe(12000);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(42000);
    const txns = await transactionsFor(loan);
    expect(txns.map((t) => t.type)).toEqual(["expense", "expense"]);
  });

  it("lent: a repayment received credits the account as income", async () => {
    const { payments, live, loan, account, accounts, transactionsFor } = await oneTime("given");
    await payments.record({ loan, scheduleInstallments: await live(loan), accountId: account.id, amount: 20000, date: new Date("2026-06-01T00:00:00Z"), idempotencyKey: "ot-lent" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(70000);
    expect((await transactionsFor(loan))[0].type).toBe("income");
  });

  it("retry with the same idempotency key moves money once", async () => {
    const { payments, live, loan, account, accounts, transactionsFor } = await oneTime("taken");
    const installments = await live(loan);
    await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 4000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "ot-retry" });
    await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: 4000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "ot-retry" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(46000);
    expect(await transactionsFor(loan)).toHaveLength(1);
  });

  it("paying more than is owed is refused and moves nothing", async () => {
    const { payments, live, loan, account, accounts, transactionsFor } = await oneTime("taken");
    await expect(
      payments.record({ loan, scheduleInstallments: await live(loan), accountId: account.id, amount: 25000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "ot-over" }),
    ).rejects.toThrow(/more than/);
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(50000);
    expect(await transactionsFor(loan)).toHaveLength(0);
  });

  it("reversal restores the account and what is owed", async () => {
    const { payments, live, loan, account, accounts } = await oneTime("taken");
    const result = await payments.record({ loan, scheduleInstallments: await live(loan), accountId: account.id, amount: 6000, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "ot-rev" });
    await payments.reversePayment({ loan, transactionId: result.transactionId, paymentIds: result.paymentIds, installmentIds: result.installmentIds, reversalIdempotencyKey: "ot-rev-undo" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBe(50000);
    expect((await live(loan))[0].amountPaid).toBe(0);
  });
});
