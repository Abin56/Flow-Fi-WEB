"use client";

/**
 * The People side of every installment of a shared Loan / EMI, for its schedule rows — read from the same
 * whole-history People statements as the Pay dialog (`installmentBreakdown`), plus each person's postponement.
 * Display only: the lender side is the installment itself; nothing here settles, moves or reschedules anything.
 */

import { useMemo } from "react";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { usePeoplePaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { installmentBreakdown, type InstallmentParticipant } from "@/lib/engines/installment-participants";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import { cycleName, deferralView } from "@/lib/engines/person-payment-deferral";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import type { Installment } from "@/lib/models/payment-schedule";
import { formatCurrency } from "@/lib/format";

const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

/** "Priya: ₹1,000 to receive · Ravi: received" — tone `received` only when every share of it came in. */
export interface InstallmentPeopleStatus {
  text: string;
  tone: "received" | "owed" | "moved";
}

/**
 * Pure: one installment's People line from its participants and their postponements. Null when nobody shares it,
 * or when it isn't due yet and nothing has come in for it (an upcoming share isn't news on the schedule).
 */
export function peopleStatusOf(
  participants: readonly InstallmentParticipant[],
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>,
  startDay: number,
  notDueYet = false,
): InstallmentPeopleStatus | null {
  const sharing = participants.filter((p) => p.current != null && p.current.share > PAYMENT_EPSILON);
  if (sharing.length === 0) return null;
  if (notDueYet && sharing.every((p) => p.current!.received <= PAYMENT_EPSILON)) return null;
  const open = sharing.filter((p) => p.current!.remaining > PAYMENT_EPSILON);
  if (open.length === 0) return { text: sharing.length === 1 ? `${sharing[0].personName}: received` : "People: all received", tone: "received" };
  let moved = 0;
  const parts = sharing.map((p) => {
    const line = p.current!;
    if (line.remaining <= PAYMENT_EPSILON) return `${p.personName}: received`;
    const deferral = deferralsByPerson[p.personId]?.find((d) => d.obligationKey === line.key);
    const view = deferral ? deferralView(deferral, line.remaining, startDay) : null;
    if (view?.status === "postponed") {
      moved += 1;
      return `${p.personName}: moved to ${cycleName(view.cycle)} cycle`;
    }
    return line.received > PAYMENT_EPSILON
      ? `${p.personName}: ${formatCurrency(line.received)} of ${formatCurrency(line.share)} received`
      : `${p.personName}: ${formatCurrency(line.remaining)} to receive`;
  });
  return { text: parts.join(" · "), tone: moved === open.length ? "moved" : "owed" };
}

export function useInstallmentPeopleStatus(
  target: { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] } | null,
): ReadonlyMap<string, InstallmentPeopleStatus> {
  const { statementsByPersonId } = usePeopleCycleStatements(ALL_TIME);
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
      out.set(i.id, installmentBreakdown({ sourceKind, source, installments, installmentId: i.id, statements })?.participants ?? []);
    }
    return out;
  }, [sourceKind, source, installments, statementsByPersonId]);
  const personIdsKey = [...new Set([...participantsById.values()].flat().map((p) => p.personId))].sort().join(",");
  const personIds = useMemo(() => (personIdsKey ? personIdsKey.split(",") : []), [personIdsKey]);
  const { deferralsByPerson } = usePeoplePaymentDeferrals(personIds);
  return useMemo(() => {
    const out = new Map<string, InstallmentPeopleStatus>();
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const dueById = new Map((installments ?? []).map((i) => [i.id, i.dueDate]));
    for (const [id, participants] of participantsById) {
      const status = peopleStatusOf(participants, deferralsByPerson, startDay, (dueById.get(id)?.getTime() ?? 0) > endOfToday.getTime());
      if (status) out.set(id, status);
    }
    return out;
  }, [participantsById, deferralsByPerson, startDay, installments]);
}
