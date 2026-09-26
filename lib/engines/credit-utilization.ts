/**
 * Direct port of the credit-card standing/utilization formulas in
 * `lib/features/credit_cards/presentation/providers/credit_card_providers.dart`
 * (`_cardOwnStanding`, `_availableFor`, `creditCardStandingProvider`,
 * `sharedCreditLimitStandingProvider`, `_sumStandingAcrossCards`) and
 * `creditUtilizationPercentProvider` in
 * `lib/features/reports/presentation/providers/monthly_financial_report_providers.dart`.
 *
 * Riverpod `ref.watch(...)` reads are replaced with plain parameters — the
 * caller (a repository/hook layer) is responsible for loading the same data
 * these providers watched. No UI or Firebase dependency here.
 */

import { CycleAnchor, classifyForCarryForward, type CycleItem } from "./cycle-engine";

export interface UtilizationStatement {
  id: string;
  /** Statement's period start/end, used only for the same-cycle dedup guard. */
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  totalAmount: number;
  amountPaid: number;
  /** totalAmount - amountPaid, clamped >= 0 — mirrors Statement.remainingAmount. */
  remainingAmount: number;
  /** Statement.status === 'paid' */
  isPaid: boolean;
}

export interface UtilizationCard {
  id: string;
  statementDay: number;
  creditLimit: number;
  sharedLimitId?: string | null;
}

export interface UtilizationEmi {
  linkedCreditCardId?: string | null;
  isClosed: boolean;
  principalAmount: number;
  /**
   * Sum of principal actually repaid so far for this EMI (see
   * principalRestoredForCardProvider). Named to match the Firestore-stored
   * field this is sourced from — `EmiPaymentBreakdown.principalPaid`
   * (lib/models/emi.ts) — which itself matches Flutter's canonical
   * `emi_payment_breakdown.dart` document shape exactly. This engine field
   * is a computed input, not a stored document, so it was free to rename;
   * `EmiPaymentBreakdown.principalPaid` was not renamed, since that field
   * name is real cross-app Firestore parity, not just internal consistency.
   * Build it with `emiPrincipalRestored` so it matches Flutter exactly.
   */
  principalPaid: number;
  /**
   * True when this EMI's `purchaseTransactionId` purchase is still represented in the card's
   * liability (see `emiPurchaseRepresentedOnCard`) — Case A. Such an EMI never locks credit: its
   * purchase is already inside `outstanding`. Absent/false — Cases B and C — the EMI's remaining
   * principal IS the card exposure.
   */
  purchaseRepresented?: boolean;
}

export interface SharedLimitInput {
  id: string;
  creditLimit: number;
}

export interface CreditCardStanding {
  outstanding: number;
  available: number;
  currentCycleSpend: number;
  /**
   * Card-linked EMI principal still locked against the limit (`linkedEmiPrincipal − principalRestored`,
   * floored at 0). The card is the canonical owner of this liability (Decision 3): Reports and Net
   * Worth take card-linked EMI exposure from here, never from the EMI a second time.
   */
  lockedEmiPrincipal: number;
}

function toStatementCycleItem(statement: UtilizationStatement): CycleItem & { statement: UtilizationStatement } {
  return {
    id: statement.id,
    cycleDate: statement.dueDate,
    isSettled: statement.isPaid,
    statement,
  };
}

/**
 * One card's own (outstanding, currentCycleSpend) before any EMI-lock-out
 * or shared-limit pooling is applied — mirrors `_cardOwnStanding`.
 *
 * `currentCycleStatement` is the live, not-yet-materialized current cycle
 * (mirrors `currentStatementCycleProvider`) — pass null if the current
 * cycle has no live total yet.
 */
export function cardOwnStanding(
  card: UtilizationCard,
  statements: UtilizationStatement[],
  currentCycleStatement: { periodStart: Date; periodEnd: Date; totalAmount: number } | null,
): { outstanding: number; currentCycleSpend: number } {
  const unpaidStatements = statements.reduce((sum, s) => sum + s.remainingAmount, 0);

  const alreadyMaterialized =
    currentCycleStatement != null &&
    statements.some(
      (s) =>
        s.periodStart.getTime() === currentCycleStatement.periodStart.getTime() &&
        s.periodEnd.getTime() === currentCycleStatement.periodEnd.getTime(),
    );

  const currentCycleSpend = alreadyMaterialized ? 0 : (currentCycleStatement?.totalAmount ?? 0);
  return { outstanding: unpaidStatements + currentCycleSpend, currentCycleSpend };
}

/**
 * Shared `available` formula — credit limit minus what's owed, minus the
 * full principal of any purchase converted to EMI (tied up until repaid),
 * plus whatever of that principal has already been repaid. Never negative,
 * never above the limit itself. Mirrors `_availableFor`.
 */
export function availableCredit(params: {
  creditLimit: number;
  outstanding: number;
  linkedEmiPrincipal: number;
  principalRestored: number;
}): number {
  const { creditLimit, outstanding, linkedEmiPrincipal, principalRestored } = params;
  const raw = creditLimit - outstanding - linkedEmiPrincipal + principalRestored;
  return Math.min(Math.max(raw, 0), creditLimit);
}

/** Open EMIs linked to `cardId` whose exposure the card carries through the EMI lock (Cases B/C). */
function lockingEmisFor(emis: UtilizationEmi[], cardId: string): UtilizationEmi[] {
  return emis.filter((e) => e.linkedCreditCardId === cardId && !e.isClosed && !e.purchaseRepresented);
}

function linkedEmiPrincipalFor(emis: UtilizationEmi[], cardId: string): number {
  return lockingEmisFor(emis, cardId).reduce((sum, e) => sum + e.principalAmount, 0);
}

function principalRestoredFor(emis: UtilizationEmi[], cardId: string): number {
  return lockingEmisFor(emis, cardId).reduce((sum, e) => sum + e.principalPaid, 0);
}

/** Card-linked EMI principal still locked against `cardId` (Cases B/C), floored at 0. */
export function lockedEmiPrincipalFor(emis: UtilizationEmi[], cardId: string): number {
  return Math.max(linkedEmiPrincipalFor(emis, cardId) - principalRestoredFor(emis, cardId), 0);
}

/**
 * Who owns a card-linked EMI's exposure — the ONE rule available credit, utilization, exposure,
 * Reports and Net Worth all apply. Mirrors Flutter's `emiPurchaseRepresentedOnCard`
 * (`card_emi_ownership.dart`) exactly.
 *
 * The card's liability is the sum of the card account's active, calculable, non-transfer
 * Transactions (live statement totals + the current cycle). `purchase` is the EMI's
 * `purchaseTransactionId` looked up among ACTIVE transactions (a deleted/reversed one is absent):
 *  - Case A — represented: the purchase already carries the exposure; the EMI must not lock again.
 *  - Case B — no link (legacy default / issuer-converted, never recorded): the EMI is the exposure.
 *  - Case C — linked but deleted, excluded, a transfer leg, or on another account: no longer in
 *    this card's liability, so the EMI owns the exposure like Case B.
 * Never matched by amount/date.
 */
export function emiPurchaseRepresentedOnCard(
  purchaseTransactionId: string | null | undefined,
  purchase: { id: string; accountId: string; deletedAt: Date | null; excludeFromCalculations: boolean; transferId: string | null } | null | undefined,
  cardAccountId: string,
): boolean {
  if (purchaseTransactionId == null || purchase == null) return false;
  return (
    purchase.id === purchaseTransactionId &&
    purchase.deletedAt == null &&
    !purchase.excludeFromCalculations &&
    purchase.transferId == null &&
    purchase.accountId === cardAccountId
  );
}

/**
 * The Credit Card that owns a Loan's liability, or null. A borrowed Loan financed on a card (the unified
 * wizard's `fundingSource: "creditCard"` + `linkedCreditCardId`, e.g. a ₹40,000 installment purchase) is
 * the same obligation as a card-linked EMI: the card owns the exposure, so the Loan locks/restores that
 * card's available credit like an EMI and is never counted again as a Loan liability
 * (docs/loans-installments-unification-audit.md §6.5). Same rule as the unified adapter's
 * `cardOwnedLiability`. Mirrors Flutter's `cardFundedLoanCardId` (`card_emi_ownership.dart`).
 */
export function cardFundedLoanCardId(loan: {
  direction: "given" | "taken";
  fundingSource?: string | null;
  linkedCreditCardId?: string | null;
}): string | null {
  return loan.direction === "taken" && loan.fundingSource === "creditCard" && loan.linkedCreditCardId
    ? loan.linkedCreditCardId
    : null;
}

/**
 * A card-funded Loan as a `UtilizationEmi`. Its principal restored is exactly the Loan's repaid principal
 * (`loanAmount − outstandingPrincipal`, extra principal included), so the card's lock always equals the
 * Loan's outstanding principal — never its future interest.
 */
export function cardFundedLoanUtilization(params: {
  linkedCreditCardId: string;
  isClosed: boolean;
  loanAmount: number;
  /** From `outstandingPrincipalAfterPrepaymentsFor`. */
  outstandingPrincipal: number;
  purchaseRepresented: boolean;
}): UtilizationEmi {
  return {
    linkedCreditCardId: params.linkedCreditCardId,
    isClosed: params.isClosed,
    principalAmount: params.loanAmount,
    principalPaid: Math.max(params.loanAmount - params.outstandingPrincipal, 0),
    purchaseRepresented: params.purchaseRepresented,
  };
}

/**
 * Principal repaid on one EMI — mirrors Flutter's `principalRestoredForCardProvider` per-payment
 * rule exactly: a payment's `EmiPaymentBreakdown.principalPaid` when it has one; otherwise its
 * principal share (`amount × principalPortion / amountDue`, or the whole amount for a no-interest
 * installment). Web used to read breakdowns only, so a payment without one restored nothing.
 */
export function emiPrincipalRestored(
  installments: { id: string; amountDue: number; principalPortion: number | null }[],
  payments: { id: string; installmentId: string; amount: number; deletedAt: Date | null }[],
  breakdownPrincipalByPaymentId: ReadonlyMap<string, number>,
): number {
  const installmentById = new Map(installments.map((i) => [i.id, i]));
  let restored = 0;
  for (const payment of payments) {
    if (payment.deletedAt != null) continue;
    const fromBreakdown = breakdownPrincipalByPaymentId.get(payment.id);
    if (fromBreakdown != null) {
      restored += fromBreakdown;
      continue;
    }
    const installment = installmentById.get(payment.installmentId);
    if (installment == null || installment.principalPortion == null || installment.amountDue === 0) {
      restored += payment.amount;
    } else {
      restored += payment.amount * (installment.principalPortion / installment.amountDue);
    }
  }
  return restored;
}

/**
 * A single card's standing (outstanding/available/currentCycleSpend) —
 * mirrors `creditCardStandingProvider` for a card that does NOT draw from a
 * shared credit limit. For shared-limit cards, use
 * `sharedCreditLimitStanding` instead and apply it to every sibling.
 */
export function creditCardStanding(params: {
  card: UtilizationCard;
  statements: UtilizationStatement[];
  currentCycleStatement: { periodStart: Date; periodEnd: Date; totalAmount: number } | null;
  emis: UtilizationEmi[];
}): CreditCardStanding {
  const { card, statements, currentCycleStatement, emis } = params;
  const own = cardOwnStanding(card, statements, currentCycleStatement);
  const linkedEmiPrincipal = linkedEmiPrincipalFor(emis, card.id);
  const principalRestored = principalRestoredFor(emis, card.id);

  return {
    outstanding: own.outstanding,
    available: availableCredit({
      creditLimit: card.creditLimit,
      outstanding: own.outstanding,
      linkedEmiPrincipal,
      principalRestored,
    }),
    currentCycleSpend: own.currentCycleSpend,
    lockedEmiPrincipal: Math.max(linkedEmiPrincipal - principalRestored, 0),
  };
}

/**
 * Pooled standing across every card drawing from the same shared credit
 * limit — mirrors `sharedCreditLimitStandingProvider`. `perCard` must
 * contain one entry per sibling card under this facility.
 */
export function sharedCreditLimitStanding(params: {
  sharedLimit: SharedLimitInput;
  perCard: Array<{
    card: UtilizationCard;
    statements: UtilizationStatement[];
    currentCycleStatement: { periodStart: Date; periodEnd: Date; totalAmount: number } | null;
    emis: UtilizationEmi[];
  }>;
}): CreditCardStanding {
  const { sharedLimit, perCard } = params;

  let totalOutstanding = 0;
  let totalCurrentCycleSpend = 0;
  let totalLinkedEmiPrincipal = 0;
  let totalPrincipalRestored = 0;

  for (const { card, statements, currentCycleStatement, emis } of perCard) {
    const own = cardOwnStanding(card, statements, currentCycleStatement);
    totalOutstanding += own.outstanding;
    totalCurrentCycleSpend += own.currentCycleSpend;
    totalLinkedEmiPrincipal += linkedEmiPrincipalFor(emis, card.id);
    totalPrincipalRestored += principalRestoredFor(emis, card.id);
  }

  return {
    outstanding: totalOutstanding,
    available: availableCredit({
      creditLimit: sharedLimit.creditLimit,
      outstanding: totalOutstanding,
      linkedEmiPrincipal: totalLinkedEmiPrincipal,
      principalRestored: totalPrincipalRestored,
    }),
    currentCycleSpend: totalCurrentCycleSpend,
    lockedEmiPrincipal: Math.max(totalLinkedEmiPrincipal - totalPrincipalRestored, 0),
  };
}

/**
 * Credit Utilization % = total outstanding / total credit limit * 100,
 * guarded against a zero denominator — mirrors `creditUtilizationPercentProvider`.
 * Callers must dedupe shared-limit totals before calling this (count a
 * shared limit's creditLimit/outstanding exactly once), matching
 * `totalCreditLimitProvider`/`totalCreditCardOutstandingProvider`.
 */
export function creditUtilizationPercent(totalOutstanding: number, totalCreditLimit: number): number {
  if (totalCreditLimit === 0) return 0;
  return (totalOutstanding / totalCreditLimit) * 100;
}

/**
 * The two-section carry-forward view for a card's statements — mirrors
 * `statementCycleViewProvider`. `current` is the separately-computed live
 * cycle (pass it in directly), not the engine's own `result.current`.
 */
export function statementCycleView(params: {
  card: UtilizationCard;
  statements: UtilizationStatement[];
  currentCycleStatement: UtilizationStatement | null;
  now?: Date;
}): { previousCyclePending: UtilizationStatement[]; current: UtilizationStatement | null } {
  const { card, statements, currentCycleStatement, now } = params;
  const anchor = new CycleAnchor(card.statementDay);
  const items = statements.map(toStatementCycleItem);
  const result = classifyForCarryForward(items, anchor, now);
  return {
    previousCyclePending: result.previousCyclePending.map((item) => item.statement),
    current: currentCycleStatement,
  };
}
