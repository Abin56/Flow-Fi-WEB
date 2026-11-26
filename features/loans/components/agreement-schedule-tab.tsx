"use client";

import { useMemo, useState } from "react";
import { InstallmentDetail, InstallmentGrid } from "@/features/loans/components/installment-grid";
import { peopleLinesByInstallment, type AgreementPerson } from "@/features/loans/lib/agreement-people";
import { firstPayableId, installmentTableRows } from "@/features/loans/lib/installment-table";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { scheduleReceipts, type ScheduleReceipts } from "@/features/loans/lib/schedule-receipts";
import { usePeopleAdvanceApplications, usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useGlobalCycle } from "@/features/month-cycle/hooks/use-global-cycle";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { Installment } from "@/lib/models/payment-schedule";

/**
 * The workspace's Schedule tab: the installment grid on top, the selected installment's details and actions beneath it.
 * The lender figures come from `installmentTableRows`, and the agreement's People balance comes from the linked shares.
 */
export function AgreementScheduleTab({
  installments,
  actions,
  closed,
  total,
  lent,
  people,
  cycleBalance,
  onPay,
  onViewPayment,
  onTheyPaid,
  peopleTarget,
  returnTo,
}: {
  installments: Installment[];
  actions: RecordedPaymentAction[];
  closed: boolean;
  total: number;
  lent: boolean;
  people: AgreementPerson[];
  cycleBalance: { remaining: number; label: string } | null;
  onPay: (installment: Installment) => void;
  onViewPayment: (action: RecordedPaymentAction) => void;
  /** Records that a person already paid their share of an installment (People side only). */
  onTheyPaid?: (installment: Installment) => void;
  /** Opens "They paid" inline under the selected installment. */
  peopleTarget?: { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] };
  returnTo: string;
}) {
  const { entriesByPersonId, isLoading: receiptsLoading } = usePeopleLedgerEntries();
  const { applicationsByPersonId } = usePeopleAdvanceApplications();
  const { cycleRange: cycle, monthCycleStartDay: startDay } = useGlobalCycle();
  const cycleStart = cycle.start.getTime();
  const cycleEnd = cycle.end.getTime();
  const receiptsByPerson = useMemo(() => {
    const receiptsByPerson = new Map<string, ScheduleReceipts>();
    for (const person of people) {
      const entries = entriesByPersonId[person.personId];
      if (entries == null) continue;
      const context = scheduleReceipts({
        entries,
        applications: applicationsByPersonId[person.personId],
        lines: person.lines,
        cycle: { start: new Date(cycleStart), end: new Date(cycleEnd) },
      });
      receiptsByPerson.set(person.personId, context);
    }
    return receiptsByPerson;
  }, [people, entriesByPersonId, applicationsByPersonId, cycleStart, cycleEnd]);
  const peopleLines = useMemo(() => peopleLinesByInstallment(people), [people]);
  const rows = useMemo(() => installmentTableRows({ installments, actions, closed }), [installments, actions, closed]);
  const [picked, setPicked] = useState<string | null>(null);
  // Until the user picks one: what to pay next, else the last installment. A picked row that has gone falls back the same way.
  const fallback = firstPayableId(rows) ?? rows[rows.length - 1]?.id ?? null;
  const selectedId = picked != null && rows.some((r) => r.id === picked) ? picked : fallback;
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  return (
    <>
      <InstallmentGrid rows={rows} selectedId={selectedId} onSelect={setPicked} total={total} lent={lent} cycleBalance={cycleBalance} />
      <InstallmentDetail
        row={selected}
        lent={lent}
        cycleStartDay={startDay}
        peopleLines={selected ? (peopleLines.get(selected.id) ?? []) : []}
        receiptsByPerson={receiptsByPerson}
        receiptsLoading={receiptsLoading}
        onPay={onPay}
        onViewPayment={onViewPayment}
        onTheyPaid={onTheyPaid}
        peopleTarget={peopleTarget}
        actions={actions}
        returnTo={returnTo}
      />
    </>
  );
}
