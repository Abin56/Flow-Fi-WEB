"use client";

import { useQuery } from "@tanstack/react-query";
import { collection, getDocs } from "firebase/firestore";
import { History } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import type { LoanDirection } from "@/lib/models/loan";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type InstallmentPayment } from "@/lib/models/payment-schedule";
import { loanAdditionalDisbursementFromFirestore, loanAdditionalDisbursementToFirestore, type LoanAdditionalDisbursement } from "@/lib/models/loan-additional-disbursement";
import { loanReamortizationEventFromFirestore, loanReamortizationEventToFirestore, type LoanReamortizationEvent } from "@/lib/models/loan-reamortization-event";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { historyEntryTitle } from "@/features/loans/lib/loan-labels";
import { historyInstallmentIds, loanHistoryQueryKey } from "@/features/loans/lib/loan-live-state";
import { useAuthStore } from "@/store/auth-store";

interface HistoryItem {
  id: string;
  title: string;
  amount: number;
  date: Date;
  reversed: boolean;
  detail: string | null;
}

export function LoanFinancialHistory({ row }: { row: LoanRow }) {
  const uid = useAuthStore((state) => state.user?.uid);
  const query = useQuery({
    // Keyed on the live loan + schedule state, so any persisted money operation (or its reversal)
    // re-reads history while the dialog stays open — see `loanHistoryQueryKey`.
    queryKey: loanHistoryQueryKey(uid, row.loan, row.installments),
    enabled: !!uid,
    queryFn: async () => {
      if (!uid) return [] as HistoryItem[];
      const eventsRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.loans, row.loan.id, FirestoreCollections.reamortizationEvents).withConverter({ toFirestore: loanReamortizationEventToFirestore, fromFirestore: loanReamortizationEventFromFirestore });
      const disbursementsRef = collection(db, FirestoreCollections.users, uid, FirestoreCollections.loans, row.loan.id, FirestoreCollections.additionalDisbursements).withConverter({ toFirestore: loanAdditionalDisbursementToFirestore, fromFirestore: loanAdditionalDisbursementFromFirestore });
      const [eventsSnap, disbursementsSnap] = await Promise.all([getDocs(eventsRef), getDocs(disbursementsRef)]);
      const events = eventsSnap.docs.map((doc) => doc.data());
      const installmentIds = historyInstallmentIds(row.installments.map((item) => item.id), events);
      const paymentEntries = await Promise.all(installmentIds.map(async (installmentId) => {
        const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.paymentSchedules, row.loan.scheduleId, FirestoreCollections.installments, installmentId, FirestoreCollections.payments).withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore });
        return (await getDocs(ref)).docs.map((doc) => doc.data());
      }));
      return composeHistory(paymentEntries.flat(), events, disbursementsSnap.docs.map((doc) => doc.data()), row.direction);
    },
    staleTime: 15_000,
    // Keep showing the previous history while a changed key re-reads, instead of flashing "Loading…".
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) return <p className="text-xs text-muted-foreground">Loading history…</p>;
  if (!query.data?.length) return <p className="text-xs text-muted-foreground">No payment history yet.</p>;
  return <div className="space-y-2">{query.data.map((item) => <div key={item.id} className="flex items-start justify-between gap-4 rounded-xl border border-border/70 px-3 py-2.5"><div className="min-w-0"><div className="flex items-center gap-2"><History className="size-3.5 text-muted-foreground"/><span className="text-sm font-medium">{item.title}</span>{item.reversed && <ClayBadge tone="neutral">Reversed</ClayBadge>}</div><p className="mt-1 text-xs text-muted-foreground">{item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}{item.detail ? ` · ${item.detail}` : ""}</p></div><span className="font-mono text-sm font-semibold tabular-nums">₹{item.amount.toLocaleString("en-IN")}</span></div>)}</div>;
}

export function composeHistory(payments: InstallmentPayment[], events: LoanReamortizationEvent[], disbursements: LoanAdditionalDisbursement[], direction: LoanDirection = "taken"): HistoryItem[] {
  const eventByPayment = new Map(events.filter((event) => event.triggeredByPaymentId).map((event) => [event.triggeredByPaymentId!, event]));
  const eventByDisbursement = new Map(events.filter((event) => event.triggeredByDisbursementId).map((event) => [event.triggeredByDisbursementId!, event]));
  // The same payment doc can be reached through both a live and a retired installment id list.
  const uniquePayments = Array.from(new Map(payments.map((payment) => [payment.id, payment])).values());
  const paymentItems = uniquePayments.map((payment): HistoryItem => {
    const event = eventByPayment.get(payment.id);
    const partial = payment.remainingBalanceAfterPayment != null && payment.remainingBalanceAfterPayment > 0;
    const title = historyEntryTitle({ kind: "payment", allocationType: payment.allocationType, partial }, direction);
    const detail = event ? `Principal ₹${event.principalBefore.toLocaleString("en-IN")} → ₹${event.principalAfter.toLocaleString("en-IN")} · Installments ${event.installmentCountBefore} → ${event.installmentCountAfter}` : partial ? `₹${payment.remainingBalanceAfterPayment!.toLocaleString("en-IN")} remaining` : null;
    return { id: `payment:${payment.id}`, title, amount: payment.amount, date: payment.date, reversed: payment.deletedAt != null || event?.reversed === true, detail };
  });
  const disbursementItems = disbursements.map((item): HistoryItem => {
    const event = eventByDisbursement.get(item.id);
    return { id: `disbursement:${item.id}`, title: historyEntryTitle({ kind: "additionalAmount" }, direction), amount: item.amount, date: item.date, reversed: item.deletedAt != null || event?.reversed === true, detail: event ? `Principal ₹${event.principalBefore.toLocaleString("en-IN")} → ₹${event.principalAfter.toLocaleString("en-IN")}` : null };
  });
  return [...paymentItems, ...disbursementItems].sort((a, b) => b.date.getTime() - a.date.getTime());
}
