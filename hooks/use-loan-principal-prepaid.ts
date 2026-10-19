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
    queryFn: () => (uid ? fetchPrincipalPrepaidByLoan(uid, loans as Loan[]) : Promise.resolve(new Map<string, number>())),
  });

  return { prepaidByLoanId: query.data ?? new Map(), isLoading: loans.length > 0 && query.isLoading };
}

/**
 * Reads every loan's installments (active AND retired) and their payments, then derives the active extra
 * principal per loan. The active and retired installment reads are independent, so they are issued together —
 * this runs after every Loan/EMI payment (and the payment dialog waits for it), so each avoidable sequential
 * round trip is felt.
 */
export async function fetchPrincipalPrepaidByLoan(uid: string, loans: readonly Loan[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await Promise.all(
    loans.map(async (loan) => {
      const installmentRepository = createInstallmentRepositoryFor(uid, loan.scheduleId);
      const [active, retired] = await Promise.all([installmentRepository.getAll(), installmentRepository.getTrash()]);
      const payments = await Promise.all(
        [...active, ...retired].map((installment) =>
          createInstallmentPaymentRepositoryFor(uid, loan.scheduleId, installment.id, installmentRepository).getAll(),
        ),
      );
      result.set(loan.id, principalPrepaidFor(payments.flat()));
    }),
  );
  return result;
}
