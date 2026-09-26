"use client";

/**
 * Active extra principal per loan, derived from persisted `InstallmentPayment` records via
 * `principalPrepaidFor` (Decision 5: the payment history is the source of truth, never a stored
 * total). Reads payments under every installment of each loan's schedule, retired ones included,
 * and re-reads whenever the live loan/installment snapshot changes — every extra-principal payment
 * and its reversal change an installment's `amountPaid` or regenerate the tail.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { principalPrepaidFor } from "@/lib/engines/loan-outstanding";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useAllLoanInstallments, useLoans } from "./use-loans";

export function useLoanPrincipalPrepaid(): { prepaidByLoanId: Map<string, number>; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: loans = [] } = useLoans();
  const { data: installments = [] } = useAllLoanInstallments();

  const fingerprint = useMemo(() => {
    const loanPart = (loans as Loan[]).map((l) => `${l.id}:${l.scheduleId}:${l.loanAmount}:${l.installmentCount ?? ""}`).sort().join(",");
    const installmentPart = (installments as Installment[]).map((i) => `${i.id}:${i.amountPaid}`).sort().join(",");
    return `${loanPart}|${installmentPart}`;
  }, [loans, installments]);

  const query = useQuery({
    queryKey: ["loanPrincipalPrepaid", uid, fingerprint],
    enabled: !!uid && loans.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<Map<string, number>> => {
      const result = new Map<string, number>();
      if (!uid) return result;
      await Promise.all(
        (loans as Loan[]).map(async (loan) => {
          const installmentRepository = createInstallmentRepositoryFor(uid, loan.scheduleId);
          const all = [...(await installmentRepository.getAll()), ...(await installmentRepository.getTrash())];
          const payments = await Promise.all(
            all.map((installment) =>
              createInstallmentPaymentRepositoryFor(uid, loan.scheduleId, installment.id, installmentRepository).getAll(),
            ),
          );
          result.set(loan.id, principalPrepaidFor(payments.flat()));
        }),
      );
      return result;
    },
  });

  return { prepaidByLoanId: query.data ?? new Map(), isLoading: loans.length > 0 && query.isLoading };
}
