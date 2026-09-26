/**
 * Loan / EMI principal classified by who owes whom — the single place Reports and Net Worth get
 * "how much do I owe / how much am I owed" from. Pure — no UI or Firebase dependency.
 *
 * Rules (principal only — future, unearned/unaccrued interest is never counted as a current
 * liability or receivable; the schedule does not capitalize it):
 *  - Loan, "taken" (money I borrowed)  → liability = outstanding principal, UNLESS it was financed on a
 *    Credit Card tracked in FlowFi (`ownedByTrackedCard`): exactly like a card-linked EMI below.
 *  - Loan, "given" (money I lent)      → receivable (asset) = outstanding principal.
 *  - EMI (always money I owe)          → liability = outstanding principal,
 *    UNLESS it is linked to a Credit Card tracked in FlowFi: the card is the canonical owner of that
 *    liability (Decision 3), so it is reported once, on the card side, as the card's locked EMI
 *    principal (`creditCardStanding().lockedEmiPrincipal`) — never again here.
 *
 * Closed items are still included, matching the previous Reports behaviour (a user closing a loan
 * with principal left is not the same as that principal being repaid).
 */

import type { LoanDirection } from "@/lib/models/loan";

export interface LoanPrincipalPosition {
  direction: LoanDirection;
  /** From `outstandingPrincipalAfterPrepaymentsFor` — already net of extra principal. */
  outstandingPrincipal: number;
  /**
   * True only for a borrowed Loan financed on a Credit Card tracked in FlowFi (`cardFundedLoanCardId`).
   * Like a card-linked EMI, the card owns that liability, so it is reported on the card side (its locked
   * principal, or the represented purchase) and never again as "borrowed".
   */
  ownedByTrackedCard?: boolean;
}

export interface EmiPrincipalPosition {
  outstandingPrincipal: number;
  /** True only when `linkedCreditCardId` resolves to a Credit Card tracked in FlowFi. */
  ownedByTrackedCard: boolean;
}

export interface LoanBalanceSheet {
  /** Principal I still owe on money I borrowed (Loans). */
  borrowedPrincipal: number;
  /** Principal still owed TO me on money I lent (Loans) — an asset, never a liability. */
  lentPrincipal: number;
  /** Principal I still owe on EMIs not owned by a tracked card. */
  emiPrincipal: number;
  /**
   * EMI / card-funded Loan principal deliberately left out of `emiPrincipal` / `borrowedPrincipal` because a
   * tracked Credit Card owns it — transparency only.
   */
  cardOwnedEmiPrincipal: number;
  /**
   * Card-owned EMI principal still locked against a tracked card because no represented purchase
   * carries it (Cases B/C of `emiPurchaseRepresentedOnCard`) — the card engine's
   * `lockedEmiPrincipal`. A real liability that sits in no account balance, so Net Worth subtracts
   * it exactly once. (Case A needs nothing: the purchase already lowered the card account.)
   */
  cardLockedEmiPrincipal: number;
}

export function loanBalanceSheet(
  loans: LoanPrincipalPosition[],
  emis: EmiPrincipalPosition[],
  cardLockedEmiPrincipal = 0,
): LoanBalanceSheet {
  let borrowedPrincipal = 0;
  let lentPrincipal = 0;
  let cardOwnedEmiPrincipal = 0;
  for (const loan of loans) {
    const principal = Math.max(loan.outstandingPrincipal, 0);
    if (loan.direction === "given") lentPrincipal += principal;
    else if (loan.ownedByTrackedCard) cardOwnedEmiPrincipal += principal;
    else borrowedPrincipal += principal;
  }
  let emiPrincipal = 0;
  for (const emi of emis) {
    const principal = Math.max(emi.outstandingPrincipal, 0);
    if (emi.ownedByTrackedCard) cardOwnedEmiPrincipal += principal;
    else emiPrincipal += principal;
  }
  return { borrowedPrincipal, lentPrincipal, emiPrincipal, cardOwnedEmiPrincipal, cardLockedEmiPrincipal: Math.max(cardLockedEmiPrincipal, 0) };
}

/**
 * Net Worth (Decision 6):
 *   account balances (credit-card accounts included, as today)
 * + principal owed TO me (lent loans)
 * − principal I owe (borrowed loans + EMIs not owned by a tracked card)
 * − card-owned EMI principal no recorded purchase represents (Case B/C, `cardLockedEmiPrincipal`)
 *
 * Credit-card debt is NOT subtracted again here: it is already inside `accountBalances` through the
 * card's own Account, and card-linked EMI principal belongs to the card (Decision 3).
 */
export function netWorthWithLoans(accountBalances: number, sheet: LoanBalanceSheet): number {
  return accountBalances + sheet.lentPrincipal - sheet.borrowedPrincipal - sheet.emiPrincipal - sheet.cardLockedEmiPrincipal;
}
