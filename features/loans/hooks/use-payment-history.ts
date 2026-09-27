"use client";

/**
 * Recorded-payment history for one Loan or EMI — the per-installment `payments` subcollections (plus a
 * Loan's re-plan events / additional disbursements, and an EMI's charge breakdowns). One-shot reads keyed
 * on the live schedule state, so every payment, edit or reversal re-reads them while a dialog stays open;
 * a write that leaves the schedule unchanged (e.g. only the date was corrected) is covered by the
 * explicit invalidation of these keys after the write.
 */

import { useQuery } from "@tanstack/react-query";
import { collection, getDocs } from "firebase/firestore";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { historyInstallmentIds, loanHistoryQueryKey } from "@/features/loans/lib/loan-live-state";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import type { EmiPaymentBreakdown } from "@/lib/models/emi";
import { loanAdditionalDisbursementFromFirestore, loanAdditionalDisbursementToFirestore, type LoanAdditionalDisbursement } from "@/lib/models/loan-additional-disbursement";
import { loanReamortizationEventFromFirestore, loanReamortizationEventToFirestore, type LoanReamortizationEvent } from "@/lib/models/loan-reamortization-event";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type InstallmentPayment } from "@/lib/models/payment-schedule";
import { createEmiPaymentBreakdownRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

/** Query-key prefix of the EMI history — invalidated after every EMI payment write. */
export const EMI_PAYMENT_HISTORY_KEY = "emiPaymentHistory";

async function readPayments(uid: string, scheduleId: string, installmentIds: string[]): Promise<InstallmentPayment[]> {
  const perInstallment = await Promise.all(
    installmentIds.map(async (installmentId) => {
      const ref = collection(
        db,
        FirestoreCollections.users,
        uid,
        FirestoreCollections.paymentSchedules,
        scheduleId,
        FirestoreCollections.installments,
        installmentId,
        FirestoreCollections.payments,
      ).withConverter({ toFirestore: installmentPaymentToFirestore, fromFirestore: installmentPaymentFromFirestore });
      return (await getDocs(ref)).docs.map((d) => d.data());
    }),
  );
  return perInstallment.flat();
}

export interface LoanPaymentHistory {
  payments: InstallmentPayment[];
  events: LoanReamortizationEvent[];
  disbursements: LoanAdditionalDisbursement[];
}

export function useLoanPaymentHistory(row: LoanRow | null) {
  const uid = useAuthStore((s) => s.user?.uid);
  return useQuery({
    queryKey: row ? loanHistoryQueryKey(uid, row.loan, row.installments) : ["loan-financial-history", uid, null],
    enabled: !!uid && row != null,
    queryFn: async (): Promise<LoanPaymentHistory> => {
      if (!uid || !row) return { payments: [], events: [], disbursements: [] };
      const base = [FirestoreCollections.users, uid, FirestoreCollections.loans, row.loan.id] as const;
      const eventsRef = collection(db, ...base, FirestoreCollections.reamortizationEvents).withConverter({
        toFirestore: loanReamortizationEventToFirestore,
        fromFirestore: loanReamortizationEventFromFirestore,
      });
      const disbursementsRef = collection(db, ...base, FirestoreCollections.additionalDisbursements).withConverter({
        toFirestore: loanAdditionalDisbursementToFirestore,
        fromFirestore: loanAdditionalDisbursementFromFirestore,
      });
      const [eventsSnap, disbursementsSnap] = await Promise.all([getDocs(eventsRef), getDocs(disbursementsRef)]);
      const events = eventsSnap.docs.map((d) => d.data());
      const ids = historyInstallmentIds(row.installments.map((i) => i.id), events);
      return { payments: await readPayments(uid, row.loan.scheduleId, ids), events, disbursements: disbursementsSnap.docs.map((d) => d.data()) };
    },
    staleTime: 15_000,
    // Keep showing the previous history while a changed key re-reads, instead of flashing "Loading…".
    placeholderData: (previous) => previous,
  });
}

export interface EmiPaymentHistory {
  payments: InstallmentPayment[];
  breakdowns: EmiPaymentBreakdown[];
}

export function useEmiPaymentHistory(row: EmiRow | null) {
  const uid = useAuthStore((s) => s.user?.uid);
  const fingerprint = row ? row.installments.map((i) => `${i.id}:${i.amountPaid}`).join(",") : "";
  return useQuery({
    queryKey: [EMI_PAYMENT_HISTORY_KEY, uid, row?.emi.id ?? null, fingerprint],
    enabled: !!uid && row != null,
    queryFn: async (): Promise<EmiPaymentHistory> => {
      if (!uid || !row) return { payments: [], breakdowns: [] };
      // Every installment, not only paid ones: a corrected/reversed payment can sit under one that is now unpaid.
      const [payments, breakdowns] = await Promise.all([
        readPayments(uid, row.emi.scheduleId, row.installments.map((i) => i.id)),
        createEmiPaymentBreakdownRepository(uid, row.emi.id).getAll(),
      ]);
      return { payments, breakdowns };
    },
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}
