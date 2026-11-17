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
import { collection, deleteDoc, deleteField, doc, getDocs, query, updateDoc, where, type Firestore } from "firebase/firestore";
import { permanentlyDeleteAgreement } from "@/lib/repositories/agreement-deletion";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { splitByOwnership, resolveOwnership } from "@/lib/engines/debt-ownership";
import { loanDebtPosition, requiredByOwnership, type LoanDebtInput } from "@/lib/engines/debt-position";
import { loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { emiReceivableThrough, personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { personLinkedEmis } from "@/lib/engines/person-linked-emis";
import { deferralView } from "@/lib/engines/person-payment-deferral";
import { LinkEarlierPaymentError, LinkedPaymentEditError } from "@/lib/engines/link-earlier-payment";
import { OwnedTransactionDeleteError, OwnedTransactionEditError } from "@/lib/repositories/transaction-repository";
import { paymentDeferralFromData } from "@/lib/models/person-payment-deferral";
import { allocatePayment, advanceRemaining, planAdvanceApplication } from "@/lib/engines/person-payment";
import { buildPersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { breakdownEntryOf, peopleNetWorthPosition, personDirectGross, personPosition, type PersonPosition } from "@/lib/engines/person-position";
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
import { balanceEffect, isLoanPrincipalDisbursement, transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository, type LoanAdvancePaymentResult } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository, OriginationDeleteBlockedError } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, StalePersonPaymentError, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { installmentBreakdown, lenderFirstReason } from "@/lib/engines/installment-participants";
import { cycleContaining, shiftCycle } from "@/lib/engines/person-cycle-statement";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { RECORDED_EARLIER_PEOPLE_ACK, RecordedEarlierError } from "@/lib/engines/recorded-earlier";
import { countsFromSchedule } from "@/lib/engines/loan-cash-flow";
import { historicalCandidates, planBulkRecordedEarlier, runBulkRecordedEarlier, type BulkItem } from "@/lib/engines/bulk-recorded-earlier";

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
    await Promise.all(
      [w.aId, w.bId].map(async (id) => ({
        position: await position(w, id, now),
        entries: (await ledgerEntries(w, id)).map(breakdownEntryOf),
        advanceApplications: await applications(w, id),
      })),
    ),
    new Set([loan.id]),
  );
  return {
    netWorth: netWorthWithLoans(accounts.reduce((s, a) => s + a.currentBalance, 0), sheet, people.balance),
    sheet,
    peoplePayable: people.payable,
    peopleReceivable: people.receivable,
    peopleAdvanceHeld: people.advanceHeld,
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

    // Net Worth / Dashboard components at each step: A's receivable shrinks, nothing becomes payable, B's
    // ₹900 stays, Net Worth never moves (cash +x, receivable −x).
    const components = async () => {
      const nw = await netWorth(w, FEB_15);
      return [nw.peopleReceivable, nw.peoplePayable, nw.peopleAdvanceHeld, nw.netWorth];
    };
    const nw0 = (await netWorth(w, FEB_15)).netWorth;
    expect(await components()).toEqual([1_800, 0, 0, nw0]);
    const p1 = await personPays(w, w.aId, 500, FEB_12);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([400, base + 500]);
    expect(await components()).toEqual([1_300, 0, 0, nw0]); // A ₹400 + B ₹900 — never ₹400 receivable + ₹500 payable
    await personPays(w, w.aId, 200, FEB_12);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([200, base + 700]);
    expect(await components()).toEqual([1_100, 0, 0, nw0]);
    await personPays(w, w.aId, 200, FEB_12);
    expect([(await shareOf()).remaining, (await shareOf()).state, await cash(w)]).toEqual([0, "settled", base + 900]);
    expect(await components()).toEqual([900, 0, 0, nw0]);
    expect((await position(w, w.aId, FEB_15)).iOwe).toBe(0);

    expect(await monthCycleIncome(w)).toBe(0);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // lender installment not paid
    expect((await shareRow(w, w.bId, 1, FEB_15))!.remaining).toBe(900); // B unchanged
    const st = await statement(w, w.aId, FEB_15);
    expect(st.currentPending).toBe(0);

    // Reversible: undo the first ₹500 → ₹500 owed again, cash back.
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, p1.paymentId);
    expect([(await shareOf()).remaining, await cash(w)]).toEqual([500, base + 400]);
    expect(await components()).toEqual([1_400, 0, 0, nw0]);
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
    // The ₹300 is held for A: not a payable (no "You owe A"), not income, not a receivable.
    let nw = await netWorth(w, FEB_15);
    expect([nw.peopleReceivable, nw.peoplePayable, nw.peopleAdvanceHeld]).toEqual([900, 0, 300]); // B's ₹900 only

    // March: installment #2 share ₹900 due. The advance is NOT consumed on its own…
    const MAR_15 = new Date(2026, 2, 15);
    expect((await statement(w, w.aId, MAR_15)).currentPending).toBe(900);
    nw = await netWorth(w, MAR_15);
    expect([nw.peopleReceivable, nw.peoplePayable, nw.peopleAdvanceHeld]).toEqual([900 + 1_800, 0, 300]); // A ₹900 + B ₹1,800
    const nwBeforeApply = nw.netWorth;
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
    nw = await netWorth(w, MAR_15);
    expect([nw.peopleReceivable, nw.peoplePayable, nw.peopleAdvanceHeld, nw.netWorth]).toEqual([600 + 1_800, 0, 0, nwBeforeApply]); // applying moves no wealth
    expect(await cash(w)).toBe(base + 1_200); // applying moves no money
    expect((await liveInstallments(w))[1].amountPaid).toBe(0); // lender untouched
  });
});

// ═══════════════ F2. Card attribution vs loan-share reimbursement ═══════════════

describe("F2 — a loan-share reimbursement never shrinks the person's unrelated receivables", () => {
  it("A owes ₹8,000 directly (e.g. card purchases) and reimburses their ₹1,000 loan share → ₹8,000 still attributable, no payable", async () => {
    const w = await world();
    await w.ledgerFor(w.aId).addEntry((await w.people.getByKey(w.aId))!, { type: "gave", amount: 8_000, date: FEB_12, sourceKind: "assignedExpense", transactionRef: "card-purchase" });
    await personPays(w, w.aId, 1_000, FEB_12); // oldest first: the share (due Feb 10) before the ₹8,000 (Feb 12)
    const entries = (await ledgerEntries(w, w.aId)).map(breakdownEntryOf);
    const pos = await position(w, w.aId, FEB_15);
    const gross = personDirectGross(pos, entries, new Set([w.loanId]), await applications(w, w.aId)); // = use-debt-planner-data
    // Whatever Record Payment's oldest-first allocation settled, A's total open is ₹8,000 and nothing is payable.
    expect(gross.receivable + gross.emiReceivableOpen).toBe(8_000);
    expect(gross.payable).toBe(0);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // not a lender payment
    expect(await monthCycleIncome(w)).toBe(0); // not income
  });

  it("reimbursing ONLY the loan share leaves the ₹8,000 card attribution intact", async () => {
    const w = await world();
    await w.ledgerFor(w.aId).addEntry((await w.people.getByKey(w.aId))!, { type: "gave", amount: 8_000, date: FEB_12, sourceKind: "assignedExpense", transactionRef: "card-purchase" });
    const obligations = payableObligations(await rows(w, w.aId, FEB_12)).filter((o) => o.side === "theyOwe" && o.key.startsWith("loan-inst:"));
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 1_000 });
    await w.personPayments(w.aId).recordPayment((await w.people.getByKey(w.aId)) as Person, {
      direction: "theyPaid",
      amount: 1_000,
      date: FEB_12,
      accountId: w.accountId,
      lines: paymentLines(obligations, alloc.lines),
      extra: null,
    });
    const gross = personDirectGross(await position(w, w.aId, FEB_15), (await ledgerEntries(w, w.aId)).map(breakdownEntryOf), new Set([w.loanId]));
    expect(gross).toEqual({ receivable: 8_000, payable: 0, emiReceivableOpen: 0, advanceHeld: 0, advancePaid: 0 });
    const nw = await netWorth(w, FEB_15);
    expect([nw.peopleReceivable, nw.peoplePayable]).toEqual([8_000 + 1_000, 0]); // A's ₹8,000 + B's share
    expect(await cash(w)).toBe(36_000); // the ₹1,000 moved once
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

// ═══════════════════════════ Lender-first payment + carried, postponed shares ═══════════════════════════

describe("lender-first: owner pays the installment, A reimbursed, B postponed and carried", () => {
  const ALL = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
  const MAR_12 = new Date(2026, 2, 12);
  async function breakdownAt(w: World, seq: number, now: Date) {
    const insts = await liveInstallments(w);
    const statements = await Promise.all([w.aId, w.bId].map((id) => statement(w, id, now, ALL)));
    return installmentBreakdown({ statements, installments: insts, installmentId: insts.find((i) => i.sequenceNumber === seq)!.id, sourceKind: "loan", source: await loanNow(w) })!;
  }

  it("one lender outflow, People untouched, deferral only moves timing, Loan/EMI and People agree", async () => {
    const w = await world();
    expect(await cash(w)).toBe(35_000);
    await personPays(w, w.aId, 1_000, FEB_12); // A reimburses #1 before the lender is paid
    expect(await cash(w)).toBe(36_000);

    // The dialog's lender-first path: B is still open, so the payment carries the explicit acknowledgement.
    const ack = { acknowledgedUnsettledPeople: true as const, reason: lenderFirstReason([{ personName: "Person B", remaining: 1_000 }]) };
    const args = async () => ({ loan: await loanNow(w), scheduleInstallments: await liveInstallments(w) });
    const first = await w.lender.record({ ...(await args()), accountId: w.accountId, amount: 3_000, date: FEB_15, idempotencyKey: "lender-first-1", peopleGateAcknowledgement: ack });
    // Retry / double submit with the same key never moves cash twice.
    await w.lender.record({ ...(await args()), accountId: w.accountId, amount: 3_000, date: FEB_15, idempotencyKey: "lender-first-1", peopleGateAcknowledgement: ack });
    expect(await cash(w)).toBe(33_000); // −₹3,000 once
    expect(first.transactionId).toBeTruthy();
    const lenderTxs = (await getDocs(w.transactionsRef)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null && t.type === "expense");
    expect(lenderTxs).toHaveLength(1);

    const feb = await breakdownAt(w, 1, FEB_15);
    expect(feb).toMatchObject({ installmentAmount: 3_000, lenderPaid: 3_000, lenderRemaining: 0, yourShare: 1_000, othersOwe: 1_000 });
    const byId = (b: typeof feb, id: string) => b.participants.find((p) => p.personId === id)!;
    expect(byId(feb, w.aId).current).toMatchObject({ received: 1_000, state: "received" });
    expect(byId(feb, w.bId).current).toMatchObject({ remaining: 1_000, state: "pending" }); // lender payment settled nobody

    // Postpone B's #1 reimbursement to the March cycle: only timing metadata changes.
    const inst1 = (await liveInstallments(w))[0];
    const before = JSON.stringify([await liveInstallments(w), await ledgerEntries(w, w.bId), await cash(w)]);
    const target = shiftCycle(cycleContaining(FEB_15, 1), 1, 1);
    await new PaymentDeferralRepository(w.db, UID).apply({
      action: "postpone", requestId: "b-1", expectedRevision: 0, personId: w.bId, obligationKey: `loan-inst:${inst1.id}`, obligationTitle: "Shared loan",
      now: FEB_15, startDay: 1, obligationDate: inst1.dueDate, remaining: 1_000, target, reason: "unableNow", note: null, reminder: null,
    });
    expect(JSON.stringify([await liveInstallments(w), await ledgerEntries(w, w.bId), await cash(w)])).toBe(before);
    expect((await liveInstallments(w))[0].dueDate).toEqual(FIRST_DUE); // the lender's due date never moves

    // March: #2 adds a separate share; B owes #1 + #2 = ₹2,000, identical to the People Ledger's open rows.
    const mar = await breakdownAt(w, 2, MAR_12);
    expect(byId(mar, w.bId)).toMatchObject({ outstanding: 2_000, carried: [{ sequenceNumber: 1, remaining: 1_000 }], current: { remaining: 1_000 } });
    // Record payment reads the whole-history rows (the March cycle view shows #1 as previous pending).
    const allB = await statement(w, w.bId, MAR_12, ALL);
    const bRows = buildLedgerRows({ statement: allB, history: allB, entries: await ledgerEntries(w, w.bId), pending: [], now: MAR_12, advanceApplications: await applications(w, w.bId) });
    const peopleOpen = payableObligations(bRows).filter((o) => o.key.startsWith("loan-inst:") && o.date <= MAR_12);
    expect(peopleOpen.reduce((t, o) => t + o.outstanding, 0)).toBe(2_000);
    expect(peopleOpen).toHaveLength(2);

    // Without the acknowledgement the write gate still refuses a lender payment over open shares.
    await expect(payLender(w, 3_000, MAR_12, "no-ack")).rejects.toBeInstanceOf(PeopleSettlementPendingError);
  }, 30_000);
});

// ═══════════════ Own-money lender payment and "Already paid earlier" (2026-10-13) ═══════════════

/** Every payment doc on the schedule (live and soft-deleted). */
async function paymentDocs(w: World) {
  const all = await allInstallments(w);
  return (await Promise.all(all.map((i) => getDocs(w.paymentsRef(w.scheduleId, i.id))))).flatMap((s) => s.docs.map((d) => d.data()));
}
async function loanTransactions(w: World) {
  return (await getDocs(query(w.transactionsRef, where("loanId", "==", w.loanId)))).docs.map((d) => d.data() as Transaction);
}
/**
 * Cash Flow's loan money-out: counted Transactions (live, not excluded, not a principal disbursement) plus
 * schedule-only payments (`countsFromSchedule`, the legacy path) — what `useTransactions` / Month Cycle add up.
 */
async function loanCashOut(w: World): Promise<number> {
  const txs = (await loanTransactions(w)).filter((t) => t.deletedAt == null && !t.excludeFromCalculations && !isLoanPrincipalDisbursement(t) && t.type === "expense");
  const scheduleOnly = (await paymentDocs(w)).filter(countsFromSchedule);
  return txs.reduce((s, t) => s + t.amount, 0) + scheduleOnly.reduce((s, p) => s + p.amount, 0);
}
async function seqPaid(w: World, seq: number) {
  return (await liveInstallments(w)).find((i) => i.sequenceNumber === seq)!.amountPaid;
}
/** What the dialog sends for "Already paid earlier": installments only, pinned to the first one it showed. */
async function payEarlier(w: World, amount: number, date: Date, key: string, opts: { dateKnown?: boolean; expected?: string | null; accountId?: string } = {}) {
  const insts = await liveInstallments(w);
  return w.lender.record({
    loan: await loanNow(w),
    scheduleInstallments: insts,
    accountId: opts.accountId ?? w.accountId,
    amount,
    date,
    idempotencyKey: key,
    includeUpcomingInstallments: true,
    peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    recordedEarlier: { dateKnown: opts.dateKnown ?? true },
    expectedFirstInstallmentId: opts.expected === undefined ? insts.find((i) => i.amountPaid < i.amountDue)!.id : opts.expected,
  });
}

describe("Scenario A — ₹9,000 installment: AMMA reimbursed, Sanju unpaid, owner pays the lender from own money", () => {
  it("SBI −₹9,000 once; Sanju still owes ₹3,000; AMMA stays settled; installment paid; nothing else created", async () => {
    const w = await world({ loanAmount: 90_000 }); // 10 × ₹9,000; Me / A (AMMA) / B (Sanju) ⅓ each = ₹3,000 per installment
    expect(await cash(w)).toBe(95_000);
    await personPays(w, w.aId, 3_000, FEB_12); // AMMA reimburses her share of #1
    expect(await cash(w)).toBe(98_000);
    const ledgerBefore = [(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length];

    // Default path: the write gate still refuses while Sanju's share is open — nothing moves.
    await expect(payLender(w, 9_000, FEB_15, "a-no-ack")).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect(await cash(w)).toBe(98_000);

    // "Pay using my own money": the explicit acknowledgement; the reason/note go in the payment note.
    const ack = { acknowledgedUnsettledPeople: true as const, reason: `${lenderFirstReason([{ personName: "Person B", remaining: 3_000 }])} — Payment delayed` };
    const pay = async () =>
      w.lender.record({
        loan: await loanNow(w), scheduleInstallments: await liveInstallments(w), accountId: w.accountId, amount: 9_000, date: FEB_15,
        idempotencyKey: "a-own-money", note: "Paid from my own money — Payment delayed", peopleGateAcknowledgement: ack,
      });
    const first = await pay();
    const retry = await pay(); // double submit / retry after a lost response
    expect(retry.alreadyRecorded).toBe(true);

    expect(await cash(w)).toBe(89_000); // −₹9,000 exactly once
    expect(await seqPaid(w, 1)).toBe(9_000);
    expect((await position(w, w.bId, FEB_15)).net).toBe(3_000); // Sanju still owes
    expect((await position(w, w.aId, FEB_15)).net).toBe(0); // AMMA settled
    expect([(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length]).toEqual(ledgerBefore); // no receivable / settlement written
    const lenderTxs = (await loanTransactions(w)).filter((t) => t.deletedAt == null && !isLoanPrincipalDisbursement(t));
    expect(lenderTxs).toHaveLength(1);
    expect(lenderTxs[0]).toMatchObject({ id: first.transactionId, amount: 9_000, type: "expense", excludeFromCalculations: false });
    expect((await paymentDocs(w)).find((p) => p.id === first.paymentIds[0])).toMatchObject({ note: "Paid from my own money — Payment delayed", recordedEarlier: null });
    expect(await monthCycleIncome(w)).toBe(0); // AMMA's reimbursement is not income
  }, 30_000);
});

describe("Scenario B — Already paid earlier (no account movement)", () => {
  it("installment paid, balance untouched, no counted cash movement, People shares untouched; retries never duplicate", async () => {
    const w = await world();
    const nwBefore = (await netWorth(w, FEB_15)).netWorth;
    const r = await payEarlier(w, 3_000, FIRST_DUE, "hist-1");

    expect(await cash(w)).toBe(35_000); // unchanged
    expect(await seqPaid(w, 1)).toBe(3_000);
    expect(await outstanding(w)).toBe(27_000);
    const txn = (await loanTransactions(w)).find((t) => t.id === r.transactionId)!;
    expect(txn).toMatchObject({ excludeFromCalculations: true, amount: 3_000, deletedAt: null });
    expect(txn.description).toMatch(/already paid earlier/);
    expect(balanceEffect(txn)).toBe(0);
    const doc1 = (await paymentDocs(w)).find((p) => p.id === r.paymentIds[0])!;
    expect(doc1).toMatchObject({ recordedEarlier: { dateKnown: true }, transactionId: r.transactionId, date: FIRST_DUE });
    expect(countsFromSchedule(doc1)).toBe(false);
    expect(await loanCashOut(w)).toBe(0); // Cash Flow / Month Cycle / Dashboard see no money out
    // Net Worth: the liability falls by ₹3,000 while cash stays — the correction the user asked for.
    expect((await netWorth(w, FEB_15)).netWorth).toBe(nwBefore + 3_000);
    // People: the lender payment settled nobody.
    expect([(await position(w, w.aId, FEB_15)).net, (await position(w, w.bId, FEB_15)).net]).toEqual([1_000, 1_000]);
    expect([(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length]).toEqual([0, 0]);

    // Retry of the same action: nothing twice.
    expect((await payEarlier(w, 3_000, FIRST_DUE, "hist-1", { expected: doc1.installmentId })).alreadyRecorded).toBe(true);
    // A second action (new key, stale screen) for the same installment: refused, never spilled onto #2.
    await expect(payEarlier(w, 3_000, FIRST_DUE, "hist-1-dup", { expected: doc1.installmentId })).rejects.toBeInstanceOf(RecordedEarlierError);
    expect([await seqPaid(w, 1), await seqPaid(w, 2), await cash(w)]).toEqual([3_000, 0, 35_000]);

    // A later normal payment still moves the account exactly once.
    await payLenderAnyway(w, 3_000, new Date(2026, 2, 12), "after-hist");
    expect(await cash(w)).toBe(32_000);
    expect(await loanCashOut(w)).toBe(3_000);
  }, 30_000);

  it("partial, unknown date → edit (amount, date, account) → mark unpaid: no balance moves at any step", async () => {
    const w = await world();
    const icici = await w.accounts.createAccount({ name: "ICICI", type: "bank", openingBalance: 1_000, colorValue: 0 });
    const i1 = (await liveInstallments(w))[0];
    const r = await payEarlier(w, 1_500, i1.dueDate, "hist-p", { dateKnown: false });
    expect([await cash(w), await seqPaid(w, 1)]).toEqual([35_000, 1_500]);
    expect((await paymentDocs(w)).find((p) => p.id === r.paymentIds[0])).toMatchObject({ recordedEarlier: { dateKnown: false }, date: i1.dueDate });

    // Correct it: full amount, the real date, a different account — the edit keeps it "paid earlier".
    const FEB_8 = new Date(2026, 1, 8);
    await w.lender.editPayment({
      loan: await loanNow(w), scheduleInstallments: await liveInstallments(w),
      original: { transactionId: r.transactionId, paymentIds: r.paymentIds, installmentIds: r.installmentIds },
      accountId: icici.id, amount: 3_000, date: FEB_8, idempotencyKey: "hist-p-edit", peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
    });
    expect([await cash(w), (await w.accounts.getByKey(icici.id))!.currentBalance, await seqPaid(w, 1)]).toEqual([35_000, 1_000, 3_000]);
    const txs = await loanTransactions(w);
    expect(txs.find((t) => t.id === r.transactionId)!.deletedAt).not.toBeNull();
    const corrected = txs.find((t) => t.id === "adv_hist-p-edit_txn")!;
    expect(corrected).toMatchObject({ excludeFromCalculations: true, accountId: icici.id, deletedAt: null });
    const live = (await paymentDocs(w)).filter((p) => p.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ amount: 3_000, date: FEB_8, recordedEarlier: { dateKnown: true } }); // the real date is now known
    expect(await loanCashOut(w)).toBe(0);

    // Mark as unpaid: the installment is owed again; no account gets money that FlowFi never took.
    await w.lender.reversePayment({
      loan: await loanNow(w), transactionId: corrected.id, paymentIds: [live[0].id], installmentIds: [live[0].installmentId], reversalIdempotencyKey: "hist-p-undo",
    });
    expect([await cash(w), (await w.accounts.getByKey(icici.id))!.currentBalance, await seqPaid(w, 1)]).toEqual([35_000, 1_000, 0]);
    expect((await loanTransactions(w)).find((t) => t.id === corrected.id)!.deletedAt).not.toBeNull();

    // The installment can then be paid normally — one real outflow.
    await payLenderAnyway(w, 3_000, FEB_15, "after-undo");
    expect([await cash(w), await seqPaid(w, 1)]).toEqual([32_000, 3_000]);
  }, 30_000);

  it("guards: future date, extra principal, and an edit into extra principal are refused with nothing written", async () => {
    const w = await world();
    const txCount = async () => (await loanTransactions(w)).length;
    const before = await txCount();
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    await expect(payEarlier(w, 3_000, tomorrow, "hist-future")).rejects.toBeInstanceOf(RecordedEarlierError);
    await expect(payEarlier(w, 40_000, FIRST_DUE, "hist-extra")).rejects.toBeInstanceOf(RecordedEarlierError); // > ₹30,000 owed
    expect([await txCount(), await cash(w), await seqPaid(w, 1)]).toEqual([before, 35_000, 0]);

    const r = await payEarlier(w, 3_000, FIRST_DUE, "hist-g");
    await expect(
      w.lender.editPayment({
        loan: await loanNow(w), scheduleInstallments: await liveInstallments(w),
        original: { transactionId: r.transactionId, paymentIds: r.paymentIds, installmentIds: r.installmentIds },
        accountId: w.accountId, amount: 45_000, date: FIRST_DUE, idempotencyKey: "hist-g-edit", peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      }),
    ).rejects.toBeInstanceOf(RecordedEarlierError);
    // The original is intact — the refusal came before anything was reversed.
    expect((await loanTransactions(w)).find((t) => t.id === r.transactionId)!.deletedAt).toBeNull();
    expect([await cash(w), await seqPaid(w, 1)]).toEqual([35_000, 3_000]);
  }, 30_000);

  it("two tabs record the same past installment at once → exactly one lands; nothing spills onto #2", async () => {
    const w = await world();
    const i1 = (await liveInstallments(w))[0];
    const results = await Promise.allSettled([
      payEarlier(w, 3_000, FIRST_DUE, "tab-1", { expected: i1.id }),
      payEarlier(w, 3_000, FIRST_DUE, "tab-2", { expected: i1.id }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RecordedEarlierError);
    expect([await seqPaid(w, 1), await seqPaid(w, 2), await cash(w)]).toEqual([3_000, 0, 35_000]);
    expect((await paymentDocs(w)).filter((p) => p.deletedAt == null)).toHaveLength(1);
  }, 30_000);
});

describe("Bulk — several old installments marked as already paid (shared loan)", () => {
  const TODAY = new Date(2026, 9, 13); // #1–#9 (Feb 10 … Oct 10) are due; #10 isn't
  const recordVia = (w: World, results: Map<string, LoanAdvancePaymentResult>) => async (item: BulkItem) => {
    const r = await w.lender.record({
      loan: await loanNow(w),
      scheduleInstallments: await liveInstallments(w),
      accountId: w.accountId,
      amount: item.amount,
      date: item.date,
      idempotencyKey: item.idempotencyKey,
      includeUpcomingInstallments: true,
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      recordedEarlier: { dateKnown: item.dateKnown },
      onlyInstallmentId: item.installment.id,
    });
    results.set(item.installment.id, r);
    return r;
  };

  it("non-consecutive picks, partial + already-recorded rows, a failure and its retry: no money moves, nothing twice, People untouched", async () => {
    const w = await world();
    const cashBefore = await cash(w);
    const owedBefore = await outstanding(w);
    const peopleBefore = [(await position(w, w.aId, TODAY)).net, (await position(w, w.bId, TODAY)).net];
    const insts = await liveInstallments(w);
    const bySeq = (n: number) => insts.find((i) => i.sequenceNumber === n)!;
    const done = new Map<string, LoanAdvancePaymentResult>();

    // Before: #4 was already marked paid earlier, and #2 part-paid (₹1,000) the same way.
    const pre = recordVia(w, done);
    const mk = (seq: number, amount: number, key: string): BulkItem => ({ installment: bySeq(seq), amount, date: bySeq(seq).dueDate, dateKnown: false, idempotencyKey: key });
    await pre(mk(4, 3_000, "pre-4"));
    await pre(mk(2, 1_000, "pre-2"));

    const candidates = historicalCandidates(await liveInstallments(w), await paymentDocs(w), TODAY);
    expect(candidates.map((c) => c.installment.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const c = (seq: number) => candidates.find((x) => x.installment.sequenceNumber === seq)!;
    expect([c(4).status, c(4).importedEarlier, c(4).eligible]).toEqual(["paid", true, false]);
    expect([c(2).status, c(2).remaining, c(2).importedEarlier]).toEqual(["partial", 2_000, true]);

    // Jan–Sep style pick: everything due except the already-recorded #4 → 8 installments.
    const picks = candidates.filter((x) => x.eligible).map((x) => ({ installmentId: x.installment.id, amount: "", date: "" }));
    picks.find((p) => p.installmentId === bySeq(5).id)!.amount = "2500"; // a short payment
    picks.find((p) => p.installmentId === bySeq(6).id)!.date = "2026-07-12"; // a known date
    const plan = planBulkRecordedEarlier({ candidates, draft: picks, batchId: "b1", today: TODAY });
    if (!plan.ok) throw new Error(JSON.stringify(plan.errors));
    expect([plan.items.length, plan.total]).toEqual([8, 3_000 * 6 + 2_000 + 2_500]);

    // #7 fails once (network); everything else commits.
    const record = recordVia(w, done);
    let failOnce = true;
    const flaky = async (item: BulkItem) => {
      if (item.installment.sequenceNumber === 7 && failOnce) {
        failOnce = false;
        throw new Error("network");
      }
      return record(item);
    };
    const first = await runBulkRecordedEarlier(plan.items, flaky);
    expect(Object.values(first).filter((r) => r.status === "failed")).toHaveLength(1);
    expect(await seqPaid(w, 7)).toBe(0);

    // Retry: only #7 is written; a full re-run of the batch is a no-op for what already committed.
    const second = await runBulkRecordedEarlier(plan.items, record, { previous: first });
    expect(second[bySeq(7).id]).toEqual({ status: "recorded" });
    const rerun = await runBulkRecordedEarlier(plan.items, record);
    expect(Object.values(rerun).every((r) => r.status === "alreadyRecorded")).toBe(true);

    const paid = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => seqPaid(w, n)));
    expect(paid).toEqual([3_000, 3_000, 3_000, 3_000, 2_500, 3_000, 3_000, 3_000, 3_000, 0]);
    expect(await cash(w)).toBe(cashBefore); // today's balance untouched
    expect(await loanCashOut(w)).toBe(0);
    expect(owedBefore - (await outstanding(w))).toBeCloseTo(3_000 * 8 + 2_500, 2);
    const docs = (await paymentDocs(w)).filter((p) => p.deletedAt == null);
    expect(docs).toHaveLength(10); // 2 earlier + 8 bulk, one each
    expect(docs.find((p) => p.installmentId === bySeq(6).id)).toMatchObject({ recordedEarlier: { dateKnown: true }, date: new Date(2026, 6, 12, 12) });
    expect(docs.find((p) => p.installmentId === bySeq(8).id)).toMatchObject({ recordedEarlier: { dateKnown: false }, date: bySeq(8).dueDate });
    // People: the lender payments settled nobody.
    expect([(await position(w, w.aId, TODAY)).net, (await position(w, w.bId, TODAY)).net]).toEqual(peopleBefore);
    expect([(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length]).toEqual([0, 0]);

    // A new batch can't record a paid installment again, and an amount above what's left never spills over.
    await expect(record(mk(1, 3_000, "b2-1"))).rejects.toBeInstanceOf(RecordedEarlierError);
    await expect(record(mk(5, 1_000, "b2-5"))).rejects.toBeInstanceOf(RecordedEarlierError);
    expect([await seqPaid(w, 5), await seqPaid(w, 6), await seqPaid(w, 10)]).toEqual([2_500, 3_000, 0]);

    // Mark the latest one (#7, the retry) unpaid again — the existing latest-first reversal rule applies
    // unchanged: owed again, and no account receives money FlowFi never took.
    await revertLender(w, done.get(bySeq(7).id)!, "undo-7");
    expect([await seqPaid(w, 7), await seqPaid(w, 6), await cash(w)]).toEqual([0, 3_000, cashBefore]);
  }, 60_000);
});

describe("Bulk — several overdue installments paid from my account (shared loan)", () => {
  const TODAY = new Date(2026, 9, 13);
  const OWN_MONEY_ACK = { acknowledgedUnsettledPeople: true as const, reason: "Bulk payment from my account — people's shares stay owed" };
  const payOne = (w: World, seq: number, amount: number, key: string, opts: { ack?: boolean } = {}) => async () =>
    w.lender.record({
      loan: await loanNow(w),
      scheduleInstallments: await liveInstallments(w),
      accountId: w.accountId,
      amount,
      date: TODAY,
      idempotencyKey: key,
      includeUpcomingInstallments: true,
      peopleGateAcknowledgement: opts.ack === false ? null : OWN_MONEY_ACK,
      onlyInstallmentId: (await liveInstallments(w)).find((i) => i.sequenceNumber === seq)!.id,
    });

  it("SHAN-style: a receipt first, then non-consecutive lender payments — account debited once per installment, People untouched, reversible", async () => {
    const w = await world();
    const startCash = await cash(w); // ₹35,000
    // AMMA reimburses her ₹1,000 share of #1 as NEW money: the account is credited exactly once.
    await personPays(w, w.aId, 1_000, FEB_12);
    expect(await cash(w)).toBe(startCash + 1_000);
    const peopleBefore = [(await position(w, w.aId, TODAY)).net, (await position(w, w.bId, TODAY)).net];
    const ledgerBefore = [(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length];

    // Without the explicit own-money acknowledgement the write gate still refuses — nothing moves.
    await expect(payOne(w, 1, 3_000, "ac-noack", { ack: false })()).rejects.toBeInstanceOf(PeopleSettlementPendingError);
    expect(await cash(w)).toBe(startCash + 1_000);

    // Pick #1, #2 and #4 (not #3): three single-installment writes, ₹9,000 in all.
    // The dialog's preview (balance − planned total) is computed from this same plan.
    const cands = historicalCandidates(await liveInstallments(w), await paymentDocs(w), TODAY);
    const seqId = (n: number) => cands.find((c) => c.installment.sequenceNumber === n)!.installment.id;
    const preview = planBulkRecordedEarlier({ candidates: cands, draft: [1, 2, 4].map((n) => ({ installmentId: seqId(n), amount: "", date: "2026-10-13" })), batchId: "prev", today: TODAY });
    if (!preview.ok) throw new Error(JSON.stringify(preview.errors));
    const balanceBeforeBulk = await cash(w);
    const results = [await payOne(w, 1, 3_000, "ac-1")(), await payOne(w, 2, 3_000, "ac-2")(), await payOne(w, 4, 3_000, "ac-4")()];
    expect(await cash(w)).toBe(balanceBeforeBulk - preview.total); // preview == actual recorded balance change
    expect(await cash(w)).toBe(startCash + 1_000 - 9_000);
    expect(await Promise.all([1, 2, 3, 4].map((n) => seqPaid(w, n)))).toEqual([3_000, 3_000, 0, 3_000]); // #3 never touched
    const txs = (await loanTransactions(w)).filter((t) => t.deletedAt == null && !isLoanPrincipalDisbursement(t));
    expect(txs).toHaveLength(3);
    expect(txs.every((t) => t.type === "expense" && t.excludeFromCalculations === false && t.amount === 3_000)).toBe(true);
    expect(await loanCashOut(w)).toBe(9_000);

    // Paying the lender never settles anyone: People positions and ledger are exactly as before.
    expect([(await position(w, w.aId, TODAY)).net, (await position(w, w.bId, TODAY)).net]).toEqual(peopleBefore);
    expect([(await ledgerEntries(w, w.aId)).length, (await ledgerEntries(w, w.bId)).length]).toEqual(ledgerBefore);

    // Duplicate submission of the whole batch: nothing twice.
    const again = [await payOne(w, 1, 3_000, "ac-1")(), await payOne(w, 2, 3_000, "ac-2")(), await payOne(w, 4, 3_000, "ac-4")()];
    expect(again.every((r) => r.alreadyRecorded)).toBe(true);
    expect(await cash(w)).toBe(startCash + 1_000 - 9_000);

    // Reverse the latest one: its debit comes back, the others stand, People is still untouched.
    await revertLender(w, results[2], "ac-undo-4");
    expect([await seqPaid(w, 4), await seqPaid(w, 2), await cash(w)]).toEqual([0, 3_000, startCash + 1_000 - 6_000]);
    expect([(await position(w, w.aId, TODAY)).net, (await position(w, w.bId, TODAY)).net]).toEqual(peopleBefore);
  }, 60_000);

  it("interrupted batch: the failed item is retried alone; a stale or part-paid-elsewhere installment writes nothing", async () => {
    const w = await world();
    const startCash = await cash(w);
    await payOne(w, 1, 3_000, "ac-s1")();
    expect(await cash(w)).toBe(startCash - 3_000);

    // #1 was paid elsewhere meanwhile → a new-key write for it is refused, no debit.
    await expect(payOne(w, 1, 3_000, "ac-s1-dup")()).rejects.toBeInstanceOf(RecordedEarlierError);
    // #2 was part-paid elsewhere (₹1,000) → a ₹3,000 write for it is refused rather than becoming a prepayment.
    await payOne(w, 2, 1_000, "ac-s2-part")();
    await expect(payOne(w, 2, 3_000, "ac-s2-full")()).rejects.toThrow(/paid in part elsewhere/);
    expect([await seqPaid(w, 1), await seqPaid(w, 2), await cash(w)]).toEqual([3_000, 1_000, startCash - 4_000]);
    expect((await paymentDocs(w)).filter((p) => p.deletedAt == null && p.allocationType === "principalPrepayment")).toHaveLength(0);

    // Retry of the rest at what is still owed lands once.
    await payOne(w, 2, 2_000, "ac-s2-rest")();
    expect([await seqPaid(w, 2), await cash(w)]).toEqual([3_000, startCash - 6_000]);
  }, 60_000);
});

// ═══════════ 22. Linked EMIs summary (People page) — derived from the same live documents ═══════════

describe("22 — Linked EMIs summary agrees with the ledger, the lender schedule and every payment step", () => {
  const MAR_15 = new Date(2026, 2, 15);

  /** What `usePersonCycleStatement` feeds the panel: obligations + the all-time statement's `remainingNow`. */
  async function linked(w: World, personId: string, now: Date) {
    const loan = await loanNow(w);
    const obligations = personEmiObligations({ personId, emis: [], loans: [loanSource(loan)], installments: await liveInstallments(w), now });
    const st = await statement(w, personId, now, { start: new Date(1970, 0, 1), end: cycleOf(now).end });
    const remainingByKey = new Map(st.rows.filter((r) => r.kind === "obligation" && r.remainingNow != null).map((r) => [r.key, r.remainingNow as number]));
    return personLinkedEmis({ obligations, remainingByKey, sharedSourceIds: new Set([`loan:${loan.id}`]), now })[0];
  }
  /** Record Payment exactly as the People workspace builds it: all-time rows, canonical oldest-first allocation. */
  async function payAllTime(w: World, personId: string, amount: number, date: Date) {
    const hist = await statement(w, personId, date, { start: new Date(1970, 0, 1), end: cycleOf(date).end });
    const ledger = buildLedgerRows({ statement: hist, entries: await ledgerEntries(w, personId), pending: [], now: date, advanceApplications: await applications(w, personId) });
    const obligations = payableObligations(ledger).filter((o) => o.side === "theyOwe");
    const alloc = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount });
    return { paymentId: await w.personPayments(personId).recordPayment((await w.people.getByKey(personId)) as Person, { direction: "theyPaid", amount, date, accountId: w.accountId, lines: paymentLines(obligations, alloc.lines), extra: null }) };
  }
  const figures = (e: Awaited<ReturnType<typeof linked>>) => e && { share: e.monthlyShare, whole: e.installmentAmount, due: e.dueToDate, paid: e.paid, left: e.remaining, status: e.status };

  it("create → A part-pays → lender pays → revert A → close → delete: every figure ties to People, the lender and the account", async () => {
    const w = await world();

    // Each of A and B owes ₹1,000 of every ₹3,000 installment; #1 (Feb 10) and #2 (Mar 10) are due by Mar 15.
    const a0 = await linked(w, w.aId, MAR_15);
    expect(figures(a0)).toEqual({ share: 1_000, whole: 3_000, due: 2_000, paid: 0, left: 2_000, status: "overdue" });
    expect(a0.shared).toBe(true);
    // The summary and the People position can never disagree about what is owed.
    expect((await position(w, w.aId, MAR_15)).net).toBe(a0.remaining);
    // Parts of an installment sum to it (A + B + my own third).
    expect(a0.monthlyShare + (await linked(w, w.bId, MAR_15)).monthlyShare + 1_000).toBe(3_000);

    // A pays ₹1,500 — oldest first: #1 fully, #2 by ₹500. Money in once; lender untouched; B untouched.
    const cash0 = await cash(w);
    const aPay = await payAllTime(w, w.aId, 1_500, MAR_15);
    expect(await cash(w)).toBe(cash0 + 1_500);
    const a1 = await linked(w, w.aId, MAR_15);
    expect(figures(a1)).toMatchObject({ paid: 1_500, left: 500 });
    expect(a1.installments.slice(0, 2).map((i) => [i.paid, i.remaining, i.status])).toEqual([[1_000, 0, "paid"], [500, 500, "partial"]]);
    expect(figures(await linked(w, w.bId, MAR_15))).toMatchObject({ paid: 0, left: 2_000 });
    expect((await liveInstallments(w)).map((i) => i.amountPaid).reduce((x, y) => x + y, 0)).toBe(0);
    expect((await position(w, w.aId, MAR_15)).net).toBe(a1.remaining);

    // Lender payment for #1: bank side only — nobody's People figures move, the summary just shows "bank paid".
    await payLenderAnyway(w, 3_000, FIRST_DUE, "x22-l1");
    expect(await cash(w)).toBe(cash0 + 1_500 - 3_000);
    const a2 = await linked(w, w.aId, MAR_15);
    expect(figures(a2)).toEqual(figures(a1));
    expect(a2.installments[0].lenderStatus).toBe("paid");
    expect(a2.installments[1].lenderStatus).not.toBe("paid");
    expect(figures(await linked(w, w.bId, MAR_15))).toMatchObject({ paid: 0, left: 2_000 });

    // Revert A's payment: the summary returns exactly to the original obligation and the cash leg is reversed.
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, aPay.paymentId);
    expect(await cash(w)).toBe(cash0 - 3_000);
    expect(figures(await linked(w, w.aId, MAR_15))).toEqual(figures(a0));

    // Close: only the lender-paid #1 keeps a share; open future/unpaid ones stop (existing close rule).
    await w.loans.closeLoan(await loanNow(w));
    const closed = await linked(w, w.aId, MAR_15);
    expect(closed.installments.map((i) => i.number)).toEqual([1]);
    expect((await position(w, w.aId, MAR_15)).net).toBe(closed.remaining);
  }, 60_000);

  it("a trashed agreement disappears from the person's summary and from People", async () => {
    const w = await world({ movement: false });
    expect(await linked(w, w.aId, MAR_15)).toBeDefined();
    await w.loans.softDelete(await loanNow(w));
    expect(await linked(w, w.aId, MAR_15)).toBeUndefined();
    expect((await position(w, w.aId, MAR_15)).net).toBe(0);
  });

  it("a person with no share in the agreement has no summary", async () => {
    const w = await world();
    const stranger = await w.people.createPerson({ name: "Stranger", avatarColorValue: 0, openingBalance: 0 });
    expect(await linked(w, stranger.id, MAR_15)).toBeUndefined();
  });
});

// ═══════════ 23. Postpone THE PERSON to an exact date — the bank EMI is a separate, explicit decision ═══════════

describe("23 — postponing a person's EMI share to an exact date (bank EMI due the 10th, person until the 25th)", () => {
  const ALL = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
  const FEB_25 = new Date(2026, 1, 25);
  const FEB_26 = new Date(2026, 1, 26);
  const FEB_28 = new Date(2026, 1, 28);

  const keyOf = async (w: World, seq: number) => `loan-inst:${(await liveInstallments(w)).find((i) => i.sequenceNumber === seq)!.id}`;
  async function postponeTo(w: World, personId: string, seq: number, targetDate: Date, now: Date, revision = 0, requestId = `pp-${personId}-${seq}-${revision}-${targetDate.getTime()}`) {
    const inst = (await liveInstallments(w)).find((i) => i.sequenceNumber === seq)!;
    return new PaymentDeferralRepository(w.db, UID).apply({
      action: "postpone", requestId, expectedRevision: revision, personId, obligationKey: await keyOf(w, seq), obligationTitle: "Shared loan",
      now, startDay: 1, obligationDate: inst.dueDate, remaining: 1_000, target: cycleContaining(targetDate, 1), targetDate, reason: "unableNow", note: null, reminder: null,
    });
  }
  async function undoPostpone(w: World, personId: string, seq: number, now: Date, revision: number) {
    return new PaymentDeferralRepository(w.db, UID).apply({ action: "undo", requestId: `undo-${personId}-${seq}-${revision}`, expectedRevision: revision, personId, obligationKey: await keyOf(w, seq), obligationTitle: "Shared loan", now, startDay: 1 });
  }
  /** The stored document, read straight from Firestore — what survives a reload, not what the screen said. */
  async function storedDeferral(w: World, personId: string, seq: number) {
    const snap = await getDocs(collection(w.db, "users", UID, "people", personId, "paymentDeferrals"));
    const key = await keyOf(w, seq);
    const d = snap.docs.find((x) => x.data().obligationKey === key);
    return d ? paymentDeferralFromData(d.id, d.data()) : null;
  }
  async function viewOf(w: World, personId: string, seq: number, now: Date) {
    const dfr = await storedDeferral(w, personId, seq);
    if (!dfr) return null;
    // Whole schedule (a future installment's share has no row in a statement that ends with the current cycle).
    const st = await statement(w, personId, now, ALL);
    const remaining = st.rows.find((r) => r.key === dfr.obligationKey)?.remainingNow ?? 0;
    return deferralView(dfr, remaining, 1, now);
  }
  /** The figures every connected module reads, from live documents. */
  async function snap(w: World, now: Date) {
    const nw = await netWorth(w, now);
    return {
      cash: await cash(w),
      outstanding: await outstanding(w),
      installments: (await liveInstallments(w)).map((i) => [i.sequenceNumber, i.amountPaid, i.dueDate.getTime()]),
      aNet: (await position(w, w.aId, now)).net,
      bNet: (await position(w, w.bId, now)).net,
      toReceive: nw.peopleReceivable,
      netWorth: nw.netWorth,
      income: await monthCycleIncome(w),
      expenses: (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction).filter((t) => t.deletedAt == null && t.type === "expense").length,
    };
  }

  it("1 · postpone without paying the lender: stored with the exact date, nothing else anywhere changes", async () => {
    const w = await world();
    const before = await snap(w, FEB_12);
    const written = await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    expect(written.outcome).toBe("written");

    // Persisted — read back from Firestore, not from the call's return value.
    const stored = (await storedDeferral(w, w.bId, 1))!;
    expect(stored.state).toBe("active");
    expect(stored.expected!.date).toEqual(FEB_25);
    expect(stored.expected!.reason).toBe("unableNow");
    expect(JSON.stringify(stored)).not.toMatch(/amount/i); // no amount is ever stored

    // The bank's side and every module: identical to before. A postponement is metadata only.
    expect(await snap(w, FEB_12)).toEqual(before);
    expect((await liveInstallments(w))[0].dueDate).toEqual(FIRST_DUE); // the lender's date never moves
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // and the EMI is NOT marked paid

    // Status follows the exact day: postponed → due on the 25th → lapsed the day after.
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 1_000 });
    expect((await viewOf(w, w.bId, 1, FEB_12))!.date).toEqual(FEB_25);
    expect((await viewOf(w, w.bId, 1, FEB_25))!.status).toBe("expectedNow");
    expect((await viewOf(w, w.bId, 1, FEB_26))!.status).toBe("lapsed");
    // A is untouched.
    expect(await storedDeferral(w, w.aId, 1)).toBeNull();
  }, 60_000);

  it("rejects a date that is today, in the past, or not after the original due date — nothing written", async () => {
    const w = await world();
    const before = await snap(w, FEB_12);
    for (const d of [FEB_12, new Date(2026, 1, 11), FIRST_DUE, new Date(2026, 1, 9)]) {
      await expect(postponeTo(w, w.bId, 1, d, FEB_12)).rejects.toThrow(/Choose a date/);
    }
    expect(await storedDeferral(w, w.bId, 1)).toBeNull();
    expect(await snap(w, FEB_12)).toEqual(before);
  }, 60_000);

  it("2 · postpone, then the lender EMI paid from my account: one Money Out, person still owes, both dates kept", async () => {
    const w = await world();
    await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    const cash0 = await cash(w);
    const bNet0 = (await position(w, w.bId, FEB_12)).net;

    // The explicit own-money path the payment dialog offers once the open shares are postponed.
    const paid = await payLenderAnyway(w, 3_000, FEB_12, "pp-lender-1");
    await payLenderAnyway(w, 3_000, FEB_12, "pp-lender-1"); // a double submit never deducts twice
    expect(await cash(w)).toBe(cash0 - 3_000);
    expect((await liveInstallments(w))[0].amountPaid).toBe(3_000);
    expect((await liveInstallments(w))[0].dueDate).toEqual(FIRST_DUE);
    expect((await getDocs(w.transactionsRef)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null && t.type === "expense")).toHaveLength(1);

    // Person's side untouched: still owes ₹1,000, still postponed until the 25th.
    expect((await position(w, w.bId, FEB_12)).net).toBe(bNet0);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 1_000 });

    // Reversing the lender payment restores the account and reopens the bank EMI — the postponement is unaffected.
    await revertLender(w, paid, "pp-lender-1-rev");
    expect(await cash(w)).toBe(cash0);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 1_000 });
  }, 60_000);

  it("3 · the EMI was already paid: recording it deducts nothing and adds no Money Out; the postponement is unaffected", async () => {
    const w = await world();
    await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    const cash0 = await cash(w);
    await payEarlier(w, 3_000, new Date(2026, 1, 8), "pp-earlier-1");
    await payEarlier(w, 3_000, new Date(2026, 1, 8), "pp-earlier-1"); // retry never duplicates
    expect(await cash(w)).toBe(cash0); // no balance change at all
    expect(await seqPaid(w, 1)).toBe(3_000);
    expect(await loanCashOut(w)).toBe(0); // no counted money-out in any module
    expect(await seqPaid(w, 2)).toBe(0); // and nothing spilled onto #2
    expect((await position(w, w.bId, FEB_12)).net).toBe(1_000);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed" });
  }, 60_000);

  it("4 · a future EMI: the person can be given time without marking the future bank EMI paid or moving its date", async () => {
    const w = await world();
    const before = await snap(w, FEB_12);
    const apr20 = new Date(2026, 3, 20);
    await postponeTo(w, w.bId, 3, apr20, FEB_12); // #3 falls due 10 Apr
    expect((await storedDeferral(w, w.bId, 3))!.expected!.date).toEqual(apr20);
    expect(await snap(w, FEB_12)).toEqual(before);
    expect(await seqPaid(w, 3)).toBe(0);
    expect(await viewOf(w, w.bId, 3, FEB_12)).toMatchObject({ status: "postponed" });
    // Not due yet, so nothing is owed now — the share only appears once #3 falls due, then is already postponed.
    expect((await position(w, w.bId, FEB_12)).net).toBe(1_000); // only #1 is due by Feb 12
  }, 60_000);

  it("5–6 · edit the date, then cancel: each step is one revision; cancelling restores the original timing", async () => {
    const w = await world();
    await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    const edited = await postponeTo(w, w.bId, 1, FEB_28, FEB_12, 1);
    expect(edited.outcome).toBe("written");
    let stored = (await storedDeferral(w, w.bId, 1))!;
    expect([stored.revision, stored.expected!.date]).toEqual([2, FEB_28]);
    // A stale second tab (still at revision 1) is refused, never overwrites.
    await expect(postponeTo(w, w.bId, 1, new Date(2026, 2, 5), FEB_12, 1, "stale-tab")).rejects.toThrow(/just changed elsewhere/);
    expect((await storedDeferral(w, w.bId, 1))!.expected!.date).toEqual(FEB_28);
    // The same edit retried (lost response) is a no-op.
    expect((await postponeTo(w, w.bId, 1, FEB_28, FEB_12, 1)).outcome).toBe("noop");

    await undoPostpone(w, w.bId, 1, FEB_12, 2); // cancel one step → back to the 25th
    expect((await storedDeferral(w, w.bId, 1))!.expected!.date).toEqual(FEB_25);
    await undoPostpone(w, w.bId, 1, FEB_12, 3); // cancel again → no postponement
    stored = (await storedDeferral(w, w.bId, 1))!;
    expect([stored.state, stored.expected]).toEqual(["cleared", null]);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toBeNull();
    // Still owed, in full, on its own date — cancelling never loses or invents money.
    expect((await position(w, w.bId, FEB_12)).net).toBe(1_000);
  }, 60_000);

  it("7–8 · partial then full reimbursement after postponing: Money In once each, status resolves only at zero", async () => {
    const w = await world();
    await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    const cash0 = await cash(w);

    await personPays(w, w.bId, 400, FEB_12);
    expect(await cash(w)).toBe(cash0 + 400);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 600 }); // still postponed, live remaining
    expect((await position(w, w.bId, FEB_12)).net).toBe(600);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0); // the bank EMI is not touched by the person paying me
    expect(await monthCycleIncome(w)).toBe(0); // a reimbursement is not income

    const rest = await personPays(w, w.bId, 600, FEB_12);
    expect(await cash(w)).toBe(cash0 + 1_000);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "resolved", remaining: 0 }); // nothing left to collect
    expect((await position(w, w.bId, FEB_12)).net).toBe(0);
    expect((await liveInstallments(w))[0].amountPaid).toBe(0);

    // 9 · deleting (reverting) the linked reimbursement reopens the share AND its postponement, and returns the cash.
    await w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId))!, rest.paymentId);
    expect(await cash(w)).toBe(cash0 + 400);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 600 });
    expect((await position(w, w.bId, FEB_12)).net).toBe(600);
  }, 60_000);

  it("10 · across modules: lender paid + person postponed + person part-paid reconcile (Accounts, People, Net Worth, Debt, Month Cycle)", async () => {
    const w = await world();
    await postponeTo(w, w.bId, 1, FEB_25, FEB_12);
    await payLenderAnyway(w, 3_000, FEB_12, "pp-x-1");
    await personPays(w, w.bId, 400, FEB_12);
    const s = await snap(w, FEB_12);
    // cash: 5,000 + 30,000 loan − 3,000 lender + 400 reimbursement
    expect(s.cash).toBe(32_400);
    expect(s.outstanding).toBe(27_000); // principal after the lender EMI
    expect(s.bNet).toBe(600);
    expect(s.income).toBe(0);
    // Net worth = cash − outstanding liability + what people owe me (A ₹1,000 + B ₹600).
    expect(s.netWorth).toBe(32_400 - 27_000 + 1_000 + 600);
    expect(await viewOf(w, w.bId, 1, FEB_12)).toMatchObject({ status: "postponed", remaining: 600 });
  }, 60_000);
});

// ═══════════ 24. Link an "already paid earlier" installment to the user's EXISTING expense ═══════════

describe("24 — linking an already-paid EMI to an existing account transaction", () => {
  const FEB_8 = new Date(2026, 1, 8);

  /** The user's own expense — it already moved the account once, long before the link. */
  async function ownExpense(w: World, amount: number, patch: Record<string, unknown> = {}) {
    return w.transactions.createTransaction({ type: "expense", amount, dateTime: FEB_8, accountId: w.accountId, categoryId: "cat-emi", description: "EMI paid by me", ...patch });
  }
  /** What the Loan screen sends for "already paid earlier" + a chosen transaction. */
  async function linkTo(w: World, t: { id: string; amount: number; dateTime: Date; accountId: string }, key: string, over: Record<string, unknown> = {}) {
    const insts = await liveInstallments(w);
    return w.lender.record({
      loan: await loanNow(w),
      scheduleInstallments: insts,
      accountId: t.accountId,
      amount: t.amount,
      date: t.dateTime,
      idempotencyKey: key,
      includeUpcomingInstallments: true,
      peopleGateAcknowledgement: RECORDED_EARLIER_PEOPLE_ACK,
      recordedEarlier: { dateKnown: true },
      expectedFirstInstallmentId: insts.find((i) => i.amountPaid < i.amountDue)!.id,
      linkedTransactionId: t.id,
      ...over,
    });
  }
  const liveTx = async (w: World, id: string) => (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction).find((t) => t.id === id)!;
  /** Every counted (non-excluded, live) expense — what Dashboard / Month Cycle / My Money add up. */
  async function countedExpenses(w: World) {
    return (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction).filter((t) => t.deletedAt == null && t.type === "expense" && !t.excludeFromCalculations);
  }
  async function figures(w: World, now: Date) {
    const nw = await netWorth(w, now);
    return {
      cash: await cash(w),
      outstanding: await outstanding(w),
      paid: (await liveInstallments(w)).map((i) => i.amountPaid),
      countedExpense: (await countedExpenses(w)).reduce((t, x) => t + x.amount, 0),
      netWorth: nw.netWorth,
      income: await monthCycleIncome(w),
      aNet: (await position(w, w.aId, now)).net,
    };
  }

  it("links the user's expense to #1: the installment is paid, the account is NOT touched again, the expense is counted once", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    const cashAfterExpense = await cash(w); // 5,000 + 30,000 loan − 3,000
    expect(cashAfterExpense).toBe(32_000);
    const before = await figures(w, FEB_15);

    const r = await linkTo(w, t, "link-1");
    expect(r.alreadyRecorded).toBe(false);

    expect(await cash(w)).toBe(cashAfterExpense); // no second deduction
    const insts = await liveInstallments(w);
    expect(insts[0].amountPaid).toBe(3_000);
    expect(insts[0].dueDate).toEqual(FIRST_DUE);

    // The reference and the back-marker, both stored.
    const payment = (await paymentDocs(w)).find((p) => p.installmentId === insts[0].id)!;
    expect(payment.linkedTransactionId).toBe(t.id);
    expect(payment.recordedEarlier).toEqual({ dateKnown: true });
    const stored = await liveTx(w, t.id);
    expect(stored.earlierPaymentLink).toMatchObject({ ownerType: "loan", ownerId: w.loanId, installmentId: insts[0].id, paymentId: payment.id });
    expect([stored.amount, stored.deletedAt, stored.loanId]).toEqual([3_000, null, null]); // still the user's plain expense

    // One counted expense of ₹3,000 across the whole book (the loan payment's own transaction is excluded).
    expect((await countedExpenses(w)).map((x) => x.amount)).toEqual([3_000]);
    expect(await loanCashOut(w)).toBe(0);

    // Only the loan's own figures moved: outstanding −3,000, installment paid; cash, expense, income and People unchanged.
    const after = await figures(w, FEB_15);
    expect(after).toEqual({ ...before, outstanding: before.outstanding - 3_000, paid: [3_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], netWorth: before.netWorth + 3_000 });
  }, 60_000);

  it("is idempotent, and one transaction can never be linked twice", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    await linkTo(w, t, "link-idem");
    expect((await linkTo(w, t, "link-idem")).alreadyRecorded).toBe(true); // double click / retry
    expect((await liveInstallments(w))[0].amountPaid).toBe(3_000);
    // The same transaction used again (a different action) for installment #2 → refused, nothing written.
    await expect(linkTo(w, await liveTx(w, t.id), "link-twice")).rejects.toThrow(/already linked/);
    expect((await liveInstallments(w))[1].amountPaid).toBe(0);
    expect((await countedExpenses(w)).length).toBe(1);
  }, 60_000);

  it("refuses anything that is not a real, unlinked, matching expense — nothing written", async () => {
    const w = await world();
    const good = await ownExpense(w, 3_000);
    const income = await w.transactions.createTransaction({ type: "income", amount: 3_000, dateTime: FEB_8, accountId: w.accountId, categoryId: "cat-in" });
    const gone = await ownExpense(w, 3_000);
    await w.transactions.softDeleteTransaction(gone);
    const loanPaid = await payLenderAnyway(w, 3_000, FEB_12, "real-lender-pay"); // a normal lender payment: its own txn is loan-owned
    const other = await w.accounts.createAccount({ name: "Other", type: "bank", openingBalance: 9_000, colorValue: 0 });
    const future = await ownExpense(w, 3_000, { dateTime: new Date(2099, 0, 1) });
    const snapshot = JSON.stringify([await cash(w), (await liveInstallments(w)).map((i) => i.amountPaid)]);

    const wrong = async (t: Transaction, over: Record<string, unknown> = {}) => linkTo(w, t, `bad-${Math.random()}`, over);
    await expect(wrong(income)).rejects.toThrow(/Only an expense/);
    await expect(wrong(gone)).rejects.toThrow(/deleted/);
    await expect(wrong((await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction).find((x) => x.id === loanPaid.transactionId)!)).rejects.toThrow(/already belongs to a Loan/);
    await expect(wrong(future)).rejects.toThrow(/future/);
    await expect(wrong(good, { amount: 2_500 })).rejects.toThrow(/exactly the transaction's amount/);
    await expect(wrong(good, { date: new Date(2026, 1, 9) })).rejects.toThrow(/exactly the transaction's date/);
    await expect(wrong(good, { accountId: other.id })).rejects.toThrow(/transaction's account/);
    await expect(wrong({ ...good, id: "missing-id" } as Transaction)).rejects.toBeInstanceOf(LinkEarlierPaymentError);
    // Linking needs the "already paid earlier" mode.
    await expect(wrong(good, { recordedEarlier: null })).rejects.toThrow(/already paid earlier/);

    expect(JSON.stringify([await cash(w), (await liveInstallments(w)).map((i) => i.amountPaid)])).toBe(snapshot);
    expect((await liveTx(w, good.id)).earlierPaymentLink ?? null).toBeNull();
  }, 90_000);

  it("a smaller transaction links as a PARTIAL payment (₹1,000 of ₹3,000); one larger than the installment is refused", async () => {
    const w = await world();
    const small = await ownExpense(w, 1_000);
    await linkTo(w, small, "link-partial");
    expect((await liveInstallments(w))[0].amountPaid).toBe(1_000);
    const big = await ownExpense(w, 5_000, { description: "too big" });
    await expect(linkTo(w, big, "link-big")).rejects.toThrow();
    expect((await liveInstallments(w))[0].amountPaid).toBe(1_000);
    expect((await liveTx(w, big.id)).earlierPaymentLink ?? null).toBeNull();
  }, 60_000);

  it("while linked, the transaction cannot be edited or deleted on its own, and the payment cannot be edited", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    const r = await linkTo(w, t, "link-guard");
    const linked = await liveTx(w, t.id);
    const before = JSON.stringify(await figures(w, FEB_15));

    await expect(w.transactions.editTransaction(linked, { amount: 4_000 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(w.transactions.softDeleteTransaction(linked)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    const insts = await liveInstallments(w);
    await expect(
      w.lender.editPayment({
        loan: await loanNow(w), scheduleInstallments: insts, original: { transactionId: r.transactionId, paymentIds: r.paymentIds, installmentIds: r.installmentIds },
        accountId: w.accountId, amount: 2_000, date: FEB_8, idempotencyKey: "edit-linked",
      }),
    ).rejects.toBeInstanceOf(LinkedPaymentEditError);

    expect(JSON.stringify(await figures(w, FEB_15))).toBe(before);
    expect((await liveTx(w, t.id)).amount).toBe(3_000);
  }, 60_000);

  it("marking it unpaid UNLINKS: the installment reopens, your transaction and the account are untouched, and it can be linked again", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    const cashAfterExpense = await cash(w);
    const unpaidFigures = JSON.stringify(await figures(w, FEB_15));
    const r = await linkTo(w, t, "link-undo");

    await revertLender(w, r, "link-undo-rev");
    expect((await liveInstallments(w))[0].amountPaid).toBe(0);
    expect(await cash(w)).toBe(cashAfterExpense); // the user's expense is still the only deduction
    const stored = await liveTx(w, t.id);
    expect([stored.deletedAt, stored.amount, stored.earlierPaymentLink ?? null]).toEqual([null, 3_000, null]); // intact, unlinked
    expect(JSON.stringify(await figures(w, FEB_15))).toBe(unpaidFigures); // everything back to "before the link"
    // A second reversal (retry) is a no-op.
    await revertLender(w, r, "link-undo-rev-2");
    expect(await cash(w)).toBe(cashAfterExpense);

    // Now it is free again — and the editing/deleting guards are released.
    await linkTo(w, stored, "link-again");
    expect((await liveTx(w, t.id)).earlierPaymentLink).toMatchObject({ ownerType: "loan" });
    expect((await liveInstallments(w))[0].amountPaid).toBe(3_000);
  }, 60_000);

  it("a write that BYPASSES the repositories (stale tab / older client) cannot change a linked transaction's money, move it or delete it", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    await linkTo(w, t, "link-bypass");
    const before = JSON.stringify(await figures(w, FEB_15));
    const ref = doc(w.db, "users", UID, "transactions", t.id);

    await expect(updateDoc(ref, { amount: 9_999 })).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    await expect(updateDoc(ref, { accountId: "some-other-account" })).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    await expect(updateDoc(ref, { deletedAt: new Date() })).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    await expect(deleteDoc(ref)).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    // Unlinking without reversing the payment first is refused too — otherwise the money could be changed afterwards.
    await expect(updateDoc(ref, { earlierPaymentLink: deleteField() })).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    // A descriptive edit is fine.
    await updateDoc(ref, { description: "EMI paid by me (Feb)" });

    expect(JSON.stringify(await figures(w, FEB_15))).toBe(before);
    expect((await liveTx(w, t.id)).amount).toBe(3_000);
  }, 60_000);

  it("permanently deleting the Loan RELEASES the linked expense: it stays (counted once, account untouched) and is ordinary again", async () => {
    const w = await world();
    const t = await ownExpense(w, 3_000);
    await linkTo(w, t, "link-then-delete-loan");
    expect((await liveTx(w, t.id)).earlierPaymentLink).toMatchObject({ ownerType: "loan", ownerId: w.loanId });
    const cashBefore = await cash(w);

    const result = await permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId);
    expect(result.resumed).toBe(false);

    // The expense is still there, unchanged, no longer pointing at a Loan that no longer exists...
    const stored = await liveTx(w, t.id);
    expect([stored.deletedAt, stored.amount, stored.earlierPaymentLink ?? null]).toEqual([null, 3_000, null]);
    // ...so it is editable/deletable like any ordinary expense (it used to stay locked to the deleted Loan for good).
    await w.transactions.editTransaction(stored, { amount: 3_500 });
    expect((await liveTx(w, t.id)).amount).toBe(3_500);
    // The loan's own money (disbursement) was reversed by the deletion; the user's expense was not touched by it.
    expect(cashBefore - (await cash(w))).toBe(30_000 /* loan principal reversed */ + 500 /* then the user's own +500 edit */);
  }, 90_000);

  it("every module reads the same figures as an unlinked 'already paid earlier' of the same expense (no double count anywhere)", async () => {
    const w1 = await world();
    const t1 = await ownExpense(w1, 3_000);
    await linkTo(w1, t1, "cmp-linked");
    const linked = await figures(w1, FEB_15);
    await testEnv.clearFirestore();

    const w2 = await world();
    await ownExpense(w2, 3_000);
    await payEarlier(w2, 3_000, FEB_8, "cmp-plain");
    const plain = await figures(w2, FEB_15);

    expect(linked).toEqual(plain);
    expect(linked.countedExpense).toBe(3_000); // once
  }, 90_000);
});

// ═══════════ 25. The whole flow, every module read after every step ═══════════

describe("25 — postpone → lender paid from my account → reimbursements → edit → cancel → reverse: every module, every step", () => {
  const ALL = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
  const FEB_25 = new Date(2026, 1, 25);
  const FEB_28 = new Date(2026, 1, 28);

  async function postpone(w: World, personId: string, targetDate: Date, revision: number) {
    const inst = (await liveInstallments(w))[0];
    return new PaymentDeferralRepository(w.db, UID).apply({
      action: "postpone", requestId: `flow-${personId}-${revision}-${targetDate.getTime()}`, expectedRevision: revision, personId, obligationKey: `loan-inst:${inst.id}`, obligationTitle: "Shared loan",
      now: FEB_15, startDay: 1, obligationDate: inst.dueDate, remaining: 1_000, target: cycleContaining(targetDate, 1), targetDate, reason: "unableNow", note: null, reminder: null,
    });
  }
  async function cancelPostponement(w: World, personId: string, revision: number) {
    const inst = (await liveInstallments(w))[0];
    return new PaymentDeferralRepository(w.db, UID).apply({ action: "undo", requestId: `flow-undo-${revision}`, expectedRevision: revision, personId, obligationKey: `loan-inst:${inst.id}`, obligationTitle: "Shared loan", now: FEB_15, startDay: 1 });
  }
  async function deferral(w: World, personId: string) {
    const inst = (await liveInstallments(w))[0];
    const snap = await getDocs(collection(w.db, "users", UID, "people", personId, "paymentDeferrals"));
    const doc_ = snap.docs.find((x) => x.data().obligationKey === `loan-inst:${inst.id}`);
    if (!doc_) return null;
    const d = paymentDeferralFromData(doc_.id, doc_.data());
    const st = await statement(w, personId, FEB_15, ALL);
    return deferralView(d, st.rows.find((r) => r.key === d.obligationKey)?.remainingNow ?? 0, 1, FEB_15);
  }
  /** Accounts · Loan EMI · People · Net Worth (Dashboard) · Debt Planner · My Spend (My Money) · Month Cycle — from live documents. */
  async function modules(w: World) {
    const nw = await netWorth(w, FEB_15);
    const planner = (await plannerOwnership(w, FEB_15))!;
    const txs = (await getDocs(w.transactionsRef)).docs.map((d) => d.data() as Transaction);
    const loan = await loanNow(w);
    const ctx = mySpendContextFromRecords({ transactions: txs, expenses: [], loans: [loan], emis: [] });
    return {
      accountCash: await cash(w),
      loanOutstanding: await outstanding(w),
      installment1Paid: (await liveInstallments(w))[0].amountPaid,
      installment1Due: (await liveInstallments(w))[0].dueDate.getTime(),
      aOwes: (await position(w, w.aId, FEB_15)).net,
      bOwes: (await position(w, w.bId, FEB_15)).net,
      peopleReceivable: nw.peopleReceivable,
      netWorth: nw.netWorth,
      plannerOutstanding: planner.outstanding,
      plannerMine: planner.ownership.mine,
      mySpend: txs.filter((t) => t.deletedAt == null).reduce((x, t) => x + classifyForMySpend(t, ctx).myAmount, 0),
      monthCycleIncome: await monthCycleIncome(w),
    };
  }
  const E = (patch: Partial<Awaited<ReturnType<typeof modules>>>) => ({
    accountCash: 35_000, loanOutstanding: 30_000, installment1Paid: 0, installment1Due: FIRST_DUE.getTime(), aOwes: 1_000, bOwes: 1_000, peopleReceivable: 2_000, netWorth: 7_000,
    plannerOutstanding: 30_000, plannerMine: 10_000, mySpend: 0, monthCycleIncome: 0, ...patch,
  });

  it("each step moves exactly the figures it should — and the bank's date and paid state move only with a real lender payment", async () => {
    const w = await world();
    expect(await modules(w)).toEqual(E({}));

    // 1 · Postpone B's repayment to the 25th (the bank EMI was due the 10th): metadata only — nothing else moves.
    await postpone(w, w.bId, FEB_25, 0);
    expect((await deferral(w, w.bId))!.date).toEqual(FEB_25);
    expect(await modules(w)).toEqual(E({}));

    // 2 · I pay the bank from my own account: −₹3,000 cash, loan −₹3,000, installment paid; People untouched; net worth unchanged.
    const lender = await payLenderAnyway(w, 3_000, FEB_12, "flow-lender");
    expect(await modules(w)).toEqual(E({ accountCash: 32_000, loanOutstanding: 27_000, installment1Paid: 3_000, plannerOutstanding: 27_000, plannerMine: 9_000 }));
    expect((await deferral(w, w.bId))!.status).toBe("postponed");

    // 3 · A reimburses ₹1,000 (Money In — not income, not spend).
    const aPay = await personPays(w, w.aId, 1_000, FEB_12);
    expect(await modules(w)).toEqual(E({ accountCash: 33_000, loanOutstanding: 27_000, installment1Paid: 3_000, plannerOutstanding: 27_000, plannerMine: 9_000, aOwes: 0, peopleReceivable: 1_000 }));

    // 4 · B (postponed) pays ₹400 early: still postponed, ₹600 left.
    const bPay = await personPays(w, w.bId, 400, FEB_12);
    expect(await modules(w)).toEqual(E({ accountCash: 33_400, loanOutstanding: 27_000, installment1Paid: 3_000, plannerOutstanding: 27_000, plannerMine: 9_000, aOwes: 0, bOwes: 600, peopleReceivable: 600 }));
    expect(await deferral(w, w.bId)).toMatchObject({ status: "postponed", remaining: 600 });

    // 5 · Edit the date: timing only.
    const before5 = await modules(w);
    await postpone(w, w.bId, FEB_28, 1);
    expect((await deferral(w, w.bId))!.date).toEqual(FEB_28);
    expect(await modules(w)).toEqual(before5);

    // 6 · Cancel the postponement (twice: back to the 25th, then none): timing only; B still owes ₹600.
    await cancelPostponement(w, w.bId, 2);
    expect((await deferral(w, w.bId))!.date).toEqual(FEB_25);
    await cancelPostponement(w, w.bId, 3);
    expect(await deferral(w, w.bId)).toBeNull();
    expect(await modules(w)).toEqual(before5);

    // 7 · Delete B's linked ₹400 payment: cash back, B owes the full ₹1,000 again, bank side untouched.
    await w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId))!, bPay.paymentId);
    expect(await modules(w)).toEqual(E({ accountCash: 33_000, loanOutstanding: 27_000, installment1Paid: 3_000, plannerOutstanding: 27_000, plannerMine: 9_000, aOwes: 0, bOwes: 1_000, peopleReceivable: 1_000 }));

    // 8 · Reverse my payment to the bank: the account and the loan come back; People is independent of it.
    await revertLender(w, lender, "flow-lender-rev");
    expect(await modules(w)).toEqual(E({ accountCash: 36_000, aOwes: 0, bOwes: 1_000, peopleReceivable: 1_000 }));

    // 9 · A's payment reverted too, then B pays in full: every figure follows.
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, aPay.paymentId);
    expect(await modules(w)).toEqual(E({ accountCash: 35_000 }));
    await personPays(w, w.bId, 1_000, FEB_12);
    expect(await modules(w)).toEqual(E({ accountCash: 36_000, bOwes: 0, peopleReceivable: 1_000 }));
  }, 120_000);
});
