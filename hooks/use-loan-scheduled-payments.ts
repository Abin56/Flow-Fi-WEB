"use client";

/**
 * Every active payment on every active Loan's installments, tagged with its loan's direction — the
 * input `lib/engines/loan-cash-flow.ts` needs to count each Loan money movement exactly once.
 *
 * Payments live in per-installment subcollections, so this is a fan-out read rather than one
 * listener. It re-reads whenever the live installment snapshot changes (any payment or reversal
 * changes an installment's `amountPaid`), so Cash Flow never lags a recorded payment. Only
 * installments with `amountPaid > 0` can hold an active payment, so untouched ones are skipped.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LoanScheduledPayment } from "@/lib/engines/loan-cash-flow";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useAllLoanInstallments, useLoans } from "./use-loans";
import { useTransactions } from "./use-transactions";
import { paymentRowsKey } from "@/lib/engines/payment-rows-key";

export function useLoanScheduledPayments(): { payments: LoanScheduledPayment[]; isLoading: boolean; isPlaceholderData: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: loans = [] } = useLoans();
  const { data: installments = [] } = useAllLoanInstallments();

  const paid = useMemo(() => (installments as Installment[]).filter((i) => i.amountPaid > 0), [installments]);
  const directionBySchedule = useMemo(
    () => new Map((loans as Loan[]).map((l) => [l.scheduleId, l.direction])),
    [loans],
  );
  // Loan payment Transactions — a date-only edit changes these even though every `amountPaid` stays the same.
  const { data: transactions = [] } = useTransactions();
  const linked = useMemo(() => transactions.filter((t) => t.loanId != null), [transactions]);
  const fingerprint = useMemo(
    () => paymentRowsKey(paid, linked, (i) => `:${directionBySchedule.get(i.scheduleId) ?? "?"}`),
    [paid, linked, directionBySchedule],
  );

  const query = useQuery({
    queryKey: ["loanScheduledPayments", uid, fingerprint],
    enabled: !!uid && paid.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<LoanScheduledPayment[]> => {
      if (!uid) return [];
      const perInstallment = await Promise.all(
        paid.map(async (installment) => {
          const direction = directionBySchedule.get(installment.scheduleId);
          if (direction == null) return [];
          const repository = createInstallmentPaymentRepositoryFor(
            uid,
            installment.scheduleId,
            installment.id,
            createInstallmentRepositoryFor(uid, installment.scheduleId),
          );
          const payments = await repository.getAll();
          return payments.map(
            (p): LoanScheduledPayment => ({
              direction,
              installmentDueDate: installment.dueDate,
              amount: p.amount,
              date: p.date,
              transactionId: p.transactionId ?? null,
              deletedAt: p.deletedAt,
              installmentId: installment.id,
              scheduleId: installment.scheduleId,
              paymentId: p.id,
              allocationType: p.allocationType,
              prepaymentPrincipalAmount: p.prepaymentPrincipalAmount ?? null,
              recordedEarlier: p.recordedEarlier != null,
            }),
          );
        }),
      );
      return perInstallment.flat();
    },
  });

  return { payments: paid.length === 0 ? [] : (query.data ?? []), isLoading: paid.length > 0 && query.isLoading, isPlaceholderData: paid.length > 0 && query.isPlaceholderData };
}
