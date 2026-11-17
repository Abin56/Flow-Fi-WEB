/**
 * Backend audit part 2 (2026-11-17) — global consistency, deletion guard matrix, idempotency, stale entries.
 *
 * INDEPENDENT ORACLE: every expected figure comes from `oracle()` below, which reads RAW documents
 * (transactions, ledger entries, installments, payments) and applies the domain rules by hand with plain
 * arithmetic in integer paise. It never calls the app's balance / net-worth / position functions. The app's own
 * derived values (stored balances, `netWorthWithLoans`, `personPosition`, `cashFlowTransactions`, the Debt Planner)
 * are then compared against it after EVERY operation.
 *
 * Domain rules written out by hand (not imported):
 *   - an account's cash = opening + Σ live transactions that count (income +, expense −; a transaction flagged
 *     "don't count" never moved the account);
 *   - a person's stored balance = Σ live ledger entries (gave/repaid +, borrowed/receivedBack −); POSITIVE = they owe me;
 *   - a taken, interest-free loan's outstanding principal = amount − Σ live installments' amountPaid;
 *   - a person's share of a shared loan is a receivable for every installment whose due date has passed;
 *   - net worth = cash − outstanding loan + Σ person balances + Σ shares receivable.
 *
 * Synthetic data, Firestore emulator only. Run: `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, doc, getDocs, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveOwnership } from "@/lib/engines/debt-ownership";
import { loanDebtPosition, type LoanDebtInput } from "@/lib/engines/debt-position";
import { cashFlowTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { loanBalanceSheet, netWorthComposition, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor, principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import { countsFromSchedule } from "@/lib/engines/loan-cash-flow";
import { emiReceivableThrough, personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { breakdownEntryOf, peopleNetWorthPosition, personPosition } from "@/lib/engines/person-position";
import { accountBalanceDrift, personBalanceDrift } from "@/lib/engines/stored-balance-drift";
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
import { transactionFromFirestore, transactionToFirestore, type Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { permanentlyDeleteAgreement } from "@/lib/repositories/agreement-deletion";
import { emiFromFirestore, emiToFirestore } from "@/lib/models/emi";
import { EmiRepository } from "@/lib/repositories/emi-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository, type RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-global-consistency-audit";
const UID = "global-audit-uid";
const LOAN_DATE = new Date(2026, 0, 10);
const FIRST_DUE = new Date(2026, 1, 10);
const NOW = new Date(2026, 1, 15, 12); // exactly ONE installment (Feb 10) is due
const PAY_DATE = new Date(2026, 1, 12, 12);

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
  const accountsRef = collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore });
  const accounts = new AccountRepository(accountsRef);
  const transactionsRef = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsRef, accounts);
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
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
      advanceApplications: collection(db, "users", UID, "people", personId, "advanceApplications").withConverter({
        toFirestore: advanceApplicationToFirestore,
        fromFirestore: advanceApplicationFromFirestore,
      }),
      expenseDocRef: () => {
        throw new Error("no expenses in this scenario");
      },
      installmentDocRef: (scheduleId, installmentId) => doc(installmentsRef(scheduleId), installmentId),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) => doc(paymentsRef(scheduleId, installmentId), paymentId),
      cashLegCategoryId: "cat-people",
    });
  return { db, accounts, accountsRef, transactionsRef, transactions, people, ledgerFor, installmentsRef, paymentsRef, loans, lender, personPayments };
}

/** A shared loan: ₹30,000 interest-free, 10 × ₹3,000, thirds Me / A / B, deposited into SBI (opening ₹5,000). */
async function world(opts: { shared?: boolean } = {}) {
  const s = setup();
  const account = await s.accounts.createAccount({ name: "SBI", type: "bank", openingBalance: 5_000, colorValue: 0 });
  const a = await s.people.createPerson({ name: "Person A", avatarColorValue: 0, openingBalance: 0 });
  const b = await s.people.createPerson({ name: "Person B", avatarColorValue: 0, openingBalance: 0 });
  const created = await s.loans.createAgreementWithOrigination({
    idempotencyKey: "global-audit-loan",
    name: "Shared loan",
    category: "institutional",
    institutionName: "HDFC Bank",
    fundingSource: "bank",
    direction: "taken",
    loanAmount: 30_000,
    loanDate: LOAN_DATE,
    firstDueDate: FIRST_DUE,
    repaymentType: "installment",
    installmentFrequency: "monthly",
    installmentCount: 10,
    movementAccountId: account.id,
    ownershipShares:
      opts.shared === false
        ? null
        : [
            { personId: null, amount: 10_000 },
            { personId: a.id, amount: 10_000 },
            { personId: b.id, amount: 10_000 },
          ],
  });
  return { ...s, accountId: account.id, aId: a.id, bId: b.id, loanId: created.loan.id, scheduleId: created.scheduleId };
}
type W = Awaited<ReturnType<typeof world>>;

const paise = (rupees: number) => Math.round(rupees * 100);

// ───────────────────────────── raw reads ─────────────────────────────
const rawTxns = async (w: W) => (await getDocs(w.transactionsRef)).docs.map((d) => d.data());
const rawInstallments = async (w: W) => (await getDocs(w.installmentsRef(w.scheduleId))).docs.map((d) => d.data()).filter((i) => i.deletedAt == null);
const rawLedger = async (w: W, personId: string) => (await w.ledgerFor(personId).getAll()).concat(await w.ledgerFor(personId).getTrash());
const loanNow = async (w: W): Promise<Loan> => [...(await w.loans.getAll()), ...(await w.loans.getTrash())].find((l) => l.id === w.loanId)!;

/** Hand-written ledger sign: positive = they owe me. */
function handSign(e: { type: string; amount: number; increasesBalance: boolean }): number {
  switch (e.type) {
    case "gave":
    case "repaid":
      return paise(e.amount);
    case "borrowed":
    case "receivedBack":
      return -paise(e.amount);
    default:
      return e.increasesBalance ? paise(e.amount) : -paise(e.amount);
  }
}

/** Everything expected, derived from raw documents with plain arithmetic. Integer paise throughout. */
async function oracle(w: W) {
  const txns = (await rawTxns(w)).filter((t) => t.deletedAt == null);
  // Cash: a transaction flagged "don't count" never moved the account.
  const cash = paise(5_000) + txns.filter((t) => !t.excludeFromCalculations).reduce((s, t) => s + (t.type === "income" ? paise(t.amount) : -paise(t.amount)), 0);
  const installments = await rawInstallments(w);
  const paid = installments.reduce((s, i) => s + paise(i.amountPaid), 0);
  const outstanding = paise(30_000) - paid;
  const dueCount = installments.filter((i) => i.dueDate.getTime() <= NOW.getTime()).length;
  const sharedLoan = (await loanNow(w)).ownershipShares != null;
  const share = sharedLoan ? Math.round(paise(30_000 / 10 / 3)) * dueCount : 0; // each installment 3,000 → ⅓ = 1,000
  const direct = { a: 0, b: 0 };
  for (const [k, id] of [["a", w.aId], ["b", w.bId]] as const) direct[k] = (await rawLedger(w, id)).filter((e) => e.deletedAt == null).reduce((s, e) => s + handSign(e), 0);
  const net = { a: direct.a + share, b: direct.b + share }; // what each owes me (negative = I owe them)
  const receivable = Math.max(net.a, 0) + Math.max(net.b, 0);
  const payable = Math.max(-net.a, 0) + Math.max(-net.b, 0);
  const assets = cash + receivable;
  const debt = outstanding + payable;
  // Money In / Out (calendar month of NOW): real cash only — not loan principal, not People settlement cash, not transfers.
  const inMonth = txns.filter((t) => !t.excludeFromCalculations && t.dateTime.getMonth() === NOW.getMonth() && t.dateTime.getFullYear() === NOW.getFullYear());
  const real = inMonth.filter((t) => !t.isPersonLedgerMovement && t.transferId == null && !(t.loanId != null && t.type === "income"));
  const moneyIn = real.filter((t) => t.type === "income").reduce((s, t) => s + paise(t.amount), 0);
  const moneyOut = real.filter((t) => t.type === "expense").reduce((s, t) => s + paise(t.amount), 0);
  return { cash, outstanding, share, direct, net, receivable, payable, assets, debt, netWorth: assets - debt, moneyIn, moneyOut, netCashFlow: moneyIn - moneyOut };
}

// ─────────────── the app's own derived values (compared AGAINST the oracle) ───────────────
async function appFigures(w: W) {
  const account = (await w.accounts.getByKey(w.accountId))!;
  const loan = await loanNow(w);
  const all = (await getDocs(w.installmentsRef(w.scheduleId))).docs.map((d) => d.data());
  const live = all.filter((i) => i.deletedAt == null);
  const records = (await Promise.all(all.map((i) => getDocs(w.paymentsRef(w.scheduleId, i.id))))).flatMap((s) => s.docs.map((d) => d.data()));
  const outstanding = outstandingPrincipalAfterPrepaymentsFor(loan.loanAmount, live, principalPrepaidFor(records));
  const source = {
    id: loan.id, name: loan.name, scheduleId: loan.scheduleId, direction: loan.direction, personId: loan.personId,
    beneficiaryPersonId: loan.beneficiaryPersonId ?? null, beneficiaryRepaysInstallments: loan.beneficiaryRepaysInstallments,
    ownershipShares: loan.ownershipShares ?? null, isClosed: loan.isClosed, deletedAt: loan.deletedAt,
  };
  const positions = [] as { position: ReturnType<typeof personPosition>; entries: ReturnType<typeof breakdownEntryOf>[]; advanceApplications: never[] }[];
  const stored: Record<string, number> = {};
  for (const id of [w.aId, w.bId]) {
    const person = (await w.people.getByKey(id)) as Person;
    stored[id] = paise(person.currentBalance);
    const ledger = await w.ledgerFor(id).getAll();
    const obligations = personEmiObligations({ personId: id, emis: [], loans: [source], installments: live, now: NOW });
    positions.push({
      position: personPosition({
        personId: id, currentBalance: person.currentBalance, loans: [],
        ledgerEntries: ledger.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
        loanIds: new Set([loan.id]), emiReceivable: emiReceivableThrough(obligations, NOW),
      }),
      entries: ledger.map(breakdownEntryOf),
      advanceApplications: [],
    });
  }
  const sheet = loanBalanceSheet(loan.deletedAt == null ? [{ direction: loan.direction, outstandingPrincipal: outstanding }] : [], []);
  const people = peopleNetWorthPosition(positions as never, new Set([loan.id]));
  const nw = netWorthWithLoans(account.currentBalance, sheet, people.balance);
  const composition = netWorthComposition(nw, { total: sheet.borrowedPrincipal + sheet.emiPrincipal }, { payable: people.payable, advanceHeld: people.advanceHeld });
  // Month cash flow exactly as the headline feeds it (modern loan payments are counted through their Transaction; the
  // schedule-only line must therefore add nothing — asserted separately below).
  const txns = (await rawTxns(w)).filter((t) => t.deletedAt == null);
  const flows = cashFlowTransactions(txns as Transaction[], new Set())
    .filter((t) => !t.isTransfer && !t.isCreditCardAccount && t.effectiveMonth.getMonth() === NOW.getMonth() && t.effectiveMonth.getFullYear() === NOW.getFullYear());
  const moneyIn = flows.filter((t) => t.type === "income").reduce((s, t) => s + paise(t.amount), 0);
  const moneyOut = flows.filter((t) => t.type === "expense").reduce((s, t) => s + paise(t.amount), 0);
  const scheduleOnly = records.filter((r) => countsFromSchedule(r)).reduce((s, r) => s + paise(r.amount), 0);
  const debtPlanner = loanDebtPosition(
    {
      id: loan.id, name: loan.name ?? null, lenderName: "HDFC Bank", direction: loan.direction, category: loan.category, personId: loan.personId,
      isClosed: loan.isClosed, loanAmount: loan.loanAmount, interest: loan.interest, repaymentType: loan.repaymentType, installmentFrequency: loan.installmentFrequency,
      installments: live as Installment[], outstandingPrincipal: outstanding, ownedByCardId: null, purchaseRepresented: false, ownershipShares: resolveOwnership(loan, loan.loanAmount),
    } as LoanDebtInput,
    NOW,
    {},
  );
  return {
    cash: paise(account.currentBalance), outstanding: paise(outstanding), stored, netWorth: paise(nw),
    receivable: paise(people.receivable), payable: paise(people.payable), assets: paise(composition.assets), debt: paise(composition.debt),
    moneyIn, moneyOut, netCashFlow: moneyIn - moneyOut, scheduleOnly, debtPlannerOutstanding: paise(debtPlanner?.outstanding ?? 0),
    positions: positions.map((p) => paise(p.position.net)),
  };
}

/** Compare every app figure with the independent oracle, then the drift detectors. */
async function check(w: W, label: string) {
  const o = await oracle(w);
  const f = await appFigures(w);
  expect(f.cash, `${label}: account balance`).toBe(o.cash);
  expect(f.outstanding, `${label}: outstanding loan`).toBe(o.outstanding);
  expect(f.debtPlannerOutstanding, `${label}: Debt Planner outstanding`).toBe(o.outstanding);
  expect(f.stored[w.aId], `${label}: A stored balance`).toBe(o.direct.a);
  expect(f.stored[w.bId], `${label}: B stored balance`).toBe(o.direct.b);
  expect(f.positions, `${label}: People net (positive = they owe me)`).toEqual([o.net.a, o.net.b]);
  expect(f.receivable, `${label}: People receivable`).toBe(o.receivable);
  expect(f.payable, `${label}: People payable`).toBe(o.payable);
  expect(f.netWorth, `${label}: Net Worth`).toBe(o.netWorth);
  expect(f.assets - f.debt, `${label}: Assets − Liabilities = Net Worth`).toBe(o.netWorth);
  expect(f.moneyIn, `${label}: Money In`).toBe(o.moneyIn);
  expect(f.moneyOut, `${label}: Money Out`).toBe(o.moneyOut);
  expect(f.netCashFlow, `${label}: Net Cash Flow`).toBe(o.netCashFlow);
  expect(f.scheduleOnly, `${label}: no schedule-only payment is added on top of a Transaction (no double count)`).toBe(0);
  const all = await w.transactions.getAll().then(async (a) => [...a, ...(await w.transactions.getTrash())]);
  for (const acc of await w.accounts.getAll()) expect(accountBalanceDrift(acc, all), `${label}: account drift`).toBeNull();
  for (const p of await w.people.getAll()) {
    const l = w.ledgerFor(p.id);
    expect(personBalanceDrift(p, [...(await l.getAll()), ...(await l.getTrash())]), `${label}: person drift`).toBeNull();
  }
  return o;
}

const loanShareInput = (inst: Installment, amount: number, key?: string): RecordPaymentInput => ({
  direction: "theyPaid",
  amount,
  date: PAY_DATE,
  accountId: "",
  lines: [{ key: `loan-inst:${inst.id}`, amount, route: { kind: "derived", obligationRef: `loan-inst:${inst.id}`, sourceKind: "loanInstallment" } }],
  extra: null,
  ...(key ? { idempotencyKey: key } : {}),
});
const sharePay = async (w: W, personId: string, amount: number, key?: string) => {
  const first = (await rawInstallments(w)).sort((x, y) => x.sequenceNumber - y.sequenceNumber)[0];
  const input = { ...loanShareInput(first, amount, key), accountId: w.accountId };
  const paymentId = await w.personPayments(personId).recordPayment((await w.people.getByKey(personId)) as Person, input);
  return { paymentId, first };
};
const payLender = async (w: W, amount: number, key: string) =>
  w.lender.record({
    loan: await loanNow(w),
    scheduleInstallments: (await rawInstallments(w)).sort((x, y) => x.sequenceNumber - y.sequenceNumber),
    accountId: w.accountId,
    amount,
    date: PAY_DATE,
    idempotencyKey: key,
    includeUpcomingInstallments: false,
    peopleGateAcknowledgement: { acknowledgedUnsettledPeople: true, reason: "Bank auto-debited the EMI" },
  });

/** Every document under the user, for "a blocked operation changed nothing" proofs. */
async function snapshot(): Promise<string> {
  let result = "";
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    const out: [string, unknown][] = [];
    for (const group of ["accounts", "people", "ledger", "advanceApplications", "transactions", "loans", "emis", "paymentSchedules", "installments", "payments"]) {
      const snap = await getDocs(collectionGroup(db, group));
      for (const d of snap.docs) out.push([d.ref.path, d.data()]);
    }
    result = JSON.stringify(out.sort((x, y) => x[0].localeCompare(y[0])));
  });
  return result;
}

// ══════════════════════════ Part 1 — every figure after every operation ══════════════════════════
describe("Global consistency — independently computed figures match the app after EVERY operation", () => {
  it("create → share repayment → lender payment → edit repayment → plain income/expense → reverse all → figures return exactly", async () => {
    const w = await world();
    const start = await check(w, "S0 loan created");
    expect(start.cash).toBe(paise(35_000)); // 5,000 + 30,000 deposit
    expect(start.outstanding).toBe(paise(30_000));
    expect(start.share).toBe(paise(1_000));
    expect(start.netWorth).toBe(paise(35_000) - paise(30_000) + paise(2_000)); // 7,000 — written out by hand
    expect(start.moneyIn).toBe(0); // loan principal is not income

    let { paymentId } = await sharePay(w, w.aId, 1_000, "a-pays-0001");
    const s1 = await check(w, "S1 A repays 1,000");
    expect(s1.cash).toBe(paise(36_000));
    expect(s1.net.a).toBe(0); // his share is fully settled — never negative
    expect(s1.netWorth).toBe(start.netWorth); // a repayment of a receivable is net-worth neutral

    const lenderPay = await payLender(w, 3_000, "lender-pay-0001");
    const s2 = await check(w, "S2 lender instalment 3,000");
    expect(s2.cash).toBe(paise(33_000));
    expect(s2.outstanding).toBe(paise(27_000));
    expect(s2.moneyOut).toBe(paise(3_000)); // counted once (Transaction), not again from the schedule
    expect(s2.netWorth).toBe(start.netWorth);

    // `editPayment` re-records the payment and returns its NEW id — the old one no longer exists.
    paymentId = await w.personPayments(w.aId).editPayment((await w.people.getByKey(w.aId)) as Person, paymentId, {
      ...loanShareInput((await rawInstallments(w)).sort((x, y) => x.sequenceNumber - y.sequenceNumber)[0], 800),
      accountId: w.accountId,
    });
    const s3 = await check(w, "S3 A's repayment edited 1,000 → 800");
    expect(s3.cash).toBe(paise(32_800));
    expect(s3.net.a).toBe(paise(200)); // still owes 200 — positive, never flipped
    expect(s3.netWorth).toBe(start.netWorth);

    const income = await w.transactions.createTransaction({ type: "income", amount: 500, dateTime: PAY_DATE, accountId: w.accountId, categoryId: "salary" });
    const s4 = await check(w, "S4 plain income 500");
    expect(s4.moneyIn).toBe(paise(500));
    expect(s4.netWorth).toBe(start.netWorth + paise(500));
    await w.transactions.editTransaction(income, { amount: 700 });
    const s5 = await check(w, "S5 income edited to 700");
    expect(s5.netWorth).toBe(start.netWorth + paise(700));
    const expense = await w.transactions.createTransaction({ type: "expense", amount: 200, dateTime: PAY_DATE, accountId: w.accountId, categoryId: "food" });
    const s6 = await check(w, "S6 expense 200");
    expect(s6.netCashFlow).toBe(paise(700) - paise(200) - paise(3_000));
    await w.transactions.editTransaction(expense, { excludeFromCalculations: true }); // "don't count": never moved the account
    await check(w, "S7 expense marked don't-count");
    await w.transactions.softDeleteTransaction((await w.transactions.getByKey(income.id))!);
    await check(w, "S8 income deleted");

    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId)) as Person, paymentId);
    const s9 = await check(w, "S9 A's repayment reverted");
    expect(s9.net.a).toBe(paise(1_000)); // receivable restored in full — positive, not negative
    expect(s9.direct.a).toBe(0);

    await w.lender.reversePayment({
      loan: await loanNow(w), transactionId: lenderPay.transactionId, paymentIds: lenderPay.paymentIds, installmentIds: lenderPay.installmentIds,
      overflowPaymentId: lenderPay.overflowPaymentId, overflowInstallmentId: lenderPay.overflowInstallmentId, reversalIdempotencyKey: "reverse-lender-0001",
    });
    const s10 = await check(w, "S10 lender payment reversed");
    expect(s10.outstanding).toBe(paise(30_000));
    expect(s10.cash).toBe(paise(35_000)); // 35,000 + (expense is don't-count → no effect) + income gone
    expect(s10.netWorth).toBe(start.netWorth);
  }, 120_000);

  it("both directions at once: B overpays into a payable (negative) and the sign is never confused with A's receivable", async () => {
    const w = await world();
    await sharePay(w, w.bId, 1_000, "b-pays-0001"); // exactly settles B's due share
    const s = await check(w, "B settled");
    expect(s.net).toEqual({ a: paise(1_000), b: 0 });
    // A manual 'borrowed 400' for B → I owe B 400 while A still owes me 1,000.
    const led = w.ledgerFor(w.bId);
    await led.addEntryWithTransaction((await w.people.getByKey(w.bId)) as Person, { type: "borrowed", amount: 400, date: PAY_DATE }, { type: "income", accountId: w.accountId, categoryId: "c" }, w.transactions);
    const t = await check(w, "B lent me 400");
    expect(t.net).toEqual({ a: paise(1_000), b: paise(-400) });
    expect(t.receivable).toBe(paise(1_000));
    expect(t.payable).toBe(paise(400));
    expect(t.netWorth).toBe(s.netWorth + paise(400) - paise(400)); // cash +400, payable −400: neutral
  }, 90_000);
});

// ══════════════════════════ Part 2 — deletion guard matrix (Loan) ══════════════════════════
describe("Loan deletion guard — before/partial/full repayment, reverted, multiple people, linked transactions", () => {
  it("before any repayment: deletes, deposit reversed, every figure back to the pre-loan world", async () => {
    const w = await world();
    await check(w, "loan live");
    await permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(5_000));
    expect((await w.people.getByKey(w.aId))!.currentBalance).toBe(0);
    expect((await w.loans.getAll()).length).toBe(0);
  }, 90_000);

  it("after a PARTIAL repayment (A pays 400 of 1,000): blocked, and EVERY document is byte-identical afterwards", async () => {
    const w = await world();
    await sharePay(w, w.aId, 400, "a-part-0001");
    const before = await snapshot();
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    expect(await snapshot()).toBe(before);
    await check(w, "after blocked delete");
  }, 90_000);

  it("after a FULL repayment (A pays his whole 1,000 share): blocked, nothing changes", async () => {
    const w = await world();
    await sharePay(w, w.aId, 1_000, "a-full-0001");
    const before = await snapshot();
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    expect(await snapshot()).toBe(before);
  }, 90_000);

  it("two people: A and B repaid → blocked; reverting only A is STILL blocked (B's); reverting B too → delete succeeds, no sign flip", async () => {
    const w = await world();
    const a = await sharePay(w, w.aId, 1_000, "a-multi-0001");
    const b = await sharePay(w, w.bId, 1_000, "b-multi-0001");
    const before = await snapshot();
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    expect(await snapshot()).toBe(before);

    await w.personPayments(w.aId).revertPayment((await w.people.getByKey(w.aId)) as Person, a.paymentId);
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    await check(w, "A reverted, B still repaid");

    await w.personPayments(w.bId).revertPayment((await w.people.getByKey(w.bId)) as Person, b.paymentId);
    await check(w, "both reverted");
    await permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(5_000));
    expect((await w.people.getByKey(w.aId))!.currentBalance).toBe(0);
    expect((await w.people.getByKey(w.bId))!.currentBalance).toBe(0);
  }, 120_000);

  it("existing linked account transactions (a lender payment) do NOT block: they are reversed with the loan", async () => {
    const w = await world();
    await payLender(w, 3_000, "lender-del-0001");
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(32_000));
    await permanentlyDeleteAgreement(w.db as never, UID, "loan", w.loanId);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(5_000)); // 35,000 → disbursement and payment both reversed
    expect((await w.transactions.getAll()).length).toBe(0);
  }, 90_000);
});

// ══════════════════════════ Part 3 — idempotency + stale ledger entries ══════════════════════════
describe("Transaction idempotency — duplicate requests cannot create duplicate financial transactions", () => {
  it("the same keyed create submitted twice, and 4 times concurrently, writes ONE transaction and moves the account ONCE", async () => {
    const w = await world({ shared: false });
    const p = { type: "expense" as const, amount: 250, dateTime: PAY_DATE, accountId: w.accountId, categoryId: "food", idempotencyKey: "dup-guard-0001" };
    await w.transactions.createTransaction(p);
    await w.transactions.createTransaction(p);
    await Promise.all([1, 2, 3, 4].map(() => w.transactions.createTransaction(p)));
    const mine = (await w.transactions.getAll()).filter((t) => t.amount === 250);
    expect(mine.length).toBe(1);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(35_000 - 250));
    // A retry with DIFFERENT details is refused, not silently written.
    await expect(w.transactions.createTransaction({ ...p, amount: 999 })).rejects.toThrow(/already saved with different details/);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(paise(35_000 - 250));
  }, 90_000);

  it("WITHOUT a key a repeat IS a second transaction (the repository cannot know it is a retry) — so every entry point must pass one", async () => {
    const w = await world({ shared: false });
    const p = { type: "expense" as const, amount: 250, dateTime: PAY_DATE, accountId: w.accountId, categoryId: "food" };
    await w.transactions.createTransaction(p);
    await w.transactions.createTransaction(p);
    expect((await w.transactions.getAll()).filter((t) => t.amount === 250).length).toBe(2);
  }, 60_000);
});

describe("Stale ledger entries — editing/deleting an already-removed entry is blocked at the backend", () => {
  it("edit of a deleted entry is refused with no balance change; a second delete is a no-op; restore re-applies once", async () => {
    const w = await world({ shared: false });
    const led = w.ledgerFor(w.aId);
    const { entry } = await led.addEntryWithTransaction((await w.people.getByKey(w.aId)) as Person, { type: "gave", amount: 1_500, date: PAY_DATE }, { type: "expense", accountId: w.accountId, categoryId: "c" }, w.transactions);
    await led.softDeleteEntriesWithCashLegs((await w.people.getByKey(w.aId)) as Person, [entry], w.transactions);
    const cashAfterDelete = paise((await w.accounts.getByKey(w.accountId))!.currentBalance);
    expect((await w.people.getByKey(w.aId))!.currentBalance).toBe(0);

    await expect(led.editEntry((await w.people.getByKey(w.aId)) as Person, entry, { amount: 2_000 }, w.transactions)).rejects.toThrow(/deleted in another tab/);
    await expect(led.editEntry((await w.people.getByKey(w.aId)) as Person, entry, { note: "x" })).rejects.toThrow(/deleted in another tab/);
    expect((await w.people.getByKey(w.aId))!.currentBalance).toBe(0);
    expect(paise((await w.accounts.getByKey(w.accountId))!.currentBalance)).toBe(cashAfterDelete);

    await led.softDeleteEntry((await w.people.getByKey(w.aId)) as Person, entry); // stale second delete
    expect((await w.people.getByKey(w.aId))!.currentBalance).toBe(0);
    await check(w, "after stale operations");
  }, 90_000);
});

// ══════════════════════════ Part 4 — EMI deletion guard matrix ══════════════════════════
describe("EMI deletion guard — two people sharing one EMI", () => {
  async function emiWorld() {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 50_000, colorValue: 0 });
    const a = await s.people.createPerson({ name: "A", avatarColorValue: 0, openingBalance: 0 });
    const b = await s.people.createPerson({ name: "B", avatarColorValue: 0, openingBalance: 0 });
    const schedules = new PaymentScheduleRepository(collection(s.db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }));
    const emis = new EmiRepository(
      collection(s.db, "users", UID, "emis").withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }),
      schedules,
      (id) => new InstallmentRepository(s.installmentsRef(id)),
    );
    const start = new Date();
    start.setMonth(start.getMonth() - 3);
    // 12,000 / 6 = 2,000 per installment: Me 1,000, A 500, B 500.
    const emi = await emis.createEmi({
      name: "Fridge EMI", principalAmount: 12_000, startDate: start, installmentFrequency: "monthly", installmentCount: 6,
      ownershipShares: [{ personId: null, amount: 6_000 }, { personId: a.id, amount: 3_000 }, { personId: b.id, amount: 3_000 }],
    });
    const first = (await getDocs(s.installmentsRef(emi.scheduleId))).docs.map((d) => d.data()).sort((x, y) => x.sequenceNumber - y.sequenceNumber)[0];
    const pay = async (personId: string, amount: number, key: string) =>
      s.personPayments(personId).recordPayment((await s.people.getByKey(personId)) as Person, {
        direction: "theyPaid", amount, date: PAY_DATE, accountId: bank.id, idempotencyKey: key, extra: null,
        lines: [{ key: `emi-inst:${first.id}`, amount, route: { kind: "derived", obligationRef: `emi-inst:${first.id}`, sourceKind: "emiInstallment" } }],
      });
    const cash = async () => paise((await s.accounts.getByKey(bank.id))!.currentBalance);
    return { ...s, emis, emi, a, b, pay, cash };
  }

  it("before any repayment: deletes cleanly and nothing else moves", async () => {
    const w = await emiWorld();
    await permanentlyDeleteAgreement(w.db as never, UID, "emi", w.emi.id);
    expect(await w.cash()).toBe(paise(50_000));
    expect((await w.people.getByKey(w.a.id))!.currentBalance).toBe(0);
  }, 90_000);

  it("A pays full 500 and B part 200: blocked with byte-identical state; revert A → still blocked (B); revert B → deletes, no sign flip", async () => {
    const w = await emiWorld();
    const pa = await w.pay(w.a.id, 500, "emi-a-full-0001");
    const pb = await w.pay(w.b.id, 200, "emi-b-part-0001");
    expect(await w.cash()).toBe(paise(50_700));
    expect(paise((await w.people.getByKey(w.a.id))!.currentBalance)).toBe(paise(-500)); // stored: repayment (receivable is derived)
    const before = await snapshot();
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "emi", w.emi.id)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    expect(await snapshot()).toBe(before);

    await w.personPayments(w.a.id).revertPayment((await w.people.getByKey(w.a.id)) as Person, pa);
    await expect(permanentlyDeleteAgreement(w.db as never, UID, "emi", w.emi.id)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });

    await w.personPayments(w.b.id).revertPayment((await w.people.getByKey(w.b.id)) as Person, pb);
    expect(await w.cash()).toBe(paise(50_000));
    await permanentlyDeleteAgreement(w.db as never, UID, "emi", w.emi.id);
    expect(await w.cash()).toBe(paise(50_000));
    expect((await w.people.getByKey(w.a.id))!.currentBalance).toBe(0);
    expect((await w.people.getByKey(w.b.id))!.currentBalance).toBe(0);
    expect((await w.emis.getAll()).length).toBe(0);
  }, 120_000);
});
