"use client";

/**
 * Composes the EMI page's real data/actions from the ported `Emi`/
 * `EmiPaymentBreakdown` models plus the feature-agnostic `PaymentSchedule`/
 * `Installment` engine — first EMI list/detail UI in the web app (Credit
 * Cards only reads `Emi`/`EmiPaymentBreakdown` for utilization math, it has
 * no EMI list/detail view of its own), so there is no mock file being
 * replaced.
 *
 * Every EMI's remaining balance / next-due installment is derived from its
 * linked schedule's real `Installment` documents (`hooks/use-emis.ts`'s
 * `useAllEmiInstallments`), using the exact same `remainingAmount`/
 * `installmentStatus` pure functions `InstallmentRepository` itself uses —
 * never a separately invented balance formula.
 *
 * Known, accepted gap for this pass: `EmisSummary`'s "Monthly EMI Outlay"
 * sums each active EMI's next-due installment amount regardless of that
 * EMI's own `installmentFrequency` (weekly/custom EMIs get counted at their
 * per-installment amount, not normalized to a monthly figure) — there's no
 * ported engine that annualizes/monthly-izes an arbitrary cadence, and
 * inventing one here would be exactly the kind of fabricated math this
 * codebase's rules forbid. Documented, not silently smoothed over.
 */

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCategories } from "@/hooks/use-categories";
import { useCreditCards, useEmis, emisQueryKey } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments, emiInstallmentsQueryKey } from "@/hooks/use-emis";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { emiStatusGiven, type Emi, type EmiLoanType, type EmiStatus } from "@/lib/models/emi";
import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import {
  createEmiPaymentBreakdownRepository,
  createEmiRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
} from "@/lib/repositories/repository-factory";
import type { CreateEmiParams, EditEmiParams, EditEmiTermsParams } from "@/lib/repositories/emi-repository";
import { useAuthStore } from "@/store/auth-store";

export interface EmiRow {
  emi: Emi;
  category: Category | undefined;
  linkedCard: CreditCardProfile | undefined;
  installments: Installment[];
  /** Sum of `remainingAmount` across every non-skipped installment — the same derivation `InstallmentRepository.remainingAmount` performs. */
  remainingBalance: number;
  /** The earliest not-fully-paid, not-skipped installment, or null once every installment is settled. */
  nextInstallment: Installment | null;
  installmentsPaid: number;
  status: EmiStatus;
}

/** Live EMI list joined with its schedule's installments, category, and linked credit card. */
export function useEmiRows(): { rows: EmiRow[]; isLoading: boolean } {
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: installments = [], isLoading: installmentsLoading } = useAllEmiInstallments();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();

  const rows = useMemo(() => {
    const categoryById = new Map((categories as Category[]).map((c) => [c.id, c]));
    const cardById = new Map((cards as CreditCardProfile[]).map((c) => [c.id, c]));
    const installmentsByScheduleId = new Map<string, Installment[]>();
    for (const installment of installments as Installment[]) {
      const list = installmentsByScheduleId.get(installment.scheduleId) ?? [];
      list.push(installment);
      installmentsByScheduleId.set(installment.scheduleId, list);
    }

    return (emis as Emi[]).map((emi) => {
      const emiInstallments = (installmentsByScheduleId.get(emi.scheduleId) ?? []).sort(
        (a, b) => a.sequenceNumber - b.sequenceNumber,
      );
      const remainingBalance = emiInstallments
        .filter((i) => installmentStatus(i) !== "skipped")
        .reduce((sum, i) => sum + remainingAmount(i), 0);
      const nextInstallment = emiInstallments.find((i) => !i.isSkipped && remainingAmount(i) > 0) ?? null;
      const installmentsPaid = emiInstallments.filter((i) => installmentStatus(i) === "paid").length;

      return {
        emi,
        category: emi.categoryId ? categoryById.get(emi.categoryId) : undefined,
        linkedCard: emi.linkedCreditCardId ? cardById.get(emi.linkedCreditCardId) : undefined,
        installments: emiInstallments,
        remainingBalance,
        nextInstallment,
        installmentsPaid,
        status: emiStatusGiven(emi, emiInstallments),
      };
    });
  }, [emis, installments, categories, cards]);

  return {
    rows,
    isLoading: emisLoading || installmentsLoading || categoriesLoading || cardsLoading,
  };
}

export interface RecordEmiPaymentParams {
  amount: number;
  date: Date;
  note?: string;
  principalPaid?: number;
  interestPaid?: number;
  gst?: number;
  igst?: number;
  processingFee?: number;
  insuranceCharge?: number;
  serviceCharge?: number;
  penalty?: number;
  otherCharges?: number;
}

/** Create/edit/close/payment actions wired to the real EMI + payment-schedule repositories, scoped to the signed-in user. */
export function useEmiActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!uid) return null;
    const emiRepository = createEmiRepository(uid);

    const invalidate = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: emisQueryKey(uid) }),
        queryClient.invalidateQueries({ queryKey: emiInstallmentsQueryKey(uid) }),
      ]);
    };

    return {
      createEmi: async (params: CreateEmiParams & { loanType?: EmiLoanType }) => {
        const emi = await emiRepository.createEmi(params);
        await invalidate();
        return emi;
      },
      editEmi: async (emi: Emi, params: EditEmiParams) => {
        await emiRepository.editEmi(emi, params);
        await invalidate();
      },
      editEmiTerms: async (emi: Emi, params: EditEmiTermsParams) => {
        await emiRepository.editEmiTerms(emi, params);
        await invalidate();
      },
      closeEmi: async (emi: Emi) => {
        await emiRepository.closeEmi(emi);
        await invalidate();
      },
      reopenEmi: async (emi: Emi) => {
        await emiRepository.reopenEmi(emi);
        await invalidate();
      },
      markDefaulted: async (emi: Emi) => {
        await emiRepository.markDefaulted(emi);
        await invalidate();
      },
      clearDefaulted: async (emi: Emi) => {
        await emiRepository.clearDefaulted(emi);
        await invalidate();
      },
      deleteEmi: async (emi: Emi) => {
        await emiRepository.permanentlyDeleteEmi(emi);
        await invalidate();
      },
      /**
       * Records a payment against `installment` (the EMI's next-due
       * installment, in practice) via the generic
       * `InstallmentPaymentRepository`, then persists the EMI-specific
       * charge breakdown (GST/processing fee/etc.) via
       * `EmiPaymentBreakdownRepository.createBreakdown` — mirrors exactly
       * how `EmiPaymentBreakdown` is documented to be created (see
       * `lib/models/emi.ts`).
       */
      recordPayment: async (emi: Emi, installment: Installment, params: RecordEmiPaymentParams) => {
        const installmentRepository = createInstallmentRepositoryFor(uid, emi.scheduleId);
        const installmentPaymentRepository = createInstallmentPaymentRepositoryFor(
          uid,
          emi.scheduleId,
          installment.id,
          installmentRepository,
        );
        const payment = await installmentPaymentRepository.recordPayment(installment, {
          amount: params.amount,
          date: params.date,
          note: params.note,
        });

        const breakdownRepository = createEmiPaymentBreakdownRepository(uid, emi.id);
        await breakdownRepository.createBreakdown({
          paymentId: payment.id,
          scheduleId: emi.scheduleId,
          installmentId: installment.id,
          principalPaid: params.principalPaid ?? params.amount,
          interestPaid: params.interestPaid,
          gst: params.gst,
          igst: params.igst,
          processingFee: params.processingFee,
          insuranceCharge: params.insuranceCharge,
          serviceCharge: params.serviceCharge,
          penalty: params.penalty,
          otherCharges: params.otherCharges,
        });

        await invalidate();
      },
    };
  }, [uid, queryClient]);
}
