"use client";

/**
 * Composes the History feed's real data from already-live-watched hooks
 * (Transactions, Expenses, Loans, Bills, EMIs, Credit Cards) plus the
 * one-shot payment-history fan-outs in `use-history-payment-sources.ts` and
 * `features/bills/hooks/use-bill-occurrence-history.ts`, then folds them
 * through `buildHistory` (`lib/engines/history-builder.ts`) — a direct port
 * of `historyEntriesProvider`
 * (`Finance_App/lib/features/transactions/presentation/providers/history_providers.dart`).
 * No business logic here beyond shape-mapping; every calculation lives in
 * the engine or in each feature's own already-ported model/repository.
 */

import { useMemo } from "react";
import { useBills } from "@/hooks/use-bills";
import { useEmis } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { useAllLoanInstallments, useLoans } from "@/hooks/use-loans";
import { useTransactions } from "@/hooks/use-transactions";
import {
  useBillPayments,
  useCreditCardStatementPayments,
  useEmiPayments,
  useLoanPayments,
} from "@/features/history/hooks/use-history-payment-sources";
import {
  buildHistory,
  type HistoryBillData,
  type HistoryCreditCardData,
  type HistoryEmiData,
  type HistoryExpense,
  type HistoryInstallment,
  type HistoryLoanData,
  type HistoryPayment,
  type HistoryStatement,
  type HistoryTransaction,
} from "@/lib/engines/history-builder";
import { isSplit, myShare } from "@/lib/models/expense";
import type { Bill } from "@/lib/models/bill";
import type { Emi } from "@/lib/models/emi";
import type { Expense } from "@/lib/models/expense";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { installmentStatus, remainingAmount } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";
import type { HistoryEntry } from "@/lib/models/history";

function toHistoryPayment(p: { id: string; date: Date; amount: number; note: string; deletedAt: Date | null }): HistoryPayment {
  return { id: p.id, date: p.date, amount: p.amount, note: p.note, isDeleted: p.deletedAt != null };
}

function toHistoryInstallment(i: Installment): HistoryInstallment {
  return {
    scheduleId: i.scheduleId,
    amountPaid: i.amountPaid,
    remainingAmount: remainingAmount(i),
    status: installmentStatus(i),
  };
}

/** Live-composed unified History feed — every plain transaction, split expense settlement,
 *  loan/bill/EMI payment, and credit-card statement event, newest first. */
export function useHistoryEntries(): { entries: HistoryEntry[]; isLoading: boolean } {
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { installmentsByScheduleId: expenseInstallmentsByScheduleId, isLoading: expenseInstallmentsLoading } =
    useExpenseInstallmentsBySchedule();

  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: loanInstallments = [], isLoading: loanInstallmentsLoading } = useAllLoanInstallments();
  const { paymentsByLoanId, isLoading: loanPaymentsLoading } = useLoanPayments(loans as Loan[], loanInstallments as Installment[]);

  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: emiInstallments = [], isLoading: emiInstallmentsLoading } = useAllEmiInstallments();
  const { paymentsByEmiId, isLoading: emiPaymentsLoading } = useEmiPayments(emis as Emi[], emiInstallments as Installment[]);

  const { data: bills = [], isLoading: billsLoading } = useBills();
  const { paymentsByBillId, isLoading: billPaymentsLoading } = useBillPayments();

  const { statementsByCardId, paymentsByStatementId, cardNameById, isLoading: statementsLoading } =
    useCreditCardStatementPayments();

  const isLoading =
    transactionsLoading ||
    expensesLoading ||
    expenseInstallmentsLoading ||
    loansLoading ||
    loanInstallmentsLoading ||
    loanPaymentsLoading ||
    emisLoading ||
    emiInstallmentsLoading ||
    emiPaymentsLoading ||
    billsLoading ||
    billPaymentsLoading ||
    statementsLoading;

  const entries = useMemo(() => {
    const historyTransactions: HistoryTransaction[] = (transactions as Transaction[]).map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      dateTime: t.dateTime,
      notes: t.notes,
      receiptPurpose: t.receiptPurpose,
      transferId: t.transferId,
      excludeFromCalculations: t.excludeFromCalculations,
      accountingMonth: t.accountingMonth,
      isDeleted: t.deletedAt != null,
    }));

    const historyExpenses: HistoryExpense[] = (expenses as Expense[]).map((e) => ({
      transactionId: e.transactionId,
      isSplit: isSplit(e),
      scheduleId: e.scheduleId,
      myShare: myShare(e),
      participants: e.participants.map((p) => ({ name: p.name, share: p.share, isMe: p.isMe })),
    }));

    const installmentsByScheduleId: Record<string, HistoryInstallment[]> = {};
    for (const [scheduleId, installments] of Object.entries(expenseInstallmentsByScheduleId)) {
      installmentsByScheduleId[scheduleId] = installments.map(toHistoryInstallment);
    }

    const loanData: HistoryLoanData[] = (loans as Loan[]).map((loan) => ({
      id: loan.id,
      name: loan.name ?? null,
      isDeleted: loan.deletedAt != null,
      payments: (paymentsByLoanId[loan.id] ?? []).map(toHistoryPayment),
    }));

    const billData: HistoryBillData[] = (bills as Bill[]).map((bill) => ({
      id: bill.id,
      name: bill.name,
      isDeleted: bill.deletedAt != null,
      payments: (paymentsByBillId[bill.id] ?? []).map(toHistoryPayment),
    }));

    const emiData: HistoryEmiData[] = (emis as Emi[]).map((emi) => ({
      id: emi.id,
      name: emi.name,
      isDeleted: emi.deletedAt != null,
      payments: (paymentsByEmiId[emi.id] ?? []).map(toHistoryPayment),
    }));

    const creditCardData: HistoryCreditCardData[] = Object.entries(statementsByCardId).map(([cardId, statements]) => ({
      cardId,
      cardName: cardNameById[cardId] ?? "Card",
      statements: statements.map(
        (s): HistoryStatement => ({
          id: s.id,
          cardId: s.cardId,
          generatedDate: s.generatedDate,
          dueDate: s.dueDate,
          totalAmount: s.totalAmount,
          isDeleted: s.deletedAt != null,
        }),
      ),
      paymentsByStatementId: Object.fromEntries(
        statements.map((s) => [s.id, (paymentsByStatementId[s.id] ?? []).map(toHistoryPayment)]),
      ),
    }));

    return buildHistory({
      transactions: historyTransactions,
      expenses: historyExpenses,
      loans: loanData,
      bills: billData,
      emis: emiData,
      creditCards: creditCardData,
      installmentsByScheduleId,
    });
  }, [
    transactions,
    expenses,
    expenseInstallmentsByScheduleId,
    loans,
    paymentsByLoanId,
    bills,
    paymentsByBillId,
    emis,
    paymentsByEmiId,
    statementsByCardId,
    paymentsByStatementId,
    cardNameById,
  ]);

  return { entries, isLoading };
}
