/**
 * Pure logic for the "Upcoming EMI" reminder on a Person's page — split out
 * from `use-person-upcoming-emi.ts` (which pulls in `@/hooks/use-loans` and
 * therefore Firebase client init) so this filtering/sorting logic stays
 * unit-testable without mounting React/Firebase. See that hook's doc
 * comment for the full context (mirrors the Flutter app's
 * `PersonLoansSummaryCard` "Upcoming EMI" block).
 *
 * Everything is read from the Loan's own schedule `Installment`s — the same documents Loan & EMI,
 * Bills and Month Cycle read — so a payment, partial payment or advance-payment re-amortization shows
 * the same state here with no Person ledger write. The Loan's remaining principal is context only
 * (passed in from the Loan engine's `outstandingPrincipal`); it is never presented as what is due now.
 */

import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { Loan } from "@/lib/models/loan";

/**
 * Who owes whom on this Loan, from the Loan's own direction — never forced one way:
 *  - "youOwe":     I borrowed from this person (`personId`, direction "taken").
 *  - "theyOwe":    I lent to this person (`personId`, direction "given").
 *  - "paysForYou": this person only pays a Loan's installments for me (`payerPersonId`).
 */
export type UpcomingEmiRelation = "youOwe" | "theyOwe" | "paysForYou";

export interface UpcomingEmiItem {
  loanId: string;
  label: string;
  /** Unpaid remainder of the next installment (overdue first, else the next upcoming one). */
  amount: number;
  dueDate: Date;
  /** True when this person only pays the loan (via `payerPersonId`), not the lender/counterparty. */
  isPayerOnly: boolean;
  relation: UpcomingEmiRelation;
  /** Unpaid remainder across every installment already past its due date. */
  overdueAmount: number;
  overdueCount: number;
  /** Earliest overdue due date, or null when nothing is overdue. */
  oldestOverdueDate: Date | null;
  /** The next installment not yet due (null when every unpaid one is overdue). */
  nextUpcoming: { amount: number; amountDue: number; amountPaid: number; dueDate: Date } | null;
  /** Remaining Loan principal (Loan engine figure) — context, not this cycle's due. Null when unknown. */
  remainingOnLoan: number | null;
}

function loanLabel(loan: Loan): string {
  if (loan.name) return loan.name;
  if (loan.category === "institutional") return loan.institutionName ?? "Institutional Loan";
  return "Loan";
}

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Every upcoming EMI for loans connected to `personId` (either as lender/
 * counterparty via `personId`, or as the payer via `payerPersonId`), soonest
 * due date first. Every loan's installments for its full term already exist
 * as documents (`generateInstallments` materializes them upfront at
 * creation), so this is a pure read/projection — no new Installment/
 * Transaction records are created here.
 */
export function computeUpcomingEmi(
  loans: Loan[],
  installments: Installment[],
  personId: string,
  options: { now?: Date; outstandingPrincipalByLoanId?: ReadonlyMap<string, number> } = {},
): UpcomingEmiItem[] {
  const now = options.now ?? new Date();
  const today = dayIndex(now);
  const installmentsByScheduleId = new Map<string, Installment[]>();
  for (const installment of installments) {
    if (installment.deletedAt != null) continue;
    const list = installmentsByScheduleId.get(installment.scheduleId) ?? [];
    list.push(installment);
    installmentsByScheduleId.set(installment.scheduleId, list);
  }

  const connected = loans.filter((loan) => loan.deletedAt == null && (loan.personId === personId || loan.payerPersonId === personId));

  const result: UpcomingEmiItem[] = [];
  for (const loan of connected) {
    if (loan.isClosed) continue;
    const unpaid = [...(installmentsByScheduleId.get(loan.scheduleId) ?? [])]
      .filter((i) => !i.isSkipped && installmentStatus(i, now) !== "paid" && remainingAmount(i) > 0)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const next = unpaid[0];
    if (!next) continue;

    const overdue = unpaid.filter((i) => dayIndex(i.dueDate) < today);
    const upcoming = unpaid.find((i) => dayIndex(i.dueDate) >= today) ?? null;
    const isPayerOnly = loan.personId !== personId;

    result.push({
      loanId: loan.id,
      label: loanLabel(loan),
      amount: round2(remainingAmount(next)),
      dueDate: next.dueDate,
      isPayerOnly,
      relation: isPayerOnly ? "paysForYou" : loan.direction === "given" ? "theyOwe" : "youOwe",
      overdueAmount: round2(overdue.reduce((s, i) => s + remainingAmount(i), 0)),
      overdueCount: overdue.length,
      oldestOverdueDate: overdue[0]?.dueDate ?? null,
      nextUpcoming: upcoming
        ? { amount: round2(remainingAmount(upcoming)), amountDue: upcoming.amountDue, amountPaid: upcoming.amountPaid, dueDate: upcoming.dueDate }
        : null,
      remainingOnLoan: options.outstandingPrincipalByLoanId?.get(loan.id) ?? null,
    });
  }

  result.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return result;
}
