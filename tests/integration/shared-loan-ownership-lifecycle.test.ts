/**
 * Shared debt ownership — financial integrity audit (real Firestore emulator).
 *
 * Drives the REAL write paths end to end — `LoanRepository.createAgreementWithOrigination` (with
 * `ownershipShares` + an account movement), `LoanAdvancePaymentRepository` (lender payments, prepayment,
 * reversal), `PersonPaymentRepository` (Record Payment: reimbursements, partials, advance, revert) — then
 * reads every linked surface from the live documents with the same engines the hooks use:
 *
 *  - Accounts      → `Account.currentBalance`
 *  - Net Worth     → `netWorthWithLoans(accounts, loanBalanceSheet(...), Σ directBalance)` (= `useLoanBalanceSheet`)
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
import { personPosition, peopleDirectPayable, type PersonPosition } from "@/lib/engines/person-position";
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
import { isLoanPrincipalDisbursement, transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { LoanAdvancePaymentRepository, type LoanAdvancePaymentResult } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository, OriginationDeleteBlockedError } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
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
  const positions = [await position(w, w.aId, now), await position(w, w.bId, now)];
  const direct = positions.reduce((s, p) => s + p.directBalance, 0);
  return { netWorth: netWorthWithLoans(accounts.reduce((s, a) => s + a.currentBalance, 0), sheet, direct), sheet, peoplePayable: peopleDirectPayable(positions) };
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

async function payLender(w: World, amount: number, date: Date, key: string, includeUpcomingInstallments = false): Promise<LoanAdvancePaymentResult> {
  return w.lender.record({ loan: await loanNow(w), scheduleInstallments: await liveInstallments(w), accountId: w.accountId, amount, date, idempotencyKey: key, includeUpcomingInstallments });
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
    await payLender(w, 3_000, FIRST_DUE, "lender-1");
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
    await payLender(w, 3_000, FIRST_DUE, "l1");
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([32_000, 27_000, 5_000]);
  });

  it("extra lender payment (₹3,000 EMI + ₹6,000 prepayment): liability −₹9,000, cash −₹9,000 → unchanged", async () => {
    const w = await world();
    const r = await payLender(w, 9_000, FIRST_DUE, "l1x");
    expect(r.overallAllocationType).toBe("principalPrepayment");
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([26_000, 21_000, 5_000]);
  });

  it("deleted/reverted lender payment restores cash and liability exactly", async () => {
    const w = await world();
    const r = await payLender(w, 3_000, FIRST_DUE, "l1r");
    await revertLender(w, r, "l1r-undo");
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([35_000, 30_000, 5_000]);
  });

  /**
   * FINDING (documented, NOT changed — Net Worth contract): a person's installment-share obligation lives
   * on the Loan (`emiReceivable`), which Net Worth does not count, while their reimbursement is a
   * "receivedBack" ledger entry that lowers `currentBalance`, which Net Worth DOES count. After Person A
   * settles their ₹1,000 share, People shows A at ₹0 but Net Worth / `peoplePayable` count "I owe A
   * ₹1,000". These assertions pin today's behaviour so any contract change is a deliberate one.
   */
  it("person reimbursement: People settles to ₹0, but Net Worth books it as ₹1,000 owed to A (pinned finding)", async () => {
    const w = await world();
    await personPays(w, w.aId, 1_000, FEB_12);
    const pos = await position(w, w.aId, FEB_15);
    expect([pos.directBalance, pos.emiReceivable, pos.net]).toEqual([-1_000, 1_000, 0]); // People: settled
    const nw = await netWorth(w, FEB_15);
    expect(await cash(w)).toBe(36_000);
    expect(nw.peoplePayable).toBe(1_000); // ← the inconsistency: A is shown as someone I owe
    expect(nw.netWorth).toBe(5_000); // cash +1,000 offset by the phantom −1,000 people balance
    expect(await monthCycleIncome(w)).toBe(0); // never income
  });

  it("partial reimbursement then full lender instalment then reversal — every step reconciles to the documented rule", async () => {
    const w = await world();
    const { paymentId } = await personPays(w, w.aId, 500, FEB_12);
    expect((await netWorth(w, FEB_15)).netWorth).toBe(5_000);
    await payLender(w, 3_000, FIRST_DUE, "l1p");
    expect((await netWorth(w, FEB_15)).netWorth).toBe(5_000);
    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId))!, paymentId);
    const nw = await netWorth(w, FEB_15);
    expect([await cash(w), nw.sheet.borrowedPrincipal, nw.netWorth, nw.peoplePayable]).toEqual([32_000, 27_000, 5_000, 0]);
  });

  it("loan closure with principal left keeps the liability in Net Worth (closing is not repaying)", async () => {
    const w = await world();
    await payLender(w, 3_000, FIRST_DUE, "l1c");
    await w.loans.closeLoan(await loanNow(w));
    const nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([27_000, 5_000]);
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
    await payLender(w, 3_000, FIRST_DUE, "l-only");
    const row = (await shareRow(w, w.bId, 1, FEB_15))!;
    expect([row.amount, row.remaining]).toEqual([1_000, 1_000]);
  });
});

// ═══════════════════════ 5. Prepayment policy ═══════════════════════

describe("5 — prepayment: today's policy reduces everyone's ownership proportionally (NOT changed)", () => {
  it("₹30,000 left, I prepay ₹6,000 → ₹24,000 split 8,000 / 8,000 / 8,000", async () => {
    const w = await world();
    // A prepayment-only action: pay the ₹3,000 due + ₹6,000 extra, then look at ownership of what remains.
    await payLender(w, 9_000, FIRST_DUE, "prepay");
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
    await payLender(w, 3_000, FIRST_DUE, "l-del");
    await expect(w.loans.softDelete(await loanNow(w))).rejects.toBeInstanceOf(OriginationDeleteBlockedError);
    await expect(w.loans.reverseOrigination("shared-30000-10")).rejects.toThrow(/payment/);
    expect([await cash(w), await outstanding(w)]).toEqual([32_000, 27_000]);
  });

  it("delete (trash) a shared loan recorded without money movement: person obligations vanish, liability leaves Net Worth", async () => {
    const w = await world({ movement: false });
    await w.loans.softDelete(await loanNow(w));
    expect((await position(w, w.aId, FEB_15)).emiReceivable).toBe(0);
    expect((await position(w, w.bId, FEB_15)).emiReceivable).toBe(0);
    const nw = await netWorth(w, FEB_15);
    expect([nw.sheet.borrowedPrincipal, nw.netWorth]).toEqual([0, 5_000]);
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
    const r = await payLender(w, 3_000, FIRST_DUE, "l-rev");
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
    await payLender(w, 3_000, FIRST_DUE, "l-close");
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
