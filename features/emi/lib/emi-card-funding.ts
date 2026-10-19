/**
 * Money legs of a CARD-LINKED EMI payment — one pure rule for record / edit / reverse (reverse needs none: it
 * soft-deletes whatever legs the payment owns).
 *
 * Who owns the principal is read from persisted records only (`emiPurchaseRepresentedOnCard`: the EMI's
 * `purchaseTransactionId` + that purchase still ACTIVE on the card account — never a balance, never "a card is linked"):
 *  - Case B — the EMI itself is the card exposure (a locked principal that each payment releases).
 *  - Case A — the purchase is already card liability, so the EMI never locks and its principal must NOT be billed again.
 *
 *  mode "card" (default) — the installment is billed to the card:
 *    B: expense on the card for the whole installment (the lock releases the principal part).
 *    A: expense on the card for the NON-principal part only (interest / fees); the principal is already in the
 *       purchase balance and is settled when that balance is paid.
 *  mode "bank" — paid directly from a bank / savings account, never the card:
 *    B: expense on the bank for the whole installment; nothing on the card; the lock releases the principal.
 *    A: expense on the bank for the non-principal part + a bank → card transfer of the principal (a card payment
 *       that pays down the purchase balance) — the bank is debited the full installment, once.
 */

import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Emi } from "@/lib/models/emi";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { Transaction } from "@/lib/models/transaction";

export type CardEmiCase = "A" | "B";
export type CardFundingMode = "card" | "bank";

const round2 = (n: number) => Math.round(n * 100) / 100;

type PurchaseRecord = Parameters<typeof emiPurchaseRepresentedOnCard>[1];

export function cardEmiCase(emi: Pick<Emi, "purchaseTransactionId">, cardAccountId: string, purchase: PurchaseRecord): CardEmiCase {
  return emiPurchaseRepresentedOnCard(emi.purchaseTransactionId, purchase, cardAccountId) ? "A" : "B";
}

export interface CardEmiLegPlan {
  emiCase: CardEmiCase;
  mode: CardFundingMode;
  /** Principal / non-principal split of the money actually moved. */
  principal: number;
  nonPrincipal: number;
  /** Expense posted on the card (billed to the statement). */
  cardCharge: number;
  /** Expense posted on the bank (interest / fees, or the whole installment in Case B). */
  bankExpense: number;
  /** Bank → card transfer paying down the purchase balance (Case A, bank mode). */
  principalTransfer: number;
  /** Everything the bank is debited — exactly once. */
  bankDebit: number;
  /** Change in the card's liability and in the principal lock this payment causes. */
  cardLiabilityDelta: number;
  lockReleased: number;
  /** Net effect on available credit (before limit clamps). */
  availableDelta: number;
}

export function planCardEmiLegs(p: { emiCase: CardEmiCase; mode: CardFundingMode; applied: number; principal: number }): CardEmiLegPlan {
  const applied = round2(Math.max(p.applied, 0));
  const principal = round2(Math.min(Math.max(p.principal, 0), applied));
  const nonPrincipal = round2(applied - principal);
  const { emiCase, mode } = p;
  let cardCharge = 0;
  let bankExpense = 0;
  let principalTransfer = 0;
  if (mode === "card") cardCharge = emiCase === "B" ? applied : nonPrincipal;
  else if (emiCase === "B") bankExpense = applied;
  else {
    bankExpense = nonPrincipal;
    principalTransfer = principal;
  }
  const cardLiabilityDelta = round2(cardCharge - principalTransfer);
  const lockReleased = emiCase === "B" ? principal : 0;
  return {
    emiCase,
    mode,
    principal,
    nonPrincipal,
    cardCharge,
    bankExpense,
    principalTransfer,
    bankDebit: round2(bankExpense + principalTransfer),
    cardLiabilityDelta,
    lockReleased,
    availableDelta: round2(lockReleased - cardLiabilityDelta),
  };
}

/** The Transactions a plan posts. Every leg carries the payment's identity, so reversal / edit find them all. */
export function buildCardEmiTransactions(p: {
  plan: CardEmiLegPlan;
  emi: Pick<Emi, "id" | "name" | "categoryId">;
  cardAccountId: string;
  bankAccountId: string | null;
  date: Date;
  note?: string;
  installmentId: string;
  installmentPaymentId: string;
}): Transaction[] {
  const { plan, emi } = p;
  const common = {
    dateTime: p.date,
    categoryId: emi.categoryId ?? "loan_payment",
    notes: p.note ?? "",
    emiId: emi.id,
    installmentId: p.installmentId,
    installmentPaymentId: p.installmentPaymentId,
    paymentAllocationType: "regularEmi" as const,
  };
  const label = emi.name ? `EMI payment — ${emi.name}` : "EMI payment";
  const out: Transaction[] = [];
  if (plan.cardCharge > 0) {
    out.push(TransactionRepository.buildTransaction({ ...common, type: "expense", amount: plan.cardCharge, accountId: p.cardAccountId, description: plan.emiCase === "A" ? `${label} (interest & fees)` : label }));
  }
  if (plan.bankExpense > 0) {
    if (p.bankAccountId == null) throw new Error("Choose the bank or savings account this payment is made from");
    out.push(TransactionRepository.buildTransaction({ ...common, type: "expense", amount: plan.bankExpense, accountId: p.bankAccountId, description: plan.emiCase === "A" ? `${label} (interest & fees)` : label }));
  }
  if (plan.principalTransfer > 0) {
    if (p.bankAccountId == null) throw new Error("Choose the bank or savings account this payment is made from");
    const transferId = `xfer_emi_${p.installmentPaymentId}`;
    const legCommon = { ...common, amount: plan.principalTransfer, transferId, description: `${label} (principal to card)` };
    out.push({ ...TransactionRepository.buildTransaction({ ...legCommon, type: "expense", accountId: p.bankAccountId }), id: `${transferId}_out` });
    out.push({ ...TransactionRepository.buildTransaction({ ...legCommon, type: "income", accountId: p.cardAccountId }), id: `${transferId}_in` });
  }
  return out;
}
