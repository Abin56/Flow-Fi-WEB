/**
 * Real-emulator tests for `LoanRepository.createAgreementWithOrigination` — the atomic, idempotent
 * create path of the unified Loans & Installments wizard (Loan + PaymentSchedule + Installments +
 * origination Transaction + Account balance in one `runTransaction`). Same scenarios as Flutter's
 * `test/features/lending/loan_origination_repository_test.dart`.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import {
  effectiveMonth,
  isNonIncomeExpenseMovement,
  transactionFromFirestore,
  transactionToFirestore,
  type Transaction,
} from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import {
  LoanRepository,
  OriginationConflictError,
  OriginationReversalBlockedError,
  type CreateAgreementWithOriginationParams,
  type OriginationStage,
} from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LoanPaymentTransactionRestrictedError, TransactionRepository } from "@/lib/repositories/transaction-repository";
import { loanTransactionLabel } from "@/features/loans/lib/loan-labels";

const PROJECT_ID = "flowfi-loan-origination-integration-test";
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
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as import("firebase/firestore").Firestore;
  const accounts = new AccountRepository(
    collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }),
  );
  const transactionsRef = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsRef, accounts);
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });
  const loansRef = collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore });
  const schedulesRef = collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore });
  const loans = new LoanRepository(loansRef, new PaymentScheduleRepository(schedulesRef), (scheduleId) => new InstallmentRepository(installmentsRef(scheduleId)));
  const payments = new LoanAdvancePaymentRepository(db, UID);
  const counts = async () => ({
    loans: (await getDocs(loansRef)).size,
    schedules: (await getDocs(schedulesRef)).size,
    transactions: (await getDocs(transactionsRef)).size,
  });
  const allInstallments = async (scheduleId: string) =>
    (await getDocs(installmentsRef(scheduleId))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const loanTransactions = async (loanId: string) =>
    (await getDocs(query(transactionsRef, where("loanId", "==", loanId)))).docs.map((d) => d.data());
  const balance = async (accountId: string) => (await accounts.getByKey(accountId))!.currentBalance;
  return { db, accounts, transactions, transactionsRef, loans, payments, counts, allInstallments, loanTransactions, balance };
}

type Setup = ReturnType<typeof setup>;

const LOAN_DATE = new Date(2026, 0, 10);

function borrowed(key: string, extra: Partial<CreateAgreementWithOriginationParams> = {}): CreateAgreementWithOriginationParams {
  return {
    idempotencyKey: key,
    name: "Home renovation",
    category: "institutional",
    institutionName: "HDFC Bank",
    fundingSource: "bank",
    direction: "taken",
    loanAmount: 50000,
    loanDate: LOAN_DATE,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 12,
    ...extra,
  };
}

function lent(key: string, personId: string, extra: Partial<CreateAgreementWithOriginationParams> = {}): CreateAgreementWithOriginationParams {
  return {
    idempotencyKey: key,
    name: "Rahul",
    category: "personal",
    personId,
    fundingSource: "person",
    direction: "given",
    loanAmount: 25000,
    loanDate: LOAN_DATE,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 5,
    ...extra,
  };
}

function purchase(key: string, extra: Partial<CreateAgreementWithOriginationParams> = {}): CreateAgreementWithOriginationParams {
  return {
    idempotencyKey: key,
    name: "Laptop",
    agreementKind: "installmentPurchase",
    category: "institutional",
    institutionName: "Bajaj Finserv",
    fundingSource: "financeCompany",
    direction: "taken",
    purchaseAmount: 60000,
    downPayment: 10000,
    loanAmount: 50000,
    loanDate: LOAN_DATE,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 10,
    ...extra,
  };
}

async function bank(s: Setup, name = "HDFC", openingBalance = 100000) {
  return s.accounts.createAccount({ name, type: "bank", openingBalance, colorValue: 0 });
}

/** Net Worth = accounts + lent principal − borrowed principal, from live documents (Decision 6). */
async function netWorth(s: Setup) {
  const accounts = (await getDocs(collection(s.db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }))).docs.map((d) => d.data());
  const loans = (await s.loans.getAll()).filter((l) => l.deletedAt == null && !l.isClosed);
  const accountTotal = accounts.reduce((sum, a) => sum + a.currentBalance, 0);
  return netWorthWithLoans(accountTotal, {
    lentPrincipal: loans.filter((l) => l.direction === "given").reduce((sum, l) => sum + l.loanAmount, 0),
    borrowedPrincipal: loans.filter((l) => l.direction === "taken").reduce((sum, l) => sum + l.loanAmount, 0),
    emiPrincipal: 0,
    cardOwnedEmiPrincipal: 0,
    cardLockedEmiPrincipal: 0,
  } as Parameters<typeof netWorthWithLoans>[1]);
}

function cashFlowFor(transactions: Transaction[], now: Date) {
  return cashFlowThisMonth({
    transactions: transactions.map((t) => ({ type: t.type, amount: t.amount, effectiveMonth: effectiveMonth(t), isDeleted: t.deletedAt != null, isTransfer: isNonIncomeExpenseMovement(t) })),
    emiPaidThisMonth: 0,
    loanPaidThisMonth: 0,
    billsPaidThisMonth: 0,
    moneyReceivedThisMonth: 0,
    now,
  });
}

describe("Money I Borrowed", () => {
  it("1 — no account movement: Loan + schedule + installments, no Transaction, no Account change", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("borrow-none-01"));
    expect(result.alreadyCreated).toBe(false);
    expect(result.transactionId).toBeNull();
    expect(result.loan.id).toBe("orig_borrow-none-01_loan");
    expect(await s.allInstallments(result.scheduleId)).toHaveLength(12);
    expect(await s.counts()).toEqual({ loans: 1, schedules: 1, transactions: 0 });
    expect(await s.balance(hdfc.id)).toBe(100000);
  });

  it("2/5 — record money received into HDFC: +₹50,000 account, +₹50,000 liability, one inflow, Net Worth unchanged, not income", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const before = await netWorth(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("borrow-move-01", { movementAccountId: hdfc.id }));
    expect(await s.balance(hdfc.id)).toBe(150000);
    expect(await netWorth(s)).toBeCloseTo(before, 2);

    const txns = await s.loanTransactions(result.loan.id);
    expect(txns).toHaveLength(1);
    const [txn] = txns;
    expect(txn.id).toBe("orig_borrow-move-01_txn");
    expect([txn.type, txn.amount, txn.accountId, txn.paymentAllocationType, txn.excludeFromCalculations]).toEqual(["income", 50000, hdfc.id, "additionalDisbursement", false]);
    expect(loanTransactionLabel(txn, result.loan)).toBe("Loan Received — Home renovation");

    // Visible in Transactions (it is a real document), but not income: Cash Flow / Dashboard / Reports
    // all derive income from `cashFlowThisMonth` over `isNonIncomeExpenseMovement`.
    expect(isNonIncomeExpenseMovement(txn)).toBe(true);
    expect(cashFlowFor(txns, LOAN_DATE)).toEqual({ moneyIn: 0, moneyOut: 0, net: 0 });

    const schedule = (await s.allInstallments(result.scheduleId));
    expect(schedule.map((i) => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `orig_borrow-move-01_inst_${i + 1}`));
    expect(schedule.reduce((sum, i) => sum + i.amountDue, 0)).toBeCloseTo(50000, 2);
  });

  it("6 — one-time borrowed: one oneTime installment on the due date, no fake monthly rows", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const due = new Date(2026, 5, 30);
    const result = await s.loans.createAgreementWithOrigination(
      borrowed("borrow-once-01", { repaymentType: "oneTime", installmentFrequency: null, installmentCount: null, dueDate: due, loanAmount: 8000, movementAccountId: hdfc.id }),
    );
    expect(result.loan.repaymentType).toBe("oneTime");
    expect(result.loan.installmentCount).toBeNull();
    const installments = await s.allInstallments(result.scheduleId);
    expect(installments).toHaveLength(1);
    expect(installments[0].dueDate.getTime()).toBe(due.getTime());
    expect(installments[0].amountDue).toBe(8000);
    expect(await s.balance(hdfc.id)).toBe(108000);
  });
});

describe("Money I Lent", () => {
  it("3 — no account movement", async () => {
    const s = setup();
    const sbi = await bank(s, "SBI");
    const result = await s.loans.createAgreementWithOrigination(lent("lend-none-01", "rahul"));
    expect(result.loan.personId).toBe("rahul");
    expect(result.transactionId).toBeNull();
    expect(await s.balance(sbi.id)).toBe(100000);
  });

  it("4/7 — record money sent from SBI: −₹25,000 account, +₹25,000 receivable, one outflow, Net Worth unchanged, not spending", async () => {
    const s = setup();
    const sbi = await bank(s, "SBI");
    const before = await netWorth(s);
    const result = await s.loans.createAgreementWithOrigination(lent("lend-move-01", "rahul", { movementAccountId: sbi.id }));
    expect(await s.balance(sbi.id)).toBe(75000);
    expect(await netWorth(s)).toBeCloseTo(before, 2);
    const txns = await s.loanTransactions(result.loan.id);
    expect(txns.map((t) => [t.type, t.amount, t.paymentAllocationType])).toEqual([["expense", 25000, "additionalDisbursement"]]);
    expect(cashFlowFor(txns, LOAN_DATE).moneyOut).toBe(0);
    expect(loanTransactionLabel(txns[0], result.loan)).toBe("Money Lent — Rahul");
    // Person linkage only — no Person document/ledger was written by the origination.
    expect((await getDocs(collection(s.db, "users", UID, "people"))).size).toBe(0);
  });

  it("8 — one-time lent, then repaid and reversed through the existing one-time payment flow", async () => {
    const s = setup();
    const sbi = await bank(s, "SBI");
    const result = await s.loans.createAgreementWithOrigination(
      lent("lend-once-01", "rahul", { repaymentType: "oneTime", installmentFrequency: null, installmentCount: null, dueDate: new Date(2026, 2, 1), loanAmount: 3000, movementAccountId: sbi.id }),
    );
    expect(await s.balance(sbi.id)).toBe(97000);
    const installments = await s.allInstallments(result.scheduleId);
    const paid = await s.payments.record({ loan: result.loan, scheduleInstallments: installments, accountId: sbi.id, amount: 3000, date: new Date(2026, 2, 1), idempotencyKey: "lend-once-01-repay" });
    expect(await s.balance(sbi.id)).toBe(100000);
    await s.payments.reversePayment({ loan: result.loan, transactionId: paid.transactionId, paymentIds: paid.paymentIds, installmentIds: paid.installmentIds, reversalIdempotencyKey: "lend-once-01-rev" });
    expect(await s.balance(sbi.id)).toBe(97000);
  });
});

describe("Installment Purchase", () => {
  it("9 — zero down payment: financed = purchase, no movement", async () => {
    const s = setup();
    const result = await s.loans.createAgreementWithOrigination(purchase("buy-zero-01", { downPayment: 0, loanAmount: 60000 }));
    expect([result.loan.purchaseAmount, result.loan.downPayment, result.loan.loanAmount]).toEqual([60000, 0, 60000]);
    expect(result.transactionId).toBeNull();
  });

  it("9b — zero down payment cannot be 'recorded'", async () => {
    const s = setup();
    const hdfc = await bank(s);
    await expect(s.loans.createAgreementWithOrigination(purchase("buy-zero-02", { downPayment: 0, loanAmount: 60000, movementAccountId: hdfc.id }))).rejects.toThrow(/no down payment/);
    expect(await s.counts()).toEqual({ loans: 0, schedules: 0, transactions: 0 });
  });

  it("10 — down payment not recorded: metadata only, financed ₹50,000", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(purchase("buy-down-none"));
    expect(result.loan.loanAmount).toBe(50000);
    expect((await s.allInstallments(result.scheduleId)).reduce((sum, i) => sum + i.amountDue, 0)).toBeCloseTo(50000, 2);
    expect(await s.balance(hdfc.id)).toBe(100000);
  });

  it("11/13 — down payment recorded (finance company): −₹10,000 once, financed stays ₹50,000, counted as purchase spending", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(purchase("buy-down-rec", { movementAccountId: hdfc.id }));
    expect(await s.balance(hdfc.id)).toBe(90000);
    expect(result.loan.loanAmount).toBe(50000);
    const txns = await s.loanTransactions(result.loan.id);
    expect(txns.map((t) => [t.type, t.amount, t.paymentAllocationType])).toEqual([["expense", 10000, null]]);
    expect(loanTransactionLabel(txns[0], result.loan)).toBe("Down Payment — Laptop");
    expect(cashFlowFor(txns, LOAN_DATE).moneyOut).toBe(10000);
  });

  it("12 — bank financing", async () => {
    const s = setup();
    const result = await s.loans.createAgreementWithOrigination(purchase("buy-bank-01", { fundingSource: "bank", institutionName: "ICICI" }));
    expect([result.loan.agreementKind, result.loan.fundingSource, result.loan.institutionName]).toEqual(["installmentPurchase", "bank", "ICICI"]);
  });

  it("14 — tracked card with purchaseTransactionId: no second liability/purchase Transaction; separate down payment only", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const cardAccount = await s.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    await setDoc(doc(s.db, "users", UID, "creditCards", "card-1"), { accountId: cardAccount.id });
    const cardPurchase = await s.transactions.createTransaction({ type: "expense", amount: 50000, dateTime: LOAN_DATE, accountId: cardAccount.id, categoryId: "shopping", description: "Phone" });
    const before = await s.counts();
    const result = await s.loans.createAgreementWithOrigination(
      purchase("buy-card-01", { fundingSource: "creditCard", institutionName: "HDFC Card", linkedCreditCardId: "card-1", purchaseTransactionId: cardPurchase.id, movementAccountId: hdfc.id }),
    );
    expect(result.loan.purchaseTransactionId).toBe(cardPurchase.id);
    expect(await s.counts()).toEqual({ loans: before.loans + 1, schedules: before.schedules + 1, transactions: before.transactions + 1 });
    expect((await s.loanTransactions(result.loan.id)).map((t) => [t.accountId, t.amount])).toEqual([[hdfc.id, 10000]]);
    expect(await s.balance(cardAccount.id)).toBe(-50000);
  });

  it("14b — a purchase that is not a live expense on the chosen card is refused, nothing written", async () => {
    const s = setup();
    const hdfc = await bank(s);
    await setDoc(doc(s.db, "users", UID, "creditCards", "card-1"), { accountId: "card-account" });
    const bankSpend = await s.transactions.createTransaction({ type: "expense", amount: 500, dateTime: LOAN_DATE, accountId: hdfc.id, categoryId: "food", description: "Lunch" });
    await expect(
      s.loans.createAgreementWithOrigination(purchase("buy-card-02", { fundingSource: "creditCard", institutionName: "Card", linkedCreditCardId: "card-1", purchaseTransactionId: bankSpend.id })),
    ).rejects.toThrow(/active expense on this credit card/);
    expect((await s.counts()).loans).toBe(0);
  });

  it("15 — tracked card without purchaseTransactionId (Case B) persists the plan only", async () => {
    const s = setup();
    const result = await s.loans.createAgreementWithOrigination(purchase("buy-card-b", { fundingSource: "creditCard", institutionName: "Card", linkedCreditCardId: "card-1", purchaseTransactionId: null }));
    expect([result.loan.linkedCreditCardId, result.loan.purchaseTransactionId, result.transactionId]).toEqual(["card-1", null, null]);
  });

  it("16 — external/person financing", async () => {
    const s = setup();
    const result = await s.loans.createAgreementWithOrigination(
      purchase("buy-person-01", { fundingSource: "person", category: "personal", personId: "uncle", institutionName: null, downPayment: 0, purchaseAmount: 20000, loanAmount: 20000, installmentCount: 4 }),
    );
    expect([result.loan.fundingSource, result.loan.personId, result.loan.category]).toEqual(["person", "uncle", "personal"]);
  });

  it("refuses a card account as the movement account (my-card-for-someone-else stays unavailable)", async () => {
    const s = setup();
    const card = await s.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    await expect(s.loans.createAgreementWithOrigination(lent("lend-card-01", "rahul", { movementAccountId: card.id }))).rejects.toThrow(/bank, cash or wallet/);
    expect(await s.counts()).toEqual({ loans: 0, schedules: 0, transactions: 0 });
  });
});

describe("17/18 — idempotency, retry and concurrency", () => {
  it("A — the same key submitted twice: one Loan, one schedule, one Transaction, one account movement", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const params = borrowed("retry-same-01", { movementAccountId: hdfc.id });
    const first = await s.loans.createAgreementWithOrigination(params);
    const second = await s.loans.createAgreementWithOrigination(params);
    expect(second.alreadyCreated).toBe(true);
    expect(second.loan.id).toBe(first.loan.id);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await s.counts()).toEqual({ loans: 1, schedules: 1, transactions: 1 });
    expect(await s.allInstallments(first.scheduleId)).toHaveLength(12);
    expect(await s.balance(hdfc.id)).toBe(150000);
  });

  it("B — network-style retry with a stale caller object after the account moved elsewhere: still one operation, no lost update", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const params = borrowed("retry-stale-01", { movementAccountId: hdfc.id, loanDate: new Date(LOAN_DATE) });
    await s.loans.createAgreementWithOrigination(params);
    await s.transactions.createTransaction({ type: "expense", amount: 700, dateTime: LOAN_DATE, accountId: hdfc.id, categoryId: "food", description: "Lunch" });
    const retried = await s.loans.createAgreementWithOrigination({ ...params });
    expect(retried.alreadyCreated).toBe(true);
    expect(await s.balance(hdfc.id)).toBe(150000 - 700);
  });

  it("C — genuine concurrent duplicate submissions (Promise.all): exactly one origination", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const params = borrowed("retry-concurrent-01", { movementAccountId: hdfc.id });
    const results = await Promise.all(Array.from({ length: 5 }, () => s.loans.createAgreementWithOrigination(params)));
    expect(results.filter((r) => !r.alreadyCreated)).toHaveLength(1);
    expect(await s.counts()).toEqual({ loans: 1, schedules: 1, transactions: 1 });
    expect(await s.balance(hdfc.id)).toBe(150000);
  });

  it("C2 — two different originations racing on the same account: both movements land (no lost update)", async () => {
    const s = setup();
    const hdfc = await bank(s);
    await Promise.all([
      s.loans.createAgreementWithOrigination(borrowed("race-a-0001", { movementAccountId: hdfc.id })),
      s.loans.createAgreementWithOrigination(lent("race-b-0001", "rahul", { movementAccountId: hdfc.id })),
    ]);
    expect(await s.balance(hdfc.id)).toBe(100000 + 50000 - 25000);
  });

  it("reusing a key for a different request is a conflict, not a silent success", async () => {
    const s = setup();
    const hdfc = await bank(s);
    await s.loans.createAgreementWithOrigination(borrowed("retry-conflict-01"));
    await expect(s.loans.createAgreementWithOrigination(borrowed("retry-conflict-01", { movementAccountId: hdfc.id }))).rejects.toBeInstanceOf(OriginationConflictError);
    await expect(s.loans.createAgreementWithOrigination(lent("retry-conflict-01", "rahul"))).rejects.toBeInstanceOf(OriginationConflictError);
    expect(await s.balance(hdfc.id)).toBe(100000);
  });
});

describe("failure injection — nothing partial is ever committed", () => {
  const stages: OriginationStage[] = ["loan", "schedule", "installments", "transaction", "account"];
  for (const stage of stages) {
    it(`a failure while writing the ${stage} leaves no Loan, schedule, Transaction or balance change; a retry then succeeds exactly once`, async () => {
      const s = setup();
      const hdfc = await bank(s);
      const params = borrowed(`fail-${stage}-01`, { movementAccountId: hdfc.id });
      await expect(
        s.loans.createAgreementWithOrigination(params, { beforeWrite: (at) => { if (at === stage) throw new Error(`injected ${stage} failure`); } }),
      ).rejects.toThrow(`injected ${stage} failure`);
      expect(await s.counts()).toEqual({ loans: 0, schedules: 0, transactions: 0 });
      expect((await getDocs(collection(s.db, "users", UID, "paymentSchedules", `orig_fail-${stage}-01_sched`, "installments"))).size).toBe(0);
      expect(await s.balance(hdfc.id)).toBe(100000);

      const retried = await s.loans.createAgreementWithOrigination(params);
      expect(retried.alreadyCreated).toBe(false);
      expect(await s.counts()).toEqual({ loans: 1, schedules: 1, transactions: 1 });
      expect(await s.balance(hdfc.id)).toBe(150000);
    });
  }

  it("a missing account (account read failure) writes nothing", async () => {
    const s = setup();
    await expect(s.loans.createAgreementWithOrigination(borrowed("fail-acct-01", { movementAccountId: "no-such-account" }))).rejects.toThrow(/Account not found/);
    expect(await s.counts()).toEqual({ loans: 0, schedules: 0, transactions: 0 });
  });

  it("schedule generation that cannot fit one atomic commit is refused up front", async () => {
    const s = setup();
    await expect(s.loans.createAgreementWithOrigination(borrowed("fail-big-01", { installmentFrequency: "weekly", installmentCount: 481 }))).rejects.toThrow(/At most 480/);
    expect(await s.counts()).toEqual({ loans: 0, schedules: 0, transactions: 0 });
  });
});

describe("19 — reversal / undo", () => {
  it("the origination Transaction cannot be generically deleted (would desync Loan and Account)", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("undo-guard-01", { movementAccountId: hdfc.id }));
    const [txn] = await s.loanTransactions(result.loan.id);
    await expect(s.transactions.softDeleteTransaction(txn)).rejects.toBeInstanceOf(LoanPaymentTransactionRestrictedError);
  });

  it("reverseOrigination undoes Transaction + Account + Loan atomically and is idempotent", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const before = await netWorth(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("undo-ok-0001", { movementAccountId: hdfc.id }));
    expect((await s.loans.reverseOrigination("undo-ok-0001")).alreadyReversed).toBe(false);
    expect(await s.balance(hdfc.id)).toBe(100000);
    expect((await getDoc(doc(s.db, "users", UID, "loans", result.loan.id))).data()?.deletedAt).not.toBeNull();
    expect((await s.loanTransactions(result.loan.id))[0].deletedAt).not.toBeNull();
    expect(await netWorth(s)).toBeCloseTo(before, 2);
    expect((await s.loans.reverseOrigination("undo-ok-0001")).alreadyReversed).toBe(true);
    expect(await s.balance(hdfc.id)).toBe(100000);
  });

  it("reverseOrigination works without a money movement too", async () => {
    const s = setup();
    const result = await s.loans.createAgreementWithOrigination(borrowed("undo-none-01"));
    await s.loans.reverseOrigination("undo-none-01");
    expect((await getDoc(doc(s.db, "users", UID, "loans", result.loan.id))).data()?.deletedAt).not.toBeNull();
  });

  it("reverseOrigination is blocked once a payment exists", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("undo-paid-01", { movementAccountId: hdfc.id }));
    const installments = await s.allInstallments(result.scheduleId);
    await s.payments.record({ loan: result.loan, scheduleInstallments: installments, accountId: hdfc.id, amount: installments[0].amountDue, date: new Date(2026, 0, 10), idempotencyKey: "undo-paid-01-p1" });
    await expect(s.loans.reverseOrigination("undo-paid-01")).rejects.toBeInstanceOf(OriginationReversalBlockedError);
    expect(await s.balance(hdfc.id)).toBeCloseTo(150000 - installments[0].amountDue, 2);
  });
});

describe("20 — legacy regression", () => {
  it("legacy createLoan still creates a random-id Loan + schedule with no Transaction", async () => {
    const s = setup();
    const loan = await s.loans.createLoan({ loanAmount: 12000, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 12, institutionName: "Axis" });
    expect(loan.id.startsWith("orig_")).toBe(false);
    expect(await s.allInstallments(loan.scheduleId)).toHaveLength(12);
    expect(await s.counts()).toEqual({ loans: 1, schedules: 1, transactions: 0 });
  });

  it("an existing Borrow More disbursement is now also excluded from income/expense (same principal semantics)", async () => {
    const s = setup();
    const hdfc = await bank(s);
    const result = await s.loans.createAgreementWithOrigination(borrowed("legacy-disb-01", { movementAccountId: hdfc.id }));
    await s.payments.recordAdditionalDisbursement({ loan: result.loan, scheduleInstallments: await s.allInstallments(result.scheduleId), accountId: hdfc.id, amount: 2000, date: LOAN_DATE, idempotencyKey: "legacy-disb-01-more" });
    const txns = await s.loanTransactions(result.loan.id);
    expect(txns).toHaveLength(2);
    expect(cashFlowFor(txns, LOAN_DATE)).toEqual({ moneyIn: 0, moneyOut: 0, net: 0 });
    expect(await s.balance(hdfc.id)).toBe(152000);
  });
});
