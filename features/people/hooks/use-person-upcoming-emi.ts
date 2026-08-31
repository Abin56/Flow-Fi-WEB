"use client";

/**
 * Powers the "Upcoming EMI" section on a Person's overview panel — mirrors
 * the Flutter app's `PersonLoansSummaryCard` "Upcoming EMI" block. See
 * `compute-upcoming-emi.ts` for the pure filtering/sorting logic this hook
 * wraps around live `useLoans()`/`useAllLoanInstallments()` data.
 */

import { useMemo } from "react";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { useAllLoanInstallments, useLoans } from "@/hooks/use-loans";
import { computeUpcomingEmi, type UpcomingEmiItem } from "./compute-upcoming-emi";

export type { UpcomingEmiItem };

/** Every upcoming EMI for loans connected to `personId`, soonest due date first. */
export function usePersonUpcomingEmi(personId: string): { items: UpcomingEmiItem[]; isLoading: boolean } {
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: installments = [], isLoading: installmentsLoading } = useAllLoanInstallments();

  const items = useMemo(
    () => computeUpcomingEmi(loans as Loan[], installments as Installment[], personId),
    [loans, installments, personId],
  );

  return { items, isLoading: loansLoading || installmentsLoading };
}
