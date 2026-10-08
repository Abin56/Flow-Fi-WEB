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
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useEmiInstallmentPayments, type EmiPaidRow } from "@/hooks/use-emi-installment-payments";
import { useEmis } from "@/hooks/use-credit-cards";
import { useLoanScheduledPayments } from "@/hooks/use-loan-scheduled-payments";
import { scheduleOnlyLoanFlows } from "@/lib/engines/loan-cash-flow";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { useAllBillOccurrences } from "@/features/bills/hooks/use-bill-occurrence-history";
import { billsPaid as billsPaidInRange, type DashboardBillOccurrence } from "@/lib/engines/dashboard-aggregation";
import { cashFlowThisMonth, moneyReceivedThisMonth as moneyReceivedInMonth, type CashFlowSummary } from "@/lib/engines/cash-flow";
import { cashFlowTransactions as toCashFlowTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { effectiveMonth, type Transaction } from "@/lib/models/transaction";
import { isSplit, type Expense } from "@/lib/models/expense";
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

export function transactionsTrashQueryKey(uid: string | undefined) {
  return ["transactions", "trash", uid] as const;
}

/** Live-subscribes to the signed-in user's soft-deleted transactions. */
export function useTrashedTransactions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Transaction[]>({
    queryKey: transactionsTrashQueryKey(uid),
    enabled: !!uid,
    hookName: "useTrashedTransactions",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const accountRepository = createAccountRepository(uid);
      return createTransactionRepository(uid, accountRepository).watchTrash(onData, onError);
    },
  });
}

/**
 * Ids of every People cash-leg Transaction (`isPersonLedgerMovement`), active and trashed — what lets the
 * People Ledger recognise an entry's `transactionRef` as its OWN cash leg (settleable/deletable there)
 * rather than a split-expense or Loan link. Trashed ones are included so an entry whose cash leg was
 * deleted by an older transaction-only delete is still recognised and can be cleaned up.
 */
export function usePersonCashLegIds(): ReadonlySet<string> {
  const { data: active = [] } = useTransactions();
  const { data: trashed = [] } = useTrashedTransactions();
  return useMemo(
    () => new Set([...active, ...trashed].filter((t) => t.isPersonLedgerMovement).map((t) => t.id)),
    [active, trashed],
  );
}

function isSameCalendarMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Sum of EMI payments PAID this calendar month — bucketed by payment date, not due date (WFI-P2-11). */
function paidThisMonth(payments: readonly EmiPaidRow[], now: Date): number {
  return payments.filter((p) => isSameCalendarMonth(p.date, now)).reduce((sum, p) => sum + p.amount, 0);
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
  const { payments: emiPayments } = useEmiInstallmentPayments();
  const { data: emis } = useEmis();
  // Payment-level (not installment-level) so each Loan money movement counts once: payments with a
  // linked Transaction are already in `transactions`; only legacy unlinked ones come from here.
  const { payments: loanScheduledPayments } = useLoanScheduledPayments();
  const { occurrences: billOccurrences } = useAllBillOccurrences();
  const { data: expenses } = useExpenses();
  const { installmentsByScheduleId } = useExpenseInstallmentsBySchedule();

  const { data: creditCards } = useCreditCards();

  const now = new Date();

  const creditCardAccountIds = new Set((creditCards ?? []).map((c) => c.accountId));
  const cashFlowTransactions = toCashFlowTransactions(transactions ?? [], creditCardAccountIds);
  const cardLinkedEmiScheduleIds = new Set((emis ?? []).filter((e) => e.linkedCreditCardId != null).map((e) => e.scheduleId));

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

  // Bucketed by the real payment date, matching Flutter's Cash Flow loan lines.
  const loanScheduleFlows = scheduleOnlyLoanFlows(loanScheduledPayments, monthRange, "paymentDate");

  return cashFlowThisMonth({
    transactions: cashFlowTransactions,
    // A card-linked EMI is cash out only when its card bill is paid (counted as a card payment) — never at
    // EMI-payment time too (WFI-P1-06). Every other EMI is cash out here, once (its bank row is dropped above).
    emiPaidThisMonth: paidThisMonth(emiPayments.filter((p) => !cardLinkedEmiScheduleIds.has(p.scheduleId)), now),
    loanPaidThisMonth: loanScheduleFlows.moneyOut,
    loanReceivedThisMonth: loanScheduleFlows.moneyIn,
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
