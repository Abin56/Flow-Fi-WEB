"use client";

/**
 * One-shot (not live-watched) fan-out fetches for every payment-record
 * subcollection the History feed needs but no other page bulk-fetches yet:
 * per-loan and per-EMI installment payments (`.../installments/{id}/payments`),
 * per-bill payments (`.../bills/{id}/payments`), and per-statement payments
 * (`.../statements/{id}/statementPayments`). Mirrors the per-parent fan-out
 * pattern already established by `usePeopleLedgerEntries`
 * (`features/people/hooks/use-people-data.ts`) and
 * `useBillOccurrenceHistory` (`features/bills/hooks/use-bill-occurrence-history.ts`)
 * — one `useQuery` keyed by the sorted parent-id set, fanning out `getAll()`
 * per parent, rather than a live listener per row.
 *
 * Mirrors `historyEntriesProvider`'s `_installmentPaymentsForScheduleProvider`
 * (`Finance_App/lib/features/transactions/presentation/providers/history_providers.dart`):
 * for a loan/EMI's whole schedule, payments are fetched per-installment (not
 * per-schedule — the Firestore subcollection lives under each installment),
 * so this fans out one level further than the bill/statement cases.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Bill } from "@/lib/models/bill";
import type { PaymentRecord } from "@/lib/models/bill";
import type { CreditCardProfile, Statement, StatementPayment } from "@/lib/models/credit-card";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import {
  createAccountRepository,
  createBillRepository,
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createStatementPaymentRepository,
  createStatementRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { createPaymentRepository, createBillOccurrenceRepository } from "@/features/bills/lib/bill-occurrence-factory";
import { useAuthStore } from "@/store/auth-store";
import { useBills } from "@/hooks/use-bills";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";

/** Every payment across every installment in `installments`, keyed by that installment's `scheduleId`. */
function useInstallmentPaymentsBySchedule(
  installments: Installment[],
  queryKeyPrefix: string,
): { paymentsByScheduleId: Record<string, InstallmentPayment[]>; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const installmentIds = useMemo(
    () => installments.map((i) => `${i.scheduleId}:${i.id}`).sort(),
    [installments],
  );
  const idsKey = installmentIds.join(",");

  const query = useQuery({
    queryKey: [queryKeyPrefix, uid, idsKey],
    queryFn: async () => {
      if (!uid) return {} as Record<string, InstallmentPayment[]>;
      const byScheduleId: Record<string, InstallmentPayment[]> = {};
      await Promise.all(
        installments.map(async (installment) => {
          const installmentRepository = createInstallmentRepositoryFor(uid, installment.scheduleId);
          const paymentRepository = createInstallmentPaymentRepositoryFor(
            uid,
            installment.scheduleId,
            installment.id,
            installmentRepository,
          );
          const payments = await paymentRepository.getAll();
          byScheduleId[installment.scheduleId] = [...(byScheduleId[installment.scheduleId] ?? []), ...payments];
        }),
      );
      return byScheduleId;
    },
    enabled: !!uid && installments.length > 0,
    staleTime: 60_000,
  });

  return { paymentsByScheduleId: query.data ?? {}, isLoading: installments.length > 0 && query.isLoading };
}

/** Every payment across every loan's schedule, keyed by loan id. */
export function useLoanPayments(
  loans: { id: string; scheduleId: string }[],
  loanInstallments: Installment[],
): { paymentsByLoanId: Record<string, InstallmentPayment[]>; isLoading: boolean } {
  const { paymentsByScheduleId, isLoading } = useInstallmentPaymentsBySchedule(loanInstallments, "loanInstallmentPayments");
  const paymentsByLoanId = useMemo(() => {
    const byId: Record<string, InstallmentPayment[]> = {};
    for (const loan of loans) byId[loan.id] = paymentsByScheduleId[loan.scheduleId] ?? [];
    return byId;
  }, [loans, paymentsByScheduleId]);
  return { paymentsByLoanId, isLoading };
}

/** Every payment across every EMI's schedule, keyed by EMI id. */
export function useEmiPayments(
  emis: { id: string; scheduleId: string }[],
  emiInstallments: Installment[],
): { paymentsByEmiId: Record<string, InstallmentPayment[]>; isLoading: boolean } {
  const { paymentsByScheduleId, isLoading } = useInstallmentPaymentsBySchedule(emiInstallments, "emiInstallmentPayments");
  const paymentsByEmiId = useMemo(() => {
    const byId: Record<string, InstallmentPayment[]> = {};
    for (const emi of emis) byId[emi.id] = paymentsByScheduleId[emi.scheduleId] ?? [];
    return byId;
  }, [emis, paymentsByScheduleId]);
  return { paymentsByEmiId, isLoading };
}

/** Every payment across every bill's whole payment history (not occurrence-scoped), keyed by bill id. */
export function useBillPayments(): { paymentsByBillId: Record<string, PaymentRecord[]>; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: bills = [], isLoading: billsLoading } = useBills();
  const billIds = useMemo(() => (bills as Bill[]).map((b) => b.id).sort(), [bills]);

  const query = useQuery({
    queryKey: ["billPayments", uid, billIds.join(",")],
    queryFn: async () => {
      if (!uid) return {} as Record<string, PaymentRecord[]>;
      const billRepository = createBillRepository(uid);
      const entries = await Promise.all(
        (bills as Bill[]).map(async (bill) => {
          const occurrenceRepository = createBillOccurrenceRepository(uid, bill.id, billRepository);
          const paymentRepository = createPaymentRepository(uid, bill.id, occurrenceRepository);
          const payments = await paymentRepository.getAll();
          return [bill.id, payments] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, PaymentRecord[]>;
    },
    enabled: !!uid && billIds.length > 0,
    staleTime: 60_000,
  });

  return { paymentsByBillId: query.data ?? {}, isLoading: billsLoading || (billIds.length > 0 && query.isLoading) };
}

/** Every card's materialized statements plus every payment recorded against each, keyed by card id. */
export function useCreditCardStatementPayments(): {
  statementsByCardId: Record<string, Statement[]>;
  paymentsByStatementId: Record<string, StatementPayment[]>;
  cardNameById: Record<string, string>;
  isLoading: boolean;
} {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();

  const statementIds = useMemo(
    () => (statements as Statement[]).map((s) => `${s.cardId}:${s.id}`).sort(),
    [statements],
  );

  const query = useQuery({
    queryKey: ["statementPayments", uid, statementIds.join(",")],
    queryFn: async () => {
      if (!uid) return {} as Record<string, StatementPayment[]>;
      const accountRepository = createAccountRepository(uid);
      const transactionRepository = createTransactionRepository(uid, accountRepository);
      const entries = await Promise.all(
        (statements as Statement[]).map(async (statement) => {
          const statementRepository = createStatementRepository(uid, statement.cardId);
          const paymentRepository = createStatementPaymentRepository(
            uid,
            statement.cardId,
            statement.id,
            statementRepository,
            transactionRepository,
          );
          const payments = await paymentRepository.getAll();
          return [statement.id, payments] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, StatementPayment[]>;
    },
    enabled: !!uid && statementIds.length > 0,
    staleTime: 60_000,
  });

  const statementsByCardId = useMemo(() => {
    const byCard: Record<string, Statement[]> = {};
    for (const statement of statements as Statement[]) {
      byCard[statement.cardId] = [...(byCard[statement.cardId] ?? []), statement];
    }
    return byCard;
  }, [statements]);

  const cardNameById = useMemo(() => {
    const byId: Record<string, string> = {};
    for (const card of cards as CreditCardProfile[]) {
      byId[card.id] = card.cardHolderName ?? `Card •••• ${card.lastFourDigits ?? ""}`;
    }
    return byId;
  }, [cards]);

  return {
    statementsByCardId,
    paymentsByStatementId: query.data ?? {},
    cardNameById,
    isLoading: cardsLoading || statementsLoading || (statementIds.length > 0 && query.isLoading),
  };
}
