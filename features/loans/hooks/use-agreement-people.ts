"use client";

/**
 * The People tab's data for one shared Loan / EMI: every participant's share of every installment, from the same
 * whole-history People statements as the Pay dialog and the schedule rows (`installmentBreakdown`), plus each person's
 * postponements. Display only — nothing here settles, moves or reschedules anything.
 */

import { useMemo } from "react";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { usePeoplePaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { agreementPeople, type AgreementPerson } from "@/features/loans/lib/agreement-people";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { installmentBreakdown, type InstallmentParticipant } from "@/lib/engines/installment-participants";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { Installment } from "@/lib/models/payment-schedule";

const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

export function useAgreementPeople(
  target: { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] } | null,
): { people: AgreementPerson[]; isLoading: boolean } {
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(ALL_TIME);
  const startDay = useMonthCycleStartDay();
  const sourceKind = target?.sourceKind;
  const source = target?.source;
  const installments = target?.installments;
  const participantsById = useMemo(() => {
    const out = new Map<string, InstallmentParticipant[]>();
    if (!sourceKind || !source || !installments) return out;
    const statements = Object.values(statementsByPersonId);
    for (const i of installments) {
      if (i.deletedAt != null || i.isSkipped) continue;
      const participants = installmentBreakdown({ sourceKind, source, installments, installmentId: i.id, statements })?.participants ?? [];
      if (participants.length > 0) out.set(i.id, participants);
    }
    return out;
  }, [sourceKind, source, installments, statementsByPersonId]);
  const personIdsKey = [...new Set([...participantsById.values()].flat().map((p) => p.personId))].sort().join(",");
  const personIds = useMemo(() => (personIdsKey ? personIdsKey.split(",") : []), [personIdsKey]);
  const { deferralsByPerson } = usePeoplePaymentDeferrals(personIds);
  const people = useMemo(
    () => (installments ? agreementPeople({ participantsByInstallment: participantsById, installments, deferralsByPerson, startDay }) : []),
    [participantsById, installments, deferralsByPerson, startDay],
  );
  return { people, isLoading: target != null && isLoading };
}
