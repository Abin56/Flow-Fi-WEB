"use client";

import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import type { LoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import { PaymentHistoryList, type HistoryExtraItem } from "@/features/loans/components/payment-rows";
import { historyEntryTitle } from "@/features/loans/lib/loan-labels";
import { installmentRangeLabel, type RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";

/**
 * A Loan's payment history: one row per recorded payment action (the amount entered, even when it was
 * spread across several installments), plus additional amounts. Active payments open their details.
 */
export function LoanFinancialHistory({
  row,
  history,
  actions,
  isLoading,
  onOpen,
}: {
  row: LoanRow;
  history: LoanPaymentHistory | undefined;
  actions: RecordedPaymentAction[];
  isLoading: boolean;
  onOpen: (action: RecordedPaymentAction) => void;
}) {
  if (isLoading && !history) return <p className="text-xs text-muted-foreground">Loading history…</p>;
  const events = history?.events ?? [];
  const eventByPayment = new Map(events.filter((e) => e.triggeredByPaymentId).map((e) => [e.triggeredByPaymentId!, e]));
  const eventByDisbursement = new Map(events.filter((e) => e.triggeredByDisbursementId).map((e) => [e.triggeredByDisbursementId!, e]));
  const inr = (v: number) => `₹${v.toLocaleString("en-IN")}`;

  const extras: HistoryExtraItem[] = (history?.disbursements ?? []).map((item) => {
    const event = eventByDisbursement.get(item.id);
    return {
      id: `disbursement:${item.id}`,
      title: historyEntryTitle({ kind: "additionalAmount" }, row.direction),
      amount: item.amount,
      date: item.date,
      reversed: item.deletedAt != null || event?.reversed === true,
      detail: event ? `Principal ${inr(event.principalBefore)} → ${inr(event.principalAfter)}` : null,
    };
  });

  return (
    <PaymentHistoryList
      actions={actions}
      extras={extras}
      onOpen={onOpen}
      titleFor={(action) =>
        historyEntryTitle({ kind: "payment", allocationType: action.allocationType, partial: action.overflow == null && (action.remainingAfter ?? 0) > 0 }, row.direction)
      }
      detailFor={(action) => {
        const event = action.overflow ? eventByPayment.get(action.overflow.id) : undefined;
        if (event) return `Principal ${inr(event.principalBefore)} → ${inr(event.principalAfter)} · Installments ${event.installmentCountBefore} → ${event.installmentCountAfter}`;
        const range = action.installmentSeqs.length > 0 ? `Installment ${installmentRangeLabel(action.installmentSeqs)}` : null;
        const left = action.overflow == null && (action.remainingAfter ?? 0) > 0 ? `${inr(action.remainingAfter!)} remaining` : null;
        return [range, left].filter(Boolean).join(" · ") || null;
      }}
    />
  );
}
