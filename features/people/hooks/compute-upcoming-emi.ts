/**
 * Pure logic for the "Upcoming EMI" reminder on a Person's page — split out
 * from `use-person-upcoming-emi.ts` (which pulls in `@/hooks/use-loans` and
 * therefore Firebase client init) so this filtering/sorting logic stays
 * unit-testable without mounting React/Firebase. See that hook's doc
 * comment for the full context (mirrors the Flutter app's
 * `PersonLoansSummaryCard` "Upcoming EMI" block).
 */

import { installmentStatus, type Installment } from "@/lib/models/payment-schedule";
import type { Loan } from "@/lib/models/loan";

export interface UpcomingEmiItem {
  loanId: string;
  label: string;
  amount: number;
  dueDate: Date;
  /** True when this person only pays the loan (via `payerPersonId`), not the lender/counterparty. */
  isPayerOnly: boolean;
}

function loanLabel(loan: Loan): string {
  if (loan.name) return loan.name;
  if (loan.category === "institutional") return loan.institutionName ?? "Institutional Loan";
  return "Loan";
}

function nextUnpaidInstallment(installments: Installment[]): Installment | null {
  const sorted = [...installments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return sorted.find((i) => installmentStatus(i) !== "paid" && !i.isSkipped) ?? null;
}

/**
 * Every upcoming EMI for loans connected to `personId` (either as lender/
 * counterparty via `personId`, or as the payer via `payerPersonId`), soonest
 * due date first. Every loan's installments for its full term already exist
 * as documents (`generateInstallments` materializes them upfront at
 * creation), so this is a pure read/projection — no new Installment/
 * Transaction records are created here.
 */
export function computeUpcomingEmi(loans: Loan[], installments: Installment[], personId: string): UpcomingEmiItem[] {
  const installmentsByScheduleId = new Map<string, Installment[]>();
  for (const installment of installments) {
    const list = installmentsByScheduleId.get(installment.scheduleId) ?? [];
    list.push(installment);
    installmentsByScheduleId.set(installment.scheduleId, list);
  }

  const connected = loans.filter((loan) => loan.personId === personId || loan.payerPersonId === personId);

  const result: UpcomingEmiItem[] = [];
  for (const loan of connected) {
    if (loan.isClosed) continue;
    const next = nextUnpaidInstallment(installmentsByScheduleId.get(loan.scheduleId) ?? []);
    if (!next) continue;
    result.push({
      loanId: loan.id,
      label: loanLabel(loan),
      amount: next.amountDue - next.amountPaid,
      dueDate: next.dueDate,
      isPayerOnly: loan.personId !== personId,
    });
  }

  result.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return result;
}
