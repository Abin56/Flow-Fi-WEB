/**
 * Loan & EMI financial lifecycle integrity — create → schedule → dues → full / partial / multiple
 * partial / early / missed / final payment → completion → close / trash, plus card-linked EMIs,
 * card-funded Loans, People, month transitions and double-count prevention. Every figure is an exact
 * ₹ value computed through the same pure engines the Web hooks compose (and Flutter mirrors).
 */

import { describe, expect, it } from "vitest";
import { calculate, evenSplit, type InterestType } from "@/lib/engines/interest-calculator";
import {
  cardFundedLoanCardId,
  cardFundedLoanUtilization,
  creditCardStanding,
  emiPrincipalRestored,
  lockedEmiPrincipalFor,
  type UtilizationEmi,
} from "@/lib/engines/credit-utilization";
import { loanBalanceSheet, netWorthWithLoans } from "@/lib/engines/loan-balance-sheet";
import { countsFromSchedule, dashboardLoanPaidRows, scheduleOnlyLoanFlows, type LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import { outstandingPrincipalFor, principalPaidFor } from "@/lib/engines/loan-outstanding";
import { personPosition, peopleTotals } from "@/lib/engines/person-position";
import { computeUpcomingDues, type DueAgreementInput } from "@/lib/engines/upcoming-dues";
import { defaultEmiPaymentSplit, emiStatusGiven, type Emi } from "@/lib/models/emi";
import { loanStatusGiven, type Loan } from "@/lib/models/loan";
import { installmentStatus, type Installment, type PaymentSchedule } from "@/lib/models/payment-schedule";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";
import { emiToUnifiedAgreement, loanToUnifiedAgreement } from "@/lib/models/unified-finance-agreement";
import { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";

const paise = (v: number) => Math.round(v * 100) / 100;

function buildSchedule(params: {
  principal: number;
  count: number;
  firstDueDate: Date;
  interest?: { type: InterestType; ratePercent: number } | null;
  ownerType?: "loan" | "emi";
  dueDayOfMonth?: number;
}): Installment[] {
  const { principal, count, firstDueDate, interest = null, ownerType = "loan", dueDayOfMonth } = params;
  const periods =
    interest == null
      ? null
      : calculate({
          principal,
          type: interest.type,
          ratePercent: interest.ratePercent,
          period: "yearly",
          installmentCount: count,
          installmentFrequency: "monthly",
          installmentsPerYear: 12,
        }).periods;
  const schedule: PaymentSchedule = {
    id: "sched-1",
    ownerType,
    ownerId: "owner-1",
    totalAmount: periods == null ? principal : periods.reduce((s, p) => s + p.paymentAmount, 0),
    scheduleType: "monthly",
    firstDueDate,
    customIntervalDays: null,
    installmentCount: count,
    notes: "",
    createdAt: firstDueDate,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
  return InstallmentRepository.buildInstallments(schedule, {
    precomputedAmounts: periods?.map((p) => ({ amountDue: p.paymentAmount, principalPortion: p.principalPortion, interestPortion: p.interestPortion })),
    idFor: (n) => `inst-${n}`,
    dueDayOfMonth,
  });
}

/** Mirrors `InstallmentRepository.applyPayment`: amountPaid never exceeds amountDue. */
function pay(installments: Installment[], sequenceNumber: number, amount: number): Installment[] {
  return installments.map((i) =>
    i.sequenceNumber === sequenceNumber ? { ...i, amountPaid: Math.min(paise(i.amountPaid + amount), i.amountDue) } : i,
  );
}

function makeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    personId: null,
    direction: "taken",
    category: "institutional",
    institutionName: "HDFC Bank",
    loanAmount: 60000,
    interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" },
    loanDate: new Date(2026, 8, 5),
    repaymentType: "installment",
    dueDate: null,
    installmentFrequency: "monthly",
    installmentCount: 12,
    notes: "",
    scheduleId: "sched-1",
    isClosed: false,
    createdAt: new Date(2026, 8, 5),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function makeEmi(overrides: Partial<Emi> = {}): Emi {
  return {
    id: "emi-1",
    name: "Phone EMI",
    lenderName: null,
    categoryId: null,
    loanNumber: null,
    loanType: "creditCard",
    branch: null,
    customerId: null,
    sanctionDate: null,
    disbursementDate: null,
    processingFee: 0,
    insuranceAmount: 0,
    extraCharges: 0,
    foreclosureAmount: null,
    prepaymentCharges: null,
    isAutoDebitEnabled: false,
    autoDebitAccount: null,
    isDefaulted: false,
    linkedCreditCardId: null,
    purchaseTransactionId: null,
    beneficiaryPersonId: null,
    principalAmount: 40000,
    interest: null,
    startDate: new Date(2026, 9, 5),
    dueDayOfMonth: null,
    installmentFrequency: "monthly",
    installmentCount: 8,
    endDate: new Date(2027, 4, 5),
    notes: "",
    scheduleId: "sched-1",
    isClosed: false,
    createdAt: new Date(2026, 8, 10),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function agreementInput(installments: Installment[], overrides: Partial<DueAgreementInput> = {}): DueAgreementInput {
  return {
    source: "emi",
    id: "emi-1",
    title: "Phone EMI",
    providerName: null,
    borrowed: true,
    isClosed: false,
    installments,
    linkedCardLabel: null,
    purchaseRepresentedOnCard: false,
    forPersonName: null,
    ...overrides,
  };
}

describe("₹60,000 loan at 12% p.a. reducing balance, 12 monthly installments — payment lifecycle", () => {
  const principal = 60000;
  const initial = buildSchedule({
    principal,
    count: 12,
    firstDueDate: new Date(2026, 8, 5),
    interest: { type: "reducingBalance", ratePercent: 12 },
    dueDayOfMonth: 5,
  });
  const invariant = (installments: Installment[]) => {
    const paid = principalPaidFor(installments);
    const remaining = outstandingPrincipalFor(principal, installments);
    expect(paise(paid + remaining)).toBe(principal);
    const unified = loanToUnifiedAgreement(makeLoan(), installments, new Date(2026, 8, 1));
    expect(paise(unified.paidPrincipal + unified.remainingPrincipal)).toBe(principal);
    return { paid: paise(paid), remaining: paise(remaining) };
  };

  it("generates exactly 12 installments whose principal sums to ₹60,000.00 — no rounding drift", () => {
    expect(initial.map((i) => i.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(initial.map((i) => i.id)).size).toBe(12);
    expect(initial[0].amountDue).toBe(5330.93);
    expect(initial[0].principalPortion).toBe(4730.93);
    expect(initial[0].interestPortion).toBe(600);
    expect(paise(initial.reduce((s, i) => s + (i.principalPortion ?? 0), 0))).toBe(60000);
    expect(invariant(initial)).toEqual({ paid: 0, remaining: 60000 });
  });

  it("full, partial, multiple-partial, early, missed and final payments keep paid + remaining = ₹60,000", () => {
    let s = pay(initial, 1, 5330.93); // full installment #1
    expect(installmentStatus(s[0], new Date(2026, 8, 6))).toBe("paid");
    expect(invariant(s)).toEqual({ paid: 4730.93, remaining: 55269.07 });

    s = pay(s, 2, 2000); // partial #2 — prorated principal share
    expect(installmentStatus(s[1], new Date(2026, 9, 1))).toBe("partiallyPaid");
    const afterPartial = invariant(s);
    expect(afterPartial.paid).toBe(paise(4730.93 + (s[1].principalPortion! * 2000) / s[1].amountDue));

    s = pay(s, 2, 1000); // second partial
    s = pay(s, 2, s[1].amountDue - s[1].amountPaid); // settles the rest
    expect(s[1].amountPaid).toBe(s[1].amountDue);
    expect(invariant(s).paid).toBe(paise(s[0].principalPortion! + s[1].principalPortion!));

    s = pay(s, 3, s[2].amountDue); // early: #3 due 5 Nov, paid in October
    expect(installmentStatus(s[2], new Date(2026, 9, 20))).toBe("paid");

    // #4 (due 5 Dec) missed: overdue in mid-December, and the Loan reads overdue.
    const midDecember = new Date(2026, 11, 15);
    expect(installmentStatus(s[3], midDecember)).toBe("overdue");
    expect(s.some((i) => installmentStatus(i, midDecember) === "overdue")).toBe(true);
    const dues = computeUpcomingDues({ statements: [], agreements: [agreementInput(s, { source: "loan", id: "loan-1" })], now: midDecember });
    expect(dues.items.filter((d) => d.installmentNumber === 4)).toHaveLength(1);
    expect(dues.totals.overdue).toBe(s[3].amountDue);

    for (let n = 4; n <= 12; n++) s = pay(s, n, s[n - 1].amountDue); // …through the final installment
    expect(invariant(s)).toEqual({ paid: 60000, remaining: 0 });
  });

  it("overpaying an installment is clamped — it never reduces principal beyond the schedule", () => {
    const s = pay(initial, 1, 999999);
    expect(s[0].amountPaid).toBe(s[0].amountDue);
    expect(invariant(s).remaining).toBe(55269.07);
  });
});

describe("rounding — the schedule always amortizes exactly the principal", () => {
  it.each([
    [60000, 12, null],
    [40000, 7, null],
    [99999.99, 13, { type: "flat" as const, ratePercent: 10.5 }],
    [60000, 12, { type: "reducingBalance" as const, ratePercent: 12 }],
    [150000, 60, { type: "reducingBalance" as const, ratePercent: 18 }],
    [33333.33, 36, { type: "flat" as const, ratePercent: 14 }],
  ])("₹%s over %s installments (%o)", (principal, count, interest) => {
    const installments = buildSchedule({ principal, count, firstDueDate: new Date(2026, 8, 5), interest });
    const principalTotal = installments.reduce((s, i) => s + (i.principalPortion ?? i.amountDue), 0);
    expect(paise(principalTotal)).toBe(principal);
    const allPaid = installments.map((i) => ({ ...i, amountPaid: i.amountDue }));
    expect(paise(outstandingPrincipalFor(principal, allPaid))).toBe(0);
    expect(paise(principalPaidFor(allPaid))).toBe(principal);
  });

  it("evenSplit never loses or invents a paisa", () => {
    for (const [total, count] of [[60000, 7], [40000, 3], [100, 3], [99999.99, 11]]) {
      expect(paise(evenSplit(total, count).reduce((s, v) => s + v, 0))).toBe(total);
    }
  });
});

describe("completion and closure", () => {
  it("a fully repaid EMI is completed: nothing outstanding, no next due, no dues, no liability", () => {
    const installments = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), ownerType: "emi" }).map((i) => ({
      ...i,
      amountPaid: i.amountDue,
    }));
    const emi = makeEmi();
    expect(emiStatusGiven(emi, installments)).toBe("completed");
    const unified = emiToUnifiedAgreement(emi, installments, null, new Date(2027, 5, 1));
    expect(unified.remainingPrincipal).toBe(0);
    expect(unified.liabilityPrincipal).toBe(0);
    expect(unified.nextDueDate).toBeNull();
    expect(computeUpcomingDues({ statements: [], agreements: [agreementInput(installments)], now: new Date(2027, 4, 1) }).items).toEqual([]);
  });

  it("a closed / trashed agreement stops producing future dues, liabilities and person positions", () => {
    const installments = buildSchedule({ principal: 60000, count: 12, firstDueDate: new Date(2026, 8, 5) });
    const now = new Date(2026, 8, 1);
    expect(computeUpcomingDues({ statements: [], agreements: [agreementInput(installments, { isClosed: true })], now }).items).toEqual([]);
    expect(loanToUnifiedAgreement(makeLoan({ isClosed: true, interest: null }), installments, now).liabilityPrincipal).toBe(0);
    expect(loanStatusGiven(makeLoan({ isClosed: true }), installments)).toBe("closed");
    // Trashed Loans leave the People position — but a legacy Loan-generated ledger entry is still recognised.
    const position = personPosition({
      personId: "anu",
      currentBalance: 60000,
      loans: [{ id: "loan-1", personId: "anu", direction: "given", outstandingPrincipal: 60000, isDeleted: true }],
      ledgerEntries: [{ transactionRef: "loan-1", signedAmount: 60000, isDeleted: false }],
      loanIds: new Set(["loan-1"]),
    });
    expect(position.net).toBe(0);
  });
});

describe("Credit Card-linked EMI — ₹40,000 principal on an ₹80,000 card", () => {
  const card = { id: "card-1", statementDay: 5, creditLimit: 80000 };
  const standingFor = (emis: UtilizationEmi[], currentCycle = 0) =>
    creditCardStanding({ card, statements: [], currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(), totalAmount: currentCycle }, emis });

  function restoredAfter(installments: Installment[]): number {
    // Every payment is recorded with the Web default breakdown (`defaultEmiPaymentSplit`).
    const payments = installments.filter((i) => i.amountPaid > 0).map((i) => ({ id: `pay-${i.id}`, installmentId: i.id, amount: i.amountPaid, deletedAt: null }));
    const breakdowns = new Map(payments.map((p) => [p.id, defaultEmiPaymentSplit(installments.find((i) => i.id === p.installmentId)!, p.amount).principalPaid]));
    return emiPrincipalRestored(installments, payments, breakdowns);
  }

  it("no interest: ₹40,000 available at start, recovers ₹5,000 per installment, ₹80,000 when complete", () => {
    let installments = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), ownerType: "emi" });
    const lockFor = () => [{ linkedCreditCardId: "card-1", isClosed: false, principalAmount: 40000, principalPaid: restoredAfter(installments) }];
    expect(standingFor(lockFor()).available).toBe(40000);
    installments = pay(installments, 1, 5000);
    expect(standingFor(lockFor()).available).toBe(45000);
    expect(standingFor(lockFor()).lockedEmiPrincipal).toBe(35000);
    for (let n = 2; n <= 8; n++) installments = pay(installments, n, 5000);
    expect(standingFor(lockFor()).available).toBe(80000);
    expect(standingFor(lockFor()).lockedEmiPrincipal).toBe(0);
  });

  it("with interest: only principal restores credit — the lock always equals outstanding principal", () => {
    let installments = buildSchedule({
      principal: 40000,
      count: 8,
      firstDueDate: new Date(2026, 9, 5),
      interest: { type: "reducingBalance", ratePercent: 15 },
      ownerType: "emi",
    });
    for (let n = 1; n <= 8; n++) {
      installments = pay(installments, n, installments[n - 1].amountDue);
      const locked = lockedEmiPrincipalFor([{ linkedCreditCardId: "card-1", isClosed: false, principalAmount: 40000, principalPaid: restoredAfter(installments) }], "card-1");
      expect(paise(locked)).toBe(paise(outstandingPrincipalFor(40000, installments)));
    }
  });

  it("a partial EMI payment splits principal/interest by the installment's own ratio and never exceeds the amount", () => {
    const [first] = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), interest: { type: "reducingBalance", ratePercent: 15 }, ownerType: "emi" });
    const split = defaultEmiPaymentSplit(first, 2000);
    expect(paise(split.principalPaid + split.interestPaid)).toBe(2000);
    expect(split.principalPaid).toBe(paise((2000 * first.principalPortion!) / first.amountDue));
    expect(defaultEmiPaymentSplit({ amountDue: 5000, principalPortion: null }, 5000)).toEqual({ principalPaid: 5000, interestPaid: 0 });
  });

  it("closing the EMI releases its remaining lock", () => {
    expect(standingFor([{ linkedCreditCardId: "card-1", isClosed: true, principalAmount: 40000, principalPaid: 10000 }]).available).toBe(80000);
  });

  it("assigning the EMI to a person (beneficiary) never changes the card or creates a receivable", () => {
    const emi = makeEmi({ linkedCreditCardId: "card-1", beneficiaryPersonId: "anu" });
    const installments = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), ownerType: "emi" });
    expect(emiToUnifiedAgreement(emi, installments, null).personId).toBeNull();
    expect(emiToUnifiedAgreement(emi, installments, null).cardOwnedLiability).toBe(40000);
    const anu = personPosition({ personId: "anu", currentBalance: 0, loans: [], ledgerEntries: [], loanIds: new Set() });
    expect(anu.net).toBe(0);
  });
});

describe("double-count prevention — one ₹40,000 obligation is counted once", () => {
  const card = { id: "card-1", statementDay: 5, creditLimit: 80000 };
  const bank = 200000;

  it("card-linked EMI, no recorded purchase (Case B): ₹40,000 locked, never also an EMI liability", () => {
    const standing = creditCardStanding({ card, statements: [], currentCycleStatement: null, emis: [{ linkedCreditCardId: "card-1", isClosed: false, principalAmount: 40000, principalPaid: 0 }] });
    const sheet = loanBalanceSheet([], [{ outstandingPrincipal: 40000, ownedByTrackedCard: true }], standing.lockedEmiPrincipal);
    expect(sheet.emiPrincipal + sheet.borrowedPrincipal + sheet.cardLockedEmiPrincipal + standing.outstanding).toBe(40000);
    expect(netWorthWithLoans(bank, sheet)).toBe(160000);
  });

  it("card-funded Loan with its ₹40,000 purchase on the card (Case A): card account only — not Loan + card", () => {
    const loan = makeLoan({
      loanAmount: 40000,
      interest: null,
      agreementKind: "installmentPurchase",
      fundingSource: "creditCard",
      linkedCreditCardId: "card-1",
      purchaseTransactionId: "p",
    });
    const cardId = cardFundedLoanCardId(loan)!;
    const utilization = cardFundedLoanUtilization({ linkedCreditCardId: cardId, isClosed: false, loanAmount: 40000, outstandingPrincipal: 40000, purchaseRepresented: true });
    const standing = creditCardStanding({ card, statements: [], currentCycleStatement: { periodStart: new Date(0), periodEnd: new Date(), totalAmount: 40000 }, emis: [utilization] });
    const sheet = loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 40000, ownedByTrackedCard: true }], [], standing.lockedEmiPrincipal);
    const cardAccountBalance = -40000;
    expect(standing.outstanding + standing.lockedEmiPrincipal + sheet.borrowedPrincipal).toBe(40000);
    expect(netWorthWithLoans(bank + cardAccountBalance, sheet)).toBe(160000);
    // The unified workspace agrees: the plan shows no liability of its own.
    expect(loanToUnifiedAgreement(loan, [], { cardAccountId: "acct", purchase: { id: "p", accountId: "acct", deletedAt: null, excludeFromCalculations: false, transferId: null } }).liabilityPrincipal).toBe(0);
  });

  it("only a borrowed Loan financed on a card is card-owned", () => {
    expect(cardFundedLoanCardId({ direction: "taken", fundingSource: "creditCard", linkedCreditCardId: "card-1" })).toBe("card-1");
    expect(cardFundedLoanCardId({ direction: "given", fundingSource: "creditCard", linkedCreditCardId: "card-1" })).toBeNull();
    expect(cardFundedLoanCardId({ direction: "taken", fundingSource: "bank", linkedCreditCardId: null })).toBeNull();
    expect(cardFundedLoanCardId({ direction: "taken", fundingSource: "creditCard", linkedCreditCardId: null })).toBeNull();
  });

  it("a card-linked installment already inside the card bill (Case A) is listed but not counted twice in dues", () => {
    const installments = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), ownerType: "emi" });
    const dues = computeUpcomingDues({
      statements: [{ cardId: "card-1", cardLabel: "HDFC", statementId: "st-1", dueDate: new Date(2026, 9, 25), remainingAmount: 45000, isPaid: false }],
      agreements: [agreementInput(installments, { linkedCardLabel: "HDFC", purchaseRepresentedOnCard: true })],
      now: new Date(2026, 9, 1),
    });
    expect(dues.totals.total).toBe(45000);
    expect(dues.totals.includedInCardBills).toBe(5000);
  });

  it("a Loan payment linked to its Transaction is counted by the Transaction only, never again from the schedule", () => {
    const payments: LoanScheduledPayment[] = [
      { direction: "taken", installmentDueDate: new Date(2026, 9, 5), amount: 5330.93, date: new Date(2026, 9, 5), transactionId: "txn-1", deletedAt: null },
      { direction: "taken", installmentDueDate: new Date(2026, 10, 5), amount: 5330.93, date: new Date(2026, 10, 5), transactionId: null, deletedAt: null },
    ];
    expect(countsFromSchedule(payments[0])).toBe(false);
    const all = { start: new Date(2026, 0, 1), end: new Date(2026, 11, 31, 23, 59, 59) };
    expect(scheduleOnlyLoanFlows(payments, all, "paymentDate").moneyOut).toBe(5330.93);
    expect(dashboardLoanPaidRows(payments)).toHaveLength(1);
  });
});

describe("month transitions — created September, first due October, paid October, next due November", () => {
  const month = (y: number, m: number) => ({ start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59, 999) });

  it("each month shows only its own installment; the principal itself never enters monthly cash flow", () => {
    // EMI of ₹40,000 created 10 Sep, first EMI 5 Oct, 8 monthly installments of ₹5,000.
    let installments = buildSchedule({ principal: 40000, count: 8, firstDueDate: new Date(2026, 9, 5), ownerType: "emi" });
    expect(installments.slice(0, 3).map((i) => i.dueDate.getMonth())).toEqual([9, 10, 11]);

    const sep = computeUpcomingDues({ statements: [], agreements: [agreementInput(installments)], now: new Date(2026, 8, 20) });
    expect(sep.items.map((d) => d.installmentNumber)).toEqual([1]);
    expect(sep.totals.total).toBe(5000);

    installments = pay(installments, 1, 5000); // paid 5 Oct
    const oct = computeUpcomingDues({ statements: [], agreements: [agreementInput(installments)], now: new Date(2026, 9, 20) });
    expect(oct.items.map((d) => d.installmentNumber)).toEqual([2]);
    expect(oct.items.map((d) => d.key)).toEqual(["emi:emi-1:inst-2"]);

    // Advancing the month never regenerates or duplicates an installment.
    const nov = computeUpcomingDues({ statements: [], agreements: [agreementInput(installments)], now: new Date(2026, 10, 1) });
    expect(nov.items.map((d) => d.installmentNumber)).toEqual([2]);
    expect(new Set(installments.map((i) => i.sequenceNumber)).size).toBe(8);

    // Legacy (schedule-only) loan payments land in the month they were paid — never the principal.
    const loanPayments: LoanScheduledPayment[] = [
      { direction: "taken", installmentDueDate: new Date(2026, 9, 5), amount: 5000, date: new Date(2026, 9, 5), transactionId: null, deletedAt: null },
    ];
    expect(scheduleOnlyLoanFlows(loanPayments, month(2026, 8), "paymentDate").moneyOut).toBe(0);
    expect(scheduleOnlyLoanFlows(loanPayments, month(2026, 9), "paymentDate").moneyOut).toBe(5000);
    expect(scheduleOnlyLoanFlows(loanPayments, month(2026, 10), "paymentDate").moneyOut).toBe(0);
    // The ₹40,000 origination movement is a principal disbursement: excluded from income/expense.
    expect(isNonIncomeExpenseMovement({ transferId: null, loanId: "loan-1", paymentAllocationType: "additionalDisbursement" })).toBe(true);
    expect(isNonIncomeExpenseMovement({ transferId: null, loanId: "loan-1", paymentAllocationType: "regularEmi" })).toBe(false);
  });

  it("a Loan dated the 31st keeps its due day through short months (Web now matches Flutter)", () => {
    const installments = buildSchedule({ principal: 60000, count: 5, firstDueDate: new Date(2027, 0, 31), dueDayOfMonth: 31 });
    expect(installments.map((i) => `${i.dueDate.getMonth() + 1}/${i.dueDate.getDate()}`)).toEqual(["1/31", "2/28", "3/31", "4/30", "5/31"]);
  });
});

describe("People — independent obligations, never duplicated", () => {
  // ₹60,000 lent across two people as two Loans: Anu ₹36,000, Ravi ₹24,000.
  const anuSchedule = buildSchedule({ principal: 36000, count: 12, firstDueDate: new Date(2026, 9, 5) });
  const raviSchedule = buildSchedule({ principal: 24000, count: 12, firstDueDate: new Date(2026, 9, 5) });

  it("a partial settlement by one person reduces only that person's outstanding", () => {
    const anuPaid = pay(pay(anuSchedule, 1, 3000), 2, 1500); // one full + one partial
    const loans = [
      { id: "loan-anu", personId: "anu", direction: "given" as const, outstandingPrincipal: outstandingPrincipalFor(36000, anuPaid), isDeleted: false },
      { id: "loan-ravi", personId: "ravi", direction: "given" as const, outstandingPrincipal: outstandingPrincipalFor(24000, raviSchedule), isDeleted: false },
    ];
    const common = { currentBalance: 0, loans, ledgerEntries: [], loanIds: new Set(["loan-anu", "loan-ravi"]) };
    const anu = personPosition({ personId: "anu", ...common });
    const ravi = personPosition({ personId: "ravi", ...common });
    expect(anu.owesMe).toBe(31500);
    expect(ravi.owesMe).toBe(24000);
    const totals = peopleTotals([anu, ravi]);
    expect(totals.totalOwedToMe).toBe(55500);
    expect(totals.totalOwedToMe).toBeLessThanOrEqual(60000);
  });

  it("each person's monthly dues stay separately identifiable, one per installment, with the right amount", () => {
    const now = new Date(2026, 9, 1);
    const dues = computeUpcomingDues({
      statements: [],
      agreements: [
        agreementInput(anuSchedule, { source: "loan", id: "loan-anu", forPersonName: "Anu" }),
        agreementInput(raviSchedule, { source: "loan", id: "loan-ravi", forPersonName: "Ravi" }),
      ],
      now,
    });
    expect(dues.items.map((d) => [d.forPersonName, d.installmentNumber, d.amount, d.dueDate.getDate()])).toEqual([
      ["Anu", 1, 3000, 5],
      ["Ravi", 1, 2000, 5],
    ]);
    expect(new Set(dues.items.map((d) => d.key)).size).toBe(dues.items.length);
    expect(dues.totals.loan).toBe(5000);
  });

  it("a borrowed Loan taken for someone (beneficiary) creates no Person receivable or payable", () => {
    const loans = [{ id: "loan-1", personId: null, direction: "taken" as const, outstandingPrincipal: 40000, isDeleted: false }];
    const anu = personPosition({ personId: "anu", currentBalance: 0, loans, ledgerEntries: [], loanIds: new Set(["loan-1"]) });
    expect([anu.owesMe, anu.iOwe]).toEqual([0, 0]);
  });
});
