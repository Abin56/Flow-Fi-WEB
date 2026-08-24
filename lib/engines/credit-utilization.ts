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
   */
  principalPaid: number;
}

export interface SharedLimitInput {
  id: string;
  creditLimit: number;
}

export interface CreditCardStanding {
  outstanding: number;
  available: number;
  currentCycleSpend: number;
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

function linkedEmiPrincipalFor(emis: UtilizationEmi[], cardId: string): number {
  return emis
    .filter((e) => e.linkedCreditCardId === cardId && !e.isClosed)
    .reduce((sum, e) => sum + e.principalAmount, 0);
}

function principalRestoredFor(emis: UtilizationEmi[], cardId: string): number {
  return emis
    .filter((e) => e.linkedCreditCardId === cardId && !e.isClosed)
    .reduce((sum, e) => sum + e.principalPaid, 0);
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
