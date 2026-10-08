/**
 * The one mapping from stored Transactions to the Month Cycle hero engine (`amountFor`) and the Dashboard
 * cash-flow engine (`cashFlowThisMonth`). Those engines' input types carry no exclude / deleted / EMI flags,
 * so every row that must not count is dropped HERE — never re-derived in a hook.
 */

import type { CashFlowTransaction } from "./cash-flow";
import type { DashboardTransaction } from "./dashboard-aggregation";
import { effectiveMonth, isLoanPrincipalDisbursement, isNonIncomeExpenseMovement, isTransfer, type Transaction } from "@/lib/models/transaction";

/** Live and counted: not trashed, not "Don't count this in my totals" (WFI-P1-05). */
const counts = (t: Transaction) => t.deletedAt == null && !t.excludeFromCalculations;

/**
 * Month Cycle Income / Total outflow rows. Besides the uncounted rows above it drops:
 *  - loan principal disbursements and People cash legs (not income/spend);
 *  - EMI payment transactions — `emiPaid` already counts the installment's `amountPaid` (WFI-P1-06);
 *  - a non-transfer credit on a card account (refund / cashback) from income — it lowers the card's
 *    liability, it is not money earned (WFI-P2-01).
 */
export function monthCycleDashboardTransactions(transactions: readonly Transaction[], cardAccountIds: ReadonlySet<string>): DashboardTransaction[] {
  return transactions
    .filter(
      (t) =>
        counts(t) &&
        !isLoanPrincipalDisbursement(t) &&
        !t.isPersonLedgerMovement &&
        t.emiId == null &&
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
 */
export function cashFlowTransactions(transactions: readonly Transaction[], cardAccountIds: ReadonlySet<string>): CashFlowTransaction[] {
  // Transfers whose incoming leg lands on a card account — i.e. card bill payments.
  const cardPaymentTransferIds = new Set(
    transactions.filter((t) => t.transferId != null && t.type === "income" && cardAccountIds.has(t.accountId)).map((t) => t.transferId as string),
  );
  return transactions.filter((t) => counts(t) && t.emiId == null).map((t) => {
    const isCreditCardAccount = cardAccountIds.has(t.accountId);
    return {
      type: t.type,
      amount: t.amount,
      effectiveMonth: effectiveMonth(t),
      isDeleted: false,
      isTransfer: isNonIncomeExpenseMovement(t),
      isCreditCardAccount,
      isCreditCardPayment: t.transferId != null && !isCreditCardAccount && cardPaymentTransferIds.has(t.transferId),
    };
  });
}
