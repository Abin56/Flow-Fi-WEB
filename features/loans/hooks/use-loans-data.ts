"use client";

/**
 * Composes the Loans page's real data/actions from the ported `Loan`/
 * `PaymentSchedule`/`Installment` models and repositories — replaces
 * `lib/mock/loans-data.ts` as the page's data source. Mirrors
 * `features/credit-cards/hooks/use-credit-cards-data.ts`'s posture: this file
 * never recomputes amortization itself (that already happened once, at
 * creation/edit time, inside `LoanRepository.createLoan`/`editLoanTerms` via
 * the `calculate` engine — see that file), it only projects the resulting
 * `Loan` + its linked schedule's installments into the view shape the
 * workspace/card/summary components render.
 *
 * Outstanding principal is derived from installments, not a cached balance —
 * the exact same `principalPaid` computation `LoanRepository.editLoanTerms`
 * already uses internally (an installment counts as "settled" once any
 * amount has been paid toward it or it's been skipped; a settled
 * installment's principal contribution is its `principalPortion` when the
 * loan carries interest, else its full `amountDue` — non-interest
 * installments have no interest/principal split, so the whole amount IS
 * principal). This file re-expresses that formula rather than reimplementing
 * amortization.
 *
 * Known, accepted gaps for this pass (documented, not silently faked):
 *  - Institutional loans (`category: "institutional"`) store their lender
 *    directly as `Loan.institutionName` — `Loan.personId` being nullable
 *    (see `lib/models/loan.ts`) is what let this page drop its previous
 *    find-or-create-a-Person-by-name hack for them. Personal loans
 *    (`category: "personal"`) instead pick a real `Person` via `personId`,
 *    mirroring the Flutter app's Loans feature exactly. Loans created
 *    *before* the category field existed still have `institutionName: null`
 *    and a real `personId` pointing at their old shadow Person — those are
 *    left untouched (no migration) and keep resolving their `lenderName`
 *    through that linked Person, exactly as before. See `toLoanRow`'s
 *    `lenderName` fallback and `useLoanActions().createLoan`/`editLoan` below.
 *  - Only a settled installment's own `principalPortion`/`amountDue` counts
 *    toward `outstandingPrincipal` — a *partially* paid installment's
 *    principal/interest split for the paid fraction isn't tracked anywhere
 *    (no `LoanPaymentBreakdown` equivalent to EMI's `EmiPaymentBreakdown`
 *    exists), so partial payments are treated the same simplified way
 *    `editLoanTerms` already treats them, not approximated further here.
 */

import { useMemo } from "react";
import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import {
  installmentStatus,
  type Installment,
  type ScheduleType,
} from "@/lib/models/payment-schedule";
import {
  loanStatusGiven,
  type Loan,
  type LoanCategory,
  type LoanDirection,
  type LoanInterest,
  type LoanStatus,
} from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { CreateLoanParams, EditLoanParams } from "@/lib/repositories/loan-repository";
import {
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLoanRepository,
} from "@/lib/repositories/repository-factory";
import { useAllLoanInstallments, useLoanPersons, useLoans, useTrashedLoans } from "@/hooks/use-loans";
import { useAuthStore } from "@/store/auth-store";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const ACCENT_CYCLE: LoanRow["accent"][] = ["primary", "success", "warning", "purple", "expense"];

export interface LoanRow {
  loan: Loan;
  lenderName: string;
  direction: LoanDirection;
  category: LoanCategory;
  /** The person who actually pays this loan's installments, when set — see `Loan.payerPersonId`. */
  payerPersonId: string | null;
  payerName: string | null;
  /** This loan's schedule installments, sorted by sequenceNumber ascending. */
  installments: Installment[];
  status: LoanStatus;
  outstandingPrincipal: number;
  totalInstallments: number;
  installmentsPaid: number;
  /** Next unpaid installment's amountDue, or the last installment's amountDue once fully paid. */
  emiAmount: number;
  nextDueDate: Date | null;
  accent: "primary" | "success" | "warning" | "purple" | "expense";
}

function toLoanRow(loan: Loan, installments: Installment[], personById: Map<string, Person>, index: number): LoanRow {
  const sorted = [...installments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const status = loanStatusGiven(loan, sorted);

  // Mirrors LoanRepository.editLoanTerms's settled/principalPaid computation exactly.
  const settled = sorted.filter((i) => i.amountPaid > 0 || i.isSkipped);
  const principalPaid = settled.reduce((sum, i) => {
    if (i.isSkipped && i.amountPaid === 0) return sum;
    return sum + (i.principalPortion ?? i.amountPaid);
  }, 0);
  const outstandingPrincipal = clamp(loan.loanAmount - principalPaid, 0, loan.loanAmount);

  const installmentsPaid = sorted.filter((i) => installmentStatus(i) === "paid").length;
  const totalInstallments = sorted.length || loan.installmentCount || 1;
  const nextInstallment = sorted.find((i) => installmentStatus(i) !== "paid" && !i.isSkipped) ?? null;
  const lastInstallment = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const emiAmount = nextInstallment?.amountDue ?? lastInstallment?.amountDue ?? 0;
  const nextDueDate = nextInstallment?.dueDate ?? null;

  return {
    loan,
    // New loans resolve directly through the real `institutionName` field;
    // legacy loans (institutionName still null) keep resolving through the
    // find-or-create-person hack's linked Person, exactly as before — see
    // this file's module doc comment.
    lenderName: loan.institutionName ?? (loan.personId ? personById.get(loan.personId)?.name : undefined) ?? "Unknown lender",
    direction: loan.direction,
    category: loan.category,
    payerPersonId: loan.payerPersonId ?? null,
    payerName: loan.payerPersonId ? (personById.get(loan.payerPersonId)?.name ?? null) : null,
    installments: sorted,
    status,
    outstandingPrincipal,
    totalInstallments,
    installmentsPaid,
    emiAmount,
    nextDueDate,
    accent: ACCENT_CYCLE[index % ACCENT_CYCLE.length],
  };
}

/** Live loans joined with their lender's name and their schedule's installments. */
export function useLoanRows(): { rows: LoanRow[]; isLoading: boolean } {
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: persons = [], isLoading: personsLoading } = useLoanPersons();
  const { data: installments = [], isLoading: installmentsLoading } = useAllLoanInstallments();

  const rows = useMemo(() => {
    const personById = new Map((persons as Person[]).map((p) => [p.id, p]));
    const installmentsByScheduleId = new Map<string, Installment[]>();
    for (const installment of installments as Installment[]) {
      const list = installmentsByScheduleId.get(installment.scheduleId) ?? [];
      list.push(installment);
      installmentsByScheduleId.set(installment.scheduleId, list);
    }
    return (loans as Loan[]).map((loan, index) =>
      toLoanRow(loan, installmentsByScheduleId.get(loan.scheduleId) ?? [], personById, index),
    );
  }, [loans, persons, installments]);

  return { rows, isLoading: loansLoading || personsLoading || installmentsLoading };
}

export interface TrashedLoanRow {
  loan: Loan;
  lenderName: string;
}

/** Soft-deleted loans awaiting restore or permanent deletion — the web equivalent of
 *  `loansTrashStreamProvider`/`LoansTrashScreen`. No installments needed here (trash is a name +
 *  deleted-date list, not a working schedule view), so this skips `useAllLoanInstallments`'s per-loan
 *  fan-out entirely. */
export function useTrashedLoanRows(): { rows: TrashedLoanRow[]; isLoading: boolean } {
  const { data: loans = [], isLoading: loansLoading } = useTrashedLoans();
  const { data: persons = [], isLoading: personsLoading } = useLoanPersons();

  const rows = useMemo(() => {
    const personById = new Map((persons as Person[]).map((p) => [p.id, p]));
    return (loans as Loan[]).map((loan) => ({
      loan,
      lenderName: loan.institutionName ?? (loan.personId ? personById.get(loan.personId)?.name : undefined) ?? "Unknown lender",
    }));
  }, [loans, persons]);

  return { rows, isLoading: loansLoading || personsLoading };
}

export interface CreateLoanFormParams {
  name: string;
  category: LoanCategory;
  /** Required when `category` is "personal" — the lender/counterparty. */
  personId?: string | null;
  /** Required when `category` is "institutional" — free-text lender name. */
  lenderName: string;
  loanAmount: number;
  loanDate: Date;
  direction: LoanDirection;
  interest: LoanInterest | null;
  installmentFrequency: CreateLoanParams["installmentFrequency"];
  installmentCount: number;
  notes?: string;
  loanType?: string | null;
  loanNumber?: string | null;
  accountNumber?: string | null;
  branch?: string | null;
  /** Someone other than the account owner who actually pays this loan's EMIs — see `Loan.payerPersonId`. */
  payerPersonId?: string | null;
}

export interface EditLoanFormParams {
  name: string;
  lenderName: string;
  notes?: string;
  currentInstallments: Installment[];
  loanType?: string | null;
  loanNumber?: string | null;
  accountNumber?: string | null;
  branch?: string | null;
  payerPersonId?: string | null;
}

/** Create/edit/delete/payment actions wired to the real repositories, scoped to the signed-in user. */
export function useLoanActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const loanRepository = createLoanRepository(uid);

    return {
      createLoan: async (params: CreateLoanFormParams) => {
        // Personal: picks a real Person (`personId`), no institution fields.
        // Institutional: no more find-or-create-person hack — the lender
        // name goes straight into the real `institutionName` field. Legacy
        // loans (created before the category field existed) keep resolving
        // their lender through the linked Person, untouched — see this
        // file's module doc comment and `toLoanRow`'s `lenderName` fallback.
        const loan = await loanRepository.createLoan({
          category: params.category,
          personId: params.category === "personal" ? params.personId : null,
          institutionName: params.category === "institutional" ? params.lenderName.trim() : null,
          direction: params.direction,
          loanAmount: params.loanAmount,
          loanDate: params.loanDate,
          repaymentType: "installment",
          name: params.name,
          interest: params.interest,
          installmentFrequency: params.installmentFrequency,
          installmentCount: params.installmentCount,
          notes: params.notes ?? "",
          loanType: params.category === "institutional" ? params.loanType : null,
          loanNumber: params.category === "institutional" ? params.loanNumber : null,
          accountNumber: params.category === "institutional" ? params.accountNumber : null,
          branch: params.category === "institutional" ? params.branch : null,
          payerPersonId: params.payerPersonId,
        });
        return loan;
      },
      editLoan: async (loan: Loan, params: EditLoanFormParams) => {
        const hasPayments = params.currentInstallments.some((i) => i.amountPaid > 0);
        // `category`/`personId` are immutable after creation (mirrors the
        // Flutter port) — only an institutional loan's free-text lender name
        // and reference fields are ever rewritten here. A personal loan's
        // lender is fixed at creation, same posture as Flutter's Person
        // picker being locked once the loan exists. A legacy loan's old
        // `personId`/shadow Person is left alone (not cleaned up, no
        // migration — see this file's module doc comment); from this edit
        // onward, an institutional loan's `lenderName` resolves from the
        // real field instead.
        const editParams: EditLoanParams =
          loan.category === "institutional"
            ? {
                hasPayments,
                name: params.name,
                notes: params.notes,
                institutionName: params.lenderName.trim(),
                loanType: params.loanType,
                loanNumber: params.loanNumber,
                accountNumber: params.accountNumber,
                branch: params.branch,
                payerPersonId: params.payerPersonId,
              }
            : {
                hasPayments,
                name: params.name,
                notes: params.notes,
                payerPersonId: params.payerPersonId,
              };
        await loanRepository.editLoan(loan, editParams);
      },
      // Wraps `LoanRepository.editLoanTerms` — the only path that can change loan amount, interest,
      // frequency, or tenure (installment count) after creation, since those require re-amortizing the
      // *outstanding* principal and regenerating the unpaid tail of the schedule (see that method's
      // doc comment).
      editLoanTerms: async (
        loan: Loan,
        params: {
          currentInstallments: Installment[];
          loanAmount?: number;
          interest: LoanInterest | null;
          installmentFrequency: ScheduleType;
          newInstallmentCount: number;
        },
      ) => {
        await loanRepository.editLoanTerms(loan, params);
      },
      // Wraps `LoanRepository.editLoanDate` — only permitted before any payment exists on the loan
      // (the repository throws otherwise), since it regenerates the whole schedule from scratch.
      editLoanDate: async (
        loan: Loan,
        params: { newLoanDate: Date; hasPayments: boolean; currentInstallments: Installment[] },
      ) => {
        await loanRepository.editLoanDate(loan, params);
      },
      // Soft-deletes to trash — mirrors `loans_screen.dart`'s swipe-to-delete (moves to trash, restorable
      // via `restoreLoan`/the trash view), not a permanent removal. The schedule/installments are left
      // as-is: once the loan itself is filtered out of `useLoans()`'s active list, `useAllLoanInstallments`
      // stops fanning out to them too, so they simply go dormant until the loan is restored or purged.
      deleteLoan: async (loan: Loan) => {
        await loanRepository.softDelete(loan);
      },
      restoreLoan: async (loan: Loan) => {
        await loanRepository.restore(loan);
      },
      // Cascades schedule/installments/payments — the actual point of no return, reachable only from
      // the trash view's "Delete Forever", matching `deleteEmi`'s existing permanentlyDeleteEmi posture.
      permanentlyDeleteLoan: async (loan: Loan) => {
        await loanRepository.permanentlyDeleteLoan(loan);
      },
      closeLoan: async (loan: Loan) => {
        await loanRepository.closeLoan(loan);
      },
      reopenLoan: async (loan: Loan) => {
        await loanRepository.reopenLoan(loan);
      },
      recordPayment: async (
        loan: Loan,
        installment: Installment,
        params: { amount: number; date: Date; note?: string },
      ) => {
        const installmentRepository = createInstallmentRepositoryFor(uid, loan.scheduleId);
        const paymentRepository = createInstallmentPaymentRepositoryFor(
          uid,
          loan.scheduleId,
          installment.id,
          installmentRepository,
        );
        await paymentRepository.recordPayment(installment, params);
      },
      // Wraps `planInstallmentSettlement` (port of `InstallmentSettlement.plan`) — fans one entered
      // amount across the oldest unpaid installments, recording one payment per installment touched.
      // `installments` must be sorted oldest-due-first by the caller, same contract as the ported
      // function itself.
      recordLumpSumSettlement: async (
        loan: Loan,
        installments: Installment[],
        params: { amount: number; date: Date; note?: string },
      ) => {
        const plan = planInstallmentSettlement(installments, params.amount);
        const installmentRepository = createInstallmentRepositoryFor(uid, loan.scheduleId);
        for (const { installment, portion } of plan.portions) {
          const paymentRepository = createInstallmentPaymentRepositoryFor(
            uid,
            loan.scheduleId,
            installment.id,
            installmentRepository,
          );
          await paymentRepository.recordPayment(installment, { amount: portion, date: params.date, note: params.note });
        }
        return plan;
      },
    };
  }, [uid]);
}
