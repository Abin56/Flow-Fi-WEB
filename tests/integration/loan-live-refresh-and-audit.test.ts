/**
 * Real-emulator regression tests for the Loan UX/live-refresh pass:
 *  - Edit Loan lost update (the root cause of "edit didn't show up"): chained whole-document writes
 *    must pass the previously-written Loan on, not the render-time snapshot.
 *  - Close/Reopen/Edit reach a live `watchAll` listener (what the open detail dialog renders from).
 *  - Every physical money operation writes exactly ONE Transaction with correct FKs + direction.
 *  - Extra principal lowers principal, Borrow/Lend More raises it, in the persisted documents.
 *  - The Loan history refresh key changes after each operation and its reversal.
 *  - The extra-principal payment record survives a re-plan in history (retired installment ids).
 *  - FIXED (Decision 5): outstanding principal now subtracts extra principal derived from the
 *    persisted payment records — the former `it.fails` pin is now a passing regression test.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanStatusGiven, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { loanReamortizationEventFromFirestore } from "@/lib/models/loan-reamortization-event";
import { outstandingPrincipalAfterPrepaymentsFor, outstandingPrincipalFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { historyInstallmentIds, loanHistoryQueryKey } from "@/features/loans/lib/loan-live-state";
import { loanTransactionLabel } from "@/features/loans/lib/loan-labels";

const PROJECT_ID = "flowfi-loan-live-refresh-integration-test";
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
    collection(db, "users", UID, "paymentSchedules").withConverter({
      toFirestore: paymentScheduleToFirestore,
      fromFirestore: paymentScheduleFromFirestore,
    }),
  );
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(
      collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
        toFirestore: installmentToFirestore,
        fromFirestore: installmentFromFirestore,
      }),
    );
  const loanRepository = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    scheduleRepository,
    installmentRepositoryFor,
  );
  const payments = new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID);
  return { db, accounts, loanRepository, payments };
}

async function baseLoan(loanRepository: LoanRepository, direction: "taken" | "given", name = "Home Loan") {
  return loanRepository.createLoan({
    name,
    loanAmount: 12000,
    loanDate: new Date("2026-01-01T00:00:00Z"),
    repaymentType: "installment",
    direction,
    category: "institutional",
    institutionName: "Bank",
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    installmentFrequency: "monthly",
    installmentCount: 12,
  });
}

async function liveInstallments(db: TestFirestore, scheduleId: string): Promise<Installment[]> {
  const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
    toFirestore: installmentToFirestore,
    fromFirestore: installmentFromFirestore,
  });
  const snap = await getDocs(query(ref, where("deletedAt", "==", null)));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

async function transactionsFor(db: TestFirestore, loanId: string) {
  const ref = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  return (await getDocs(query(ref, where("loanId", "==", loanId)))).docs.map((d) => d.data());
}

async function paymentsUnder(db: TestFirestore, scheduleId: string, installmentId: string) {
  const ref = collection(db, "users", UID, "paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({
    toFirestore: installmentPaymentToFirestore,
    fromFirestore: installmentPaymentFromFirestore,
  });
  return (await getDocs(ref)).docs.map((d) => d.data());
}

async function eventsFor(db: TestFirestore, loanId: string) {
  const ref = collection(db, "users", UID, "loans", loanId, "reamortizationEvents").withConverter({
    toFirestore: (e: never) => e,
    fromFirestore: loanReamortizationEventFromFirestore,
  });
  return (await getDocs(ref)).docs.map((d) => d.data());
}

/** Resolves with the first live `watchAll` emission for `loanId` that satisfies `predicate`. */
function waitForLiveLoan(loanRepository: LoanRepository, loanId: string, predicate: (loan: Loan) => boolean): Promise<Loan> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Live listener never delivered the expected Loan state"));
    }, 10_000);
    const unsubscribe = loanRepository.watchAll((loans) => {
      const loan = loans.find((l) => l.id === loanId);
      if (loan && predicate(loan)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(loan);
      }
    }, reject);
  });
}

function historyKey(loan: Loan, installments: Installment[]) {
  return JSON.stringify(loanHistoryQueryKey(UID, loan, installments));
}

describe("Edit Loan — chained whole-document writes (root cause of stale/lost edits)", () => {
  it("reproduction: passing the render-time Loan to editLoanTerms after editLoan reverts the rename", async () => {
    const { db, loanRepository } = setup();
    const loan = await baseLoan(loanRepository, "taken", "Old Name");
    const installments = await liveInstallments(db, loan.scheduleId);

    await loanRepository.editLoan(loan, { hasPayments: false, name: "New Name" });
    // The pre-fix workspace passed `activeRow.loan` (still "Old Name") here.
    await loanRepository.editLoanTerms(loan, {
      currentInstallments: installments,
      interest: { type: "reducingBalance", ratePercent: 10, period: "yearly" },
      installmentFrequency: "monthly",
      newInstallmentCount: 12,
    });

    const persisted = await loanRepository.getByKey(loan.id);
    expect(persisted?.interest?.ratePercent).toBe(10);
    expect(persisted?.name).toBe("Old Name"); // the rename was silently lost
  });

  it("fix: chaining each step's returned Loan keeps name, terms and date together, and the live listener sees all of them", async () => {
    const { db, loanRepository } = setup();
    const loan = await baseLoan(loanRepository, "taken", "Old Name");
    const installments = await liveInstallments(db, loan.scheduleId);

    let current = await loanRepository.editLoan(loan, { hasPayments: false, name: "New Name", notes: "refinanced" });
    current = await loanRepository.editLoanTerms(current, {
      currentInstallments: installments,
      interest: { type: "flat", ratePercent: 10, period: "yearly" },
      installmentFrequency: "monthly",
      newInstallmentCount: 10,
    });
    current = await loanRepository.editLoanDate(current, {
      newLoanDate: new Date("2026-02-01T00:00:00Z"),
      hasPayments: false,
      currentInstallments: await liveInstallments(db, loan.scheduleId),
    });

    const live = await waitForLiveLoan(loanRepository, loan.id, (l) => l.installmentCount === 10);
    expect(live.name).toBe("New Name");
    expect(live.notes).toBe("refinanced");
    expect(live.interest).toEqual({ type: "flat", ratePercent: 10, period: "yearly" });
    expect(live.loanDate.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(current.name).toBe("New Name");
  });
});

describe("Close / Reopen — live listener delivers the persisted status", () => {
  it("close then reopen flip the derived status the dialog, card and Status filter all read", async () => {
    const { db, loanRepository } = setup();
    const loan = await baseLoan(loanRepository, "taken");
    const installments = await liveInstallments(db, loan.scheduleId);

    const closing = waitForLiveLoan(loanRepository, loan.id, (l) => l.isClosed);
    await loanRepository.closeLoan(loan);
    const closed = await closing;
    expect(loanStatusGiven(closed, installments)).toBe("closed");

    const reopening = waitForLiveLoan(loanRepository, loan.id, (l) => !l.isClosed);
    await loanRepository.reopenLoan(closed);
    const reopened = await reopening;
    // Back to the schedule-derived status (these 2026 due dates may already be past → "overdue").
    expect(loanStatusGiven(reopened, installments)).not.toBe("closed");
    expect(loanStatusGiven(reopened, installments)).toBe(loanStatusGiven({ ...loan, isClosed: false }, installments));
  });
});

describe("Money operations — one Transaction each, correct FKs, direction and principal effect", () => {
  it("borrowed loan: EMI, multi-EMI, extra principal, borrow more — balances, FKs, labels, history keys", async () => {
    const { db, accounts, loanRepository, payments } = setup();
    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, "taken");
    let installments = await liveInstallments(db, loan.scheduleId);
    let key = historyKey(loan, installments);
    const emi = installments[0].amountDue;

    // 1) Regular EMI → money out, one Transaction, FK chain Transaction → InstallmentPayment.
    const regular = await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: emi, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "emi-1" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(100000 - emi, 2);
    let txns = await transactionsFor(db, loan.id);
    expect(txns).toHaveLength(1);
    const emiTxn = txns[0];
    expect(emiTxn).toMatchObject({ type: "expense", loanId: loan.id, paymentAllocationType: "regularEmi", installmentId: installments[0].id, installmentPaymentId: regular.paymentIds[0] });
    const emiPayment = (await paymentsUnder(db, loan.scheduleId, installments[0].id)).find((p) => p.id === regular.paymentIds[0]);
    expect(emiPayment?.transactionId).toBe(emiTxn.id);
    expect(loanTransactionLabel(emiTxn, loan)).toBe("Loan EMI — Home Loan");
    installments = await liveInstallments(db, loan.scheduleId);
    expect(historyKey(loan, installments)).not.toBe(key);
    key = historyKey(loan, installments);

    // 2) One payment across three EMIs → still exactly ONE new Transaction.
    const threeEmis = installments.slice(1, 4).reduce((s, i) => s + i.amountDue, 0);
    const multi = await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: threeEmis, date: new Date("2026-02-02T00:00:00Z"), includeUpcomingInstallments: true, idempotencyKey: "multi-1" });
    expect(multi.paymentIds).toHaveLength(3);
    txns = await transactionsFor(db, loan.id);
    expect(txns).toHaveLength(2);
    expect(txns.find((t) => t.id === multi.transactionId)?.amount).toBeCloseTo(threeEmis, 2);
    for (const [i, paymentId] of multi.paymentIds.entries()) {
      const p = (await paymentsUnder(db, loan.scheduleId, multi.installmentIds[i])).find((x) => x.id === paymentId);
      expect(p?.transactionId).toBe(multi.transactionId);
    }
    installments = await liveInstallments(db, loan.scheduleId);
    expect(historyKey(loan, installments)).not.toBe(key);
    key = historyKey(loan, installments);

    // 3) Extra principal → money out; persisted principal goes DOWN by exactly the extra amount.
    const balanceBeforeExtra = (await accounts.getByKey(account.id))!.currentBalance;
    const due = installments.find((i) => i.amountPaid === 0)!.amountDue;
    const extra = await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: due + 3000, date: new Date("2026-02-03T00:00:00Z"), idempotencyKey: "extra-1" });
    expect(extra.overallAllocationType).toBe("principalPrepayment");
    expect(extra.prepaymentPrincipalAmount).toBeCloseTo(3000, 2);
    expect(extra.reamortization?.kind).toBe("solved");
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(balanceBeforeExtra - due - 3000, 2);
    const [event] = await eventsFor(db, loan.id);
    expect(event.principalAfter).toBeCloseTo(event.principalBefore - 3000, 2);
    expect(event.principalAfter).toBeLessThan(event.principalBefore);
    const afterExtra = await liveInstallments(db, loan.scheduleId);
    const tailPrincipal = afterExtra.filter((i) => i.amountPaid === 0).reduce((s, i) => s + (i.principalPortion ?? 0), 0);
    expect(tailPrincipal).toBeCloseTo(event.principalAfter, 0);
    txns = await transactionsFor(db, loan.id);
    expect(txns).toHaveLength(3);
    const extraTxn = txns.find((t) => t.id === extra.transactionId)!;
    expect(extraTxn).toMatchObject({ type: "expense", paymentAllocationType: "principalPrepayment" });
    expect(loanTransactionLabel(extraTxn, loan)).toBe("Extra Principal Payment — Home Loan");
    const loanAfterExtra = (await loanRepository.getByKey(loan.id))!;
    expect(loanAfterExtra.loanAmount).toBe(12000); // never increased by a prepayment
    expect(historyKey(loanAfterExtra, afterExtra)).not.toBe(key);

    // History must still find the extra-principal record after the re-plan retired its installment.
    const liveOnly = (await Promise.all(afterExtra.map((i) => paymentsUnder(db, loan.scheduleId, i.id)))).flat();
    expect(liveOnly.some((p) => p.id === extra.overflowPaymentId)).toBe(false); // the pre-fix read missed it
    const withRetired = (await Promise.all(historyInstallmentIds(afterExtra.map((i) => i.id), [event]).map((id) => paymentsUnder(db, loan.scheduleId, id)))).flat();
    expect(withRetired.some((p) => p.id === extra.overflowPaymentId && p.allocationType === "principalPrepayment")).toBe(true);

    // 4) Borrow more → money IN, loanAmount up by the amount, its own Transaction.
    const balanceBeforeMore = (await accounts.getByKey(account.id))!.currentBalance;
    const more = await payments.recordAdditionalDisbursement({ loan: loanAfterExtra, scheduleInstallments: afterExtra, accountId: account.id, amount: 5000, date: new Date("2026-02-04T00:00:00Z"), idempotencyKey: "more-1" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(balanceBeforeMore + 5000, 2);
    const loanAfterMore = await waitForLiveLoan(loanRepository, loan.id, (l) => l.loanAmount === 17000);
    expect(loanAfterMore.loanAmount).toBe(17000);
    const moreTxn = (await transactionsFor(db, loan.id)).find((t) => t.id === more.transactionId)!;
    expect(moreTxn).toMatchObject({ type: "income", paymentAllocationType: "additionalDisbursement", amount: 5000 });
    expect(loanTransactionLabel(moreTxn, loan)).toBe("Borrowed More — Home Loan");
    const disbDoc = await getDoc(doc(db, "users", UID, "loans", loan.id, "additionalDisbursements", more.disbursementId));
    expect(disbDoc.data()?.transactionId).toBe(more.transactionId);
    const afterMore = await liveInstallments(db, loan.scheduleId);
    const keyAfterMore = historyKey(loanAfterMore, afterMore);
    expect(keyAfterMore).not.toBe(historyKey(loanAfterExtra, afterExtra));

    // 5) Reversing Borrow More restores balance and loanAmount; the history key moves again.
    await payments.reverseAdditionalDisbursement({ loan: loanAfterMore, transactionId: more.transactionId, disbursementId: more.disbursementId, reversalIdempotencyKey: "rev-more-1" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(balanceBeforeMore, 2);
    const loanAfterReversal = await waitForLiveLoan(loanRepository, loan.id, (l) => l.loanAmount === 12000);
    expect(historyKey(loanAfterReversal, await liveInstallments(db, loan.scheduleId))).not.toBe(keyAfterMore);
  });

  it("lent loan: repayment and extra principal bring money IN; lend more takes money OUT", async () => {
    const { db, accounts, loanRepository, payments } = setup();
    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 50000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, "given", "Rahul Loan");
    const installments = await liveInstallments(db, loan.scheduleId);
    const emi = installments[0].amountDue;

    await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: emi, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "g-emi" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(50000 + emi, 2);

    const afterEmi = await liveInstallments(db, loan.scheduleId);
    const due = afterEmi.find((i) => i.amountPaid === 0)!.amountDue;
    const extra = await payments.record({ loan, scheduleInstallments: afterEmi, accountId: account.id, amount: due + 2000, date: new Date("2026-02-02T00:00:00Z"), idempotencyKey: "g-extra" });
    expect(extra.overallAllocationType).toBe("principalPrepayment");
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(50000 + emi + due + 2000, 2);
    const [event] = await eventsFor(db, loan.id);
    expect(event.principalAfter).toBeCloseTo(event.principalBefore - 2000, 2);

    const more = await payments.recordAdditionalDisbursement({ loan, scheduleInstallments: await liveInstallments(db, loan.scheduleId), accountId: account.id, amount: 4000, date: new Date("2026-02-03T00:00:00Z"), idempotencyKey: "g-more" });
    expect((await accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(50000 + emi + due + 2000 - 4000, 2);
    const txns = await transactionsFor(db, loan.id);
    expect(txns).toHaveLength(3);
    const moreTxn = txns.find((t) => t.id === more.transactionId)!;
    expect(moreTxn.type).toBe("expense");
    expect(loanTransactionLabel(moreTxn, loan)).toBe("Lent More — Rahul Loan");
    expect(loanTransactionLabel(txns.find((t) => t.paymentAllocationType === "regularEmi")!, loan)).toBe("Loan Repayment Received — Rahul Loan");
    expect((await loanRepository.getByKey(loan.id))?.loanAmount).toBe(16000);
  });

  it("current classification (documented, unchanged): loan transactions are counted income/expense with excludeFromCalculations=false", async () => {
    // `excludeFromCalculations` also zeroes a Transaction's balance effect (`balanceEffect`), while the
    // loan repository moves the account balance directly — so flipping it on these documents would
    // make any later generic edit/delete of them mis-adjust the balance. Left as-is and reported.
    const { db, accounts, loanRepository, payments } = setup();
    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, "taken");
    const installments = await liveInstallments(db, loan.scheduleId);
    await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: installments[0].amountDue + 1000, date: new Date("2026-01-15T00:00:00Z"), idempotencyKey: "cls-extra" });
    await payments.recordAdditionalDisbursement({ loan, scheduleInstallments: await liveInstallments(db, loan.scheduleId), accountId: account.id, amount: 2000, date: new Date("2026-01-16T00:00:00Z"), idempotencyKey: "cls-more" });
    const txns = await transactionsFor(db, loan.id);
    expect(txns.map((t) => [t.paymentAllocationType, t.type, t.excludeFromCalculations]).sort()).toEqual(
      [["additionalDisbursement", "income", false], ["principalPrepayment", "expense", false]].sort(),
    );
  });
});

describe("FIXED (Decision 5) — displayed outstanding principal after Pay Extra Principal", () => {
  it("outstanding principal net of extra principal (derived from payment records) equals the persisted re-plan principal", async () => {
    const { db, accounts, loanRepository, payments } = setup();
    const account = await accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100000, colorValue: 0 });
    const loan = await baseLoan(loanRepository, "taken");
    const installments = await liveInstallments(db, loan.scheduleId);
    await payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: installments[0].amountDue + 5000, date: new Date("2026-01-15T00:00:00Z"), idempotencyKey: "gap-extra" });
    const [event] = await eventsFor(db, loan.id);
    const fresh = (await loanRepository.getByKey(loan.id))!;
    const live = await liveInstallments(db, loan.scheduleId);
    // BEFORE: the installment-only formula missed the extra ₹5,000 (`loanAmount` is unchanged and the
    // overflow is never applied to any installment).
    expect(outstandingPrincipalFor(fresh.loanAmount, live)).toBeCloseTo(event.principalAfter + 5000, 2);
    // AFTER: subtract the extra principal derived from the persisted payment records — including the
    // record under the installment this re-plan retired.
    const allPayments = (await Promise.all(historyInstallmentIds(live.map((i) => i.id), [event]).map((id) => paymentsUnder(db, loan.scheduleId, id)))).flat();
    const prepaid = principalPrepaidFor(allPayments);
    expect(prepaid).toBeCloseTo(5000, 2);
    expect(outstandingPrincipalAfterPrepaymentsFor(fresh.loanAmount, live, prepaid)).toBeCloseTo(event.principalAfter, 2);
  });
});
