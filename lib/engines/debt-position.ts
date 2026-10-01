/**
 * Debt Planner read model — every liability the user currently owes, normalized into one
 * `DebtPosition[]` so the planner can reason about cards, loans, EMIs and people the same way. Pure: no
 * UI or Firebase, nothing stored. Every figure is taken from the authoritative engine the rest of the app
 * already uses; this file only projects and de-duplicates, it never re-derives a balance.
 *
 * One liability, one position (the same ownership rules as `loan-balance-sheet.ts` / Net Worth):
 *  - Credit card → the card's standing (`creditCardStanding` / `sharedCreditLimitStanding`): statement
 *    outstanding + card-linked EMI principal still locked against it. Cards sharing a limit are ONE
 *    facility, because their standing is pooled. Card purchases are never a second debt: they are what
 *    the outstanding is made of.
 *  - A card-owned EMI / card-funded Loan (Decision 3, `cardFundedLoanCardId`, tracked card) → only on its
 *    card. Its installments are listed on the card (Cases B/C) so the planner sees the monthly amount the
 *    card will bill, but its principal is never added again.
 *  - Borrowed Loan (not card-owned) → outstanding principal (`outstandingPrincipalAfterPrepaymentsFor`).
 *    A Loan borrowed from a Person is that Loan — People only presents it.
 *  - EMI (not card-owned) → outstanding principal (`outstandingPrincipalFor`, same as the balance sheet).
 *  - Person → only what I owe them DIRECTLY through the People ledger (`personPosition`, legacy
 *    Loan-generated entries already removed), net of anything else they owe me that is not a Loan.
 *
 * Ownership (`debt-ownership.ts`) is a SEPARATE view on top of `outstanding`, never a change to it: the
 * lender/issuer holds me liable for the whole outstanding either way. Each position carries `ownership`
 * (`mine + othersTotal + unallocated === outstanding`) from authoritative links only:
 *  - Loan / EMI → its ownership shares (explicit `ownershipShares`, or the legacy beneficiary opt-in).
 *  - Card → unrecovered split/assigned purchase shares charged to that card (`cardPurchaseShares`,
 *    capped per person at what they still owe me directly, so one rupee is never both netted against
 *    what I owe them and attributed to them here), plus card-owned EMI principal by its shares.
 *  - Person payable → all mine.
 *
 * Never debt: a Loan I lent, what a person owes me, transfers, income, a paid expense, a trashed record.
 * Closed Loans/EMIs with principal still recorded stay in the total (Net Worth counts them — closing is
 * not repaying) but are flagged and not projected.
 */

import type { InterestPeriod, InterestType } from "@/lib/engines/interest-calculator";
import {
  fromPaise,
  mineOnly,
  ownershipFromParts,
  ownershipFromShares,
  splitByOwnership,
  splitPaymentByOwnership,
  toPaise,
  type DebtOwnership,
  type OwnershipPart,
  type OwnershipShare,
} from "@/lib/engines/debt-ownership";
import { installmentStatus, remainingAmount, type Installment, type ScheduleType } from "@/lib/models/payment-schedule";

export type DebtSourceType = "creditCard" | "loan" | "emi" | "person";

/** How the planner groups debts on screen — by who the money is owed to. */
export type DebtCategory = "creditCards" | "loans" | "emis" | "people";

export const DEBT_CATEGORY_LABEL: Record<DebtCategory, string> = {
  creditCards: "Credit cards",
  loans: "Loans",
  emis: "EMIs",
  people: "People",
};

/**
 * What FlowFi knows about the interest on a debt.
 *  - `none`: the recorded terms carry no interest (a Loan/EMI with no interest terms, a People balance).
 *  - `schedule`: interest terms exist and are already amortized into the installments' interest portions.
 *  - `unknown`: interest may be charged but FlowFi has no engine for it (credit cards). `statedRatePercent`
 *    is the user's reference figure, never used in any interest calculation.
 */
export type DebtInterest =
  | { kind: "none" }
  | { kind: "schedule"; type: InterestType; ratePercent: number; period: InterestPeriod }
  | { kind: "unknown"; statedRatePercent: number | null };

/**
 * How extra money beyond the schedule can be applied — mirrors each source's real payment flow:
 *  - `reamortize`: installment Loan — the overflow is a principal prepayment and the tail is re-planned by
 *    `reduceTenurePolicy` (`LoanAdvancePaymentRepository`).
 *  - `advanceOnly`: EMI / one-time Loan — extra only pays upcoming installments early (no prepayment path;
 *    the installments keep their interest).
 *  - `flexible`: card / person — any amount up to the balance.
 */
export type ExtraPaymentMode = "reamortize" | "advanceOnly" | "flexible";

/** One future (or overdue) payment the source record already expects. */
export interface ScheduledDebtPayment {
  key: string;
  kind: "installment" | "statement";
  dueDate: Date;
  /** Still owed on it. */
  amount: number;
  /** The part of `amount` that reduces the debt's balance. */
  principal: number;
  /** The part of `amount` that is interest (0 when unknown/none). */
  interest: number;
  /** Label for the plan line, e.g. "EMI 4 of 12" / "Statement due". */
  label: string;
}

export interface DebtComponent {
  label: string;
  amount: number;
  note?: string;
}

export interface DebtWarning {
  debtId: string;
  severity: "info" | "warning";
  message: string;
}

export interface DebtPosition {
  /** `${sourceType}:${sourceId}` — stable across renders. */
  id: string;
  sourceType: DebtSourceType;
  sourceId: string;
  category: DebtCategory;
  name: string;
  /** Who is owed — bank, lender, person, card issuer. */
  lenderName: string | null;
  /** "Credit card", "Bank loan", "Personal borrowing", "EMI", … */
  kindLabel: string;

  /** The amount counted in total debt (principal / card exposure / direct payable). */
  outstanding: number;
  originalPrincipal: number | null;
  /** How the outstanding is made up (card: statement outstanding + locked EMI principal). */
  components: DebtComponent[];

  interest: DebtInterest;
  extraMode: ExtraPaymentMode;
  frequency: ScheduleType | null;

  /** Unpaid scheduled payments (overdue first), oldest due first. */
  schedule: ScheduledDebtPayment[];
  /**
   * Card only: the card's minimum-due % (`CreditCardProfile.minimumDuePercent`), used to project a
   * minimum on the balance no statement or installment covers yet. Null = the card tracks no minimum.
   */
  minimumDuePercent: number | null;

  installmentsPaid: number | null;
  totalInstallments: number | null;
  nextDueDate: Date | null;
  nextDueAmount: number | null;
  /** Past its due date and still unpaid. */
  overdueAmount: number;
  oldestOverdueDate: Date | null;

  /** Card figures, where they exist. */
  card: {
    statementDue: number;
    minimumDue: number | null;
    creditLimit: number;
    available: number;
    utilizationPercent: number;
    cardCount: number;
  } | null;

  /** Who this outstanding economically belongs to — a view on `outstanding`, never a change to it. */
  ownership: DebtOwnership;

  links: { personId?: string; cardId?: string; loanId?: string; emiId?: string };
  /** Not projected by the payoff simulation (still counted in total debt). */
  excludedFromPlan: string | null;
  status: "active" | "overdue" | "closed" | "defaulted";
  warnings: DebtWarning[];
}

// ─────────────────────────── helpers ───────────────────────────

const round2 = (v: number) => Math.round(v * 100) / 100;

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function interestLabel(interest: DebtInterest): string {
  if (interest.kind === "none") return "No interest";
  if (interest.kind === "unknown") {
    return interest.statedRatePercent != null ? `${interest.statedRatePercent}% stated · not modeled` : "Interest not modeled";
  }
  const period = interest.period === "yearly" ? "p.a." : "p.m.";
  return `${interest.ratePercent}% ${period} ${interest.type === "flat" ? "flat" : "reducing"}`;
}

/** Annualized nominal rate, for ordering only. Null when FlowFi has no usable rate. */
export function annualRateForOrdering(interest: DebtInterest): number | null {
  if (interest.kind === "none") return 0;
  if (interest.kind === "unknown") return interest.statedRatePercent;
  return interest.period === "yearly" ? interest.ratePercent : interest.ratePercent * 12;
}

export function hasKnownPositiveInterest(position: DebtPosition): boolean {
  return position.interest.kind === "schedule" && position.interest.ratePercent > 0;
}

/**
 * The unpaid, non-skipped installments of a schedule as planner payments. A partly paid installment
 * keeps only its remainder, with principal/interest prorated exactly like `principalPaidFor`.
 */
export function installmentPayments(installments: readonly Installment[], labelPrefix: string): ScheduledDebtPayment[] {
  const live = installments.filter((i) => i.deletedAt == null && !i.isSkipped);
  const count = live.length;
  return live
    .filter((i) => remainingAmount(i) > 0)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.sequenceNumber - b.sequenceNumber)
    .map((i) => {
      const amount = round2(remainingAmount(i));
      const share = i.amountDue > 0 ? amount / i.amountDue : 1;
      const principal = round2((i.principalPortion ?? i.amountDue) * share);
      const interest = i.principalPortion == null ? 0 : round2(Math.max(amount - principal, 0));
      return {
        key: i.id,
        kind: "installment" as const,
        dueDate: i.dueDate,
        amount,
        principal: Math.min(principal, amount),
        interest,
        label: `${labelPrefix} ${i.sequenceNumber} of ${count}`,
      };
    });
}

function overdueOf(schedule: readonly ScheduledDebtPayment[], now: Date): { amount: number; oldest: Date | null } {
  const today = dayIndex(now);
  const overdue = schedule.filter((p) => dayIndex(p.dueDate) < today);
  return { amount: round2(overdue.reduce((s, p) => s + p.amount, 0)), oldest: overdue[0]?.dueDate ?? null };
}

function installmentsPaidCount(installments: readonly Installment[], now: Date): number {
  return installments.filter((i) => i.deletedAt == null && installmentStatus(i, now) === "paid").length;
}

function scheduleInterest(interest: { type: InterestType; ratePercent: number; period: InterestPeriod } | null): DebtInterest {
  if (interest == null || interest.ratePercent <= 0) return { kind: "none" };
  return { kind: "schedule", type: interest.type, ratePercent: interest.ratePercent, period: interest.period };
}

// ─────────────────────────── inputs ───────────────────────────

export interface LoanDebtInput {
  id: string;
  name: string | null;
  lenderName: string;
  direction: "given" | "taken";
  category: "personal" | "institutional";
  personId: string | null;
  isClosed: boolean;
  loanAmount: number;
  interest: { type: InterestType; ratePercent: number; period: InterestPeriod } | null;
  repaymentType: "oneTime" | "installment";
  installmentFrequency: ScheduleType | null;
  loanType?: string | null;
  installments: readonly Installment[];
  /** `LoanRow.outstandingPrincipal` — `outstandingPrincipalAfterPrepaymentsFor`. */
  outstandingPrincipal: number;
  /** `cardFundedLoanCardId(loan)` when that card is tracked in FlowFi, else null. */
  ownedByCardId: string | null;
  /** `emiPurchaseRepresentedOnCard(...)` for a card-owned Loan (Case A). */
  purchaseRepresented: boolean;
  /** `resolveOwnership(loan, loanAmount)` — absent = all mine. */
  ownershipShares?: readonly OwnershipShare[];
}

export interface EmiDebtInput {
  id: string;
  name: string;
  lenderName: string | null;
  isClosed: boolean;
  isDefaulted: boolean;
  principalAmount: number;
  interest: { type: InterestType; ratePercent: number; period: InterestPeriod } | null;
  installmentFrequency: ScheduleType;
  installments: readonly Installment[];
  /** `outstandingPrincipalFor(principalAmount, installments)` — the balance sheet's EMI figure. */
  outstandingPrincipal: number;
  /** `linkedCreditCardId` when that card is tracked in FlowFi, else null. */
  ownedByCardId: string | null;
  purchaseRepresented: boolean;
  /** `resolveOwnership(emi, principalAmount)` — absent = all mine. */
  ownershipShares?: readonly OwnershipShare[];
}

export interface CardStatementInput {
  id: string;
  dueDate: Date;
  totalAmount: number;
  amountPaid: number;
  minimumDue: number | null;
}

/** One card, or one shared-limit facility (its cards' standing is pooled, so it is one debt). */
export interface CardFacilityInput {
  /** Card id, or the shared limit id. */
  id: string;
  name: string;
  cardIds: string[];
  /** `standing.outstanding` — statements + unbilled spend, payments reconciled. */
  outstanding: number;
  /** `standing.lockedEmiPrincipal` — card-owned EMI / Loan principal no purchase represents (Cases B/C). */
  lockedEmiPrincipal: number;
  creditLimit: number;
  available: number;
  utilizationPercent: number;
  /** Live-total statements with payments reconciled (`useCreditCardStandings().statements`). */
  statements: CardStatementInput[];
  minimumDuePercent: number | null;
  statedInterestRatePercent: number | null;
  /** Unrecovered purchase shares charged to this facility (`cardPurchaseShares`) — absent = none. */
  purchaseShares?: readonly OwnershipPart[];
}

export interface PersonDebtInput {
  personId: string;
  name: string;
  /** From `personPosition`. */
  directBalance: number;
  emiReceivable: number;
  loanReceivable: number;
  loanPayable: number;
  /**
   * GROSS direct obligations (`personDirectGross`). When given they are authoritative: what I owe a person
   * is never reduced by an unrelated amount they owe me, and vice versa. Absent → the legacy net rule.
   */
  directToGive?: number;
  directToReceive?: number;
}

export interface DebtSnapshotInput {
  loans: readonly LoanDebtInput[];
  emis: readonly EmiDebtInput[];
  cards: readonly CardFacilityInput[];
  people: readonly PersonDebtInput[];
  /** Person names for ownership labels. */
  personNames?: Readonly<Record<string, string>>;
  now: Date;
}

export interface DebtSnapshot {
  positions: DebtPosition[];
  total: number;
  byCategory: Record<DebtCategory, number>;
  /** Outstanding on debts whose interest terms are known and non-zero. */
  interestBearing: number;
  /** Outstanding on debts that may carry interest FlowFi cannot model (cards). */
  interestUnknown: number;
  overdue: number;
  /** Money owed TO me — shown so it is visibly excluded, never part of `total`. */
  receivables: { lentLoans: number; people: number };
  /** Ownership across every position: `mine + others + unallocated === total`. */
  ownership: { mine: number; others: number; unallocated: number; byPerson: OwnershipPart[] };
  warnings: DebtWarning[];
}

// ─────────────────────────── adapters ───────────────────────────

const PAID_EPSILON = 0.5;

type PersonNames = Readonly<Record<string, string>> | undefined;
const nameOf = (names: PersonNames) => (id: string) => names?.[id] ?? "Someone";

function agreementOwnership(outstanding: number, shares: readonly OwnershipShare[] | undefined, names: PersonNames): DebtOwnership {
  return shares?.some((x) => x.personId != null) ? ownershipFromShares(outstanding, shares, nameOf(names)) : mineOnly(outstanding);
}

export function loanDebtPosition(input: LoanDebtInput, now: Date, names?: PersonNames): DebtPosition | null {
  if (input.direction !== "taken" || input.ownedByCardId != null) return null;
  const outstanding = round2(Math.max(input.outstandingPrincipal, 0));
  if (outstanding < PAID_EPSILON) return null;

  const id = `loan:${input.id}`;
  const warnings: DebtWarning[] = [];
  const schedule = input.isClosed ? [] : installmentPayments(input.installments, input.repaymentType === "oneTime" ? "Repayment" : "Installment");
  const interest = scheduleInterest(input.interest);
  const personal = input.category === "personal";
  const name = input.name?.trim() || input.lenderName;

  if (input.isClosed) {
    warnings.push({ debtId: id, severity: "warning", message: `${name} is closed in FlowFi but still has principal recorded — counted in total debt, not projected.` });
  } else if (input.installments.filter((i) => i.deletedAt == null).length === 0) {
    warnings.push({ debtId: id, severity: "warning", message: `${name} has no repayment schedule — it is paid only from extra budget.` });
  } else {
    const scheduledPrincipal = schedule.reduce((s, p) => s + p.principal, 0);
    if (outstanding - scheduledPrincipal > 1) {
      warnings.push({ debtId: id, severity: "info", message: `${name}'s remaining installments cover ₹${Math.round(scheduledPrincipal).toLocaleString("en-IN")} of ₹${Math.round(outstanding).toLocaleString("en-IN")} principal — the rest is treated as flexible.` });
    }
  }
  if (input.interest == null && !personal) {
    warnings.push({ debtId: id, severity: "info", message: `No interest terms recorded for ${name} — FlowFi treats it as interest-free.` });
  }

  const overdue = overdueOf(schedule, now);
  const live = input.installments.filter((i) => i.deletedAt == null && !i.isSkipped);
  const reamortizable = input.repaymentType === "installment" && (input.installmentFrequency === "monthly" || input.installmentFrequency === "weekly");

  return {
    id,
    sourceType: "loan",
    sourceId: input.id,
    category: personal ? "people" : "loans",
    name,
    lenderName: input.lenderName,
    kindLabel: personal ? "Borrowed from person" : input.loanType?.trim() || "Loan",
    outstanding,
    originalPrincipal: input.loanAmount,
    components: [{ label: "Outstanding principal", amount: outstanding }],
    interest,
    extraMode: reamortizable ? "reamortize" : "advanceOnly",
    frequency: input.repaymentType === "oneTime" ? "oneTime" : input.installmentFrequency,
    schedule,
    minimumDuePercent: null,
    installmentsPaid: live.length > 0 ? installmentsPaidCount(live, now) : null,
    totalInstallments: live.length > 0 ? live.length : null,
    nextDueDate: schedule[0]?.dueDate ?? null,
    nextDueAmount: schedule[0]?.amount ?? null,
    overdueAmount: overdue.amount,
    oldestOverdueDate: overdue.oldest,
    card: null,
    ownership: agreementOwnership(outstanding, input.ownershipShares, names),
    links: { loanId: input.id, ...(input.personId && personal ? { personId: input.personId } : {}) },
    excludedFromPlan: input.isClosed ? "Closed in FlowFi" : null,
    status: input.isClosed ? "closed" : overdue.amount > 0 ? "overdue" : "active",
    warnings,
  };
}

export function emiDebtPosition(input: EmiDebtInput, now: Date, names?: PersonNames): DebtPosition | null {
  if (input.ownedByCardId != null) return null;
  const outstanding = round2(Math.max(input.outstandingPrincipal, 0));
  if (outstanding < PAID_EPSILON) return null;

  const id = `emi:${input.id}`;
  const warnings: DebtWarning[] = [];
  const schedule = input.isClosed ? [] : installmentPayments(input.installments, "EMI");
  if (input.isClosed) {
    warnings.push({ debtId: id, severity: "warning", message: `${input.name} is closed in FlowFi but still has principal recorded — counted in total debt, not projected.` });
  }
  if (input.isDefaulted) {
    warnings.push({ debtId: id, severity: "warning", message: `${input.name} is marked defaulted.` });
  }
  const overdue = overdueOf(schedule, now);
  const live = input.installments.filter((i) => i.deletedAt == null && !i.isSkipped);

  return {
    id,
    sourceType: "emi",
    sourceId: input.id,
    category: "emis",
    name: input.name,
    lenderName: input.lenderName,
    kindLabel: "EMI",
    outstanding,
    originalPrincipal: input.principalAmount,
    components: [{ label: "Outstanding principal", amount: outstanding }],
    interest: scheduleInterest(input.interest),
    extraMode: "advanceOnly",
    frequency: input.installmentFrequency,
    schedule,
    minimumDuePercent: null,
    installmentsPaid: installmentsPaidCount(live, now),
    totalInstallments: live.length,
    nextDueDate: schedule[0]?.dueDate ?? null,
    nextDueAmount: schedule[0]?.amount ?? null,
    overdueAmount: overdue.amount,
    oldestOverdueDate: overdue.oldest,
    card: null,
    ownership: agreementOwnership(outstanding, input.ownershipShares, names),
    links: { emiId: input.id },
    excludedFromPlan: input.isClosed ? "Closed in FlowFi" : null,
    status: input.isClosed ? "closed" : input.isDefaulted ? "defaulted" : overdue.amount > 0 ? "overdue" : "active",
    warnings,
  };
}

/** A card-owned EMI / Loan, attached to its card facility. */
export interface CardOwnedAgreement {
  cardId: string;
  name: string;
  outstandingPrincipal: number;
  purchaseRepresented: boolean;
  isClosed: boolean;
  installments: readonly Installment[];
  ownershipShares?: readonly OwnershipShare[];
}

export function cardDebtPosition(input: CardFacilityInput, owned: readonly CardOwnedAgreement[], now: Date, names?: PersonNames): DebtPosition | null {
  const outstanding = round2(Math.max(input.outstanding, 0));
  const locked = round2(Math.max(input.lockedEmiPrincipal, 0));
  const exposure = round2(outstanding + locked);
  if (exposure < PAID_EPSILON) return null;

  const id = `creditCard:${input.id}`;
  const warnings: DebtWarning[] = [];
  const today = dayIndex(now);

  const unpaid = input.statements
    .filter((s) => s.totalAmount - s.amountPaid > 0.005)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const minimumTracked = unpaid.length > 0 && unpaid.every((s) => s.minimumDue != null);
  const statementDue = round2(unpaid.reduce((s, st) => s + (st.totalAmount - st.amountPaid), 0));
  const statementItems: ScheduledDebtPayment[] = unpaid.map((s) => {
    const remaining = round2(s.totalAmount - s.amountPaid);
    // Minimum due still unpaid on this statement; the full remainder when the card tracks no minimum.
    const required = s.minimumDue != null ? round2(Math.min(Math.max(s.minimumDue - s.amountPaid, 0), remaining)) : remaining;
    return {
      key: `statement:${s.id}`,
      kind: "statement" as const,
      dueDate: s.dueDate,
      amount: required,
      principal: required,
      interest: 0,
      label: s.minimumDue != null ? "Minimum due" : "Statement due",
    };
  }).filter((p) => p.amount > 0);

  const ownedLocking = owned.filter((o) => !o.isClosed && !o.purchaseRepresented);
  const installmentItems = ownedLocking.flatMap((o) =>
    installmentPayments(o.installments, "EMI").map((p) => ({ ...p, key: `${o.name}:${p.key}`, label: `${o.name} · ${p.label}` })),
  );
  const schedule = [...statementItems, ...installmentItems].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const components: DebtComponent[] = [{ label: "Card outstanding", amount: outstanding, note: "Billed statements + current-cycle spend, payments applied" }];
  if (locked > 0) {
    components.push({ label: "EMI principal on this card", amount: locked, note: ownedLocking.map((o) => o.name).join(", ") || undefined });
  }
  for (const o of owned.filter((x) => x.purchaseRepresented && !x.isClosed)) {
    warnings.push({ debtId: id, severity: "info", message: `${o.name} is inside ${input.name}'s outstanding (its purchase is on the card) — counted once, on the card.` });
  }

  warnings.push({
    debtId: id,
    severity: "info",
    message:
      input.statedInterestRatePercent != null
        ? `${input.name}: card interest isn't calculated by FlowFi — the stated ${input.statedInterestRatePercent}% is used only to rank it under "highest interest first".`
        : `${input.name}: interest rate missing — card interest projection unavailable.`,
  });
  if (unpaid.length === 0 && outstanding > 0) {
    warnings.push({ debtId: id, severity: "info", message: `${input.name}: no statement generated yet for ₹${Math.round(outstanding).toLocaleString("en-IN")} — no due date is known.` });
  } else if (unpaid.length > 0 && !minimumTracked) {
    warnings.push({ debtId: id, severity: "info", message: `${input.name}: minimum due not tracked — the full statement amount is treated as due.` });
  }

  const overdueItems = statementItems.filter((p) => dayIndex(p.dueDate) < today);
  const overdueInstallments = installmentItems.filter((p) => dayIndex(p.dueDate) < today);
  const overdueAll = [...overdueItems, ...overdueInstallments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const overdueAmount = round2(overdueAll.reduce((s, p) => s + p.amount, 0));

  return {
    id,
    sourceType: "creditCard",
    sourceId: input.id,
    category: "creditCards",
    name: input.name,
    lenderName: null,
    kindLabel: input.cardIds.length > 1 ? `Credit card · ${input.cardIds.length} cards, shared limit` : "Credit card",
    outstanding: exposure,
    originalPrincipal: null,
    components,
    interest: { kind: "unknown", statedRatePercent: input.statedInterestRatePercent },
    extraMode: "flexible",
    frequency: null,
    schedule,
    minimumDuePercent: input.minimumDuePercent,
    installmentsPaid: null,
    totalInstallments: null,
    nextDueDate: schedule[0]?.dueDate ?? null,
    nextDueAmount: schedule[0]?.amount ?? null,
    overdueAmount,
    oldestOverdueDate: overdueAll[0]?.dueDate ?? null,
    card: {
      statementDue,
      minimumDue: minimumTracked ? round2(statementItems.reduce((s, p) => s + p.amount, 0)) : null,
      creditLimit: input.creditLimit,
      available: input.available,
      utilizationPercent: input.utilizationPercent,
      cardCount: input.cardIds.length,
    },
    ownership: cardOwnership(input, ownedLocking, exposure, names),
    links: { cardId: input.cardIds[0] },
    excludedFromPlan: null,
    status: overdueAmount > 0 ? "overdue" : "active",
    warnings,
  };
}

/**
 * A card's ownership: unrecovered split/assigned purchase shares, plus each locking card-owned EMI/Loan's
 * outstanding principal split by its ownership shares. The parts never exceed the exposure.
 */
function cardOwnership(input: CardFacilityInput, locking: readonly CardOwnedAgreement[], exposure: number, names: PersonNames): DebtOwnership {
  const parts: OwnershipPart[] = [...(input.purchaseShares ?? [])];
  for (const o of locking) {
    if (!o.ownershipShares?.some((x) => x.personId != null)) continue;
    for (const part of splitByOwnership(Math.max(o.outstandingPrincipal, 0), o.ownershipShares)) {
      if (part.personId != null) parts.push({ personId: part.personId, name: nameOf(names)(part.personId), amount: part.amount });
    }
  }
  return ownershipFromParts(exposure, parts);
}

/** One split/assigned purchase share charged to a card, not yet received back. */
export interface CardPurchaseShare {
  /** Facility id (`CardFacilityInput.id`) the purchase was charged to. */
  facilityId: string;
  personId: string;
  name: string;
  /** Still unrecovered on the share (`remainingAmount` of its settlement installment). */
  unrecovered: number;
  dueDate: Date;
}

/**
 * Attribute unrecovered purchase shares to card facilities. Per person the total is capped at
 * `recoverableByPerson` (what they still owe me directly, net): a share already offset by money I owe
 * them, or already received, is mine. Oldest share first, deterministic.
 */
export function cardPurchaseShares(
  shares: readonly CardPurchaseShare[],
  recoverableByPerson: Readonly<Record<string, number>>,
): Record<string, OwnershipPart[]> {
  const left = new Map(Object.entries(recoverableByPerson).map(([k, v]) => [k, toPaise(Math.max(v, 0))]));
  const byFacility: Record<string, OwnershipPart[]> = {};
  const ordered = [...shares].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.facilityId.localeCompare(b.facilityId));
  for (const s of ordered) {
    const cap = left.get(s.personId) ?? 0;
    const take = Math.min(cap, toPaise(Math.max(s.unrecovered, 0)));
    if (take <= 0) continue;
    left.set(s.personId, cap - take);
    (byFacility[s.facilityId] ??= []).push({ personId: s.personId, name: s.name, amount: fromPaise(take) });
  }
  return byFacility;
}

/**
 * What I owe a person directly (People ledger). With the gross sides (`directToGive`) it is exactly the
 * payable side — never offset by what they owe me (two independent obligations). Legacy callers without
 * them keep the old net rule. A Loan borrowed from them is its own Loan position.
 */
export function personDirectPayable(input: PersonDebtInput): number {
  if (input.directToGive != null) return round2(Math.max(input.directToGive, 0));
  return round2(Math.max(-(input.directBalance + input.emiReceivable + input.loanReceivable), 0));
}

export function personDebtPosition(input: PersonDebtInput): DebtPosition | null {
  const outstanding = personDirectPayable(input);
  if (outstanding < PAID_EPSILON) return null;
  const id = `person:${input.personId}`;
  return {
    id,
    sourceType: "person",
    sourceId: input.personId,
    category: "people",
    name: input.name,
    lenderName: input.name,
    kindLabel: "Personal borrowing",
    outstanding,
    originalPrincipal: null,
    components: [{ label: "You owe (People ledger)", amount: outstanding }],
    interest: { kind: "none" },
    extraMode: "flexible",
    frequency: null,
    schedule: [],
    minimumDuePercent: null,
    installmentsPaid: null,
    totalInstallments: null,
    nextDueDate: null,
    nextDueAmount: null,
    overdueAmount: 0,
    oldestOverdueDate: null,
    card: null,
    ownership: mineOnly(outstanding),
    links: { personId: input.personId },
    excludedFromPlan: null,
    status: "active",
    warnings: [
      {
        debtId: id,
        severity: "info",
        message: `₹${Math.round(outstanding).toLocaleString("en-IN")} owed to ${input.name} has no repayment schedule — it is paid only from extra budget.`,
      },
    ],
  };
}

// ─────────────────────────── snapshot ───────────────────────────

export function buildDebtSnapshot(input: DebtSnapshotInput): DebtSnapshot {
  const { now } = input;
  const owned: CardOwnedAgreement[] = [
    ...input.loans
      .filter((l) => l.direction === "taken" && l.ownedByCardId != null)
      .map((l) => ({
        cardId: l.ownedByCardId!,
        name: l.name?.trim() || l.lenderName,
        outstandingPrincipal: l.outstandingPrincipal,
        purchaseRepresented: l.purchaseRepresented,
        isClosed: l.isClosed,
        installments: l.installments,
        ownershipShares: l.ownershipShares,
      })),
    ...input.emis
      .filter((e) => e.ownedByCardId != null)
      .map((e) => ({
        cardId: e.ownedByCardId!,
        name: e.name,
        outstandingPrincipal: e.outstandingPrincipal,
        purchaseRepresented: e.purchaseRepresented,
        isClosed: e.isClosed,
        installments: e.installments,
        ownershipShares: e.ownershipShares,
      })),
  ];

  const positions: DebtPosition[] = [];
  for (const card of input.cards) {
    const cardIds = new Set(card.cardIds);
    const p = cardDebtPosition(card, owned.filter((o) => cardIds.has(o.cardId)), now, input.personNames);
    if (p) positions.push(p);
  }
  for (const loan of input.loans) {
    const p = loanDebtPosition(loan, now, input.personNames);
    if (p) positions.push(p);
  }
  for (const emi of input.emis) {
    const p = emiDebtPosition(emi, now, input.personNames);
    if (p) positions.push(p);
  }
  for (const person of input.people) {
    const p = personDebtPosition(person);
    if (p) positions.push(p);
  }

  const byCategory: Record<DebtCategory, number> = { creditCards: 0, loans: 0, emis: 0, people: 0 };
  let total = 0;
  let interestBearing = 0;
  let interestUnknown = 0;
  let overdue = 0;
  for (const p of positions) {
    total += p.outstanding;
    byCategory[p.category] += p.outstanding;
    if (hasKnownPositiveInterest(p)) interestBearing += p.outstanding;
    if (p.interest.kind === "unknown") interestUnknown += p.outstanding;
    overdue += p.overdueAmount;
  }
  for (const key of Object.keys(byCategory) as DebtCategory[]) byCategory[key] = round2(byCategory[key]);

  const lentLoans = round2(input.loans.filter((l) => l.direction === "given").reduce((s, l) => s + Math.max(l.outstandingPrincipal, 0), 0));
  const peopleOwedToMe = round2(
    input.people.reduce(
      (s, p) =>
        s +
        (p.directToReceive != null
          ? Math.max(p.directToReceive, 0) + p.emiReceivable + p.loanReceivable
          : Math.max(p.directBalance + p.emiReceivable + p.loanReceivable - p.loanPayable, 0)),
      0,
    ),
  );

  return {
    positions: positions.sort((a, b) => b.outstanding - a.outstanding),
    total: round2(total),
    byCategory,
    interestBearing: round2(interestBearing),
    interestUnknown: round2(interestUnknown),
    overdue: round2(overdue),
    receivables: { lentLoans, people: peopleOwedToMe },
    ownership: snapshotOwnership(positions),
    warnings: positions.flatMap((p) => p.warnings),
  };
}

function snapshotOwnership(positions: readonly DebtPosition[]): DebtSnapshot["ownership"] {
  let mine = 0;
  let others = 0;
  let unallocated = 0;
  const byPerson = new Map<string, OwnershipPart>();
  for (const p of positions) {
    mine += toPaise(p.ownership.mine);
    others += toPaise(p.ownership.othersTotal);
    unallocated += toPaise(p.ownership.unallocated);
    for (const part of p.ownership.others) {
      const prev = byPerson.get(part.personId);
      byPerson.set(part.personId, { ...part, amount: fromPaise(toPaise(prev?.amount ?? 0) + toPaise(part.amount)) });
    }
  }
  return {
    mine: fromPaise(mine),
    others: fromPaise(others),
    unallocated: fromPaise(unallocated),
    byPerson: [...byPerson.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
  };
}

/**
 * This period's REQUIRED lender/issuer payments (`requiredThisPeriod(...).byDebt`, unchanged) split by
 * each debt's ownership: the lender still expects the full `required`; `mine` is my economic share of it
 * and `fromPeople` is what the people it was for are expected to cover.
 */
export function requiredByOwnership(
  byDebt: Readonly<Record<string, number>>,
  positions: readonly DebtPosition[],
): { required: number; mine: number; fromPeople: number; byDebt: Record<string, { required: number; mine: number; fromPeople: number }> } {
  const result: Record<string, { required: number; mine: number; fromPeople: number }> = {};
  let required = 0;
  let mine = 0;
  let fromPeople = 0;
  for (const p of positions) {
    const amount = byDebt[p.id];
    if (!(amount > 0)) continue;
    const split = splitPaymentByOwnership(amount, p.ownership);
    result[p.id] = { required: amount, mine: split.mine, fromPeople: split.others };
    required += toPaise(amount);
    mine += toPaise(split.mine);
    fromPeople += toPaise(split.others);
  }
  return { required: fromPaise(required), mine: fromPaise(mine), fromPeople: fromPaise(fromPeople), byDebt: result };
}
