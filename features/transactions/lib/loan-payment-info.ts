/**
 * What a Loan / EMI transaction should say about itself in the Transactions list: the lender, a "Loan" or "EMI" tag,
 * and — when the payment is tied to an installment — "2 of 10". Everything is read from existing records (the
 * transaction's `loanId` / `emiId` / `installmentId`, the Loan / EMI, and the schedule's installments); nothing is
 * calculated or written, and only real transactions are described — never an upcoming installment. Pure.
 */

import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

export interface LoanPaymentInfo {
  kind: "Loan" | "EMI";
  /** The lender / person / loan name to put after "Paid to" — null when nothing sensible is known. */
  lender: string | null;
  /** Installment position, only when the transaction names an installment of a known schedule. */
  installment: { number: number; total: number } | null;
}

type TxnRef = Pick<Transaction, "loanId" | "emiId" | "installmentId">;
type LoanRef = Pick<Loan, "id" | "name" | "institutionName" | "personId" | "scheduleId" | "deletedAt">;
type EmiRef = Pick<Emi, "id" | "name" | "lenderName" | "scheduleId" | "deletedAt">;
type InstRef = Pick<Installment, "id" | "scheduleId" | "sequenceNumber" | "deletedAt">;

export function buildLoanPaymentInfo(args: {
  loans: readonly LoanRef[];
  emis: readonly EmiRef[];
  loanInstallments: readonly InstRef[];
  emiInstallments: readonly InstRef[];
  personNameById: ReadonlyMap<string, string>;
}): (t: TxnRef) => LoanPaymentInfo | null {
  const loanById = new Map(args.loans.map((l) => [l.id, l]));
  const emiById = new Map(args.emis.map((e) => [e.id, e]));
  const instById = new Map<string, InstRef>();
  const totalBySchedule = new Map<string, number>();
  for (const i of [...args.loanInstallments, ...args.emiInstallments]) {
    if (i.deletedAt != null) continue;
    instById.set(i.id, i);
    totalBySchedule.set(i.scheduleId, (totalBySchedule.get(i.scheduleId) ?? 0) + 1);
  }
  const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

  return (t) => {
    if (t.emiId == null && t.loanId == null) return null;
    const emi = t.emiId != null ? emiById.get(t.emiId) : undefined;
    const loan = t.emiId == null && t.loanId != null ? loanById.get(t.loanId) : undefined;
    const lender = emi
      ? (clean(emi.lenderName) ?? clean(emi.name))
      : loan
        ? (clean(loan.institutionName) ?? (loan.personId ? clean(args.personNameById.get(loan.personId)) : null) ?? clean(loan.name))
        : null;
    const scheduleId = emi?.scheduleId ?? loan?.scheduleId ?? null;
    const inst = t.installmentId != null ? instById.get(t.installmentId) : undefined;
    const installment = inst && scheduleId != null && inst.scheduleId === scheduleId ? { number: inst.sequenceNumber, total: totalBySchedule.get(scheduleId) ?? inst.sequenceNumber } : null;
    return { kind: t.emiId != null ? "EMI" : "Loan", lender, installment };
  };
}
