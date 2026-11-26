/**
 * Which accounts an ordinary Loan / Debt repayment may be paid FROM — the picker's rule, nothing else (no write reads this).
 *
 * My own money only: bank, cash, wallet and the like, never a card — the same rule a Loan's creation
 * (`readMovementAccount`) and a card EMI's bank funding already apply, so one card can't quietly pay off a debt.
 *
 * The one exception is a Loan FINANCED on a card (`cardFundedLoanCardId`): that card owns the debt, so charging an
 * installment to it is how it reaches that card's bill. Only that card, and only while the original purchase is NOT
 * already in the card's balance — otherwise the same principal would be billed twice.
 */

import { cardFundedLoanCardId, emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Loan } from "@/lib/models/loan";
import type { Transaction } from "@/lib/models/transaction";

export function loanPayingAccounts<A extends Pick<Account, "id" | "type">>(accounts: readonly A[], ownCardAccountId: string | null = null): A[] {
  return accounts.filter((a) => a.type !== "card" || a.id === ownCardAccountId);
}

/** The card-financed Loan's own card account, when its installments may be charged to it; null for every other Loan. */
export function chargeableOwnCardAccountId(
  loan: Pick<Loan, "direction" | "fundingSource" | "linkedCreditCardId" | "purchaseTransactionId">,
  cards: readonly Pick<CreditCardProfile, "id" | "accountId">[],
  /** Undefined while still loading: whether the purchase is on the card is then unknown, so the card isn't offered. */
  transactions: readonly Transaction[] | undefined,
): string | null {
  const cardId = cardFundedLoanCardId(loan);
  const card = cardId == null ? undefined : cards.find((c) => c.id === cardId);
  if (!card) return null;
  if (loan.purchaseTransactionId == null) return card.accountId;
  if (transactions === undefined) return null;
  const purchase = transactions.find((t) => t.id === loan.purchaseTransactionId);
  return emiPurchaseRepresentedOnCard(loan.purchaseTransactionId, purchase, card.accountId) ? null : card.accountId;
}
