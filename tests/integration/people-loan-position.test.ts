/**
 * People ↔ Loans (real Firestore emulator). Reproduces the pre-change inconsistencies with the REAL
 * legacy writers (`loan-ledger-sync.ts`, via a ledger factory bound to the emulator), then proves the
 * canonical rule (`lib/engines/person-position.ts`) on live documents. Same scenarios as Flutter's
 * `test/features/people/person_position_providers_test.dart`.
 *
 * Run: VITEST_INTEGRATION=1 with a Firestore emulator on 127.0.0.1:8080 (`npm run test:integration`).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { outstandingPrincipalAfterPrepaymentsFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { peopleTotals, personPosition, type PersonPosition } from "@/lib/engines/person-position";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { loanFromFirestore, loanToFirestore, type Loan } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, signedAmount, type Person } from "@/lib/models/person";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";

const PROJECT_ID = "flowfi-people-loan-position-test";
const UID = "e2e-owner-uid";
const LOAN_DATE = new Date(2026, 0, 10);

let testDb: Firestore | null = null;
// The legacy writers resolve their ledger through this factory (bound to the app's client db in prod).
vi.mock("@/features/people/lib/ledger-factory", async () => {
  const { collection: col } = await import("firebase/firestore");
  const person = await import("@/lib/models/person");
  const repos = await import("@/lib/repositories/person-repository");
  return {
    createLedgerRepository: (uid: string, personId: string, personRepository: InstanceType<typeof repos.PersonRepository>) =>
      new repos.LedgerRepository(
        col(testDb!, "users", uid, "people", personId, "ledger").withConverter({ toFirestore: person.ledgerEntryToFirestore, fromFirestore: person.ledgerEntryFromFirestore }),
        personRepository,
      ),
  };
});
const { postLoanCreatedLedgerEntry, postLoanPaymentLedgerEntry, reverseLoanLedgerEntries } = await import("@/features/loans/lib/loan-ledger-sync");

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
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  testDb = db;
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const installmentsRef = (id: string) => collection(db, "users", UID, "paymentSchedules", id, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore })),
    (id) => new InstallmentRepository(installmentsRef(id)),
  );
  const payments = new LoanAdvancePaymentRepository(db, UID);
  const live = async (scheduleId: string) =>
    (await getDocs(installmentsRef(scheduleId))).docs.map((d) => d.data()).filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  /** Exactly `useLoanRows`' `outstandingPrincipal` (Net Worth's figure). */
  async function outstanding(loan: Loan) {
    const all = (await getDocs(installmentsRef(loan.scheduleId))).docs.map((d) => d.data());
    const records = (
      await Promise.all(
        all.map((i) =>
          getDocs(collection(db, "users", UID, "paymentSchedules", loan.scheduleId, "installments", i.id, "payments").withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore })),
        ),
      )
    ).flatMap((s) => s.docs.map((d) => d.data()));
    const active = all.filter((i) => i.deletedAt == null).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    return outstandingPrincipalAfterPrepaymentsFor(loan.loanAmount, active, principalPrepaidFor(records));
  }

  /** The canonical position, from live documents — what the rewired People hooks compute. */
  async function position(personId: string): Promise<PersonPosition> {
    const person = (await people.getByKey(personId))!;
    const allLoans = [...(await loans.getAll()), ...(await loans.getTrash())];
    const entries = await ledgerFor(personId).getAll();
    return personPosition({
      personId,
      currentBalance: person.currentBalance,
      loans: await Promise.all(allLoans.map(async (l) => ({ id: l.id, personId: l.personId, direction: l.direction, outstandingPrincipal: await outstanding(l), isDeleted: l.deletedAt != null }))),
      ledgerEntries: entries.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
      loanIds: new Set(allLoans.map((l) => l.id)),
    });
  }
  const schedules = new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }));
  const expenses = new ExpenseRepository(
    collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore }),
    new TransactionRepository(collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }), accounts),
    schedules,
    people,
    (id) => new InstallmentRepository(installmentsRef(id)),
    ledgerFor,
  );
  return { db, accounts, people, ledgerFor, loans, payments, live, outstanding, position, expenses };
}
type Setup = ReturnType<typeof setup>;

async function rahul(s: Setup): Promise<Person> {
  return s.people.createPerson({ name: "Rahul", avatarColorValue: 0, openingBalance: 0 });
}
async function bank(s: Setup) {
  return s.accounts.createAccount({ name: "HDFC", type: "bank", openingBalance: 100000, colorValue: 0 });
}

/** The old Web Loan form: `createLoan` then `postLoanCreatedLedgerEntry` (as `useLoanActions.createLoan` did). */
async function oldWebLoan(s: Setup, person: Person, direction: "given" | "taken", amount = 10000) {
  const loan = await s.loans.createLoan({
    category: "personal", personId: person.id, direction, loanAmount: amount, loanDate: LOAN_DATE,
    repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 5, name: "Rahul loan",
  });
  await postLoanCreatedLedgerEntry(UID, loan, s.people);
  return loan;
}
async function wizardLoan(s: Setup, person: Person, direction: "given" | "taken", key: string, accountId: string | null = null, amount = 10000) {
  return (
    await s.loans.createAgreementWithOrigination({
      idempotencyKey: key, name: "Rahul", category: "personal", personId: person.id, fundingSource: "person", direction,
      loanAmount: amount, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 5, movementAccountId: accountId,
    })
  ).loan;
}

/** Pre-change Flutter `PersonLoanLedgerSummary` arithmetic (ledger balance + Loan outstanding). */
function preChangeFlutterStatement(ledgerBalance: number, given: number, taken: number) {
  const theyOweYou = (ledgerBalance > 0 ? ledgerBalance : 0) + given;
  const youOweThem = (ledgerBalance < 0 ? -ledgerBalance : 0) + taken;
  return { theyOweYou, youOweThem };
}

describe("reproduction — pre-change behaviour", () => {
  it("old Web Loan I lent Rahul ₹10,000: ledger +10,000 AND Loan receivable 10,000 → Flutter statement showed ₹20,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await oldWebLoan(s, r, "given");
    const person = (await s.people.getByKey(r.id))!;
    expect(person.currentBalance).toBe(10000);
    const entries = await s.ledgerFor(r.id).getAll();
    expect(entries.map((e) => [e.type, e.amount, e.transactionRef])).toEqual([["gave", 10000, loan.id]]);
    expect(preChangeFlutterStatement(person.currentBalance, await s.outstanding(loan), 0).theyOweYou).toBe(20000);
  });

  it("old Web Loan I borrowed ₹10,000 from Rahul → Flutter statement showed I owe ₹20,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await oldWebLoan(s, r, "taken");
    const person = (await s.people.getByKey(r.id))!;
    expect(person.currentBalance).toBe(-10000);
    expect(preChangeFlutterStatement(person.currentBalance, 0, await s.outstanding(loan)).youOweThem).toBe(20000);
  });

  it("new wizard Loan I lent Rahul: Loan exists, but Person.currentBalance (the People list source) stays 0 → missing from 'owes you'", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await wizardLoan(s, r, "given", "repro-wiz-0001");
    expect(loan.personId).toBe(r.id);
    expect((await s.people.getByKey(r.id))!.currentBalance).toBe(0);
    expect(await s.ledgerFor(r.id).getAll()).toHaveLength(0);
  });

  it("new wizard Loan + the old Web payment action's ledger write → Rahul appears as someone I OWE ₹4,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await wizardLoan(s, r, "given", "repro-wiz-0002");
    await postLoanPaymentLedgerEntry(UID, loan, s.people, { amount: 4000, date: LOAN_DATE });
    expect((await s.people.getByKey(r.id))!.currentBalance).toBe(-4000);
  });
});

describe("canonical position — Loan counts once, from the Loan", () => {
  it("1 — direct ledger only", async () => {
    const s = setup();
    const r = await rahul(s);
    await s.ledgerFor(r.id).addEntry(r, { type: "gave", amount: 2000, date: LOAN_DATE, note: "Dinner" });
    expect(await s.position(r.id)).toMatchObject({ directBalance: 2000, loanReceivable: 0, net: 2000, owesMe: 2000, iOwe: 0 });
  });

  it("2/6/D — new wizard Loan I lent (no ledger entry) appears: owes me ₹10,000", async () => {
    const s = setup();
    const r = await rahul(s);
    await wizardLoan(s, r, "given", "canon-lend-01");
    expect(await s.position(r.id)).toMatchObject({ directBalance: 0, loanReceivable: 10000, net: 10000, owesMe: 10000 });
  });

  it("3/B — Loan I borrowed: I owe ₹10,000, once", async () => {
    const s = setup();
    const r = await rahul(s);
    await wizardLoan(s, r, "taken", "canon-borrow-01");
    expect(await s.position(r.id)).toMatchObject({ loanPayable: 10000, net: -10000, iOwe: 10000 });
  });

  it("4/G — direct ₹2,000 + Loan ₹10,000 = ₹12,000; the ledger part stays independent", async () => {
    const s = setup();
    const r = await rahul(s);
    await s.ledgerFor(r.id).addEntry(r, { type: "gave", amount: 2000, date: LOAN_DATE, note: "Dinner" });
    await wizardLoan(s, r, "given", "canon-mixed-01");
    expect(await s.position(r.id)).toMatchObject({ directBalance: 2000, loanReceivable: 10000, net: 12000, owesMe: 12000 });
  });

  it("5/A/C — old Web Loan with legacy ledger entries (creation AND payments) counts once", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await oldWebLoan(s, r, "given");
    await s.ledgerFor(r.id).addEntry((await s.people.getByKey(r.id))!, { type: "gave", amount: 500, date: LOAN_DATE, note: "Coffee" });
    const rows = await s.live(loan.scheduleId);
    await s.payments.record({ loan, scheduleInstallments: rows, accountId: account.id, amount: 2000, date: LOAN_DATE, idempotencyKey: "legacy-pay-1" });
    await postLoanPaymentLedgerEntry(UID, loan, s.people, { amount: 2000, date: LOAN_DATE });
    const p = await s.position(r.id);
    expect((await s.people.getByKey(r.id))!.currentBalance).toBe(10000 + 500 - 2000);
    expect(p).toMatchObject({ legacyLoanLedger: 8000, directBalance: 500, loanReceivable: 8000, net: 8500 });
  });

  it("5b — legacy Loan trashed with the old Web action (entries reversed) → contributes nothing", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await oldWebLoan(s, r, "given");
    await s.loans.softDelete(loan);
    await reverseLoanLedgerEntries(UID, loan, s.people);
    expect(await s.position(r.id)).toMatchObject({ directBalance: 0, loanReceivable: 0, net: 0 });
  });

  it("5c — legacy Loan trashed WITHOUT reversing its entries (Flutter trash) → still contributes nothing", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await oldWebLoan(s, r, "given");
    await s.loans.softDelete(loan);
    expect(await s.position(r.id)).toMatchObject({ legacyLoanLedger: 10000, directBalance: 0, loanReceivable: 0, net: 0 });
  });

  it("7/E — partial repayment ₹4,000 (zero interest) → owes me ₹6,000, no Person write needed", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "given", "canon-pay-01", account.id);
    await s.payments.record({ loan, scheduleInstallments: await s.live(loan.scheduleId), accountId: account.id, amount: 4000, date: LOAN_DATE, idempotencyKey: "canon-pay-01-p", includeUpcomingInstallments: true });
    expect(await s.position(r.id)).toMatchObject({ loanReceivable: 6000, owesMe: 6000, directBalance: 0 });
    expect(await s.ledgerFor(r.id).getAll()).toHaveLength(0);
  });

  it("7b — I repay a borrowed Loan ₹4,000 → I owe ₹6,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "taken", "canon-pay-02", account.id);
    await s.payments.record({ loan, scheduleInstallments: await s.live(loan.scheduleId), accountId: account.id, amount: 4000, date: LOAN_DATE, idempotencyKey: "canon-pay-02-p", includeUpcomingInstallments: true });
    expect(await s.position(r.id)).toMatchObject({ loanPayable: 6000, iOwe: 6000 });
  });

  it("8 — principal prepayment reduces the receivable by principal once", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "given", "canon-prep-01", account.id);
    const rows = await s.live(loan.scheduleId);
    await s.payments.record({ loan, scheduleInstallments: rows, accountId: account.id, amount: rows[0].amountDue + 3000, date: LOAN_DATE, idempotencyKey: "canon-prep-01-p" });
    expect((await s.position(r.id)).loanReceivable).toBeCloseTo(10000 - rows[0].amountDue - 3000, 2);
  });

  it("9 — Lend More ₹2,000 raises the receivable to ₹12,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "given", "canon-more-01", account.id);
    await s.payments.recordAdditionalDisbursement({ loan, scheduleInstallments: await s.live(loan.scheduleId), accountId: account.id, amount: 2000, date: LOAN_DATE, idempotencyKey: "canon-more-01-d" });
    expect((await s.position(r.id)).loanReceivable).toBeCloseTo(12000, 2);
  });

  it("9b — Borrow More ₹2,000 raises what I owe to ₹12,000", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "taken", "canon-more-02", account.id);
    await s.payments.recordAdditionalDisbursement({ loan, scheduleInstallments: await s.live(loan.scheduleId), accountId: account.id, amount: 2000, date: LOAN_DATE, idempotencyKey: "canon-more-02-d" });
    expect((await s.position(r.id)).iOwe).toBeCloseTo(12000, 2);
  });

  it("10/F — reversed origination removes the Loan once", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    await wizardLoan(s, r, "given", "canon-rev-01", account.id);
    await s.loans.reverseOrigination("canon-rev-01");
    expect(await s.position(r.id)).toMatchObject({ loanReceivable: 0, net: 0 });
  });

  it("11/F — reversed payment restores the receivable once", async () => {
    const s = setup();
    const r = await rahul(s);
    const account = await bank(s);
    const loan = await wizardLoan(s, r, "given", "canon-rev-02", account.id);
    const paid = await s.payments.record({ loan, scheduleInstallments: await s.live(loan.scheduleId), accountId: account.id, amount: 4000, date: LOAN_DATE, idempotencyKey: "canon-rev-02-p", includeUpcomingInstallments: true });
    await s.payments.reversePayment({ loan, transactionId: paid.transactionId, paymentIds: paid.paymentIds, installmentIds: paid.installmentIds, reversalIdempotencyKey: "canon-rev-02-r" });
    expect((await s.position(r.id)).loanReceivable).toBe(10000);
  });

  it("12 — a closed Loan keeps its outstanding principal (same rule as Net Worth)", async () => {
    const s = setup();
    const r = await rahul(s);
    const loan = await wizardLoan(s, r, "given", "canon-close-1");
    await s.loans.closeLoan(loan);
    expect((await s.position(r.id)).loanReceivable).toBe(10000);
  });

  it("payer-only link (someone pays my bank EMIs) is not counted as a Loan with them", async () => {
    const s = setup();
    const r = await rahul(s);
    await s.loans.createLoan({ loanAmount: 50000, loanDate: LOAN_DATE, repaymentType: "installment", installmentFrequency: "monthly", installmentCount: 5, institutionName: "Axis", payerPersonId: r.id });
    expect((await s.position(r.id)).net).toBe(0);
  });

  it("people totals: owes-me and I-owe groups over net positions", async () => {
    const s = setup();
    const a = await rahul(s);
    const b = await s.people.createPerson({ name: "Priya", avatarColorValue: 0, openingBalance: 0 });
    await wizardLoan(s, a, "given", "canon-tot-01");
    await wizardLoan(s, b, "taken", "canon-tot-02", null, 3000);
    expect(peopleTotals([await s.position(a.id), await s.position(b.id)])).toEqual({ totalOwedToMe: 10000, owedByCount: 1, totalIOwe: 3000, owingCount: 1, net: 7000 });
  });
});

describe("H — Settle Up settles the direct balance only, never Loan debt", () => {
  it("old Web Loan +10,000 and a direct 'I owe 500': settling the 500 posts 'repaid' and leaves the Loan untouched", async () => {
    const s = setup();
    const r = await rahul(s);
    await oldWebLoan(s, r, "given");
    await s.ledgerFor(r.id).addEntry((await s.people.getByKey(r.id))!, { type: "borrowed", amount: 500, date: LOAN_DATE, note: "Coffee" });
    const before = await s.position(r.id);
    expect([before.directBalance, before.loanReceivable, (await s.people.getByKey(r.id))!.currentBalance]).toEqual([-500, 10000, 9500]);
    await s.expenses.settleAcrossPending({
      person: (await s.people.getByKey(r.id))!,
      pending: [],
      amount: Math.abs(before.directBalance),
      date: LOAN_DATE,
      installmentPaymentRepositoryFor: () => { throw new Error("no split installments"); },
      legacyLoanLedger: before.legacyLoanLedger,
    });
    const entries = await s.ledgerFor(r.id).getAll();
    expect(entries.find((e) => e.note === "Settled all")?.type).toBe("repaid");
    expect(await s.position(r.id)).toMatchObject({ directBalance: 0, loanReceivable: 10000, net: 10000 });
  });

  it("without the offset (pre-change), the raw ledger sign would have posted 'receivedBack' — the wrong direction", async () => {
    const s = setup();
    const r = await rahul(s);
    await oldWebLoan(s, r, "given");
    await s.ledgerFor(r.id).addEntry((await s.people.getByKey(r.id))!, { type: "borrowed", amount: 500, date: LOAN_DATE, note: "Coffee" });
    await s.expenses.settleAcrossPending({ person: (await s.people.getByKey(r.id))!, pending: [], amount: 500, date: LOAN_DATE, installmentPaymentRepositoryFor: () => { throw new Error("none"); } });
    expect((await s.ledgerFor(r.id).getAll()).find((e) => e.note === "Settled all")?.type).toBe("receivedBack");
    expect((await s.position(r.id)).directBalance).toBe(-1000);
  });
});
