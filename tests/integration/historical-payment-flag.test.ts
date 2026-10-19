/**
 * The structured "already paid earlier" flag behind the Transactions / Dashboard label (real Firestore emulator, real
 * repositories). The Loan payment Transaction carries no flag of its own, so lists resolve it from the payment
 * document the Transaction points at (`installmentPaymentId`) — a direct read, no index.
 *
 *  - a payment recorded as already paid earlier: its payment document has `recordedEarlier`, the Transaction is excluded from
 *    calculations and points at that very payment document, and the account never moves;
 *  - an ordinary payment: its payment document has no flag (also what every legacy record looks like);
 *  - editing the Transaction's description (where the repository allows it) never touches the flag.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveHistoricalPayment } from "@/features/loans/lib/historical-payment";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import { installmentFromFirestore, installmentPaymentFromFirestore, installmentPaymentToFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore } from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-historical-payment-flag";
const UID = "historical-flag-owner";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
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
  const installments = (scheduleId: string) =>
    new InstallmentRepository(col("paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const loans = new LoanRepository(
    col("loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    new PaymentScheduleRepository(col("paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore })),
    installments,
  );
  const paymentDocs = (scheduleId: string, installmentId: string) =>
    new InstallmentPaymentRepository(
      col("paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
      installments(scheduleId),
    );
  return { db, accounts, transactions, loans, installments, paymentDocs, payments: new LoanAdvancePaymentRepository(db, UID) };
}

async function seed(w: ReturnType<typeof setup>) {
  const bank = await w.accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 100_000, colorValue: 0 });
  const loan = await w.loans.createLoan({
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
  const installments = (await getDocs(query(collection(w.db, "users", UID, "paymentSchedules", loan.scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }), where("deletedAt", "==", null)))).docs
    .map((d) => d.data())
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { bank, loan, installments };
}

describe("structured historical flag on the payment document", () => {
  it("a historical payment is flagged on its payment document and the Transaction points at it; an ordinary one is not", async () => {
    const w = setup();
    const { bank, loan, installments } = await seed(w);

    const earlier = await w.payments.record({
      loan,
      scheduleInstallments: installments,
      accountId: bank.id,
      amount: installments[0].amountDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "hist-1",
      recordedEarlier: { dateKnown: true },
      expectedFirstInstallmentId: installments[0].id,
      onlyInstallmentId: installments[0].id,
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "QA — paid before FlowFi" },
    });
    const fresh = (await w.installments(loan.scheduleId).getAll()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const ordinary = await w.payments.record({ loan, scheduleInstallments: fresh, accountId: bank.id, amount: fresh[1].amountDue, date: new Date("2026-03-01T00:00:00Z"), idempotencyKey: "ord-1" });

    const histTxn = (await w.transactions.getByKey(earlier.transactionId))!;
    const ordTxn = (await w.transactions.getByKey(ordinary.transactionId))!;

    // The link a list can follow, and the structured answer at the end of it.
    expect(histTxn.installmentPaymentId).toBe(earlier.paymentIds[0]);
    expect(histTxn.excludeFromCalculations).toBe(true);
    const histPayment = await w.paymentDocs(loan.scheduleId, histTxn.installmentId!).getByKey(histTxn.installmentPaymentId!);
    expect(histPayment?.recordedEarlier).toEqual({ dateKnown: true });
    const ordPayment = await w.paymentDocs(loan.scheduleId, ordTxn.installmentId!).getByKey(ordTxn.installmentPaymentId!);
    expect(ordPayment?.recordedEarlier ?? null).toBeNull();

    // What the UI would show.
    expect(resolveHistoricalPayment(histTxn, histPayment?.recordedEarlier != null)).toBe(true);
    expect(resolveHistoricalPayment(ordTxn, ordPayment?.recordedEarlier != null)).toBe(false);

    // Only the ordinary payment moved the account.
    expect((await w.accounts.getByKey(bank.id))!.currentBalance).toBeCloseTo(100_000 - fresh[1].amountDue, 2);
  });

  it("editing the description leaves the flag, the amount and the balance untouched (the label must not depend on the text)", async () => {
    const w = setup();
    const { bank, loan, installments } = await seed(w);
    const r = await w.payments.record({
      loan,
      scheduleInstallments: installments,
      accountId: bank.id,
      amount: installments[0].amountDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "hist-2",
      recordedEarlier: { dateKnown: true },
      expectedFirstInstallmentId: installments[0].id,
      onlyInstallmentId: installments[0].id,
      peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "QA — paid before FlowFi" },
    });
    const before = (await w.transactions.getByKey(r.transactionId))!;
    const balanceBefore = (await w.accounts.getByKey(bank.id))!.currentBalance;

    let edited = false;
    try {
      await w.transactions.editTransaction(before, { description: "Car loan — October" });
      edited = true;
    } catch {
      // A repository that refuses the edit leaves everything as it was — asserted below either way.
    }

    const after = (await w.transactions.getByKey(r.transactionId))!;
    const payment = await w.paymentDocs(loan.scheduleId, after.installmentId!).getByKey(after.installmentPaymentId!);
    expect(payment?.recordedEarlier).toEqual({ dateKnown: true });
    expect(after.amount).toBe(before.amount);
    expect(after.excludeFromCalculations).toBe(true);
    expect((await w.accounts.getByKey(bank.id))!.currentBalance).toBe(balanceBefore);
    if (edited) {
      expect(after.description).toBe("Car loan — October");
      expect(resolveHistoricalPayment(after, payment?.recordedEarlier != null)).toBe(true);
    }
  });
});
