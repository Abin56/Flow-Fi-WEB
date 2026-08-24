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
 *  - `Loan.personId` is required by the ported model (`Loan` is "money lent
 *    to a Person" in the Flutter source), but this page's loans are
 *    bank/institutional debts, not person-to-person lending. Rather than add
 *    a second, parallel "lender" entity, each loan's lender is stored as a
 *    `Person` (find-by-name-or-create) in the same `users/{uid}/people`
 *    collection the Lending feature already owns — see
 *    `createPersonRepository`'s doc comment. This page never exposes that
 *    Person's ledger/balance UI; it only reads/writes its `name`.
 *  - Only a settled installment's own `principalPortion`/`amountDue` counts
 *    toward `outstandingPrincipal` — a *partially* paid installment's
 *    principal/interest split for the paid fraction isn't tracked anywhere
 *    (no `LoanPaymentBreakdown` equivalent to EMI's `EmiPaymentBreakdown`
 *    exists), so partial payments are treated the same simplified way
 *    `editLoanTerms` already treats them, not approximated further here.
 */

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  installmentStatus,
  type Installment,
} from "@/lib/models/payment-schedule";
import { loanStatusGiven, type Loan, type LoanInterest, type LoanStatus } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { CreateLoanParams, EditLoanParams } from "@/lib/repositories/loan-repository";
import {
  createInstallmentPaymentRepositoryFor,
  createInstallmentRepositoryFor,
  createLoanRepository,
  createPersonRepository,
} from "@/lib/repositories/repository-factory";
import { useAllLoanInstallments, useLoanPersons, useLoans, loansQueryKey, loanPersonsQueryKey, loanInstallmentsQueryKey } from "@/hooks/use-loans";
import { useAuthStore } from "@/store/auth-store";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const ACCENT_CYCLE: LoanRow["accent"][] = ["primary", "success", "warning", "purple", "expense"];

export interface LoanRow {
  loan: Loan;
  lenderName: string;
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
    lenderName: personById.get(loan.personId)?.name ?? "Unknown lender",
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

export interface CreateLoanFormParams {
  name: string;
  lenderName: string;
  loanAmount: number;
  loanDate: Date;
  interest: LoanInterest | null;
  installmentFrequency: CreateLoanParams["installmentFrequency"];
  installmentCount: number;
  notes?: string;
}

export interface EditLoanFormParams {
  name: string;
  lenderName: string;
  notes?: string;
  currentInstallments: Installment[];
}

/** Create/edit/delete/payment actions wired to the real repositories, scoped to the signed-in user. */
export function useLoanActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!uid) return null;
    const loanRepository = createLoanRepository(uid);
    const personRepository = createPersonRepository(uid);

    const invalidateLoans = () => queryClient.invalidateQueries({ queryKey: loansQueryKey(uid) });
    const invalidatePersons = () => queryClient.invalidateQueries({ queryKey: loanPersonsQueryKey(uid) });
    const invalidateInstallments = () => queryClient.invalidateQueries({ queryKey: loanInstallmentsQueryKey(uid) });

    /** Finds an existing Person by case-insensitive name match, else creates one — see this file's module doc comment. */
    async function findOrCreatePerson(name: string): Promise<Person> {
      const trimmed = name.trim();
      const existing = await personRepository.getAll();
      const match = existing.find((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase());
      if (match) return match;
      const created = await personRepository.createPerson({
        name: trimmed,
        avatarColorValue: 0xff607d8b,
        openingBalance: 0,
      });
      await invalidatePersons();
      return created;
    }

    return {
      createLoan: async (params: CreateLoanFormParams) => {
        const person = await findOrCreatePerson(params.lenderName);
        const loan = await loanRepository.createLoan({
          personId: person.id,
          loanAmount: params.loanAmount,
          loanDate: params.loanDate,
          repaymentType: "installment",
          name: params.name,
          interest: params.interest,
          installmentFrequency: params.installmentFrequency,
          installmentCount: params.installmentCount,
          notes: params.notes ?? "",
        });
        await invalidateLoans();
        await invalidateInstallments();
        return loan;
      },
      editLoan: async (loan: Loan, params: EditLoanFormParams) => {
        const hasPayments = params.currentInstallments.some((i) => i.amountPaid > 0);
        const editParams: EditLoanParams = { hasPayments, name: params.name, notes: params.notes };
        await loanRepository.editLoan(loan, editParams);

        const person = await findOrCreatePerson(params.lenderName);
        if (person.id !== loan.personId) {
          // Lender changed to a different existing/newly-created Person — repoint the loan.
          await loanRepository.update({ ...loan, personId: person.id, name: params.name, notes: params.notes ?? loan.notes });
        } else if (person.name.trim() !== params.lenderName.trim()) {
          await personRepository.editPerson(person, { name: params.lenderName.trim() });
        }
        await invalidateLoans();
      },
      deleteLoan: async (loan: Loan) => {
        // Cascades schedule/installments/payments, matching deleteEmi's existing
        // permanentlyDeleteEmi behavior — softDelete alone left the schedule active.
        await loanRepository.permanentlyDeleteLoan(loan);
        await invalidateLoans();
      },
      closeLoan: async (loan: Loan) => {
        await loanRepository.closeLoan(loan);
        await invalidateLoans();
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
        await invalidateInstallments();
      },
    };
  }, [uid, queryClient]);
}
