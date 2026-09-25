import { holdTenurePolicy, type DisbursementReamortizationOutcome } from "@/lib/engines/disbursement-reamortization-policy";
import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { reduceTenurePolicy, type PrepaymentReamortizationOutcome } from "@/lib/engines/prepayment-reamortization-policy";
import type { Loan } from "@/lib/models/loan";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";

export interface PrincipalPrepaymentPreview {
  scheduledAmount: number;
  principalAmount: number;
  transactionAmount: number;
  principalBefore: number;
  principalAfter: number;
  installmentCountBefore: number;
  outcome: PrepaymentReamortizationOutcome | null;
}

export function previewPrincipalPrepayment(
  loan: Loan,
  installments: Installment[],
  principalAmount: number,
  date: Date,
): PrincipalPrepaymentPreview {
  const eligible = [...installments]
    .filter((item) => item.deletedAt == null && !item.isSkipped && remainingAmount(item) > 0)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const due = eligible.filter((item) => item.dueDate.getTime() <= date.getTime());
  const scope = due.length > 0 ? due : eligible.slice(0, 1);
  const scheduledAmount = scope.reduce((sum, item) => sum + remainingAmount(item), 0);
  const plan = scheduledAmount > 0 ? planInstallmentSettlement(scope, scheduledAmount) : { portions: [], unallocated: 0 };
  const paidById = new Map(plan.portions.map((portion) => [portion.installment.id, portion.portion]));
  const afterScheduled = installments.map((item) => ({
    ...item,
    amountPaid: Math.min(item.amountDue, item.amountPaid + (paidById.get(item.id) ?? 0)),
  }));
  const principalBefore = outstandingPrincipalFor(loan.loanAmount, installments);
  const principalAfterScheduled = outstandingPrincipalFor(loan.loanAmount, afterScheduled);
  const principalAfter = Math.max(0, principalAfterScheduled - principalAmount);
  const untouched = afterScheduled.filter((item) => item.deletedAt == null && !item.isSkipped && item.amountPaid === 0);
  const outcome = untouched.length === 0 || principalAmount <= 0 || loan.installmentFrequency == null
    ? null
    : reduceTenurePolicy.solve({
        outstandingPrincipalAfter: principalAfter,
        interest: loan.interest,
        targetInstallmentAmount: untouched[0].amountDue,
        frequency: loan.installmentFrequency,
      });
  return {
    scheduledAmount,
    principalAmount,
    transactionAmount: scheduledAmount + principalAmount,
    principalBefore,
    principalAfter,
    installmentCountBefore: loan.installmentCount ?? installments.length,
    outcome,
  };
}

export interface AdditionalDisbursementPreview {
  principalBefore: number;
  principalAfter: number;
  remainingInstallmentCount: number;
  currentInstallmentAmount: number | null;
  outcome: DisbursementReamortizationOutcome | null;
}

export function previewAdditionalDisbursement(
  loan: Loan,
  installments: Installment[],
  amount: number,
): AdditionalDisbursementPreview {
  const principalBefore = outstandingPrincipalFor(loan.loanAmount, installments);
  const principalAfter = principalBefore + amount;
  const untouched = installments
    .filter((item) => item.deletedAt == null && !item.isSkipped && item.amountPaid === 0)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const outcome = amount <= 0 || untouched.length === 0 || loan.installmentFrequency == null
    ? null
    : holdTenurePolicy.solve({
        outstandingPrincipalAfter: principalAfter,
        interest: loan.interest,
        remainingInstallmentCount: untouched.length,
        frequency: loan.installmentFrequency,
      });
  return {
    principalBefore,
    principalAfter,
    remainingInstallmentCount: untouched.length,
    currentInstallmentAmount: untouched[0]?.amountDue ?? null,
    outcome,
  };
}
