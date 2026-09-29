"use client";

/**
 * Powers the "Upcoming EMI" section on a Person's overview panel — mirrors
 * the Flutter app's `PersonLoansSummaryCard` "Upcoming EMI" block. See
 * `compute-upcoming-emi.ts` for the pure filtering/sorting logic this hook
 * wraps around live `useLoans()`/`useAllLoanInstallments()` data. Remaining
 * Loan principal comes from `useLoanRows` — the same `outstandingPrincipal`
 * Loan & EMI and Net Worth show, never re-derived here.
 */

import { useMemo } from "react";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { useAllLoanInstallments, useLoans } from "@/hooks/use-loans";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { computeUpcomingEmi, type UpcomingEmiItem } from "./compute-upcoming-emi";

export type { UpcomingEmiItem };

/** Every upcoming EMI for loans connected to `personId`, soonest due date first. */
export function usePersonUpcomingEmi(personId: string): { items: UpcomingEmiItem[]; isLoading: boolean } {
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: installments = [], isLoading: installmentsLoading } = useAllLoanInstallments();
  const { rows: loanRows, isLoading: loanRowsLoading } = useLoanRows();

  const items = useMemo(() => {
    const outstandingPrincipalByLoanId = new Map(loanRows.map((r) => [r.loan.id, r.outstandingPrincipal]));
    return computeUpcomingEmi(loans as Loan[], installments as Installment[], personId, { outstandingPrincipalByLoanId });
  }, [loans, installments, loanRows, personId]);

  return { items, isLoading: loansLoading || installmentsLoading || loanRowsLoading };
}
