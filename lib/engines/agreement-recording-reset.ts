import { round2 } from "@/lib/engines/person-payment";
import type { Loan } from "@/lib/models/loan";
import type { LoanAdditionalDisbursement } from "@/lib/models/loan-additional-disbursement";
import type { LoanReamortizationEvent } from "@/lib/models/loan-reamortization-event";
import type { Installment, InstallmentPayment, PaymentSchedule } from "@/lib/models/payment-schedule";

export class AgreementResetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgreementResetBlockedError";
  }
}

const unsafeSchedule = "The original installment schedule cannot be verified. Review the loan's adjustment history before resetting its recordings.";

/** Unwind payment-driven Loan schedule changes using their stored lineage. Manual term edits are agreement terms. */
export function planLoanScheduleReset({ loan, schedule, installments, payments, disbursements, events, now }: {
  loan: Loan;
  schedule: PaymentSchedule;
  installments: readonly Installment[];
  payments: readonly InstallmentPayment[];
  disbursements: readonly LoanAdditionalDisbursement[];
  events: readonly LoanReamortizationEvent[];
  now: Date;
}) {
  const financialEvents = events.filter((event) => event.triggerType !== "manualEditTerms");
  const activeEvents = financialEvents.filter((event) => !event.reversed).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const activeDisbursements = disbursements.filter((item) => item.deletedAt == null);
  const eventIds = new Set(financialEvents.map((event) => event.id));
  const adjustedPayments = new Set(activeEvents.map((event) => event.triggeredByPaymentId));
  const adjustedDisbursements = new Set(activeEvents.map((event) => event.triggeredByDisbursementId));
  if ([...payments, ...disbursements].some((item) => item.reamortizationEventId != null && !eventIds.has(item.reamortizationEventId))) {
    throw new AgreementResetBlockedError(unsafeSchedule);
  }
  // These writers save the financial record before a separate schedule write. With no stored event
  // an older client cannot tell a pending schedule write from a legacy adjustment with no lineage.
  if (loan.repaymentType === "installment" && (
    payments.some((item) => item.deletedAt == null && item.allocationType === "principalPrepayment" && !adjustedPayments.has(item.id)) ||
    activeDisbursements.some((item) => !adjustedDisbursements.has(item.id))
  )) {
    throw new AgreementResetBlockedError("An extra-principal adjustment has no completed schedule record. Wait for it to finish, or review the adjustment history if it was recorded earlier.");
  }

  const firstAdjustment = [...activeEvents, ...activeDisbursements].reduce((earliest, item) => Math.min(earliest, item.createdAt.getTime()), Infinity);
  if (events.some((event) => !event.reversed && event.triggerType === "manualEditTerms" && event.createdAt.getTime() >= firstAdjustment) ||
      loan.editHistory.some((edit) => edit.field === "loanTerms" && edit.timestamp.getTime() >= firstAdjustment)) {
    throw new AgreementResetBlockedError("Loan terms were edited after a principal adjustment. Resetting would overwrite those terms. Review the adjustment history first.");
  }

  const original = new Map(installments.map((item) => [item.id, item]));
  const updated = new Map<string, Date | null>();
  const paymentIds = new Set(payments.map((payment) => payment.id));
  const disbursementIds = new Set(disbursements.map((item) => item.id));
  let installmentCount = schedule.installmentCount;
  let totalAmount = schedule.totalAmount;

  function restore(ids: string[], expectedActive: boolean, deletedAt: Date | null) {
    for (const id of ids) {
      const installment = original.get(id);
      if (!installment) throw new AgreementResetBlockedError(unsafeSchedule);
      const current = updated.has(id) ? updated.get(id) : installment.deletedAt;
      if ((current == null) !== expectedActive) throw new AgreementResetBlockedError(unsafeSchedule);
      updated.set(id, deletedAt);
    }
  }

  for (const event of activeEvents) {
    const triggerExists = event.triggerType === "prepayment"
      ? event.triggeredByPaymentId != null && paymentIds.has(event.triggeredByPaymentId)
      : event.triggeredByDisbursementId != null && disbursementIds.has(event.triggeredByDisbursementId);
    if (event.loanId !== loan.id || !triggerExists || event.retiredInstallmentIds.length === 0 || event.generatedInstallmentIds.length === 0 || event.scheduleTotalAmountBefore == null || !Number.isFinite(event.scheduleTotalAmountBefore) || installmentCount !== event.installmentCountAfter) {
      throw new AgreementResetBlockedError(unsafeSchedule);
    }
    restore(event.generatedInstallmentIds, true, now);
    restore(event.retiredInstallmentIds, false, null);
    installmentCount = event.installmentCountBefore;
    totalAmount = event.scheduleTotalAmountBefore;
  }

  if (activeEvents.length > 0) {
    const restored = installments.filter((item) => (updated.has(item.id) ? updated.get(item.id) : item.deletedAt) == null);
    if (restored.length !== installmentCount || new Set(restored.map((item) => item.sequenceNumber)).size !== restored.length || Math.abs(round2(restored.reduce((sum, item) => sum + item.amountDue, 0) - totalAmount)) > 0.01) {
      throw new AgreementResetBlockedError(unsafeSchedule);
    }
  }

  const loanAmount = round2(loan.loanAmount - activeDisbursements.reduce((sum, item) => sum + item.amount, 0));
  if (!Number.isFinite(loanAmount) || loanAmount <= 0 || activeDisbursements.some((item) => item.loanId !== loan.id || !Number.isFinite(item.amount) || item.amount <= 0)) {
    throw new AgreementResetBlockedError("The loan's opening principal cannot be verified from its additional disbursements.");
  }

  return { installmentDates: updated, installmentCount, totalAmount, loanAmount, financialEventIds: eventIds };
}
