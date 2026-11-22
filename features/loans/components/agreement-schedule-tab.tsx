"use client";

import { useMemo, useState } from "react";
import { InstallmentDetail, InstallmentGrid } from "@/features/loans/components/installment-grid";
import { peopleLinesByInstallment, type AgreementPerson } from "@/features/loans/lib/agreement-people";
import { firstPayableId, installmentTableRows } from "@/features/loans/lib/installment-table";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { Installment } from "@/lib/models/payment-schedule";

/**
 * The workspace's Schedule tab: the installment grid on top, the selected installment's details and actions beneath it.
 * It owns only which row is selected (by default the one to pay next); every figure comes from `installmentTableRows` and
 * every action is a handler the caller already has (the existing Record Payment / payment details).
 */
export function AgreementScheduleTab({
  installments,
  actions,
  closed,
  total,
  lent,
  people,
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
  onPay: (installment: Installment) => void;
  onViewPayment: (action: RecordedPaymentAction) => void;
  /** Records that a person already paid their share of an installment (People side only). */
  onTheyPaid?: (installment: Installment) => void;
  /** Opens "They paid" inline under the selected installment. */
  peopleTarget?: { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] };
  returnTo: string;
}) {
  const peopleLines = useMemo(() => peopleLinesByInstallment(people), [people]);
  const rows = useMemo(() => installmentTableRows({ installments, actions, closed, peopleLines: people.length > 0 ? peopleLines : undefined }), [installments, actions, closed, people.length, peopleLines]);
  const [picked, setPicked] = useState<string | null>(null);
  // Until the user picks one: what to pay next, else the last installment. A picked row that has gone falls back the same way.
  const fallback = firstPayableId(rows) ?? rows[rows.length - 1]?.id ?? null;
  const selectedId = picked != null && rows.some((r) => r.id === picked) ? picked : fallback;
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  return (
    <>
      <InstallmentGrid rows={rows} selectedId={selectedId} onSelect={setPicked} total={total} lent={lent} showPeople={people.length > 0} />
      <InstallmentDetail row={selected} total={total} lent={lent} peopleLines={selected ? (peopleLines.get(selected.id) ?? []) : []} onPay={onPay} onViewPayment={onViewPayment} onTheyPaid={onTheyPaid} peopleTarget={peopleTarget} returnTo={returnTo} />
    </>
  );
}
