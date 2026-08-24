"use client";

/**
 * Mirrors `transactionsStreamProvider` and the transaction-derived pieces of
 * `cashFlowThisMonthProvider` in
 * `lib/features/transactions/presentation/providers/transaction_providers.dart`
 * and `lib/features/cash_flow/presentation/providers/cash_flow_providers.dart`.
 * Live Firestore subscription exposed through React Query's cache.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { cashFlowThisMonth, type CashFlowSummary } from "@/lib/engines/cash-flow";
import { effectiveMonth, isTransfer, type Transaction } from "@/lib/models/transaction";
import type { Installment } from "@/lib/models/payment-schedule";
import { createAccountRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export function transactionsQueryKey(uid: string | undefined) {
  return ["transactions", uid] as const;
}

/** Live-subscribes to the signed-in user's active transactions. */
export function useTransactions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Transaction[]>({
    queryKey: transactionsQueryKey(uid),
    enabled: !!uid,
    hookName: "useTransactions",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const accountRepository = createAccountRepository(uid);
      return createTransactionRepository(uid, accountRepository).watchAll(onData, onError);
    },
  });
}

function isSameCalendarMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Sum of amountPaid for installments due this calendar month — the closest proxy
 *  available without per-installment payment-date history (InstallmentPayment
 *  records aren't fetched in bulk anywhere in the app yet). */
function paidThisMonth(installments: Installment[], now: Date): number {
  return installments
    .filter((i) => i.deletedAt == null && isSameCalendarMonth(i.dueDate, now))
    .reduce((sum, i) => sum + i.amountPaid, 0);
}

/**
 * This month's cash flow. EMI/Loan paid-this-month figures are now real,
 * sourced from the already-fetched installment streams. Bills paid-this-month
 * stays 0: `useBills()` only exposes Bill templates, not per-cycle
 * BillOccurrence payment history, so there is no data source to sum from yet
 * (see `hooks/use-bills.ts`'s doc comment) — wiring it needs a new
 * bill-occurrence-history hook, tracked as follow-up work rather than
 * invented here. moneyReceivedThisMonth (People/Split-Expense receivables) is
 * likewise 0 until the People-Ledger slice lands.
 */
export function useCashFlowThisMonth(): CashFlowSummary {
  const { data: transactions } = useTransactions();
  const { data: emiInstallments } = useAllEmiInstallments();
  const { data: loanInstallments } = useAllLoanInstallments();

  const now = new Date();

  const cashFlowTransactions = (transactions ?? []).map((t) => ({
    type: t.type,
    amount: t.amount,
    effectiveMonth: effectiveMonth(t),
    isDeleted: t.deletedAt != null,
    isTransfer: isTransfer(t),
  }));

  return cashFlowThisMonth({
    transactions: cashFlowTransactions,
    emiPaidThisMonth: paidThisMonth(emiInstallments ?? [], now),
    loanPaidThisMonth: paidThisMonth(loanInstallments ?? [], now),
    billsPaidThisMonth: 0,
    moneyReceivedThisMonth: 0,
  });
}
