/**
 * Shared debt ownership — financial integrity audit (real Firestore emulator).
 *
 * Drives the REAL write paths end to end — `LoanRepository.createAgreementWithOrigination` (with
 * `ownershipShares` + an account movement), `LoanAdvancePaymentRepository` (lender payments, prepayment,
 * reversal), `PersonPaymentRepository` (Record Payment: reimbursements, partials, advance, revert) — then
 * reads every linked surface from the live documents with the same engines the hooks use:
 *
 *  - Accounts      → `Account.currentBalance`
 *  - Net Worth     → `netWorthWithLoans(accounts, loanBalanceSheet(...), peopleNetWorthPosition(...).balance)` (= `useLoanBalanceSheet`)
 *  - People        → `personPosition` + `personEmiObligations` (= `usePersonPositions`), cycle statement
 *  - Month Cycle   → the hook's income input filter (`!isLoanPrincipalDisbursement && !isPersonLedgerMovement`)
 *  - Debt Planner  → `loanDebtPosition` ownership + `requiredByOwnership`
 *
 * Expected accounting treatment (documented before testing — see docs/shared-debt-ownership-audit.md):
 *  - Receiving a borrowed loan is a balance-sheet event: cash +P, liability +P. Never income, never wealth.
 *  - Ownership shares say WHO the liability economically belongs to; they never change the cash received
 *    nor the liability the lender holds me to (the full outstanding principal).
 *  - A person reimbursing their share moves cash into my account and settles THEIR obligation to me only.
 *    It never marks the lender installment paid. Not income.
 *  - A lender payment reduces cash and outstanding principal only. It never settles a person.
 *
 * Run: `npm run test:integration` (Firestore emulator on 127.0.0.1:8080).
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { splitByOwnership, resolveOwnership } from "@/lib/engines/debt-ownership";
import { loanDebtPosition, requiredByOwnership, type LoanDebtInput } from "@/lib/engines/debt-position";
import { loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { emiReceivableThrough, personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { allocatePayment, advanceRemaining, planAdvanceApplication } from "@/lib/engines/person-payment";
import { buildPersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { breakdownEntryOf, peopleNetWorthPosition, personPosition, type PersonPosition } from "@/lib/engines/person-position";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { advanceSources, payableObligations, paymentLines } from "@/features/people/lib/person-payment-obligations";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
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
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
  signedAmount,
  type Person,
} from "@/lib/models/person";
import { classifyForMySpend, mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { PeopleSettlementPendingError } from "@/lib/engines/linked-people-readiness";
import { isLoanPrincipalDisbursement, transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository, type LoanAdvancePaymentResult } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository, OriginationDeleteBlockedError } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, StalePersonPaymentError, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-shared-loan-ownership-audit";
const UID = "e2e-owner-uid";
const LOAN_DATE = new Date(2026, 0, 10);
const FIRST_DUE = new Date(2026, 1, 10);
/** The calendar-month cycle containing `d` — what the People workspace shows for that month. */
const cycleOf = (d: Date): StatementCycle => ({ start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999) });

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
  const accountsRef = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const accounts = new AccountRepository(accountsRef);
  const transactionsRef = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsRef, accounts);
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  const applicationsRef = (personId: string) =>
    collection(db, "users", UID, "people", personId, "advanceApplications").withConverter({ toFirestore: advanceApplicationToFirestore, fromFirestore: advanceApplicationFromFirestore });
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
  const paymentsRef = (scheduleId: string, installmentId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({
      toFirestore: installmentPaymentToFirestore,
      fromFirestore: installmentPaymentFromFirestore,
    });
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore })),
    (id) => new InstallmentRepository(installmentsRef(id)),
  );
  const lender = new LoanAdvancePaymentRepository(db, UID);
  const personPayments = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: people,
      ledgerRepository: ledgerFor(personId),
      transactionRepository: transactions,
      advanceApplications: applicationsRef(personId),
      // Only split-expense routes touch these; a shared Loan share settles by `obligationRef`.
      expenseDocRef: () => {
        throw new Error("no expenses in this scenario");
      },
      installmentDocRef: (scheduleId, installmentId) => doc(installmentsRef(scheduleId), installmentId),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) => doc(paymentsRef(scheduleId, installmentId), paymentId),
      cashLegCategoryId: "cat-people",
    });
  return { db, accounts, accountsRef, transactionsRef, transactions, people, ledgerFor, applicationsRef, installmentsRef, paymentsRef, loans, lender, personPayments };
}

type World = Awaited<ReturnType<typeof world>>;

/** Account ₹5,000; Me / Person A / Person B; a ₹30,000 interest-free, 10 × ₹3,000 monthly loan, ⅓ each, deposited into the account. */
async function world(opts: { loanAmount?: number; count?: number; shares?: "thirds" | "none"; movement?: boolean } = {}) {
  const s = setup();
  const loanAmount = opts.loanAmount ?? 30_000;
  const count = opts.count ?? 10;
  const account = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
  const a = await s.people.createPerson({ name: "Person A", avatarColorValue: 0, openingBalance: 0 });
  const b = await s.people.createPerson({ name: "Person B", avatarColorValue: 0, openingBalance: 0 });
  const third = loanAmount / 3;
  const created = await s.loans.createAgreementWithOrigination({
    idempotencyKey: `shared-${loanAmount}-${count}`,
    name: "Shared loan",
    category: "institutional",
    institutionName: "HDFC Bank",
    fundingSource: "bank",
    direction: "taken",
    loanAmount,
    loanDate: LOAN_DATE,
    firstDueDate: FIRST_DUE,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: count,
    movementAccountId: opts.movement === false ? null : account.id,
    ownershipShares:
      opts.shares === "none"
        ? null
        : [
            { personId: null, amount: third },
            { personId: a.id, amount: third },
            { personId: b.id, amount: third },
          ],
  });
  return { ...s, accountId: account.id, aId: a.id, bId: b.id, loanId: created.loan.id, scheduleId: created.scheduleId };
}

// ─────────────────────────── live read models ───────────────────────────

async function loanNow(w: World): Promise<Loan> {
  return [...(await w.loans.getAll()), ...(await w.loans.getTrash())].find((l) => l.id === w.loanId)!;
}
async function allInstallments(w: World, scheduleId = w.scheduleId): Promise<Installment[]> {
  return (await getDocs(w.installmentsRef(scheduleId))).docs.map((d) => d.data()).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
}
async function liveInstallments(w: World): Promise<Installment[]> {
  return (await allInstallments(w)).filter((i) => i.deletedAt == null);
}
async function cash(w: World): Promise<number> {
  return (await w.accounts.getByKey(w.accountId))!.currentBalance;
}
/** `useLoanRows().outstandingPrincipal` — the Net Worth / Debt Planner figure. */
async function outstanding(w: World): Promise<number> {
  const loan = await loanNow(w);
  const all = await allInstallments(w);
  const records = (await Promise.all(all.map((i) => getDocs(w.paymentsRef(loan.scheduleId, i.id))))).flatMap((s) => s.docs.map((d) => d.data()));
  return outstandingPrincipalAfterPrepaymentsFor(loan.loanAmount, all.filter((i) => i.deletedAt == null), principalPrepaidFor(records));
}
async function ledgerEntries(w: World, personId: string) {
  return w.ledgerFor(personId).getAll();
}
async function applications(w: World, personId: string) {
  return (await getDocs(w.applicationsRef(personId))).docs.map((d) => d.data());
}
function loanSource(loan: Loan) {
  return {
    id: loan.id,
    name: loan.name,
    scheduleId: loan.scheduleId,
    direction: loan.direction,
    personId: loan.personId,
    beneficiaryPersonId: loan.beneficiaryPersonId ?? null,
    beneficiaryRepaysInstallments: loan.beneficiaryRepaysInstallments,
    ownershipShares: loan.ownershipShares ?? null,
    isClosed: loan.isClosed,
    deletedAt: loan.deletedAt,
  };
}
async function statement(w: World, personId: string, now: Date, cycle: StatementCycle = cycleOf(now)) {
  const person = (await w.people.getByKey(personId))!;
  const loan = await loanNow(w);
  return buildPersonCycleStatement({
    person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
    ledgerEntries: await ledgerEntries(w, personId),
    loanIds: new Set([loan.id]),
    emis: [],
    loans: [loanSource(loan)],
    installments: await liveInstallments(w),
    cycle,
    now,
    advanceApplications: await applications(w, personId),
  });
}
async function rows(w: World, personId: string, now: Date) {
  const s = await statement(w, personId, now);
  return buildLedgerRows({ statement: s, history: s, entries: await ledgerEntries(w, personId), pending: [], now, advanceApplications: await applications(w, personId) });
}
/** `usePersonPositions` for one person: direct ledger + opted-in installment shares due by `now`. */
async function position(w: World, personId: string, now: Date): Promise<PersonPosition> {
  const person = (await w.people.getByKey(personId))!;
  const loan = await loanNow(w);
  const obligations = personEmiObligations({ personId, emis: [], loans: [loanSource(loan)], installments: await liveInstallments(w), now });
  return personPosition({
    personId,
    currentBalance: person.currentBalance,
    loans: [],
    ledgerEntries: (await ledgerEntries(w, personId)).map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
    loanIds: new Set([loan.id]),
    emiReceivable: emiReceivableThrough(obligations, now),
  });
}
/** Exactly `useLoanBalanceSheet().netWorth`. */
async function netWorth(w: World, now: Date) {
  const accounts = (await getDocs(w.accountsRef)).docs.map((d) => d.data()).filter((a) => a.deletedAt == null);
  const loan = await loanNow(w);
  const sheet = loanBalanceSheet(loan.deletedAt == null ? [{ direction: loan.direction, outstandingPrincipal: await outstanding(w) }] : [], []);
  const people = peopleNetWorthPosition(
    [
      { position: await position(w, w.aId, now), entries: (await ledgerEntries(w, w.aId)).map(breakdownEntryOf) },
      { position: await position(w, w.bId, now), entries: (await ledgerEntries(w, w.bId)).map(breakdownEntryOf) },
    ],
    new Set([loan.id]),
  );
  return {
    netWorth: netWorthWithLoans(accounts.reduce((s, a) => s + a.currentBalance, 0), sheet, people.balance),
    sheet,
    peoplePayable: people.payable,
    peopleReceivable: people.receivable,
  };
}
/** Month Cycle's income: the hook drops loan-principal disbursements and People cash legs before `amountFor("income")`. */
async function monthCycleIncome(w: World) {
  const txs = (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction).filter((t) => t.deletedAt == null);
  return txs.filter((t) => !isLoanPrincipalDisbursement(t) && !t.isPersonLedgerMovement && t.type === "income").reduce((s, t) => s + t.amount, 0);
}
async function plannerOwnership(w: World, now: Date) {
  const loan = await loanNow(w);
  const input: LoanDebtInput = {
    id: loan.id,
    name: loan.name ?? null,
    lenderName: "HDFC Bank",
    direction: loan.direction,
    category: loan.category,
    personId: loan.personId,
    isClosed: loan.isClosed,
    loanAmount: loan.loanAmount,
    interest: loan.interest,
    repaymentType: loan.repaymentType,
    installmentFrequency: loan.installmentFrequency,
    installments: await liveInstallments(w),
    outstandingPrincipal: await outstanding(w),
    ownedByCardId: null,
    purchaseRepresented: false,
    ownershipShares: resolveOwnership(loan, loan.loanAmount),
  };
  const p = loanDebtPosition(input, now, { [w.aId]: "Person A", [w.bId]: "Person B" });
  return p;
}

// ─────────────────────────── write helpers ───────────────────────────

/** The default lender payment: the People settlement gate is enforced by the repository. */
async function payLender(w: World, amount: number, date: Date, key: string, includeUpcomingInstallments = false): Promise<LoanAdvancePaymentResult> {
  return w.lender.record({ loan: await loanNow(w), scheduleInstallments: await liveInstallments(w), accountId: w.accountId, amount, date, idempotencyKey: key, includeUpcomingInstallments });
}
/**
 * A lender payment made although a linked share is still open — with the explicit, recorded acknowledgement
 * the write layer requires (models the bank auto-debiting the EMI). Used by the tests whose PREMISE is that the
 * lender leg and the People leg are independent; the People obligation stays open either way.
 */
async function payLenderAnyway(w: World, amount: number, date: Date, key: string, includeUpcomingInstallments = false): Promise<LoanAdvancePaymentResult> {
  return w.lender.record({
    loan: await loanNow(w),
    scheduleInstallments: await liveInstallments(w),
    accountId: w.accountId,
    amount,
    date,
    idempotencyKey: key,
    includeUpcomingInstallments,
    peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Bank auto-debited the EMI" },
  });
}
async function revertLender(w: World, r: LoanAdvancePaymentResult, key: string) {
  return w.lender.reversePayment({
    loan: await loanNow(w),
    transactionId: r.transactionId,
    paymentIds: r.paymentIds,
    installmentIds: r.installmentIds,
    overflowPaymentId: r.overflowPaymentId,
    overflowInstallmentId: r.overflowInstallmentId,
    reversalIdempotencyKey: key,
  });
}
/** What the Record Payment workspace submits: oldest-first over that person's open loan-share obligations. */
async function personPays(w: World, personId: string, amount: number, date: Date, extra: "advance" | null = null): Promise<{ paymentId: string; input: RecordPaymentInput }> {
  const obligations = payableObligations(await rows(w, personId, date)).filter((o) => o.side === "theyOwe");
  const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount });
  const input: RecordPaymentInput = {
    direction: "theyPaid",
    amount,
    date,
    accountId: w.accountId,
    lines: paymentLines(obligations, alloc.lines),
    extra: alloc.extra > 0 && extra === "advance" ? { kind: "advance", amount: alloc.extra } : null,
  };
  const person = (await w.people.getByKey(personId)) as Person;
  const paymentId = await w.personPayments(personId).recordPayment(person, input);
  return { paymentId, input };
}
async function shareRow(w: World, personId: string, seq: number, now: Date) {
  const insts = await liveInstallments(w);
  const inst = insts.find((i) => i.sequenceNumber === seq)!;
  return (await rows(w, personId, now)).find((r) => r.key === `loan-inst:${inst.id}`);
}

const FEB_15 = new Date(2026, 1, 15);
const FEB_12 = new Date(2026, 1, 12);

// ═══════════════════════════ 1. Account cash ═══════════════════════════

describe("1 — account cash lifecycle (real origination + payments)", () => {
  it("₹5,000 + ₹30,000 shared loan deposited → ₹35,000; ownership never changes the cash received", async () => {
    const w = await world();
    expect(await cash(w)).toBe(35_000);
    const loan = await loanNow(w);
    expect(loan.loanAmount).toBe(30_000); // the lender still advanced ₹30,000
    expect(loan.ownershipShares!.map((s) => s.amount)).toEqual([10_000, 10_000, 10_000]);
    expect(await outstanding(w)).toBe(30_000);
    // The origination Transaction is a principal disbursement, not income.
    const txs = (await getDocs(query(w.transactionsRef, where("loanId", "==", w.loanId)))).docs.map((d) => d.data());
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ amount: 30_000, type: "income" });
    expect(isLoanPrincipalDisbursement(txs[0])).toBe(true);
    expect(await monthCycleIncome(w)).toBe(0);
  });

  it("same loan with no ownership shares deposits exactly the same cash (allocation-independent)", async () => {
    const w = await world({ shares: "none" });
    expect(await cash(w)).toBe(35_000);
  });

  it("lender repayment and person reimbursement move cash independently", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "lender-1");
    expect(await cash(w)).toBe(32_000); // lender: −₹3,000 only
    await personPays(w, w.aId, 1_000, FEB_12);
    expect(await cash(w)).toBe(33_000); // A: +₹1,000 only
    await personPays(w, w.bId, 1_000, FEB_12);
    expect(await cash(w)).toBe(34_000);
    expect(await monthCycleIncome(w)).toBe(0); // neither is income
  });

  it("without an account movement, ownership creates no cash and no transaction", async () => {
    const w = await world({ movement: false });
    expect(await cash(w)).toBe(5_000);
    expect((await getDocs(w.transactionsRef)).size).toBe(0);
  });
});

// ═══════════════════════════ 2. Net Worth ═══════════════════════════

/**
 * Net Worth components (F1 fixed): installment #1 falls due on FIRST_DUE (Feb 10), so by FEB_15 A and B
 * each owe me their ₹1,000 share — a People receivable (+₹2,000) beside the full lender liability. Before
 * the fix, Net Worth ignored that receivable and instead booked every reimbursement as a phantom payable;
 * these assertions previously read ₹5,000 at FEB_15. Every step below asserts the components.
 */
describe("2 — Net Worth lifecycle", () => {
  it("loan creation: cash +₹30,000 and liability +₹30,000 → Net Worth unchanged (₹5,000), no income", async () => {
    const w = await world();
    const nw = await netWorth(w, LOAN_DATE);
    expect(nw.sheet.borrowedPrincipal).toBe(30_000);
    expect(nw.netWorth).toBe(5_000);
    expect(await monthCycleIncome(w)).toBe(0);
  });

  it("first EMI to lender (interest-free): cash −₹3,000, liability −₹3,000 → Net Worth unchanged", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l1");
    const nw = await netWorth(w, FEB_15);
    // cash 32,000 + A/B shares due 2,000 − liability 27,000
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.peoplePayable, nw.netWorth]).toEqual([32_000, 27_000, 2_000, 0, 7_000]);
  });

  it("extra lender payment (₹3,000 EMI + ₹6,000 prepayment): liability −₹9,000, cash −₹9,000 → unchanged", async () => {
    const w = await world();
    const r = await payLenderAnyway(w, 9_000, FIRST_DUE, "l1x");
    expect(r.overallAllocationType).toBe("principalPrepayment");
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([26_000, 21_000, 2_000, 7_000]);
  });

  it("deleted/reverted lender payment restores cash and liability exactly", async () => {
    const w = await world();
    const r = await payLenderAnyway(w, 3_000, FIRST_DUE, "l1r");
    await revertLender(w, r, "l1r-undo");
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([35_000, 30_000, 2_000, 7_000]);
  });

  /**
   * F1 (FIXED). This test used to pin the defect: after A settled their ₹1,000 share, People showed A at ₹0
   * but Net Worth / `peoplePayable` counted "I owe A ₹1,000" (cash +1,000 offset by a phantom −1,000).
   * Now the reimbursement is an asset swap: cash +₹1,000, A's receivable −₹1,000, no payable.
   */
  it("person reimbursement: People settles A to ₹0 and Net Worth has no phantom payable (F1)", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    const pos = await position(w, w.aId, FEB_15);
    expect([pos.directBalance, pos.emiReceivable, pos.net]).toEqual([-1_000, 1_000, 0]); // People: settled
    const nw = await netWorth(w, FEB_15);
    expect(await cash(w)).toBe(36_000);
    expect(nw.peoplePayable).toBe(0); // was ₹1,000 — A is not someone I owe
    expect(nw.peopleReceivable).toBe(1_000); // only B's unpaid share
    expect(nw.netWorth).toBe(7_000); // 36,000 + 1,000 − 30,000: unchanged by the reimbursement itself
    expect(await monthCycleIncome(w)).toBe(0); // never income
  });

  it("partial reimbursement then full lender instalment then reversal — every step reconciles to the documented rule", async () => {
    const w = await world();
    const { paymentId } = await personPays(w, w.aId, 500, FEB_12);
    let nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.peopleReceivable, nw.peoplePayable, nw.netWorth]).toEqual([35_500, 1_500, 0, 7_000]);
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l1p");
    nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([32_500, 27_000, 1_500, 7_000]);
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, paymentId);
    nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth, nw.peoplePayable]).toEqual([32_000, 27_000, 2_000, 7_000, 0]);
  });

  it("loan closure with principal left keeps the liability in Net Worth (closing is not repaying)", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l1c");
    await w.loans.closeLoan(await loanNow(w));
    const nw = await netWorth(w, FEB_15);
    // Closing never forgives A/B their share of an installment I already paid the lender.
    expect([nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([27_000, 2_000, 7_000]);
  });
});

// ═══════════════ 4. Person paid me, lender not yet paid ═══════════════

describe("4 — person-paid / lender-unpaid: both facts preserved", () => {
  it("A pays ₹1,000 share; installment #1 still fully payable to the lender", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);

    // Person obligation to me: settled.
    const row = (await shareRow(w, w.aId, 1, FEB_15))!;
    expect([row.amount, row.paid, row.remaining, row.state]).toEqual([1_000, 1_000, 0, "settled"]);
    expect((await position(w, w.aId, FEB_15)).net).toBe(0);

    // Lender obligation: untouched — ₹3,000 still due, nothing paid.
    const inst1 = (await liveInstallments(w))[0];
    expect([inst1.amountDue, inst1.amountPaid]).toEqual([3_000, 0]);
    expect(await outstanding(w)).toBe(30_000);

    // Debt Planner: ownership is still A's ₹10,000 (OWNERSHIP of the lender liability, not a receivable);
    // the lender still expects the full ₹3,000.
    const p = (await plannerOwnership(w, FEB_15))!;
    expect(p.ownership.others.find((o) => o.personId === w.aId)!.amount).toBe(10_000);
    const req = requiredByOwnership({ [p.id]: 3_000 }, [p]);
    expect(req).toMatchObject({ required: 3_000, mine: 1_000, fromPeople: 2_000 });
    // Receivable ≠ ownership: A owes me nothing now; B still owes ₹1,000.
    expect((await position(w, w.aId, FEB_15)).owesMe).toBe(0);
    expect((await position(w, w.bId, FEB_15)).owesMe).toBe(1_000);
  });

  it("paying the lender in full never settles B (B still owes their ₹1,000)", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l-only");
    const row = (await shareRow(w, w.bId, 1, FEB_15))!;
    expect([row.amount, row.remaining]).toEqual([1_000, 1_000]);
  });
});

// ═══════════════════════ 5. Prepayment policy ═══════════════════════

describe("5 — prepayment: today's policy reduces everyone's ownership proportionally (NOT changed)", () => {
  it("₹30,000 left, I prepay ₹6,000 → ₹24,000 split 8,000 / 8,000 / 8,000", async () => {
    const w = await world();
    // A prepayment-only action: pay the ₹3,000 due + ₹6,000 extra, then look at ownership of what remains.
    await payLenderAnyway(w, 9_000, FIRST_DUE, "prepay");
    expect(await outstanding(w)).toBe(21_000);
    const p = (await plannerOwnership(w, FEB_15))!;
    expect(p.ownership.mine).toBe(7_000);
    expect(p.ownership.others.map((o) => o.amount)).toEqual([7_000, 7_000]);
    // People: A/B still owe only their share of each installment actually due — the prepayment is not
    // credited to my ownership alone and is not charged to them.
    expect((await position(w, w.aId, FEB_15)).emiReceivable).toBe(1_000);
  });
});

// ═══════════════════════ 7. Partial person payments ═══════════════════════

describe("7 — partial payments ₹500 → ₹200 → ₹200 on a ₹900 share", () => {
  it("each step: account +cash, not income, lender untouched, other person untouched, reversible", async () => {
    const w = await world({ loanAmount: 27_000 }); // 10 × ₹2,700 → ⅓ share = ₹900
    const base = await cash(w);
    const shareOf = async () => (await shareRow(w, w.aId, 1, FEB_15))!;
    expect((await shareOf()).remaining).toBe(900);

    const p1 = await personPays(w, w.aId, 500, FEB_12);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([400, base + 500]);
    await personPays(w, w.aId, 200, FEB_12);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([200, base + 700]);
    await personPays(w, w.aId, 200, FEB_12);
    expect([(await shareOf()).remaining, (await shareOf()).state, await cash(w)]).toEqual([0, "settled", base + 900]);

    expect(await monthCycleIncome(w)).toBe(0);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // lender installment not paid
    expect((await shareRow(w, w.bId, 1, FEB_15))!.remaining).toBe(900); // B unchanged
    const st = await statement(w, w.aId, FEB_15);
    expect(st.currentPending).toBe(0);

    // Reversible: undo the first ₹500 → ₹500 owed again, cash back.
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, p1.paymentId);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([500, base + 400]);
  });
});

// ═══════════════════════ 8. Overpayment / advance ═══════════════════════

describe("8 — overpayment follows the existing advance policy", () => {
  it("₹1,200 against ₹900 due → ₹900 settled + ₹300 advance; next cycle consumes it on explicit apply", async () => {
    const w = await world({ loanAmount: 27_000 });
    const base = await cash(w);
    await personPays(w, w.aId, 1_200, FEB_12, "advance");
    expect(await cash(w)).toBe(base + 1_200); // one receipt, whole amount
    expect(await monthCycleIncome(w)).toBe(0); // advance is never income
    const st = await statement(w, w.aId, FEB_15);
    expect([st.currentPending, st.advanceBalance]).toEqual([0, -300]);

    // March: installment #2 share ₹900 due. The advance is NOT consumed on its own…
    const MAR_15 = new Date(2026, 2, 15);
    expect((await statement(w, w.aId, MAR_15)).currentPending).toBe(900);
    // …only when applied (existing policy).
    const entries = await ledgerEntries(w, w.aId);
    const inst2 = (await liveInstallments(w))[1];
    const plan = planAdvanceApplication({
      available: advanceRemaining(advanceSources(entries), await applications(w, w.aId)),
      obligations: payableObligations(await rows(w, w.aId, MAR_15)),
      side: "theyOwe",
      selectedKeys: [`loan-inst:${inst2.id}`],
    });
    expect([plan.availableTotal, plan.allocation.allocated, plan.error]).toEqual([300, 300, null]);
    await w.personPayments(w.aId).applyAdvance((await w.people.getByKey(w.aId))!, { targets: plan.targets, date: MAR_15 });
    const mar = await statement(w, w.aId, MAR_15);
    expect([mar.currentPending, mar.advanceBalance]).toEqual([600, 0]);
    expect(await cash(w)).toBe(base + 1_200); // applying moves no money
    expect((await liveInstallments(w))[1].amountPaid).toBe(0); // lender untouched
  });
});

// ═══════════════════════ 9. Edit / delete / reversal ═══════════════════════

describe("9 — edit / delete / reversal keep every surface consistent", () => {
  it("cancel (reverse origination) before any payment: cash −₹30,000, loan trashed, no obligations", async () => {
    const w = await world();
    await w.loans.reverseOrigination("shared-30000-10");
    expect(await cash(w)).toBe(5_000);
    expect((await loanNow(w)).deletedAt).not.toBeNull();
    expect((await position(w, w.aId, FEB_15)).net).toBe(0);
    expect((await netWorth(w, FEB_15)).netWorth).toBe(5_000);
    expect(await plannerOwnership(w, FEB_15)).not.toBeNull(); // engine input still built from the doc…
    // …but the hook drops trashed loans (useLoanRows reads active loans only) — no planner position.
  });

  it("cancel after a person reimbursement: the reimbursement is not orphaned — it surfaces as money held for A", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    await w.loans.reverseOrigination("shared-30000-10"); // person payments don't block reversal
    expect(await cash(w)).toBe(6_000);
    const pos = await position(w, w.aId, FEB_15);
    expect([pos.emiReceivable, pos.directBalance, pos.iOwe]).toEqual([0, -1_000, 1_000]);
    expect((await netWorth(w, FEB_15)).netWorth).toBe(5_000);
  });

  it("delete (trash) of a funded shared loan is blocked while its origination money is active — no orphans", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l-del");
    await expect(w.loans.softDelete(await loanNow(w))).rejects.toBeInstanceOf(OriginationDeleteBlockedError);
    await expect(w.loans.reverseOrigination("shared-30000-10")).rejects.toThrow(/payment/);
    expect([await cash(w), await outstanding(w)]).toEqual([32_000, 27_000]);
  });

  it("create → trash → restore → restore again (stale) → edit → trash: never duplicates, never rolls back a newer field", async () => {
    const w = await world({ movement: false });
    const stale = await loanNow(w); // the object a stale screen still holds
    await w.loans.softDelete(stale);
    const trashed = await loanNow(w);
    await w.loans.restore(trashed);
    expect((await loanNow(w)).deletedAt).toBeNull();
    let nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([30_000, 2_000, -23_000]);
    // A newer edit lands, then the same restore fires again from the stale trash list.
    await w.loans.update({ ...(await loanNow(w)), name: "Renamed after restore" });
    await w.loans.restore(trashed);
    const after = await loanNow(w);
    expect([after.deletedAt, after.name]).toEqual([null, "Renamed after restore"]); // no roll-back
    expect((await liveInstallments(w)).length).toBe(10); // one schedule, never duplicated
    nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([30_000, 2_000, -23_000]);
    // Trash from the stale object: trashed, name kept; trashing again is a no-op.
    await w.loans.softDelete(stale);
    await w.loans.softDelete(stale);
    const gone = await loanNow(w);
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.name).toBe("Renamed after restore");
    expect((await position(w, w.aId, FEB_15)).emiReceivable).toBe(0);
    nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.peopleReceivable, nw.netWorth]).toEqual([0, 0, 5_000]);
  });

  it("delete (trash) a shared loan recorded without money movement: person obligations vanish, liability leaves Net Worth", async () => {
    const w = await world({ movement: false });
    await w.loans.softDelete(await loanNow(w));
    expect((await position(w, w.aId, FEB_15)).emiReceivable).toBe(0);
    expect((await position(w, w.bId, FEB_15)).emiReceivable).toBe(0);
    const nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([0, 5_000]);
  });

  it("duplicate submit / retry of the same Record Payment: one cash leg, one settlement — the second is refused", async () => {
    const w = await world();
    const screenPerson = (await w.people.getByKey(w.aId)) as Person; // what the modal was opened with
    const obligations = payableObligations(await rows(w, w.aId, FEB_12)).filter((o) => o.side === "theyOwe");
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 1_000 });
    const input: RecordPaymentInput = { direction: "theyPaid", amount: 1_000, date: FEB_12, accountId: w.accountId, lines: paymentLines(obligations, alloc.lines), extra: null };
    await w.personPayments(w.aId).recordPayment(screenPerson, input);
    await expect(w.personPayments(w.aId).recordPayment(screenPerson, input)).rejects.toBeInstanceOf(StalePersonPaymentError);
    expect(await cash(w)).toBe(36_000); // +₹1,000 exactly once
    const pos = await position(w, w.aId, FEB_15);
    expect([pos.directBalance, pos.emiReceivable, pos.net]).toEqual([-1_000, 1_000, 0]);
    const nw = await netWorth(w, FEB_15);
    expect([nw.peoplePayable, nw.peopleReceivable]).toEqual([0, 1_000]); // no over-settled share held as a payable
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // lender leg untouched
    // A fresh screen (current balance) can still record a genuine second payment.
    const fresh = (await w.people.getByKey(w.aId)) as Person;
    await w.personPayments(w.aId).recordPayment(fresh, { ...input, lines: [], extra: { kind: "advance", amount: 500 }, amount: 500 });
    expect(await cash(w)).toBe(36_500);
  });

  it("revert a person reimbursement: obligation reopens, cash returns, lender side untouched", async () => {
    const w = await world();
    const { paymentId } = await personPays(w, w.aId, 1_000, FEB_12);
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, paymentId);
    expect(await cash(w)).toBe(35_000);
    expect((await shareRow(w, w.aId, 1, FEB_15))!.remaining).toBe(1_000);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0);
  });

  it("revert a lender payment: installment reopens; A's settlement is untouched", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    const r = await payLenderAnyway(w, 3_000, FIRST_DUE, "l-rev");
    await revertLender(w, r, "l-rev-undo");
    expect((await liveInstallments(w))[0].amountPaid).toBe(0);
    expect((await shareRow(w, w.aId, 1, FEB_15))!.remaining).toBe(0);
    expect(await cash(w)).toBe(36_000);
  });

  it("edit permitted loan fields (name/notes) never touches ownership, schedule or money", async () => {
    const w = await world();
    const before = await loanNow(w);
    await w.loans.editLoan(before, { hasPayments: false, name: "Renamed", notes: "edited" });
    const after = await loanNow(w);
    expect(after.name).toBe("Renamed");
    expect(after.ownershipShares).toEqual(before.ownershipShares);
    expect(await cash(w)).toBe(35_000);
  });

  it("close: unpaid future shares stop; already-due paid history keeps its share", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FIRST_DUE, "l-close");
    await w.loans.closeLoan(await loanNow(w));
    const MAY = new Date(2026, 4, 15);
    // Only installment #1 (lender-paid) remains a person obligation after closing.
    expect((await position(w, w.aId, MAY)).emiReceivable).toBe(1_000);
  });
});

// ═══════════════════════ 6. paise check on the live schedule ═══════════════════════

describe("6 — live schedule: every installment's shares sum to the installment", () => {
  it("₹10,000.01 over 3 installments, ⅓-ish shares", async () => {
    const s = setup();
    const account = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 0, colorValue: 0 });
    const a = await s.people.createPerson({ name: "A", avatarColorValue: 0, openingBalance: 0 });
    const b = await s.people.createPerson({ name: "B", avatarColorValue: 0, openingBalance: 0 });
    const shares = [
      { personId: null, amount: 3_333.35 },
      { personId: a.id, amount: 3_333.33 },
      { personId: b.id, amount: 3_333.33 },
    ];
    const r = await s.loans.createAgreementWithOrigination({
      idempotencyKey: "odd-paise-01",
      category: "institutional",
      institutionName: "Bank",
      fundingSource: "bank",
      direction: "taken",
      loanAmount: 10_000.01,
      loanDate: LOAN_DATE,
      firstDueDate: FIRST_DUE,
      repaymentType: "installment",
      installmentFrequency: "monthly",
      installmentCount: 3,
      interest: { type: "reducingBalance", ratePercent: 13.7, period: "yearly" },
      movementAccountId: account.id,
      ownershipShares: shares,
    });
    const insts = (await getDocs(s.installmentsRef(r.scheduleId))).docs.map((d) => d.data());
    for (const i of insts) {
      const parts = splitByOwnership(i.amountDue, shares);
      expect(parts.reduce((t, p) => t + Math.round(p.amount * 100), 0)).toBe(Math.round(i.amountDue * 100));
    }
  });
});

// ═══════════════ 20. Cross-screen reconciliation — one story, every screen ═══════════════

/**
 * One realistic sequence over the REAL write paths; after every step each screen's figure is read from
 * the live documents with the engines its hook uses, and all of them must tell the same story.
 * A = AMMA, B = SOJAN; ₹30,000 interest-free, 10 × ₹3,000 (#1 due Feb 10, #2 due Mar 10), ⅓ each.
 * Account starts at ₹5,000.
 */
describe("20 — cross-screen reconciliation (Accounts · Loan · People · Net Worth · Debt Planner · Month Cycle · My Spend)", () => {
  const MAR_10 = new Date(2026, 2, 10);
  const MAR_15 = new Date(2026, 2, 15);

  async function screens(w: World, now: Date) {
    const nw = await netWorth(w, now);
    const planner = (await plannerOwnership(w, now))!;
    const a = await position(w, w.aId, now);
    const b = await position(w, w.bId, now);
    const txs = (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction);
    const loan = await loanNow(w);
    const ctx = mySpendContextFromRecords({ transactions: txs, expenses: [], loans: [loan], emis: [] });
    const mySpend = txs.reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
    const insts = await liveInstallments(w);
    return {
      cash: await cash(w),
      outstanding: await outstanding(w),
      inst1Paid: insts[0].amountPaid,
      inst2Paid: insts[1].amountPaid,
      amma: a.net,
      sojan: b.net,
      toReceive: nw.peopleReceivable,
      toGive: nw.peoplePayable,
      liability: nw.sheet.borrowedPrincipal,
      netWorth: nw.netWorth,
      plannerTotal: planner.outstanding,
      plannerMine: planner.ownership.mine,
      plannerOthers: planner.ownership.others.reduce((s, o) => s + o.amount, 0),
      income: await monthCycleIncome(w),
      mySpend,
    };
  }

  it("create → AMMA pays → SOJAN part-pays → I pay lender → next due → prepay → revert SOJAN → edit → close", async () => {
    const w = await world();
    const base = { income: 0, mySpend: 0, toGive: 0 };

    // 0. Created; #1 (Feb 10) is due by Feb 15 → each owes ₹1,000.
    expect(await screens(w, FEB_15)).toEqual({ ...base, cash: 35_000, outstanding: 30_000, inst1Paid: 0, inst2Paid: 0, amma: 1_000, sojan: 1_000, toReceive: 2_000, liability: 30_000, netWorth: 7_000, plannerTotal: 30_000, plannerMine: 10_000, plannerOthers: 20_000 });

    // 1. AMMA pays her ₹1,000 — People leg only; lender installment untouched.
    await personPays(w, w.aId, 1_000, FEB_12);
    expect(await screens(w, FEB_15)).toEqual({ ...base, cash: 36_000, outstanding: 30_000, inst1Paid: 0, inst2Paid: 0, amma: 0, sojan: 1_000, toReceive: 1_000, liability: 30_000, netWorth: 7_000, plannerTotal: 30_000, plannerMine: 10_000, plannerOthers: 20_000 });

    // 2. SOJAN pays ₹500 of ₹1,000.
    const sojanPart = await personPays(w, w.bId, 500, FEB_12);
    expect(await screens(w, FEB_15)).toEqual({ ...base, cash: 36_500, outstanding: 30_000, inst1Paid: 0, inst2Paid: 0, amma: 0, sojan: 500, toReceive: 500, liability: 30_000, netWorth: 7_000, plannerTotal: 30_000, plannerMine: 10_000, plannerOthers: 20_000 });

    // 3. I pay the lender ₹3,000 — lender leg only; SOJAN still owes ₹500.
    // Default path: refused — SOJAN's ₹500 of #1 is still open. Recorded with the explicit acknowledgement instead.
    await expect(payLender(w, 3_000, FIRST_DUE, "x20-l1")).rejects.toThrow(/₹500 from Person B/);
    expect(await cash(w)).toBe(36_500);
    await payLenderAnyway(w, 3_000, FIRST_DUE, "x20-l1");
    expect(await screens(w, FEB_15)).toEqual({ ...base, cash: 33_500, outstanding: 27_000, inst1Paid: 3_000, inst2Paid: 0, amma: 0, sojan: 500, toReceive: 500, liability: 27_000, netWorth: 7_000, plannerTotal: 27_000, plannerMine: 9_000, plannerOthers: 18_000 });

    // 4. #2 falls due (Mar 10). SOJAN: ₹500 brought forward from #1 + ₹1,000 new for #2 — kept as two rows.
    expect(await screens(w, MAR_15)).toEqual({ ...base, cash: 33_500, outstanding: 27_000, inst1Paid: 3_000, inst2Paid: 0, amma: 1_000, sojan: 1_500, toReceive: 2_500, liability: 27_000, netWorth: 9_000, plannerTotal: 27_000, plannerMine: 9_000, plannerOthers: 18_000 });
    const march = await statement(w, w.bId, MAR_15);
    expect([march.previousPending, march.addedToReceive, march.toReceive]).toEqual([500, 1_000, 1_500]); // Previous pending · Added this cycle · Total
    const allTime = await statement(w, w.bId, MAR_15, { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) });
    const [i1, i2] = await liveInstallments(w);
    const openOf = (id: string) => allTime.rows.find((r) => r.key === `loan-inst:${id}`)!.remainingNow;
    expect([openOf(i1.id), openOf(i2.id)]).toEqual([500, 1_000]); // still attributable to #1 and #2, never one anonymous ₹1,500

    // 5. Pay #2 plus ₹3,000 extra principal. Ownership shrinks proportionally (documented policy); People shares of #2 unchanged.
    await payLenderAnyway(w, 6_000, MAR_10, "x20-l2");
    expect(await screens(w, MAR_15)).toEqual({ ...base, cash: 27_500, outstanding: 21_000, inst1Paid: 3_000, inst2Paid: 3_000, amma: 1_000, sojan: 1_500, toReceive: 2_500, liability: 21_000, netWorth: 9_000, plannerTotal: 21_000, plannerMine: 7_000, plannerOthers: 14_000 });

    // 6. Revert SOJAN's ₹500 — exactly the original obligation returns; cash −₹500; lender side unchanged.
    await w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId))!, sojanPart.paymentId);
    expect(await screens(w, MAR_15)).toEqual({ ...base, cash: 27_000, outstanding: 21_000, inst1Paid: 3_000, inst2Paid: 3_000, amma: 1_000, sojan: 2_000, toReceive: 3_000, liability: 21_000, netWorth: 9_000, plannerTotal: 21_000, plannerMine: 7_000, plannerOthers: 14_000 });

    // 7. Edit a safe field — no financial effect anywhere.
    const before = await screens(w, MAR_15);
    await w.loans.update({ ...(await loanNow(w)), name: "Family loan", notes: "renamed" });
    expect(await screens(w, MAR_15)).toEqual(before);

    // 8. Close with principal left: the liability stays (closing is not repaying), People keep owing paid installments' shares.
    await w.loans.closeLoan(await loanNow(w));
    expect(await screens(w, MAR_15)).toEqual(before);
  }, 30_000);
});

// ═══════════════ Write-layer People settlement gate (repository, not the dialog) ═══════════════

describe("People settlement gate — enforced by LoanAdvancePaymentRepository from current documents", () => {
  const MAR_15 = new Date(2026, 2, 15);
  const JAN_20 = new Date(2026, 0, 20);
  async function loanTxCount(w: World) {
    return (await getDocs(query(w.transactionsRef, where("loanId", "==", w.loanId)))).docs.filter((d) => d.data().deletedAt == null).length;
  }

  it("#1 due, A and B unpaid → refused with the exact amounts; nothing written; a retry is refused again", async () => {
    const w = await world();
    const err = await payLender(w, 3_000, FEB_15, "g1").catch((e) => e);
    expect(err).toBeInstanceOf(PeopleSettlementPendingError);
    expect((err as PeopleSettlementPendingError).gate.outstanding).toBe(2_000);
    expect((err as Error).message).toMatch(/₹1,000 from Person A/);
    await expect(payLender(w, 3_000, FEB_15, "g1")).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect([await cash(w), (await liveInstallments(w))[0].amountPaid, await loanTxCount(w)]).toEqual([35_000, 0, 1]); // origination only
  });

  it("both shares received → the lender payment records once; the same key again is a no-op", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    await personPays(w, w.bId, 1_000, FEB_12);
    const first = await payLender(w, 3_000, FEB_15, "g2");
    const again = await payLender(w, 3_000, FEB_15, "g2"); // double click / network retry
    expect([first.alreadyRecorded, again.alreadyRecorded]).toEqual([false, true]);
    expect([await cash(w), (await liveInstallments(w))[0].amountPaid, await loanTxCount(w)]).toEqual([34_000, 3_000, 2]);
  });

  it("paying #1 before it is due is allowed (shares not owed yet) — and the shares are still owed once it falls due", async () => {
    const w = await world();
    await payLender(w, 3_000, JAN_20, "g3");
    expect((await liveInstallments(w))[0].amountPaid).toBe(3_000);
    expect([(await position(w, w.aId, FEB_15)).net, (await position(w, w.bId, FEB_15)).net]).toEqual([1_000, 1_000]);
  });

  it("only the installments the allocation reaches are gated: #1 shares paid, #2 shares open → ₹3,000 allowed, ₹6,000 refused", async () => {
    const w = await world();
    const key1 = (await liveInstallments(w))[0].id;
    for (const p of [w.aId, w.bId]) {
      const obligations = payableObligations(await rows(w, p, FEB_12)).filter((o) => o.key === `loan-inst:${key1}`);
      const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 1_000 });
      await w.personPayments(p).recordPayment((await w.people.getByKey(p)) as Person, { direction: "theyPaid", amount: 1_000, date: FEB_12, accountId: w.accountId, lines: paymentLines(obligations, alloc.lines), extra: null });
    }
    await expect(payLender(w, 6_000, MAR_15, "g4-both")).rejects.toBeInstanceOf(PeopleSettlementPendingError); // reaches #2
    expect(await cash(w)).toBe(37_000);
    await payLender(w, 3_000, MAR_15, "g4-one"); // reaches #1 only
    expect((await liveInstallments(w)).map((i) => i.amountPaid).slice(0, 2)).toEqual([3_000, 0]);
  });

  it("stale tab: the dialog saw both shares paid, then tab B reverted SOJAN's payment → the repository refuses", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    const b = await personPays(w, w.bId, 1_000, FEB_12);
    const staleLoan = await loanNow(w);
    const staleInstallments = await liveInstallments(w); // what tab A's dialog holds
    await w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId))!, b.paymentId); // tab B
    await expect(
      w.lender.record({ loan: staleLoan, scheduleInstallments: staleInstallments, accountId: w.accountId, amount: 3_000, date: FEB_15, idempotencyKey: "g5" }),
    ).rejects.toThrow(/₹1,000 from Person B/);
    expect([await cash(w), (await liveInstallments(w))[0].amountPaid]).toEqual([36_000, 0]); // A +1,000 kept, B +1,000 reverted, lender untouched
  });

  it("race: SOJAN's revert and the lender payment submitted together → never 'paid while open' from a pre-revert view", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    const b = await personPays(w, w.bId, 1_000, FEB_12);
    const [rev, pay] = await Promise.allSettled([
      w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId))!, b.paymentId),
      payLender(w, 3_000, FEB_15, "g6"),
    ]);
    expect(rev.status).toBe("fulfilled");
    const paid = (await liveInstallments(w))[0].amountPaid;
    // Either the payment committed first (legitimately, B had paid) and the revert followed, or it saw the revert and was refused.
    if (pay.status === "rejected") expect(pay.reason).toBeInstanceOf(PeopleSettlementPendingError);
    expect(paid === 3_000 ? pay.status : "rejected").toBe(paid === 3_000 ? "fulfilled" : "rejected");
    expect(await cash(w)).toBe(paid === 3_000 ? 33_000 : 36_000); // each leg exactly once
    expect((await position(w, w.bId, FEB_15)).net).toBe(1_000); // B's obligation is open again either way
  });

  it("explicit acknowledgement pays the lender; People shares stay open (never netted, never auto-settled)", async () => {
    const w = await world();
    await payLenderAnyway(w, 3_000, FEB_15, "g7");
    expect([await cash(w), (await position(w, w.aId, FEB_15)).net, (await position(w, w.bId, FEB_15)).net]).toEqual([32_000, 1_000, 1_000]);
    // An empty reason is not an acknowledgement.
    await expect(
      w.lender.record({
        loan: await loanNow(w), scheduleInstallments: await liveInstallments(w), accountId: w.accountId, amount: 3_000, date: MAR_15, idempotencyKey: "g7b",
        peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "  " },
      }),
    ).rejects.toBeInstanceOf(PeopleSettlementPendingError);
  });
});

// ═══════════════ §8 Missed share carried forward, then paid oldest-first ═══════════════

describe("§8 — AMMA misses #1, #2 falls due, she pays ₹1,500", () => {
  it("previous pending stays tied to #1; ₹1,500 settles #1 fully and #2 by ₹500; Net Worth only swaps components", async () => {
    const w = await world();
    const MAR_15 = new Date(2026, 2, 15);
    const ALL = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
    const [i1, i2] = await liveInstallments(w);
    const openOf = async (id: string) => (await statement(w, w.aId, MAR_15, ALL)).rows.find((r) => r.key === `loan-inst:${id}`)!.remainingNow;

    const march = await statement(w, w.aId, MAR_15);
    expect([march.previousPending, march.addedToReceive, march.toReceive]).toEqual([1_000, 1_000, 2_000]);
    expect([await openOf(i1.id), await openOf(i2.id)]).toEqual([1_000, 1_000]);
    let nw = await netWorth(w, MAR_15);
    expect([await cash(w), nw.peopleReceivable, nw.peoplePayable, nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([35_000, 4_000, 0, 30_000, 9_000]);

    // Exactly the People workspace: this cycle's rows with the all-time statement as history, then
    // Record Payment's canonical allocation (oldest first).
    const cyc = await statement(w, w.aId, MAR_15);
    const hist = await statement(w, w.aId, MAR_15, { start: ALL.start, end: cycleOf(MAR_15).end }); // as `allTimeStatement`
    void cyc; // the cycle view shows previous pending; Record Payment reads the all-time rows (`allRows`)
    const ledger = buildLedgerRows({ statement: hist, entries: await ledgerEntries(w, w.aId), pending: [], now: MAR_15, advanceApplications: await applications(w, w.aId) });
    const obligations = payableObligations(ledger).filter((o) => o.side === "theyOwe");
    expect(obligations.map((o) => o.key)).toEqual([`loan-inst:${i1.id}`, `loan-inst:${i2.id}`]); // #1 still payable in March
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 1_500 });
    await w.personPayments(w.aId).recordPayment((await w.people.getByKey(w.aId)) as Person, { direction: "theyPaid", amount: 1_500, date: MAR_15, accountId: w.accountId, lines: paymentLines(obligations, alloc.lines), extra: null });
    expect([await openOf(i1.id), await openOf(i2.id)]).toEqual([0, 500]);
    expect((await position(w, w.aId, MAR_15)).net).toBe(500);
    nw = await netWorth(w, MAR_15);
    expect([await cash(w), nw.peopleReceivable, nw.peoplePayable, nw.netWorth]).toEqual([36_500, 2_500, 0, 9_000]); // cash +1,500, receivable −1,500
    expect(await monthCycleIncome(w)).toBe(0);
  }, 30_000);
});
