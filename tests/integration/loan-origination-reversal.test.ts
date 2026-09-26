/**
 * Origination reversal + Loan delete safety (real Firestore emulator). Same scenarios as Flutter's
 * `test/features/lending/loan_origination_reversal_test.dart`.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirestoreCrudRepository } from "@/lib/firestore/firestore-crud-repository";
import { netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import {
  LoanRepository,
  OriginationDeleteBlockedError,
  OriginationReversalBlockedError,
  type CreateAgreementWithOriginationParams,
} from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";

const PROJECT_ID = "flowfi-loan-origination-reversal-test";
const UID = "e2e-owner-uid";
const LOAN_DATE = new Date(2026, 0, 10);

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
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  const loansRef = collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore });
  const schedulesRef = collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore });
  const transactionsRef = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const loans = new LoanRepository(loansRef, new PaymentScheduleRepository(schedulesRef), (id) => new InstallmentRepository(installmentsRef(id)));
  const payments = new LoanAdvancePaymentRepository(db, UID);
  const installments = async (scheduleId: string) =>
    (await getDocs(installmentsRef(scheduleId))).docs.map((d) => d.data()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const liveInstallments = async (scheduleId: string) => (await installments(scheduleId)).filter((i) => i.deletedAt == null);
  const loanTxns = async (loanId: string) => (await getDocs(query(transactionsRef, where("loanId", "==", loanId)))).docs.map((d) => d.data());
  const balance = async (id: string) => (await accounts.getByKey(id))!.currentBalance;
  const loanDoc = async (id: string) => (await getDoc(doc(loansRef, id))).data() ?? null;
  const scheduleDoc = async (id: string) => (await getDoc(doc(schedulesRef, id))).data() ?? null;
  /** Net Worth exactly as the app computes it: live accounts ± principal of non-trashed, open Loans. */
  const netWorth = async () => {
    const accountTotal = (await getDocs(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }))).docs
      .map((d) => d.data())
      .filter((a) => a.deletedAt == null)
      .reduce((sum, a) => sum + a.currentBalance, 0);
    const live = (await loans.getAll()).filter((l) => !l.isClosed);
    return netWorthWithLoans(accountTotal, {
      lentPrincipal: live.filter((l) => l.direction === "given").reduce((s, l) => s + l.loanAmount, 0),
      borrowedPrincipal: live.filter((l) => l.direction === "taken").reduce((s, l) => s + l.loanAmount, 0),
      emiPrincipal: 0,
      cardOwnedEmiPrincipal: 0,
      cardLockedEmiPrincipal: 0,
    } as Parameters<typeof netWorthWithLoans>[1]);
  };
  return { db, accounts, loans, payments, installments, liveInstallments, loanTxns, balance, loanDoc, scheduleDoc, netWorth };
}
type Setup = ReturnType<typeof setup>;

async function hdfc(s: Setup, name = "HDFC") {
  return s.accounts.createAccount({ name, type: "bank", openingBalance: 100000, colorValue: 0 });
}

const borrowed = (key: string, accountId: string | null): CreateAgreementWithOriginationParams => ({
  idempotencyKey: key, name: "Renovation", category: "institutional", institutionName: "HDFC Bank", fundingSource: "bank",
  direction: "taken", loanAmount: 50000, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly",
  installmentCount: 12, interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, movementAccountId: accountId,
});
const lent = (key: string, accountId: string | null): CreateAgreementWithOriginationParams => ({
  idempotencyKey: key, name: "Rahul", category: "personal", personId: "rahul", fundingSource: "person", direction: "given",
  loanAmount: 25000, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 5, movementAccountId: accountId,
});
const purchase = (key: string, accountId: string | null): CreateAgreementWithOriginationParams => ({
  idempotencyKey: key, name: "Laptop", agreementKind: "installmentPurchase", category: "institutional", institutionName: "Bajaj",
  fundingSource: "financeCompany", direction: "taken", purchaseAmount: 60000, downPayment: 10000, loanAmount: 50000, loanDate: LOAN_DATE,
  repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 10, movementAccountId: accountId,
});

/** What the Loan UIs called before this change: the inherited, check-free soft delete / hard delete. */
const genericSoftDelete = (s: Setup, loan: Loan) => FirestoreCrudRepository.prototype.softDelete.call(s.loans, loan);

describe("reproduction — the pre-fix generic trash path corrupts an originated Loan", () => {
  for (const [label, make, accountAfterCreate] of [
    ["borrowed", borrowed, 150000],
    ["lent", lent, 75000],
    ["down payment", purchase, 90000],
  ] as const) {
    it(`${label}: trashing only the Loan leaves the Account movement and Transaction active`, async () => {
      const s = setup();
      const account = await hdfc(s);
      const before = await s.netWorth();
      const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(make(`repro-${label.replace(" ", "-")}-1`, account.id));
      const afterCreate = await s.netWorth();
      await genericSoftDelete(s, loan);

      expect((await s.loanDoc(loan.id))?.deletedAt).not.toBeNull(); // Loan: in Trash
      expect(await s.balance(account.id)).toBe(accountAfterCreate); // Account: movement still applied
      expect((await s.loanTxns(loan.id)).map((t) => t.deletedAt)).toEqual([null]); // Transaction: still active
      expect(await s.scheduleDoc(scheduleId)).not.toBeNull(); // schedule + installments: untouched
      expect(await s.liveInstallments(scheduleId)).not.toHaveLength(0);
      // Net Worth: the Loan's principal left the balance sheet while its cash stayed.
      if (label === "down payment") {
        expect(afterCreate).toBeCloseTo(before - 10000 - 50000, 2);
        expect(await s.netWorth()).toBeCloseTo(before - 10000, 2);
      } else {
        expect(afterCreate).toBeCloseTo(before, 2);
        expect(await s.netWorth()).toBeCloseTo(before + (label === "borrowed" ? 50000 : -25000), 2);
      }
    });
  }
});

describe("trash / permanent delete safety", () => {
  it("9 — trashing a Loan whose origination money is active is refused; nothing changes", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("trash-block-1", account.id));
    await expect(s.loans.softDelete(loan)).rejects.toBeInstanceOf(OriginationDeleteBlockedError);
    expect((await s.loanDoc(loan.id))?.deletedAt).toBeNull();
    expect(await s.balance(account.id)).toBe(150000);
  });

  it("9b — an originated Loan without money movement, and a legacy Loan, still trash and restore normally", async () => {
    const s = setup();
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("trash-nomove-1", null));
    await s.loans.softDelete(loan);
    await s.loans.restore((await s.loanDoc(loan.id))!);
    expect((await s.loanDoc(loan.id))?.deletedAt).toBeNull();
    const legacy = await s.loans.createLoan({ loanAmount: 1000, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 2, institutionName: "Axis" });
    await s.loans.softDelete(legacy);
    expect((await s.loanDoc(legacy.id))?.deletedAt).not.toBeNull();
  });

  it("10 — permanent delete refuses a Loan whose origination money is still active (e.g. trashed by an older app)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("perm-block-1", account.id));
    await genericSoftDelete(s, loan);
    await expect(s.loans.permanentlyDeleteLoan((await s.loanDoc(loan.id))!)).rejects.toBeInstanceOf(OriginationDeleteBlockedError);
    expect(await s.loanDoc(loan.id)).not.toBeNull();
    // Recovery path for that state: reversing still works from Trash.
    expect((await s.loans.reverseOrigination("perm-block-1")).alreadyReversed).toBe(false);
    expect(await s.balance(account.id)).toBe(100000);
  });

  it("10b — after reversal, permanent delete removes Loan + schedule + installments; the reversed Transaction stays as audit", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("perm-ok-1", account.id));
    await s.loans.reverseOrigination("perm-ok-1");
    await s.loans.permanentlyDeleteLoan((await s.loanDoc(loan.id))!);
    expect(await s.loanDoc(loan.id)).toBeNull();
    expect(await s.scheduleDoc(scheduleId)).toBeNull();
    expect(await s.installments(scheduleId)).toHaveLength(0);
    const [txn] = await s.loanTxns(loan.id);
    expect(txn.deletedAt).not.toBeNull();
    expect(await s.balance(account.id)).toBe(100000);
  });

  it("a Loan whose money movement was reversed cannot be restored from Trash (that would bring back the debt without the money)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("restore-block-1", account.id));
    await s.loans.reverseOrigination("restore-block-1");
    await expect(s.loans.restore((await s.loanDoc(loan.id))!)).rejects.toBeInstanceOf(OriginationDeleteBlockedError);
  });
});

describe("reverse origination", () => {
  it("1/11/12/13 — borrowed: HDFC back to exactly ₹1,00,000; Transaction reversed once; Loan trashed; schedule kept with the trashed Loan; Net Worth restored", async () => {
    const s = setup();
    const account = await hdfc(s);
    const before = await s.netWorth();
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("rev-borrow-1", account.id));
    const result = await s.loans.reverseOrigination("rev-borrow-1");
    expect(result).toEqual({ alreadyReversed: false });
    expect(await s.balance(account.id)).toBe(100000);
    const txns = await s.loanTxns(loan.id);
    expect(txns).toHaveLength(1);
    expect(txns[0].deletedAt).not.toBeNull();
    expect((await s.loanDoc(loan.id))?.deletedAt).not.toBeNull();
    expect(await s.scheduleDoc(scheduleId)).not.toBeNull();
    expect(await s.installments(scheduleId)).toHaveLength(12);
    expect(await s.netWorth()).toBeCloseTo(before, 2);
    const audit = (await s.accounts.getByKey(account.id))!.editHistory.filter((e) => e.field === "currentBalance");
    expect(audit.map((e) => e.newValue)).toEqual(["150000", "100000"]);
  });

  it("2 — lent: SBI back to exactly ₹1,00,000", async () => {
    const s = setup();
    const account = await hdfc(s, "SBI");
    const { loan } = await s.loans.createAgreementWithOrigination(lent("rev-lend-1", account.id));
    await s.loans.reverseOrigination("rev-lend-1");
    expect(await s.balance(account.id)).toBe(100000);
    expect((await s.loanTxns(loan.id))[0].deletedAt).not.toBeNull();
  });

  it("3 — down payment: ₹10,000 restored; purchase plan trashed", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(purchase("rev-down-1", account.id));
    await s.loans.reverseOrigination("rev-down-1");
    expect(await s.balance(account.id)).toBe(100000);
    expect((await s.loanDoc(loan.id))?.deletedAt).not.toBeNull();
  });

  it("4 — the same reversal twice, and a stale repeat after other activity: the Account moves back exactly once", async () => {
    const s = setup();
    const account = await hdfc(s);
    await s.loans.createAgreementWithOrigination(borrowed("rev-retry-1", account.id));
    await s.loans.reverseOrigination("rev-retry-1");
    await s.accounts.adjustBalance((await s.accounts.getByKey(account.id))!, -700);
    expect(await s.loans.reverseOrigination("rev-retry-1")).toEqual({ alreadyReversed: true });
    expect(await s.balance(account.id)).toBe(100000 - 700);
  });

  it("5 — concurrent duplicate reversals (Promise.all): exactly one applies", async () => {
    const s = setup();
    const account = await hdfc(s);
    await s.loans.createAgreementWithOrigination(borrowed("rev-conc-1", account.id));
    const results = await Promise.all(Array.from({ length: 5 }, () => s.loans.reverseOrigination("rev-conc-1")));
    expect(results.filter((r) => !r.alreadyReversed)).toHaveLength(1);
    expect(await s.balance(account.id)).toBe(100000);
  });

  it("a failure injected inside the reversal commit writes nothing; the retry then applies once", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("rev-fail-1", account.id));
    await expect(s.loans.reverseOrigination("rev-fail-1", { beforeWrite: () => { throw new Error("injected"); } })).rejects.toThrow("injected");
    expect(await s.balance(account.id)).toBe(150000);
    expect((await s.loanDoc(loan.id))?.deletedAt).toBeNull();
    expect((await s.loanTxns(loan.id))[0].deletedAt).toBeNull();
    await s.loans.reverseOrigination("rev-fail-1");
    expect(await s.balance(account.id)).toBe(100000);
  });

  it("works for an origination without money movement (Loan trashed only)", async () => {
    const s = setup();
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("rev-nomove-1", null));
    await s.loans.reverseOrigination("rev-nomove-1");
    expect((await s.loanDoc(loan.id))?.deletedAt).not.toBeNull();
  });
});

describe("dependency guards — reversal is refused once later activity exists", () => {
  async function blocked(s: Setup, key: string, reason: OriginationReversalBlockedError["reason"], accountId: string) {
    const error = await s.loans.reverseOrigination(key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OriginationReversalBlockedError);
    expect((error as OriginationReversalBlockedError).reason).toBe(reason);
    expect(await s.balance(accountId)).not.toBe(100000);
  }

  it("6 — after a regular payment", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-pay-1", account.id));
    const rows = await s.liveInstallments(scheduleId);
    await s.payments.record({ loan, scheduleInstallments: rows, accountId: account.id, amount: rows[0].amountDue, date: LOAN_DATE, idempotencyKey: "dep-pay-1-p" });
    await blocked(s, "dep-pay-1", "payment", account.id);
  });

  it("6b — after a partial payment", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-part-1", account.id));
    await s.payments.record({ loan, scheduleInstallments: await s.liveInstallments(scheduleId), accountId: account.id, amount: 100, date: LOAN_DATE, idempotencyKey: "dep-part-1-p" });
    await blocked(s, "dep-part-1", "payment", account.id);
  });

  it("6c — even after that payment was itself reversed (history exists)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-revd-1", account.id));
    const rows = await s.liveInstallments(scheduleId);
    const paid = await s.payments.record({ loan, scheduleInstallments: rows, accountId: account.id, amount: rows[0].amountDue, date: LOAN_DATE, idempotencyKey: "dep-revd-1-p" });
    await s.payments.reversePayment({ loan, transactionId: paid.transactionId, paymentIds: paid.paymentIds, installmentIds: paid.installmentIds, reversalIdempotencyKey: "dep-revd-1-r" });
    await blocked(s, "dep-revd-1", "payment", account.id);
  });

  it("7 — after a principal prepayment (re-amortized)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-prep-1", account.id));
    const rows = await s.liveInstallments(scheduleId);
    await s.payments.record({ loan, scheduleInstallments: rows, accountId: account.id, amount: rows[0].amountDue + 5000, date: LOAN_DATE, idempotencyKey: "dep-prep-1-p" });
    await blocked(s, "dep-prep-1", "payment", account.id);
  });

  it("8 — after an additional disbursement (Borrow More)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-disb-1", account.id));
    await s.payments.recordAdditionalDisbursement({ loan, scheduleInstallments: await s.liveInstallments(scheduleId), accountId: account.id, amount: 2000, date: LOAN_DATE, idempotencyKey: "dep-disb-1-d" });
    await blocked(s, "dep-disb-1", "disbursement", account.id);
  });

  it("after Edit Loan Terms (schedule re-planned)", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan, scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-terms-1", account.id));
    await s.loans.editLoanTerms(loan, { currentInstallments: await s.liveInstallments(scheduleId), interest: loan.interest, installmentFrequency: "monthly", newInstallmentCount: 10 });
    await blocked(s, "dep-terms-1", "scheduleChanged", account.id);
  });

  it("after a skipped installment", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { scheduleId } = await s.loans.createAgreementWithOrigination(borrowed("dep-skip-1", account.id));
    const [first] = await s.liveInstallments(scheduleId);
    await new InstallmentRepository(
      collection(s.db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }),
    ).skipInstallment(first);
    await blocked(s, "dep-skip-1", "scheduleChanged", account.id);
  });

  it("after the Loan was closed", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("dep-close-1", account.id));
    await s.loans.closeLoan(loan);
    await blocked(s, "dep-close-1", "closed", account.id);
  });

  it("a descriptive edit (rename) does not block", async () => {
    const s = setup();
    const account = await hdfc(s);
    const { loan } = await s.loans.createAgreementWithOrigination(borrowed("dep-name-1", account.id));
    await s.loans.editLoan(loan, { hasPayments: false, name: "Kitchen" });
    await s.loans.reverseOrigination("dep-name-1");
    expect(await s.balance(account.id)).toBe(100000);
  });
});
