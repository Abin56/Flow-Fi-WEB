"use client";

/**
 * Feeds `buildPersonCycleStatement` from the live Firestore records — the Person, their ledger, and the
 * EMIs/taken Loans linked to them by `beneficiaryPersonId`. Every People statement surface (panel,
 * preview, WhatsApp, PDF) reads the one result this returns.
 *
 * Linked EMIs count as Person obligations only after the explicit `beneficiaryRepaysInstallments`
 * opt-in (see `person-emi-obligations.ts`); `linkedEmis` lists every linked one so the panel can offer it.
 */

import { useMemo } from "react";
import { useEmis } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments, useLoans, useTrashedLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useLoanScheduledPayments } from "@/hooks/use-loan-scheduled-payments";
import { usePeopleAdvanceApplications, usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import {
  buildPersonCycleStatement,
  cycleContaining,
  type PersonCycleStatement,
  type StatementCycle,
} from "@/lib/engines/person-cycle-statement";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import { createEmiRepository, createLoanRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export interface LinkedEmiSource {
  kind: "emi" | "loan";
  id: string;
  name: string;
  /** True once the user confirmed this person repays me each installment. */
  repays: boolean;
}

export function usePersonCycleStatement(
  personId: string,
  cycle: StatementCycle,
): {
  statement: PersonCycleStatement | null;
  /**
   * The same statement over the person's whole history, through the end of the current cycle (so
   * future EMI installments aren't listed) — the "All transactions" list reads its rows.
   */
  allTimeStatement: PersonCycleStatement | null;
  /** This person's raw ledger entries (active and trashed) — what deletes are planned from. */
  ledgerEntries: LedgerEntry[];
  /** This person's active advance applications. */
  advanceApplications: AdvanceApplication[];
  person: Person | null;
  linkedEmis: LinkedEmiSource[];
  setRepays: (source: LinkedEmiSource, repays: boolean) => Promise<void>;
  isLoading: boolean;
} {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { applicationsByPersonId, isLoading: applicationsLoading } = usePeopleAdvanceApplications();
  const { data: emis = [] } = useEmis();
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loans = [] } = useLoans();
  const { data: loanInstallments = [] } = useAllLoanInstallments();
  const { data: trashedLoans = [] } = useTrashedLoans();
  const { payments: loanPayments } = useLoanScheduledPayments();

  const person = useMemo(() => (people as Person[]).find((p) => p.id === personId) ?? null, [people, personId]);

  const linkedEmis = useMemo<LinkedEmiSource[]>(
    () => [
      ...(emis as Emi[])
        .filter((e) => e.deletedAt == null && e.beneficiaryPersonId === personId)
        .map((e) => ({ kind: "emi" as const, id: e.id, name: e.name?.trim() || "EMI", repays: e.beneficiaryRepaysInstallments === true })),
      ...(loans as Loan[])
        .filter((l) => l.deletedAt == null && l.direction === "taken" && l.beneficiaryPersonId === personId)
        .map((l) => ({
          kind: "loan" as const,
          id: l.id,
          name: l.name?.trim() || l.institutionName?.trim() || "Loan EMI",
          repays: l.beneficiaryRepaysInstallments === true,
        })),
    ],
    [emis, loans, personId],
  );

  const ledgerEntries = useMemo(() => (person ? (entriesByPersonId[person.id] ?? []) : []), [person, entriesByPersonId]);
  const advanceApplications = useMemo(() => (person ? (applicationsByPersonId[person.id] ?? []) : []), [person, applicationsByPersonId]);

  const baseInput = useMemo(() => {
    if (person == null) return null;
    const loanIds = new Set([...(loans as Loan[]).map((l) => l.id), ...(trashedLoans as Loan[]).map((l) => l.id)]);
    return {
      person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
      ledgerEntries,
      loanIds,
      emis: emis as Emi[],
      loans: loans as Loan[],
      installments: [...(emiInstallments as Installment[]), ...(loanInstallments as Installment[])],
      loanPayments,
      advanceApplications,
    };
  }, [person, ledgerEntries, advanceApplications, emis, loans, trashedLoans, emiInstallments, loanInstallments, loanPayments]);

  const statement = useMemo(() => (baseInput ? buildPersonCycleStatement({ ...baseInput, cycle }) : null), [baseInput, cycle]);
  const allTimeStatement = useMemo(
    () => (baseInput ? buildPersonCycleStatement({ ...baseInput, cycle: { start: new Date(1970, 0, 1), end: cycleContaining(new Date()).end } }) : null),
    [baseInput],
  );

  const setRepays = async (source: LinkedEmiSource, repays: boolean) => {
    if (!uid) return;
    // `hasPayments: true` only locks principal edits, which this call never makes.
    if (source.kind === "emi") {
      const emi = (emis as Emi[]).find((e) => e.id === source.id);
      if (emi) await createEmiRepository(uid).editEmi(emi, { hasPayments: true, beneficiaryRepaysInstallments: repays });
    } else {
      const loan = (loans as Loan[]).find((l) => l.id === source.id);
      if (loan) await createLoanRepository(uid).editLoan(loan, { hasPayments: true, beneficiaryRepaysInstallments: repays });
    }
  };

  return {
    statement,
    allTimeStatement,
    ledgerEntries,
    advanceApplications,
    person,
    linkedEmis,
    setRepays,
    isLoading: peopleLoading || entriesLoading || applicationsLoading,
  };
}

/**
 * Every person's statement for one cycle — the People Ledger list. Same live sources and the same
 * `buildPersonCycleStatement` call as `usePersonCycleStatement` (no extra reads: the ledger watch,
 * EMIs and Loans are already shared), so a row's previous / this cycle / current pending always
 * matches what that person's workspace shows for the same cycle.
 */
export function usePeopleCycleStatements(cycle: StatementCycle): {
  statementsByPersonId: Record<string, PersonCycleStatement>;
  isLoading: boolean;
} {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { applicationsByPersonId, isLoading: applicationsLoading } = usePeopleAdvanceApplications();
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: emiInstallments = [], isLoading: emiInstallmentsLoading } = useAllEmiInstallments();
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: loanInstallments = [], isLoading: loanInstallmentsLoading } = useAllLoanInstallments();
  const { data: trashedLoans = [], isLoading: trashedLoading } = useTrashedLoans();
  const { payments: loanPayments } = useLoanScheduledPayments();

  const statementsByPersonId = useMemo(() => {
    const loanIds = new Set([...(loans as Loan[]).map((l) => l.id), ...(trashedLoans as Loan[]).map((l) => l.id)]);
    const installments = [...(emiInstallments as Installment[]), ...(loanInstallments as Installment[])];
    const out: Record<string, PersonCycleStatement> = {};
    for (const person of people as Person[]) {
      out[person.id] = buildPersonCycleStatement({
        person: { id: person.id, name: person.name, openingBalance: person.openingBalance, createdAt: person.createdAt },
        ledgerEntries: entriesByPersonId[person.id] ?? [],
        loanIds,
        emis: emis as Emi[],
        loans: loans as Loan[],
        installments,
        loanPayments,
        advanceApplications: applicationsByPersonId[person.id] ?? [],
        cycle,
      });
    }
    return out;
  }, [people, entriesByPersonId, applicationsByPersonId, emis, loans, trashedLoans, emiInstallments, loanInstallments, loanPayments, cycle]);

  // Every source the engine reads must have reported before a row renders: a statement built while the
  // EMI/Loan watches are still resolving omits linked-EMI obligations, then jumps once they land.
  const isLoading =
    peopleLoading || entriesLoading || applicationsLoading || emisLoading || emiInstallmentsLoading || loansLoading || loanInstallmentsLoading || trashedLoading;
  return { statementsByPersonId, isLoading };
}
