/**
 * Safety net for the read-parallelisation in `LoanAdvancePaymentRepository` (installments, payments and the
 * "schedule unchanged" check are now read together inside the transaction) and for the indexed
 * `ExpenseRepository.findActiveByTransactionId`. Real Firestore emulator — a duplicate submit must still move
 * money exactly once, and a reversal must still be refused when the schedule changed underneath it.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, query, setDoc, Timestamp, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { LoanAdvancePaymentRepository, PaymentReversalBlockedError } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";

const PROJECT_ID = "flowfi-payment-read-concurrency-test";
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

function reposFor(db: TestFirestore) {
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
  return { accounts, loans, installmentRepositoryFor, payments: new LoanAdvancePaymentRepository(db as unknown as import("firebase/firestore").Firestore, UID) };
}

async function longLoan(db: TestFirestore, count = 24) {
  const r = reposFor(db);
  const account = await r.accounts.createAccount({ name: "Wallet", type: "bank", openingBalance: 500_000, colorValue: 0 });
  const loan = await r.loans.createLoan({
    loanAmount: 120000,
    loanDate: new Date("2026-01-01T00:00:00Z"),
    repaymentType: "installment",
    direction: "taken",
    category: "institutional",
    institutionName: "Bank",
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    installmentFrequency: "monthly",
    installmentCount: count,
  });
  const installments = (await getDocs(query(collection(db, "users", UID, "paymentSchedules", loan.scheduleId, "installments").withConverter({
    toFirestore: installmentToFirestore,
    fromFirestore: installmentFromFirestore,
  }), where("deletedAt", "==", null)))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { r, account, loan, installments };
}

describe("loan payment reads issued together (real emulator)", () => {
  it("duplicate submit: the same idempotency key sent three times at once debits the account once", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const { r, account, loan, installments } = await longLoan(db);
    const due = installments[0].amountDue;

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        r.payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: due, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "double-click-0001" }),
      ),
    );

    expect(results.filter((x) => !x.alreadyRecorded)).toHaveLength(1);
    expect(new Set(results.map((x) => x.transactionId)).size).toBe(1);
    expect((await r.accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(500_000 - due, 2);
  });

  it("two different payments at once on a long schedule both land (no lost update)", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const { r, account, loan, installments } = await longLoan(db);
    const due = installments[0].amountDue;

    await Promise.all([
      r.payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: due / 4, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "part-a-000001" }),
      r.payments.record({ loan, scheduleInstallments: installments, accountId: account.id, amount: due / 4, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "part-b-000001" }),
    ]);

    expect((await r.accounts.getByKey(account.id))?.currentBalance).toBeCloseTo(500_000 - due / 2, 2);
    const fresh = await r.installmentRepositoryFor(loan.scheduleId).getByKey(installments[0].id);
    expect(fresh?.amountPaid).toBeCloseTo(due / 2, 2);
  });

  it("a reversal is still refused when another payment landed on the schedule meanwhile", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const { r, account, loan, installments } = await longLoan(db);
    const first = await r.payments.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: installments[0].amountDue,
      date: new Date("2026-02-01T00:00:00Z"),
      idempotencyKey: "first-0000001",
    });
    await r.payments.record({
      loan,
      scheduleInstallments: installments,
      accountId: account.id,
      amount: installments[1].amountDue,
      date: new Date("2026-03-01T00:00:00Z"),
      idempotencyKey: "second-000001",
    });

    await expect(
      r.payments.reversePayment({ loan, transactionId: first.transactionId, paymentIds: first.paymentIds, installmentIds: first.installmentIds, reversalIdempotencyKey: "rev-blocked-01" }),
    ).rejects.toBeInstanceOf(PaymentReversalBlockedError);
  });
});

describe("ExpenseRepository.findActiveByTransactionId (real emulator)", () => {
  it("returns the active expense for a transaction, ignores trashed ones, and null when there is none", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    const expenses = collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
    const seed = async (id: string, transactionId: string, deletedAt: Date | null) =>
      setDoc(doc(db, "users", UID, "expenses", id), {
        description: id,
        totalAmount: 900,
        date: Timestamp.fromDate(new Date(2026, 8, 1)),
        categoryId: "c",
        accountId: "a",
        transactionId,
        splitType: "equal",
        participants: [],
        scheduleId: null,
        notes: "",
        createdAt: Timestamp.fromDate(new Date(2026, 8, 1)),
        deletedAt: deletedAt == null ? null : Timestamp.fromDate(deletedAt),
        lastEditedAt: null,
        editHistory: [],
      });
    await seed("live", "txn-1", null);
    await seed("trashed", "txn-2", new Date(2026, 8, 2));
    await seed("other", "txn-3", null);

    // The method only touches its own collection.
    const repository = new ExpenseRepository(expenses, {} as never, {} as never, {} as never, (() => ({})) as never, (() => ({})) as never);
    expect((await repository.findActiveByTransactionId("txn-1"))?.id).toBe("live");
    expect(await repository.findActiveByTransactionId("txn-2")).toBeNull();
    expect(await repository.findActiveByTransactionId("txn-missing")).toBeNull();
  });
});

