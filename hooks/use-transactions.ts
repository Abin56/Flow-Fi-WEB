"use client";

/**
 * Mirrors `transactionsStreamProvider` and the transaction-derived pieces of
 * `cashFlowThisMonthProvider` in
 * `lib/features/transactions/presentation/providers/transaction_providers.dart`
 * and `lib/features/cash_flow/presentation/providers/cash_flow_providers.dart`.
 * Live Firestore subscription exposed through React Query's cache.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import { billsPaid as billsPaidInRange, type DashboardBillOccurrence } from "@/lib/engines/dashboard-aggregation";
import { cashFlowThisMonth, moneyReceivedThisMonth as moneyReceivedInMonth, type CashFlowSummary } from "@/lib/engines/cash-flow";
import { effectiveMonth, isTransfer, type Transaction } from "@/lib/models/transaction";
import { isSplit, type Expense } from "@/lib/models/expense";
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
 * This month's cash flow. EMI/Loan/Bills paid-this-month figures are all
 * real now, sourced from the already-fetched installment/occurrence streams
 * (`billsPaidThisMonth` via `useAllBillOccurrences` +
 * `lib/engines/dashboard-aggregation.ts`'s ported `billsPaid`, bucketed by
 * each occurrence's due date, matching `_billsPaidThisMonthProvider`).
 * `moneyReceivedThisMonth` is real too — see `moneyReceivedForRange`'s doc
 * comment in `lib/engines/cash-flow.ts` for why it's split-expense
 * settlement collections, not a `receiptPurpose` transaction sum.
 */
export function useCashFlowThisMonth(): CashFlowSummary {
  const { data: transactions } = useTransactions();
  const { data: emiInstallments } = useAllEmiInstallments();
  const { data: loanInstallments } = useAllLoanInstallments();
  const { occurrences: billOccurrences } = useAllBillOccurrences();
  const { data: expenses } = useExpenses();
  const { installmentsByScheduleId } = useExpenseInstallmentsBySchedule();

  const now = new Date();

  const cashFlowTransactions = (transactions ?? []).map((t) => ({
    type: t.type,
    amount: t.amount,
    effectiveMonth: effectiveMonth(t),
    isDeleted: t.deletedAt != null,
    isTransfer: isTransfer(t),
  }));

  const dashboardBillOccurrences: DashboardBillOccurrence[] = (billOccurrences ?? []).map((o) => ({
    dueDate: o.dueDate,
    amountPaid: o.amountPaid,
  }));
  const monthRange = { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };

  const transactionsById = useMemo(
    () =>
      new Map(
        (transactions ?? []).map((t) => [
          t.id,
          { effectiveMonth: effectiveMonth(t), isDeleted: t.deletedAt != null, excludeFromCalculations: t.excludeFromCalculations },
        ]),
      ),
    [transactions],
  );

  return cashFlowThisMonth({
    transactions: cashFlowTransactions,
    emiPaidThisMonth: paidThisMonth(emiInstallments ?? [], now),
    loanPaidThisMonth: paidThisMonth(loanInstallments ?? [], now),
    billsPaidThisMonth: billsPaidInRange(dashboardBillOccurrences, monthRange),
    moneyReceivedThisMonth: moneyReceivedInMonth(
      {
        expenses: ((expenses ?? []) as Expense[]).map((e) => ({
          isSplit: isSplit(e),
          scheduleId: e.scheduleId,
          transactionId: e.transactionId,
        })),
        transactionsById,
        installmentsByScheduleId,
      },
      now,
    ),
  });
}
