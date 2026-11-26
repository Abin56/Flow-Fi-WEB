"use client";

/**
 * Live participant breakdown for one shared Loan / EMI installment (`installmentBreakdown`). Reads the same
 * whole-history People statements as `useLinkedPeopleReadiness`, so every share / received / remaining
 * figure is the People Ledger's own.
 */

import { useMemo } from "react";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { coverageBreakdown, installmentBreakdown, type InstallmentBreakdown } from "@/lib/engines/installment-participants";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { Installment } from "@/lib/models/payment-schedule";

const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

export interface InstallmentBreakdownTarget {
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
  /** Every installment one lender payment covers — with two or more, `coverage` reads them together. */
  coveredIds?: readonly string[];
}

export function useInstallmentBreakdown(target: InstallmentBreakdownTarget | null): { breakdown: InstallmentBreakdown | null; coverage?: InstallmentBreakdown | null; isLoading: boolean } {
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(ALL_TIME);
  const sourceKind = target?.sourceKind;
  const source = target?.source;
  const installments = target?.installments;
  const installmentId = target?.installmentId;
  const breakdown = useMemo(
    () =>
      sourceKind && source && installments && installmentId
        ? installmentBreakdown({ sourceKind, source, installments, installmentId, statements: Object.values(statementsByPersonId) })
        : null,
    [sourceKind, source, installments, installmentId, statementsByPersonId],
  );
  const coveredKey = (target?.coveredIds?.length ?? 0) > 1 ? target!.coveredIds!.join(",") : "";
  const coverage = useMemo(
    () => (sourceKind && source && installments && coveredKey ? coverageBreakdown({ sourceKind, source, installments, installmentIds: coveredKey.split(","), statements: Object.values(statementsByPersonId) }) : null),
    [sourceKind, source, installments, coveredKey, statementsByPersonId],
  );
  return { breakdown, coverage, isLoading: target != null && isLoading };
}
