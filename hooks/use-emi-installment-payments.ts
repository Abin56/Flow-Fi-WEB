"use client";

/**
 * Every active payment on every EMI's installments — the payment-level input Month Cycle and Dashboard need to
 * bucket EMI money by the day it was PAID, not by the installment's due date (WFI-P2-11): an advance or late
 * payment then lands in the month it really happened. Same fan-out shape as `useLoanScheduledPayments`; it
 * re-reads whenever the live installment snapshot changes (every payment / reversal moves `amountPaid`).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Installment } from "@/lib/models/payment-schedule";
import { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useAllEmiInstallments } from "./use-emis";

export interface EmiPaidRow {
  scheduleId: string;
  /** The payment's own date — the bucket date. */
  date: Date;
  amount: number;
}

export function useEmiInstallmentPayments(): { payments: EmiPaidRow[]; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: installments = [] } = useAllEmiInstallments();

  const paid = useMemo(() => (installments as Installment[]).filter((i) => i.deletedAt == null && i.amountPaid > 0), [installments]);
  const fingerprint = useMemo(() => paid.map((i) => `${i.scheduleId}:${i.id}:${i.amountPaid}`).sort().join(","), [paid]);

  const query = useQuery({
    queryKey: ["emiInstallmentPayments", uid, fingerprint],
    enabled: !!uid && paid.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<EmiPaidRow[]> => {
      if (!uid) return [];
      const perInstallment = await Promise.all(
        paid.map(async (installment) => {
          const repository = createInstallmentPaymentRepositoryFor(uid, installment.scheduleId, installment.id, createInstallmentRepositoryFor(uid, installment.scheduleId));
          const payments = (await repository.getAll()).filter((p) => p.deletedAt == null);
          const rows = payments.map((p): EmiPaidRow => ({ scheduleId: installment.scheduleId, date: p.date, amount: p.amount }));
          // A legacy installment whose `amountPaid` has no (or not all) payment records keeps the unrecorded part
          // at its due date, as before — never dropped from the totals.
          const unrecorded = Math.round((installment.amountPaid - rows.reduce((s, r) => s + r.amount, 0)) * 100) / 100;
          if (unrecorded > 0) rows.push({ scheduleId: installment.scheduleId, date: installment.dueDate, amount: unrecorded });
          return rows;
        }),
      );
      return perInstallment.flat();
    },
  });

  return { payments: paid.length === 0 ? [] : (query.data ?? []), isLoading: paid.length > 0 && query.isLoading };
}
