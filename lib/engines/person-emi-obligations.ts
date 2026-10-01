/**
 * Person-linked EMI obligations — the one primitive both the People list (`person-position.ts` via
 * `emiReceivableThrough`) and the cycle statement (`person-cycle-statement.ts`) use, so they can never
 * disagree about which installments a Person owes me. Pure.
 *
 * Three relationships stay separate:
 *  1. Person-linked installment → creates a Person obligation (this module): the installment's
 *     `amountDue`, dated on its due date — never the financed principal.
 *  2. Lender/bank EMI payment → affects only the Loan/EMI (`Installment.amountPaid`). It is NOT read
 *     here: me paying the bank does not mean the Person paid me.
 *  3. Person repayment → an explicit Person ledger settlement ("Received back" / Settle Up), already in
 *     the ledger balance and the statement's ledger rows.
 *
 * Which EMIs count: `beneficiaryPersonId` alone is a pure "who was this for" association (see
 * docs/unified-finance-agreement-contract.md — "It creates no Person ledger entry or receivable"), so it
 * is NOT reinterpreted. An EMI/taken Loan counts only when it ALSO carries the explicit, additive
 * opt-in `beneficiaryRepaysInstallments === true`. Every legacy document (flag absent) stays
 * association-only.
 *
 * Shared agreements (`ownershipShares`, several people and/or me): every listed person owes me THEIR
 * share of each installment only (`personInstallmentShare`, paise-exact, the parts summing to the
 * installment). Still one lender schedule — the shares are sub-obligations beneath it.
 */

import { personInstallmentShare, personSharesInstallments, type OwnershipShare } from "@/lib/engines/debt-ownership";
import { installmentStatus, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";

export interface EmiObligationEmiSource {
  id: string;
  name: string;
  scheduleId: string;
  beneficiaryPersonId?: string | null;
  beneficiaryRepaysInstallments?: boolean;
  ownershipShares?: readonly OwnershipShare[] | null;
  isClosed: boolean;
  deletedAt: Date | null;
}

export interface EmiObligationLoanSource {
  id: string;
  name?: string | null;
  institutionName?: string | null;
  scheduleId: string;
  direction: "given" | "taken";
  /** The Loan's counterparty (lender for "taken", borrower for "given") — read by the People statement. */
  personId?: string | null;
  beneficiaryPersonId?: string | null;
  beneficiaryRepaysInstallments?: boolean;
  ownershipShares?: readonly OwnershipShare[] | null;
  isClosed: boolean;
  deletedAt: Date | null;
}

export type EmiObligationInstallment = Pick<
  Installment,
  "id" | "scheduleId" | "sequenceNumber" | "dueDate" | "amountDue" | "amountPaid" | "isSkipped" | "deletedAt" | "createdAt"
>;

/** Lender-side installment state — shown for context only; never settles the Person. */
export type LenderInstallmentStatus = "upcoming" | "partial" | "paid" | "overdue";

export interface PersonEmiObligation {
  /** `emi-inst:{installmentId}` — the ID-based identity used for de-duplication. */
  key: string;
  installmentId: string;
  sourceKind: "emi" | "loan";
  sourceId: string;
  sourceName: string;
  installmentNumber: number;
  dueDate: Date;
  createdAt: Date;
  /** What the Person owes me for this installment (their share on a shared agreement). */
  amount: number;
  /** The whole installment the lender expects — equals `amount` unless the agreement is shared. */
  installmentAmount: number;
  lenderStatus: LenderInstallmentStatus;
}

interface LinkedSource {
  kind: "emi" | "loan";
  id: string;
  name: string;
  isClosed: boolean;
  owner: EmiObligationEmiSource | EmiObligationLoanSource;
}

/** True when this EMI/taken Loan is explicitly one `personId` repays me for (whole or a share). */
export function beneficiaryOwesInstallments(
  source: Pick<EmiObligationEmiSource, "beneficiaryPersonId" | "beneficiaryRepaysInstallments" | "ownershipShares" | "deletedAt">,
  personId: string,
): boolean {
  return personSharesInstallments(source, personId);
}

function lenderStatus(inst: EmiObligationInstallment, now: Date): LenderInstallmentStatus {
  const s: InstallmentStatus = installmentStatus(inst as Installment, now);
  if (s === "paid") return "paid";
  if (s === "partiallyPaid") return "partial";
  if (s === "overdue") return "overdue";
  return "upcoming";
}

/** Every installment `personId` owes me through an opted-in EMI / taken Loan, each exactly once. */
export function personEmiObligations(params: {
  personId: string;
  emis: readonly EmiObligationEmiSource[];
  loans: readonly EmiObligationLoanSource[];
  installments: readonly EmiObligationInstallment[];
  now?: Date;
}): PersonEmiObligation[] {
  const { personId, emis, loans, installments } = params;
  const now = params.now ?? new Date();
  const bySchedule = new Map<string, LinkedSource>();
  for (const emi of emis) {
    if (beneficiaryOwesInstallments(emi, personId))
      bySchedule.set(emi.scheduleId, { kind: "emi", id: emi.id, name: emi.name?.trim() || "EMI", isClosed: emi.isClosed, owner: emi });
  }
  for (const loan of loans) {
    if (loan.direction === "taken" && beneficiaryOwesInstallments(loan, personId))
      bySchedule.set(loan.scheduleId, {
        kind: "loan",
        id: loan.id,
        name: loan.name?.trim() || loan.institutionName?.trim() || "Loan EMI",
        isClosed: loan.isClosed,
        owner: loan,
      });
  }
  if (bySchedule.size === 0) return [];

  const seen = new Set<string>();
  const result: PersonEmiObligation[] = [];
  for (const inst of installments) {
    const source = bySchedule.get(inst.scheduleId);
    if (source == null || inst.deletedAt != null || seen.has(inst.id)) continue;
    // A skipped installment, or a closed (e.g. foreclosed) EMI's never-paid tail, was never charged.
    if (inst.isSkipped && inst.amountPaid <= 0) continue;
    if (source.isClosed && inst.amountPaid <= 0) continue;
    const amount = personInstallmentShare(source.owner, inst.amountDue, personId);
    if (amount <= 0) continue;
    seen.add(inst.id);
    result.push({
      key: `${source.kind === "emi" ? "emi-inst" : "loan-inst"}:${inst.id}`,
      installmentId: inst.id,
      sourceKind: source.kind,
      sourceId: source.id,
      sourceName: source.name,
      installmentNumber: inst.sequenceNumber,
      dueDate: inst.dueDate,
      createdAt: inst.createdAt,
      amount,
      installmentAmount: inst.amountDue,
      lenderStatus: lenderStatus(inst, now),
    });
  }
  return result;
}

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Total the Person owes me for installments due on or before `through` (inclusive, by day). */
export function emiReceivableThrough(obligations: readonly PersonEmiObligation[], through: Date): number {
  const cutoff = dayIndex(through);
  const total = obligations.filter((o) => dayIndex(o.dueDate) <= cutoff).reduce((s, o) => s + o.amount, 0);
  return Math.round(total * 100) / 100;
}
