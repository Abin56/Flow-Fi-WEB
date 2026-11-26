/**
 * "Someone paid the card issuer directly" can only be recorded when FlowFi can show BOTH sides of it.
 *  - The EMI / card Loan holds its own card exposure (no linked purchase): the record releases that locked principal and
 *    bills nothing — the card figures stay right. Supported.
 *  - The original purchase is already in the card balance: nothing in the existing records can lower that balance
 *    without inventing a card credit or a bank transfer. The person would be credited while the card still shows the
 *    money owed. Refused.
 * Only the direct record is limited (`recordedEarlier` + the direct note, `direct-lender-settlement.ts`). Money a
 * person pays ME, payments from my accounts, and "already paid before FlowFi" records are unaffected. Existing direct
 * records are left as they are and can still be corrected downwards or marked unpaid. Documents are only read.
 */

import { doc, type Firestore, type Transaction } from "firebase/firestore";
import { cardFundedLoanCardId, emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import { isDirectLenderPayment } from "@/lib/engines/direct-lender-settlement";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { FirestoreCollections } from "@/lib/firestore/collections";
import type { InstallmentPayment } from "@/lib/models/payment-schedule";

export const DIRECT_ISSUER_UNSUPPORTED_MESSAGE =
  "FlowFi can't record someone paying the card issuer directly for this one: the purchase is already in the card balance, so the person would be marked as paid while the card still showed the money owed. If they gave you the money, record it with Receive. If the card bill was paid, record that payment in Credit Cards.";

export class DirectIssuerPaymentUnsupportedError extends Error {
  constructor() {
    super(DIRECT_ISSUER_UNSUPPORTED_MESSAGE);
    this.name = "DirectIssuerPaymentUnsupportedError";
  }
}

type DirectShape = Pick<InstallmentPayment, "amount" | "recordedEarlier" | "note" | "deletedAt">;

const directTotal = (payments: readonly DirectShape[]) => payments.filter(isDirectLenderPayment).reduce((t, p) => t + p.amount, 0);

/** The card carrying this agreement's money, if any: a card-linked EMI, or a taken Loan financed on a card. */
export function cardAgreementCardId(
  kind: "loan" | "emi",
  agreement: { linkedCreditCardId?: string | null; direction?: "given" | "taken"; fundingSource?: string | null },
): string | null {
  if (kind === "emi") return agreement.linkedCreditCardId ?? null;
  return cardFundedLoanCardId({ direction: agreement.direction ?? "given", fundingSource: agreement.fundingSource, linkedCreditCardId: agreement.linkedCreditCardId });
}

/** Run inside the payment's own transaction, before its first write. */
export async function assertDirectIssuerPaymentSupported(params: {
  firestore: Firestore;
  uid: string;
  tx: Pick<Transaction, "get">;
  kind: "loan" | "emi";
  agreement: { linkedCreditCardId?: string | null; purchaseTransactionId?: string | null; direction?: "given" | "taken"; fundingSource?: string | null };
  /** The payment documents about to be written. */
  writing: readonly DirectShape[];
  /** A correction: the documents it replaces. It may keep what was already recorded as direct, never add to it. */
  replacing?: readonly DirectShape[];
}): Promise<void> {
  const added = directTotal(params.writing.map((p) => ({ ...p, deletedAt: null })));
  if (added <= directTotal(params.replacing ?? []) + PAYMENT_EPSILON) return;
  const cardId = cardAgreementCardId(params.kind, params.agreement);
  const purchaseId = params.agreement.purchaseTransactionId ?? null;
  if (cardId == null || purchaseId == null) return;
  const userDoc = doc(params.firestore, FirestoreCollections.users, params.uid);
  const card = await params.tx.get(doc(userDoc, FirestoreCollections.creditCards, cardId));
  if (!card.exists()) return;
  const purchase = await params.tx.get(doc(userDoc, FirestoreCollections.transactions, purchaseId));
  if (!purchase.exists()) return;
  // The converted record when the reference carries a converter, else the stored fields: the rule reads only these.
  const data = purchase.data() as unknown as Parameters<typeof emiPurchaseRepresentedOnCard>[1];
  const record = { ...data!, id: purchaseId, deletedAt: data!.deletedAt ?? null, transferId: data!.transferId ?? null, excludeFromCalculations: data!.excludeFromCalculations ?? false };
  if (emiPurchaseRepresentedOnCard(purchaseId, record, (card.data() as { accountId: string }).accountId)) throw new DirectIssuerPaymentUnsupportedError();
}
