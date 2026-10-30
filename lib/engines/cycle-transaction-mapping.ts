/**
 * The one mapping from stored Transactions to the Month Cycle hero engine (`amountFor`) and the Dashboard
 * cash-flow engine (`cashFlowThisMonth`). Those engines' input types carry no exclude / deleted / EMI flags,
 * so every row that must not count is dropped HERE — never re-derived in a hook.
 */

import type { CashFlowTransaction } from "./cash-flow";
import type { DashboardTransaction } from "./dashboard-aggregation";
import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { Emi } from "@/lib/models/emi";
import { isLenderChargeSettlement } from "@/lib/models/lender-charge";
import { effectiveMonth, isLoanPrincipalDisbursement, isNonIncomeExpenseMovement, isTransfer, type Transaction } from "@/lib/models/transaction";

/** Live and counted: not trashed, not "Don't count this in my totals" (WFI-P1-05). */
const counts = (t: Transaction) => t.deletedAt == null && !t.excludeFromCalculations;

/** Card-linked EMIs (live) — their cash leaves through a bank account or the card bill, never through `emiPaid`. */
export function cardLinkedEmiIds(emis: readonly Pick<Emi, "id" | "linkedCreditCardId" | "deletedAt">[]): Set<string> {
  return new Set(emis.filter((e) => e.deletedAt == null && e.linkedCreditCardId != null).map((e) => e.id));
}

/**
 * Case A EMIs: the EMI's linked purchase is still ACTIVE on its card (`emiPurchaseRepresentedOnCard` — the one rule
 * available credit and My Spend already use), so the principal was recognised as spend when the purchase happened.
 * Case B / C (no link, or the purchase is deleted / elsewhere) are NOT in this set and keep their existing behaviour.
 */
export function caseAEmis<E extends Pick<Emi, "id" | "scheduleId" | "linkedCreditCardId" | "purchaseTransactionId" | "deletedAt">>(
  emis: readonly E[],
  cards: readonly { id: string; accountId: string }[],
  transactions: readonly Transaction[],
): E[] {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const byId = new Map(transactions.map((t) => [t.id, t]));
  return emis.filter((e) => {
    if (e.deletedAt != null || e.linkedCreditCardId == null || e.purchaseTransactionId == null) return false;
    const card = cardById.get(e.linkedCreditCardId);
    return card != null && emiPurchaseRepresentedOnCard(e.purchaseTransactionId, byId.get(e.purchaseTransactionId), card.accountId);
  });
}

/**
 * EMI payment rows that are Month Cycle spend through `emiPaid`: every payment except one recorded as already paid
 * earlier, and except a Case A EMI's — its principal was spent at the purchase and its interest / fees are spent
 * through the transactions it posted (kept by `monthCycleDashboardTransactions`), so counting the payment too would
 * count the principal twice.
 */
export function monthCycleEmiPaymentRows<P extends { scheduleId: string; recordedEarlier: boolean }>(payments: readonly P[], caseAScheduleIds: ReadonlySet<string>): P[] {
  return payments.filter((p) => !p.recordedEarlier && !caseAScheduleIds.has(p.scheduleId));
}

/**
 * Month Cycle Income / Total outflow rows. Besides the uncounted rows above it drops:
 *  - loan principal disbursements and People cash legs (not income/spend);
 *  - EMI payment transactions — `emiPaid` already counts the installment's `amountPaid` (WFI-P1-06) — EXCEPT a
 *    Case A EMI's (`caseAEmiIds`): `monthCycleEmiPaymentRows` leaves its payments out, so the interest / fees it posted
 *    (card charge or bank expense) are its spend here. Its principal legs are a transfer (bank → card): never spend;
 *  - a non-transfer credit on a card account (refund / cashback) from income — it lowers the card's
 *    liability, it is not money earned (WFI-P2-01).
 */
export function monthCycleDashboardTransactions(
  transactions: readonly Transaction[],
  cardAccountIds: ReadonlySet<string>,
  caseAEmiIds: ReadonlySet<string> = new Set(),
): DashboardTransaction[] {
  return transactions
    .filter(
      (t) =>
        counts(t) &&
        !isLoanPrincipalDisbursement(t) &&
        !t.isPersonLedgerMovement &&
        (t.emiId == null || caseAEmiIds.has(t.emiId)) &&
        !(t.type === "income" && !isTransfer(t) && cardAccountIds.has(t.accountId)),
    )
    .map((t) => ({
      id: t.id,
      type: t.type === "income" ? "income" : "expense",
      amount: t.amount,
      dateTime: t.dateTime,
      effectiveMonth: effectiveMonth(t),
      isTransfer: isTransfer(t),
      accountId: t.accountId,
    }));
}

/**
 * Dashboard Money In / Money Out rows (`useCashFlowThisMonth`). Uncounted rows are dropped (WFI-P1-05), and so
 * are EMI payment rows: `emiPaidThisMonth` already counts a non-card EMI from its installment (WFI-P1-08).
 * A CARD-LINKED EMI is the exception (`cardLinkedIds`): `emiPaidThisMonth` skips it (its cash leaves when the card is
 * paid), so its rows are classified like any other transaction by the account they actually moved — a bank expense
 * is Money Out, a bank → card transfer leg is a card payment (Money Out, its card-side leg never income), and a
 * charge on the card account is liability only (excluded until the bill is paid).
 */
export function cashFlowTransactions(
  transactions: readonly Transaction[],
  cardAccountIds: ReadonlySet<string>,
  cardLinkedIds: ReadonlySet<string> = new Set(),
): CashFlowTransaction[] {
  // Transfers whose incoming leg lands on a card account — i.e. card bill payments.
  const cardPaymentTransferIds = new Set(
    transactions.filter((t) => t.transferId != null && t.type === "income" && cardAccountIds.has(t.accountId)).map((t) => t.transferId as string),
  );
  return transactions.filter((t) => counts(t) && (t.emiId == null || cardLinkedIds.has(t.emiId))).map((t) => {
    const isCreditCardAccount = cardAccountIds.has(t.accountId);
    return {
      type: t.type,
      amount: t.amount,
      effectiveMonth: effectiveMonth(t),
      isDeleted: false,
      // A lender-charge settlement is excluded from income/expense TOTALS (its expense was recognised at billing) but it
      // is real cash leaving the account, so this cash-basis feed counts it once as money out.
      isTransfer: isNonIncomeExpenseMovement(t) && !isLenderChargeSettlement(t),
      isCreditCardAccount,
      isCreditCardPayment: t.transferId != null && !isCreditCardAccount && cardPaymentTransferIds.has(t.transferId),
    };
  });
}
