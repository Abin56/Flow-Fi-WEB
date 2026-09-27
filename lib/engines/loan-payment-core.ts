/**
 * The pure core of one Loan payment action — classification, allocation and the exact documents its
 * atomic write produces — shared by `LoanAdvancePaymentRepository.record` and `.editPayment`, so a
 * recorded payment and an edited one can never be computed two different ways. Always called with
 * installments read FRESH inside the Firestore transaction.
 *
 * Classification scope: the installments currently due on `date` (overdue, or — if none — the single
 * next one), unless `includeUpcomingInstallments` (the "Apply to upcoming EMIs" choice) widens it to
 * every remaining installment. Whatever is left becomes a principal prepayment (ledger-only overflow
 * record on the schedule's last installment). One-time loans refuse an overflow.
 */

import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { recordEdit } from "@/lib/firestore/soft-deletable";
import type { Loan } from "@/lib/models/loan";
import { remainingAmount, type Installment, type InstallmentPayment, type PaymentAllocationType } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";

export interface LoanPaymentCoreInput {
  loan: Loan;
  /** Fresh installments, sorted by sequence. */
  fresh: Installment[];
  /** The schedule's last known installment id — where an overflow record is attached. */
  lastInstallmentId: string;
  accountId: string;
  amount: number;
  date: Date;
  idempotencyKey: string;
  note?: string;
  includeUpcomingInstallments?: boolean;
  now?: Date;
}

export interface LoanPaymentCore {
  transactionId: string;
  paymentIds: string[];
  installmentIds: string[];
  /** Touched installments with their new `amountPaid`. */
  installments: Installment[];
  payments: InstallmentPayment[];
  overflowPayment: InstallmentPayment | null;
  overflowPaymentId: string;
  overflow: number;
  overallType: PaymentAllocationType;
  transaction: Transaction;
}

export function loanTransactionId(idempotencyKey: string): string {
  return `adv_${idempotencyKey}_txn`;
}

export function planLoanPaymentCore(input: LoanPaymentCoreInput): LoanPaymentCore {
  const { loan, fresh, amount, date, idempotencyKey, accountId, note = "", includeUpcomingInstallments = false } = input;
  const now = input.now ?? new Date();
  const transactionId = loanTransactionId(idempotencyKey);
  const overflowPaymentId = `adv_${idempotencyKey}_principal`;

  const eligible = fresh.filter((i) => remainingAmount(i) > 0 && !i.isSkipped);
  if (eligible.length === 0) throw new Error("This loan is already fully paid");
  const dueNow = eligible.filter((i) => !(i.dueDate.getTime() > date.getTime()));
  const scope = includeUpcomingInstallments ? eligible : dueNow.length > 0 ? dueNow : [eligible[0]];
  const plan = planInstallmentSettlement(scope, amount);
  const overflow = plan.unallocated;
  if (loan.repaymentType === "oneTime" && overflow > 0) {
    throw new Error("Amount is more than what's still owed on this loan");
  }

  const paymentIds = plan.portions.map((_, i) => `adv_${idempotencyKey}_p${i}`);
  const installmentIds = plan.portions.map((p) => p.installment.id);
  const overallType: PaymentAllocationType =
    overflow > 0 ? "principalPrepayment" : plan.portions[0].installment.dueDate.getTime() > date.getTime() ? "advanceEmi" : "regularEmi";

  const installments: Installment[] = [];
  const payments: InstallmentPayment[] = [];
  plan.portions.forEach((portion, i) => {
    const current = portion.installment;
    const newAmountPaid = Math.min(Math.max(current.amountPaid + portion.portion, 0), current.amountDue);
    const updated = { ...recordEdit(current, "amountPaid", String(current.amountPaid), String(newAmountPaid)), amountPaid: newAmountPaid };
    installments.push(updated);
    payments.push({
      id: paymentIds[i],
      installmentId: current.id,
      scheduleId: loan.scheduleId,
      ownerType: current.ownerType,
      ownerId: current.ownerId,
      amount: portion.portion,
      date,
      note,
      createdAt: now,
      settlementMethod: null,
      billingCycleLabel: null,
      remainingBalanceAfterPayment: remainingAmount(updated),
      allocationType: current.dueDate.getTime() > date.getTime() ? "advanceEmi" : "regularEmi",
      prepaymentPrincipalAmount: null,
      prepaymentPolicyApplied: null,
      reamortizationEventId: null,
      transactionId,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    });
  });

  let overflowPayment: InstallmentPayment | null = null;
  if (overflow > 0) {
    const last = fresh[fresh.length - 1];
    // Ledger-only — never applied to an installment's amountPaid: this money reduces principal directly.
    overflowPayment = {
      id: overflowPaymentId,
      installmentId: input.lastInstallmentId,
      scheduleId: loan.scheduleId,
      ownerType: last.ownerType,
      ownerId: last.ownerId,
      amount: overflow,
      date,
      note,
      createdAt: now,
      settlementMethod: null,
      billingCycleLabel: null,
      remainingBalanceAfterPayment: null,
      allocationType: "principalPrepayment",
      prepaymentPrincipalAmount: overflow,
      prepaymentPolicyApplied: null,
      reamortizationEventId: null,
      transactionId,
      deletedAt: null,
      lastEditedAt: null,
      editHistory: [],
    };
  }

  const transaction: Transaction = {
    id: transactionId,
    type: loan.direction === "given" ? "income" : "expense",
    amount,
    dateTime: date,
    accountId,
    // TODO(Phase 1): point at the real seeded "Loan Payment"/"EMI Payment" system category once that
    // seeding mechanism exists.
    categoryId: "loan_payment",
    description: loan.name ? `Loan payment — ${loan.name}` : "Loan payment",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: now,
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: loan.id,
    emiId: null,
    installmentId: plan.portions[0].installment.id,
    installmentPaymentId: paymentIds[0],
    paymentAllocationType: overallType,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };

  return { transactionId, paymentIds, installmentIds, installments, payments, overflowPayment, overflowPaymentId, overflow, overallType, transaction };
}
