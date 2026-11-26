/**
 * What the payment screens say about a Loan / EMI whose money sits on a credit card. Display only — the write layer
 * makes its own check on freshly read records (`direct-issuer-guard.ts`).
 */

import { cardFundedLoanCardId, emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Loan } from "@/lib/models/loan";
import type { Emi } from "@/lib/models/emi";
import type { Transaction } from "@/lib/models/transaction";

export interface CardPaymentContext {
  /** A card-linked EMI, or a taken Loan financed on a card: what is owed goes to the card issuer. */
  onCard: boolean;
  /** The original purchase is already in the card balance, so a direct issuer payment can't be recorded. */
  purchaseOnCard: boolean;
  /** Who the money goes to, in words. */
  payee: "lender" | "card issuer";
}

export function cardBillPaymentHref(cardId: string): string {
  return `/credit-cards?card=${encodeURIComponent(cardId)}&pay=1`;
}

export function cardPaymentContext(
  source:
    | { kind: "emi"; emi: Pick<Emi, "linkedCreditCardId" | "purchaseTransactionId">; cardAccountId: string | null }
    | { kind: "loan"; loan: Pick<Loan, "direction" | "fundingSource" | "linkedCreditCardId" | "purchaseTransactionId"> }
    | null,
  transactions: readonly Transaction[],
): CardPaymentContext {
  const onCard = source != null && (source.kind === "emi" ? source.emi.linkedCreditCardId != null : cardFundedLoanCardId(source.loan) != null);
  if (!onCard || source == null) return { onCard: false, purchaseOnCard: false, payee: "lender" };
  const purchaseId = (source.kind === "emi" ? source.emi.purchaseTransactionId : source.loan.purchaseTransactionId) ?? null;
  const purchase = purchaseId == null ? undefined : transactions.find((t) => t.id === purchaseId);
  // A card Loan's purchase was checked against its card when it was linked, so only "is it still counted" is asked here.
  const cardAccountId = source.kind === "emi" ? source.cardAccountId : (purchase?.accountId ?? null);
  const purchaseOnCard = cardAccountId != null && emiPurchaseRepresentedOnCard(purchaseId, purchase, cardAccountId);
  return { onCard, purchaseOnCard, payee: "card issuer" };
}
