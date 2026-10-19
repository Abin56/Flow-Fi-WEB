/**
 * Paying-account funding rules at the WRITE layer (real Firestore emulator, real repositories): an
 * account-funded payment re-reads the account inside its own transaction and refuses — writing nothing —
 * when it would take the account below zero. See `lib/engines/payment-funding.ts`.
 *
 * Covers Loan payments, Loan edits/reversals, card bill payments (transfer into a card), EMI payments,
 * People payments I make, "already paid earlier" (never checked, never moves an account), duplicate
 * submissions, concurrent payments and retry-after-failure. Each scenario reconciles the account's stored
 * balance against opening balance + its active transactions' effects.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const UID = "funding-owner-uid";
const env: { db: Firestore | null; cards: { id: string; accountId: string }[] } = vi.hoisted(() => ({ db: null, cards: [] }));
vi.mock("@/lib/firebase/client", () => ({
  get db() {
    return env.db;
  },
  auth: {},
  firebaseApp: {},
  storage: {},
}));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { uid: UID } }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: env.cards }), useEmis: () => ({ data: [] }) }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (factory: () => unknown) => factory() }));

import { useEmiActions as emiActionsFor } from "@/features/emi/hooks/use-emi-data";
import { InsufficientFundsError } from "@/lib/engines/payment-funding";
import { RECORDED_EARLIER_PEOPLE_ACK } from "@/lib/engines/recorded-earlier";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
} from "@/lib/models/payment-schedule";
import { advanceApplicationFromFirestore, advanceApplicationToFirestore, ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { purposeFundFromFirestore, purposeFundToFirestore } from "@/lib/models/purpose-fund";
import { balanceEffect, transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { createAccountRepository, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "flowfi-payment-funding",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  env.db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  env.cards = [];
  await testEnv.clearFirestore();
});

type Repos = ReturnType<typeof repos>;

function repos() {
  const db = env.db!;
  const col = (...path: string[]) => collection(db, "users", UID, ...(path as [string]));
  const accounts = new AccountRepository(col("accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(col("transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), accounts);
  const people = new PersonRepository(col("people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const installments = (scheduleId: string) =>
    new InstallmentRepository(col("paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const schedules = new PaymentScheduleRepository(col("paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }));
  const loans = new LoanRepository(col("loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }), schedules, installments);
  const loanPayments = new LoanAdvancePaymentRepository(db, UID);
  const paymentsFor = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: people,
      ledgerRepository: new LedgerRepository(col("people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people),
      transactionRepository: transactions,
      advanceApplications: col("people", personId, "advanceApplications").withConverter({ toFirestore: advanceApplicationToFirestore, fromFirestore: advanceApplicationFromFirestore }),
      expenseDocRef: (id) => doc(col("expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore }), id),
      installmentDocRef: (scheduleId, id) => installments(scheduleId).docRef(id),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) =>
        new InstallmentPaymentRepository(
          col("paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore }),
          installments(scheduleId),
        ).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
      purposeFunds: col("people", personId, "purposeFunds").withConverter({ toFirestore: purposeFundToFirestore, fromFirestore: purposeFundFromFirestore }),
    });
  return { accounts, transactions, people, loans, loanPayments, paymentsFor, installments };
}

const bank = (r: Repos, name: string, openingBalance: number) => r.accounts.createAccount({ name, type: "bank", openingBalance, colorValue: 0 });
const balance = async (r: Repos, id: string) => (await r.accounts.getByKey(id))!.currentBalance;

async function allTransactions(): Promise<Transaction[]> {
  const snap = await getDocs(collection(env.db!, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }));
  return snap.docs.map((d) => d.data());
}
/** Cross-section reconciliation: stored balance === opening + the active transactions' effects. */
async function expectReconciled(r: Repos, accountId: string) {
  const account = (await r.accounts.getByKey(accountId))!;
  const effects = (await allTransactions()).filter((t) => t.accountId === accountId && t.deletedAt == null).reduce((s, t) => s + balanceEffect(t), 0);
  expect(account.currentBalance).toBeCloseTo(account.openingBalance + effects, 2);
}

type LoanWorld = { loan: Loan; installments: Installment[] };

/** A single-installment (by default) loan of ₹`amount` with no interest — its installment is exactly `amount`. */
async function loan(r: Repos, amount: number, direction: "taken" | "given" = "taken", count = 1): Promise<LoanWorld> {
  const created = await r.loans.createLoan({
    loanAmount: amount,
    loanDate: new Date("2026-01-01T00:00:00Z"),
    repaymentType: "installment",
    direction,
    category: "institutional",
    institutionName: "Bank",
    interest: null,
    installmentFrequency: "monthly",
    installmentCount: count,
  });
  const installments = (await r.installments(created.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return { loan: created as Loan, installments };
}
const DATE = new Date(2026, 1, 10, 12);
type RecordParams = Parameters<LoanAdvancePaymentRepository["record"]>[0];
const pay = (r: Repos, l: LoanWorld, accountId: string, key: string, extra: Partial<RecordParams> = {}) =>
  r.loanPayments.record({ loan: l.loan, scheduleInstallments: l.installments, accountId, amount: l.installments[0].amountDue, date: DATE, idempotencyKey: key, enforceFunds: true, ...extra });
const paid = async (r: Repos, l: LoanWorld) => (await r.installments(l.loan.scheduleId).getAll()).reduce((s, i) => s + i.amountPaid, 0);
const EARLIER: Partial<RecordParams> = { recordedEarlier: { dateKnown: true }, peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK, date: new Date(2026, 0, 20, 12) };

describe("Loan payment — funds are enforced inside the write", () => {
  it("₹100,000 balance, ₹100,000 payment → ₹0, exactly one debit", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 100_000);
    const l = await loan(r, 100_000);
    await pay(r, l, acct.id, "k-exact");
    expect(await balance(r, acct.id)).toBe(0);
    expect(await paid(r, l)).toBe(100_000);
    expect((await allTransactions()).filter((t) => t.loanId === l.loan.id)).toHaveLength(1);
    await expectReconciled(r, acct.id);
  });

  it("one paisa short is refused: nothing written (balance, installment, transactions all unchanged)", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 99_999.99);
    const l = await loan(r, 100_000);
    await expect(pay(r, l, acct.id, "k-short")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(99_999.99);
    expect(await paid(r, l)).toBe(0);
    expect(await allTransactions()).toHaveLength(0);
  });

  it("zero-balance account is refused, and the error names the fresh balance", async () => {
    const r = repos();
    const acct = await bank(r, "Empty", 0);
    const l = await loan(r, 5_000);
    const err = await pay(r, l, acct.id, "k-zero").catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).available).toBe(0);
    expect((err as InsufficientFundsError).required).toBe(5_000);
  });

  it("several eligible accounts: only the chosen one moves", async () => {
    const r = repos();
    const a = await bank(r, "SBI", 10_000);
    const b = await bank(r, "HDFC", 10_000);
    const l = await loan(r, 4_000);
    await pay(r, l, b.id, "k-multi");
    expect([await balance(r, a.id), await balance(r, b.id)]).toEqual([10_000, 6_000]);
  });

  it("a Current account is checked like any bank account (no overdraft is assumed), and callers that don't opt in keep the existing behaviour", async () => {
    const r = repos();
    const current = await r.accounts.createAccount({ name: "Current", type: "bank", bankAccountSubtype: "current", openingBalance: 1_000, colorValue: 0 });
    const l = await loan(r, 4_000);
    await expect(pay(r, l, current.id, "k-od")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, current.id)).toBe(1_000);
    const savings = await bank(r, "Low", 1_000);
    const l2 = await loan(r, 4_000);
    await pay(r, l2, savings.id, "k-legacy", { enforceFunds: false });
    expect(await balance(r, savings.id)).toBe(-3_000);
  });

  it("backdated payment still checks the CURRENT balance", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 3_000);
    const l = await loan(r, 5_000);
    await expect(pay(r, l, acct.id, "k-back", { date: new Date(2025, 5, 1, 12) })).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(3_000);
  });

  it("already paid earlier: never checked, never moves the account — even on an empty one", async () => {
    const r = repos();
    const acct = await bank(r, "Empty", 0);
    const l = await loan(r, 5_000);
    await pay(r, l, acct.id, "k-earlier", EARLIER);
    expect(await balance(r, acct.id)).toBe(0);
    expect(await paid(r, l)).toBe(5_000);
    await expectReconciled(r, acct.id);
  });

  it("money received on a loan I gave is never checked", async () => {
    const r = repos();
    const acct = await bank(r, "Empty", 0);
    const l = await loan(r, 5_000, "given");
    await pay(r, l, acct.id, "k-given");
    expect(await balance(r, acct.id)).toBe(5_000);
  });

  it("more money lent (additional disbursement on a loan I gave) is checked; borrowed money is not", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 1_000);
    const given = await loan(r, 12_000, "given", 12);
    await expect(
      r.loanPayments.recordAdditionalDisbursement({ loan: given.loan, scheduleInstallments: given.installments, accountId: acct.id, amount: 2_000, date: DATE, idempotencyKey: "disb-1", enforceFunds: true }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(1_000);
    const taken = await loan(r, 12_000, "taken", 12);
    await r.loanPayments.recordAdditionalDisbursement({ loan: taken.loan, scheduleInstallments: taken.installments, accountId: acct.id, amount: 2_000, date: DATE, idempotencyKey: "disb-2", enforceFunds: true });
    expect(await balance(r, acct.id)).toBe(3_000);
  });
});

describe("Duplicate submissions, retries and concurrency", () => {
  it("the same action twice debits once; a replay after the balance dropped is a no-op, not an error", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 5_000);
    const l = await loan(r, 5_000);
    await pay(r, l, acct.id, "k-dup");
    expect((await pay(r, l, acct.id, "k-dup")).alreadyRecorded).toBe(true);
    expect(await balance(r, acct.id)).toBe(0);
    expect((await allTransactions()).filter((t) => t.loanId === l.loan.id)).toHaveLength(1);
  });

  it("a refused attempt can be retried with the same key once the account is funded — recorded exactly once", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 1_000);
    const l = await loan(r, 5_000);
    await expect(pay(r, l, acct.id, "k-retry")).rejects.toBeInstanceOf(InsufficientFundsError);
    await r.transactions.createTransaction({ type: "income", amount: 4_000, dateTime: DATE, accountId: acct.id, categoryId: "salary", description: "top up" });
    await pay(r, l, acct.id, "k-retry");
    expect(await balance(r, acct.id)).toBe(0);
    expect(await paid(r, l)).toBe(5_000);
    await expectReconciled(r, acct.id);
  });

  it("two payments racing for one ₹100,000 account (₹60,000 each): exactly one wins, the balance is never negative", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 100_000);
    const l1 = await loan(r, 60_000);
    const l2 = await loan(r, 60_000);
    const results = await Promise.allSettled([pay(r, l1, acct.id, "race-1"), pay(r, l2, acct.id, "race-2")]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(40_000);
    expect(((await paid(r, l1)) > 0 ? 1 : 0) + ((await paid(r, l2)) > 0 ? 1 : 0)).toBe(1);
    await expectReconciled(r, acct.id);
  });
});

describe("Edit and reversal restore only what was recorded", () => {
  it("reversing a payment restores the account; reversing an 'already paid earlier' record restores nothing", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 100_000);
    const l = await loan(r, 60_000);
    const done = await pay(r, l, acct.id, "k-rev");
    expect(await balance(r, acct.id)).toBe(40_000);
    await r.loanPayments.reversePayment({ loan: l.loan, transactionId: done.transactionId, paymentIds: done.paymentIds, installmentIds: done.installmentIds, reversalIdempotencyKey: "rev-1" });
    expect(await balance(r, acct.id)).toBe(100_000);
    expect(await paid(r, l)).toBe(0);

    const l2 = await loan(r, 30_000);
    const earlier = await pay(r, l2, acct.id, "k-rev-earlier", EARLIER);
    expect(await balance(r, acct.id)).toBe(100_000);
    await r.loanPayments.reversePayment({ loan: l2.loan, transactionId: earlier.transactionId, paymentIds: earlier.paymentIds, installmentIds: earlier.installmentIds, reversalIdempotencyKey: "rev-2" });
    expect(await balance(r, acct.id)).toBe(100_000);
    await expectReconciled(r, acct.id);
  });

  it("editing a payment checks the NET change: ₹60,000 → ₹90,000 on ₹90,000 is fine (→ ₹0); ₹100,000 is refused and the original stays", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 90_000);
    const l = await loan(r, 100_000);
    const done = await pay(r, l, acct.id, "k-edit", { amount: 60_000 });
    expect(await balance(r, acct.id)).toBe(30_000);
    const edit = (amount: number, key: string) =>
      r.loanPayments.editPayment({
        loan: l.loan,
        scheduleInstallments: l.installments,
        original: { transactionId: done.transactionId, paymentIds: done.paymentIds, installmentIds: done.installmentIds },
        accountId: acct.id,
        amount,
        date: DATE,
        idempotencyKey: key,
        enforceFunds: true,
      });
    await expect(edit(100_000, "edit-a")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(30_000);
    expect(await paid(r, l)).toBe(60_000);
    await edit(90_000, "edit-b");
    expect(await balance(r, acct.id)).toBe(0);
    expect(await paid(r, l)).toBe(90_000);
    await expectReconciled(r, acct.id);
  });
});

describe("Card bill payment (transfer into a credit card)", () => {
  const cardPay = (r: Repos, from: string, to: string, amount: number, key: string) =>
    r.transactions.createTransferPairAtomic({ amount, dateTime: DATE, sourceAccountId: from, destinationAccountId: to, categoryId: "transfer", description: "Card bill payment", idempotencyKey: key, enforceFunds: true });

  it("₹32,000 in the bank pays a ₹32,000 card bill: bank → ₹0, card liability reduced by ₹32,000, once", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 32_000);
    const card = await r.accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: -32_000, colorValue: 0 });
    await cardPay(r, acct.id, card.id, 32_000, "bill-0001");
    await cardPay(r, acct.id, card.id, 32_000, "bill-0001");
    expect(await balance(r, acct.id)).toBe(0);
    expect(await balance(r, card.id)).toBe(0);
    await expectReconciled(r, acct.id);
    await expectReconciled(r, card.id);
  });

  it("insufficient bank balance: refused, neither leg nor either balance changes", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 31_999);
    const card = await r.accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: -32_000, colorValue: 0 });
    await expect(cardPay(r, acct.id, card.id, 32_000, "bill-0002")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect([await balance(r, acct.id), await balance(r, card.id)]).toEqual([31_999, -32_000]);
    expect(await allTransactions()).toHaveLength(0);
  });

  it("a fee charged to the source counts toward the check", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 10_000);
    const dest = await bank(r, "HDFC", 0);
    await expect(
      r.transactions.createTransferPairAtomic({
        amount: 10_000,
        dateTime: DATE,
        sourceAccountId: acct.id,
        destinationAccountId: dest.id,
        categoryId: "transfer",
        description: "Move",
        idempotencyKey: "fee-0001",
        enforceFunds: true,
        fee: { amount: 50, chargedTo: "source", categoryId: "fees" },
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(10_000);
  });

  it("a credit-card → bank transfer (the card may run into its limit) is never blocked by the balance rule", async () => {
    const r = repos();
    const card = await r.accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 });
    const acct = await bank(r, "SBI", 0);
    await cardPay(r, card.id, acct.id, 20_000, "roll-0001");
    expect([await balance(r, card.id), await balance(r, acct.id)]).toEqual([-20_000, 20_000]);
  });
});

describe("EMI payment", () => {
  const actions = () => emiActionsFor()!;
  async function emiWorld(card: boolean, bankBalance: number) {
    const accounts = createAccountRepository(UID);
    const acct = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: bankBalance, colorValue: 0 });
    const cardAcct = card ? await accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 }) : null;
    if (cardAcct) env.cards = [{ id: "card-1", accountId: cardAcct.id }];
    const emi = await actions().createEmi({
      name: "Phone",
      principalAmount: 12_000,
      startDate: new Date(2026, 0, 5),
      installmentFrequency: "monthly",
      installmentCount: 4,
      interest: null,
      linkedCreditCardId: card ? "card-1" : null,
      ownershipShares: null,
    });
    const installments = (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    return { emi, installments, acct, cardAcct, accounts };
  }

  it("non-card EMI: ₹3,000 from exactly ₹3,000 → ₹0; from ₹2,999 it is refused and nothing is written", async () => {
    const w = await emiWorld(false, 3_000);
    await actions().recordPayment(w.emi, w.installments, { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-ok", targetInstallmentId: w.installments[0].id, date: DATE, enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);

    const poor = await emiWorld(false, 2_999);
    await expect(
      actions().recordPayment(poor.emi, poor.installments, { amount: 3_000, accountId: poor.acct.id, idempotencyKey: "emi-no", targetInstallmentId: poor.installments[0].id, date: DATE, enforceFunds: true }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect((await poor.accounts.getByKey(poor.acct.id))!.currentBalance).toBe(2_999);
    const after = (await createInstallmentRepositoryFor(UID, poor.emi.scheduleId).getAll()).filter((i) => i.deletedAt == null);
    expect(after.every((i) => i.amountPaid === 0)).toBe(true);
  });

  it("card-linked EMI posts on its card only — no bank debit and no bank balance requirement", async () => {
    const w = await emiWorld(true, 0);
    await actions().recordPayment(w.emi, w.installments, { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-card", targetInstallmentId: w.installments[0].id, date: DATE, enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    expect((await w.accounts.getByKey(w.cardAcct!.id))!.currentBalance).toBe(-3_000);
  });

  it("already paid earlier posts nothing, even on an empty account", async () => {
    const w = await emiWorld(false, 0);
    await actions().recordPayment(w.emi, w.installments, {
      amount: 3_000,
      accountId: null,
      idempotencyKey: "emi-earlier",
      targetInstallmentId: w.installments[0].id,
      date: new Date(2026, 0, 20, 12),
      enforceFunds: true,
      recordedEarlier: { dateKnown: true },
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    expect(await allTransactions()).toHaveLength(0);
  });
});

describe("People payment I make", () => {
  const payout = (accountId: string, amount: number, key: string): RecordPaymentInput => ({
    direction: "iPaid",
    amount,
    date: DATE,
    accountId,
    lines: [{ key: "emi-inst:x", amount, route: { kind: "derived", obligationRef: "emi-inst:x", sourceKind: "emiInstallment" } }],
    extra: null,
    idempotencyKey: key,
    enforceFunds: true,
  });

  it("paying ₹5,000 from exactly ₹5,000 → ₹0 once (double submit safe); ₹5,000 from ₹4,999.99 is refused with nothing written", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 5_000);
    const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
    await r.paymentsFor(amma.id).recordPayment((await r.people.getByKey(amma.id))!, payout(acct.id, 5_000, "pp-1"));
    await r.paymentsFor(amma.id).recordPayment((await r.people.getByKey(amma.id))!, payout(acct.id, 5_000, "pp-1"));
    expect(await balance(r, acct.id)).toBe(0);
    expect((await allTransactions()).filter((t) => t.linkedPersonId === amma.id)).toHaveLength(1);

    const poor = await bank(r, "Poor", 4_999.99);
    await expect(r.paymentsFor(amma.id).recordPayment((await r.people.getByKey(amma.id))!, payout(poor.id, 5_000, "pp-2"))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, poor.id)).toBe(4_999.99);
    await expectReconciled(r, acct.id);
  });

  it("money they pay me is never checked", async () => {
    const r = repos();
    const acct = await bank(r, "Empty", 0);
    const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
    await r.paymentsFor(amma.id).recordPayment((await r.people.getByKey(amma.id))!, { ...payout(acct.id, 700, "pp-in"), direction: "theyPaid" });
    expect(await balance(r, acct.id)).toBe(700);
  });
});

describe("EMI payment edit — only the net extra debit is validated", () => {
  const actions = () => emiActionsFor()!;
  async function world(opts: { card?: boolean; bankBalance: number }) {
    const accounts = createAccountRepository(UID);
    const acct = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: opts.bankBalance, colorValue: 0 });
    const cardAcct = opts.card ? await accounts.createAccount({ name: "Card", type: "card", cardSubtype: "credit", openingBalance: 0, colorValue: 0 }) : null;
    if (cardAcct) env.cards = [{ id: "card-1", accountId: cardAcct.id }];
    const emi = await actions().createEmi({
      name: "Phone",
      principalAmount: 12_000,
      startDate: new Date(2026, 0, 5),
      installmentFrequency: "monthly",
      installmentCount: 4,
      interest: null,
      linkedCreditCardId: opts.card ? "card-1" : null,
      ownershipShares: null,
    });
    const list = async () => (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    return { emi, list, acct, cardAcct, accounts };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const refs = (key: string, ids: string[]) => ({ paymentIds: ids.map((_, i) => `emi_${key}_p${i}`), installmentIds: ids });
  const totalPaid = async (w: World) => (await w.list()).reduce((s, i) => s + i.amountPaid, 0);
  const emiTxns = async (w: World) => (await allTransactions()).filter((t) => t.emiId === w.emi.id && t.deletedAt == null);

  it("₹3,000 → ₹10,000 on a ₹10,000 account: net extra ₹7,000 fits (→ ₹0); ₹10,001 is refused and the original payment stays intact", async () => {
    const w = await world({ bankBalance: 10_000 });
    const first = (await w.list())[0];
    await actions().recordPayment(w.emi, await w.list(), { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-e-0001", targetInstallmentId: first.id, date: DATE, enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(7_000);
    const edit = async (amount: number, key: string) =>
      actions().editPayment(w.emi, await w.list(), { original: refs("emi-e-0001", [first.id]), amount, date: DATE, idempotencyKey: key, enforceFunds: true });
    await expect(edit(10_001, "emi-e-0002")).rejects.toBeInstanceOf(InsufficientFundsError);
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(7_000);
    expect(await totalPaid(w)).toBe(3_000);
    expect(await emiTxns(w)).toHaveLength(1);
    await edit(10_000, "emi-e-0003");
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    expect(await totalPaid(w)).toBe(10_000);
    expect(await emiTxns(w)).toHaveLength(1);
  });

  it("lowering the amount refunds and is never blocked; reversing restores the account to the original balance", async () => {
    const w = await world({ bankBalance: 3_000 });
    const first = (await w.list())[0];
    await actions().recordPayment(w.emi, await w.list(), { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-l-0001", targetInstallmentId: first.id, date: DATE, enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    await actions().editPayment(w.emi, await w.list(), { original: refs("emi-l-0001", [first.id]), amount: 1_000, date: DATE, idempotencyKey: "emi-l-0002", enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(2_000);
    await actions().reversePayment(w.emi, { original: refs("emi-l-0002", [first.id]) });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(3_000);
    expect(await totalPaid(w)).toBe(0);
  });

  it("same-key edit retry writes nothing twice", async () => {
    const w = await world({ bankBalance: 10_000 });
    const first = (await w.list())[0];
    await actions().recordPayment(w.emi, await w.list(), { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-r-0001", targetInstallmentId: first.id, date: DATE, enforceFunds: true });
    const edit = async () => actions().editPayment(w.emi, await w.list(), { original: refs("emi-r-0001", [first.id]), amount: 4_000, date: DATE, idempotencyKey: "emi-r-0002", enforceFunds: true });
    await edit();
    expect((await edit()).alreadyRecorded).toBe(true);
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(6_000);
  });

  it("card-linked EMI edit is never bank-checked and keeps its card accounting", async () => {
    const w = await world({ card: true, bankBalance: 0 });
    const first = (await w.list())[0];
    await actions().recordPayment(w.emi, await w.list(), { amount: 3_000, accountId: w.acct.id, idempotencyKey: "emi-c-0001", targetInstallmentId: first.id, date: DATE, enforceFunds: true });
    await actions().editPayment(w.emi, await w.list(), { original: refs("emi-c-0001", [first.id]), amount: 6_000, date: DATE, idempotencyKey: "emi-c-0002", enforceFunds: true });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    expect((await w.accounts.getByKey(w.cardAcct!.id))!.currentBalance).toBe(-6_000);
  });

  it("an already-paid-earlier EMI edit stays account-neutral", async () => {
    const w = await world({ bankBalance: 0 });
    const first = (await w.list())[0];
    await actions().recordPayment(w.emi, await w.list(), {
      amount: 3_000,
      accountId: null,
      idempotencyKey: "emi-h-0001",
      targetInstallmentId: first.id,
      date: new Date(2026, 0, 20, 12),
      enforceFunds: true,
      recordedEarlier: { dateKnown: true },
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    await actions().editPayment(w.emi, await w.list(), {
      original: refs("emi-h-0001", [first.id]),
      amount: 2_000,
      date: new Date(2026, 0, 21, 12),
      idempotencyKey: "emi-h-0002",
      enforceFunds: true,
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect((await w.accounts.getByKey(w.acct.id))!.currentBalance).toBe(0);
    expect(await allTransactions()).toHaveLength(0);
  });

  it("two EMI payments racing for one ₹5,000 account (₹3,000 each): exactly one wins", async () => {
    const accounts = createAccountRepository(UID);
    const acct = await accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const make = async (name: string) => {
      const emi = await actions().createEmi({ name, principalAmount: 12_000, startDate: new Date(2026, 0, 5), installmentFrequency: "monthly", installmentCount: 4, interest: null, linkedCreditCardId: null, ownershipShares: null });
      const list = (await createInstallmentRepositoryFor(UID, emi.scheduleId).getAll()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      return { emi, list };
    };
    const a = await make("A");
    const b = await make("B");
    const run = (x: typeof a, key: string) => actions().recordPayment(x.emi, x.list, { amount: 3_000, accountId: acct.id, idempotencyKey: key, targetInstallmentId: x.list[0].id, date: DATE, enforceFunds: true });
    const res = await Promise.allSettled([run(a, "emi-x-0001"), run(b, "emi-x-0002")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    expect((await accounts.getByKey(acct.id))!.currentBalance).toBe(2_000);
  });
});

describe("Purpose money — real account debits are enforced", () => {
  async function purposeWorld(balance: number) {
    const r = repos();
    const acct = await bank(r, "SBI", balance);
    const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
    const { PurposeFundRepository } = await import("@/lib/repositories/purpose-fund-repository");
    const col = collection(env.db!, "users", UID, "people", amma.id, "purposeFunds").withConverter({ toFirestore: purposeFundToFirestore, fromFirestore: purposeFundFromFirestore });
    const ledger = new LedgerRepository(collection(env.db!, "users", UID, "people", amma.id, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), r.people);
    const repo = new PurposeFundRepository({ personRepository: r.people, ledgerRepository: ledger, transactionRepository: r.transactions, purposeFunds: col, cashLegCategoryId: "personal-loan" });
    const { setDoc, doc: docRef } = await import("firebase/firestore");
    await setDoc(docRef(col, "fund-1"), {
      id: "fund-1", personId: amma.id, paymentId: "pay-1", receiptTransactionRef: "none", receivedDate: DATE, title: "Fees", amount: 5_000, dueDate: null, note: "", link: null, uses: [], state: "active", release: null, completedAt: null, createdAt: DATE, lastEditedAt: null, deletedAt: null,
    } as never);
    return { r, acct, amma, repo };
  }
  const spend = async (w: Awaited<ReturnType<typeof purposeWorld>>, amount: number) =>
    w.repo.recordUse((await w.r.people.getByKey(w.amma.id))!, "fund-1", { mode: "new", accountId: w.acct.id, amount, date: DATE, description: "Fees", classification: "behalf" });

  it("using ₹5,000 from exactly ₹5,000 → ₹0", async () => {
    const w = await purposeWorld(5_000);
    await spend(w, 5_000);
    expect(await balance(w.r, w.acct.id)).toBe(0);
    await expectReconciled(w.r, w.acct.id);
  });

  it("insufficient balance writes no transaction and no use", async () => {
    const w = await purposeWorld(4_999);
    await expect(spend(w, 5_000)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(w.r, w.acct.id)).toBe(4_999);
    expect(await allTransactions()).toHaveLength(0);
  });
});

describe("People payment edit — net extra debit only", () => {
  const payout = (accountId: string, amount: number, key?: string): RecordPaymentInput => ({
    direction: "iPaid",
    amount,
    date: DATE,
    accountId,
    lines: [{ key: "emi-inst:x", amount, route: { kind: "derived", obligationRef: "emi-inst:x", sourceKind: "emiInstallment" } }],
    extra: null,
    ...(key ? { idempotencyKey: key } : {}),
    enforceFunds: true,
  });

  it("₹3,000 → ₹5,000 on ₹5,000 fits (→ ₹0); ₹5,001 is refused and the original stays", async () => {
    const r = repos();
    const acct = await bank(r, "SBI", 5_000);
    const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
    const get = async () => (await r.people.getByKey(amma.id))!;
    const id = await r.paymentsFor(amma.id).recordPayment(await get(), payout(acct.id, 3_000, "pp-e-0001"));
    expect(await balance(r, acct.id)).toBe(2_000);
    await expect(r.paymentsFor(amma.id).editPayment(await get(), id, payout(acct.id, 5_001))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balance(r, acct.id)).toBe(2_000);
    expect((await allTransactions()).filter((t) => t.linkedPersonId === amma.id && t.deletedAt == null)).toHaveLength(1);
    await r.paymentsFor(amma.id).editPayment(await get(), id, payout(acct.id, 5_000));
    expect(await balance(r, acct.id)).toBe(0);
    await expectReconciled(r, acct.id);
  });
});
