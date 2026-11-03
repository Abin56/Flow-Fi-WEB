"use client";

import { ArrowUpRight, Building2, CheckCircle2, HandCoins, History, Lock, LockOpen, Pencil, Trash2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { AgreementFooter, AgreementPopup, NextStrip } from "@/features/loans/components/agreement-popup";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { installmentProgress } from "@/lib/engines/installment-progress";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { loanBadges, loanDisplayName } from "@/features/loans/components/loan-card";
import { DetailSectionTitle, FactGrid, LinkedList, LinkedRow, Money, daysUntil } from "@/features/loans/components/loan-emi-ui";
import { LoanFinancialHistory } from "@/features/loans/components/loan-financial-history";
import { InstallmentList } from "@/features/loans/components/payment-rows";
import type { LoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { additionalAmountCopy } from "@/features/loans/lib/loan-labels";
import { hasPastDue } from "@/features/loans/lib/record-payment";
import { useInstallmentPeopleStatus } from "@/features/loans/hooks/use-installment-people-status";
import { LenderPayoffBreakdown } from "@/features/loans/components/lender-payoff-breakdown";

/** Port of `LoanDetailScreen._remainingInterest`. "Loan Amount Left" (the principal counterpart)
 *  now reads `row.outstandingPrincipal` directly instead of a second, locally-recomputed formula —
 *  see the audit-fix comment in `use-loans-data.ts`'s `toLoanRow` for why two implementations of
 *  the same figure used to silently disagree whenever an installment was partially paid. */
function remainingInterest(installments: Installment[]): number {
  return installments.reduce((sum, i) => {
    const interestPortion = i.interestPortion ?? 0;
    const paidTowardInterest = Math.min(Math.max(i.amountPaid, 0), interestPortion);
    return sum + (interestPortion - paidTowardInterest);
  }, 0);
}

interface LoanScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: LoanRow | null;
  onEdit: (row: LoanRow) => void;
  onDelete: (row: LoanRow) => void;
  /** "Reverse & Delete" for a wizard-created Loan whose origination money is still active. */
  deleteLabel?: string;
  /** Name of the Account the loan's money moved through when it was created, if any. */
  linkedAccountName?: string | null;
  /** Opens the unified Record Payment surface (installment, partial, advance, extra principal, pay-all). */
  onRecordPayment: (row: LoanRow, installment?: Installment) => void;
  /** Opens "Record past payments" — installments paid before FlowFi, recorded without moving any account. */
  onRecordPastPayments?: (row: LoanRow) => void;
  onAdditionalDisbursement: (row: LoanRow) => void;
  onToggleClose: (row: LoanRow) => void;
  /** True while a Close/Reopen write is in flight — blocks a double click. */
  statusBusy?: boolean;
  /** Recorded payments (grouped per action) and the raw history they came from. */
  history: LoanPaymentHistory | undefined;
  historyLoading: boolean;
  paymentActions: RecordedPaymentAction[];
  /** Opens a recorded payment's details (where it can be edited). */
  onViewPayment: (action: RecordedPaymentAction) => void;
}

function GoTo({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUpRight className="size-4" />
    </Link>
  );
}

/** Loan details: the outstanding balance first, then the key facts, what it's linked to, the installment
 *  schedule and history. One primary money action (Record Payment); the less common ones sit under "More
 *  payment options"; loan management (Edit/Close/Delete) stays visually quieter. `row` is resolved live by
 *  the parent from Firestore-backed rows, so every persisted change re-renders it in place. */
export function LoanScheduleDialog({ open, onOpenChange, row, onEdit, onDelete, deleteLabel = "Delete Loan", linkedAccountName, onRecordPayment, onRecordPastPayments, onAdditionalDisbursement, onToggleClose, statusBusy = false, history, historyLoading, paymentActions, onViewPayment }: LoanScheduleDialogProps) {
  // Shared loan: each installment's People side on its row (a loan I gave has no People shares).
  const peopleStatus = useInstallmentPeopleStatus(row && row.direction !== "given" ? { sourceKind: "loan", source: row.loan, installments: row.installments } : null);
  if (!row) return null;

  const totalReceived = row.installments.reduce((sum, i) => sum + i.amountPaid, 0);
  const totalRemaining = row.installments.reduce((sum, i) => sum + remainingAmount(i), 0);
  const isClosed = row.status === "closed";
  const lent = row.direction === "given";
  // Oldest installment still owing money — what "Record Payment" pays toward.
  const nextPayable = row.installments.find((i) => !i.isSkipped && remainingAmount(i) > 0) ?? null;
  const nextOverdue = nextPayable != null && daysUntil(nextPayable.dueDate) < 0;
  const additionalCopy = additionalAmountCopy(row.direction);
  const interest = row.loan.interest;

  const linked = [
    <LinkedRow
      key="lender"
      icon={row.category === "personal" ? UserRound : Building2}
      label={lent ? "Loan given to" : "Loan taken from"}
      value={row.lenderName}
      action={row.category === "personal" && row.loan.personId ? <GoTo href="/people" label="Open People" /> : undefined}
    />,
    linkedAccountName ? (
      <LinkedRow
        key="account"
        icon={Wallet}
        label={lent ? "Paid from account" : "Received into account"}
        value={linkedAccountName}
        action={<GoTo href="/accounts" label="Open Accounts" />}
      />
    ) : null,
    row.beneficiaryPersonId ? (
      <LinkedRow
        key="for"
        icon={UserRound}
        label="For"
        value={row.beneficiaryName ?? "Someone else"}
        action={<GoTo href="/people" label="Open People" />}
      />
    ) : null,
    row.payerName ? (
      <LinkedRow key="payer" icon={HandCoins} label="Installments paid by" value={row.payerName} action={<GoTo href="/people" label="Open People" />} />
    ) : null,
  ].filter(Boolean);

  const manageBtn = "h-8 gap-1.5 rounded-[6px] px-2 text-xs font-medium text-foreground hover:bg-card";
  const moneyBtn = "h-9 gap-1.5 rounded-[6px] px-3 text-[13px]";

  return (
    <AgreementPopup
      open={open}
      onOpenChange={onOpenChange}
      testId="loan-popup"
      eyebrow="Loan"
      title={loanDisplayName(row)}
      subtitle={`${row.lenderName}${interest ? ` · ${+interest.ratePercent.toFixed(2)}% ${interest.period === "monthly" ? "p.m." : "p.a."} ${interest.type === "flat" ? "flat" : "reducing"}` : " · No interest"}`}
      badges={loanBadges(row)}
      outstandingLabel={lent ? "Still to receive" : "Outstanding"}
      outstanding={row.outstandingPrincipal}
      paid={row.installmentsPaid}
      total={row.totalInstallments}
      partial={installmentProgress(row.installments).partial}
      strip={
        isClosed ? undefined : (
          <NextStrip
            next={nextPayable ? { dueDate: nextPayable.dueDate, amount: remainingAmount(nextPayable), sequenceNumber: nextPayable.sequenceNumber } : null}
            total={row.totalInstallments}
            overdue={nextOverdue}
          />
        )
      }
      scheduleCount={row.installments.length}
      historyCount={paymentActions.length}
      schedule={
        <InstallmentList
          installments={row.installments}
          total={row.totalInstallments}
          closed={isClosed}
          actions={paymentActions}
          onPay={(i) => onRecordPayment(row, i)}
          onViewPayment={onViewPayment}
          lent={row.direction === "given"}
          peopleStatus={peopleStatus}
        />
      }
      details={
        <>
          <FactGrid
            facts={[
              { label: "Original amount", value: <Money amount={row.loan.loanAmount} /> },
              { label: "Installment", value: <Money amount={row.emiAmount} />, strong: true },
              { label: lent ? "Received so far" : "Paid so far", value: <Money amount={totalReceived} /> },
              { label: "Left incl. interest", value: <Money amount={totalRemaining} /> },
              interest ? { label: "Interest left", value: <Money amount={remainingInterest(row.installments)} /> } : null,
              {
                label: "Next due",
                value: row.nextDueDate ? formatDateLong(row.nextDueDate) : "—",
                tone: nextOverdue ? "expense" : undefined,
              },
            ]}
          />
          <LenderPayoffBreakdown kind="loan" agreementId={row.loan.id} principal={row.outstandingPrincipal} />
          {linked.length > 0 && (
            <section>
              <DetailSectionTitle>Linked</DetailSectionTitle>
              <LinkedList>{linked}</LinkedList>
            </section>
          )}
        </>
      }
      history={<LoanFinancialHistory row={row} history={history} actions={paymentActions} isLoading={historyLoading} onOpen={onViewPayment} />}
      footer={
        <AgreementFooter
          note={isClosed ? "This loan is closed. Reopen it to record payments or add money." : undefined}
          money={
            <>
              {onRecordPastPayments && !isClosed && hasPastDue(row.installments) && (
                <ClayButton
                  variant="secondary"
                  className={cn(moneyBtn, "border-border-strong font-medium text-foreground hover:bg-card")}
                  onClick={() => onRecordPastPayments(row)}
                  title="Installments paid before you used FlowFi — recorded without changing any account balance"
                >
                  <History className="size-3.5" />
                  {lent ? "Record past repayments" : "Record past payments"}
                </ClayButton>
              )}
              <ClayButton variant="secondary" className={cn(moneyBtn, "border-border-strong font-medium text-foreground hover:bg-card")} disabled={isClosed} onClick={() => onAdditionalDisbursement(row)}>
                <HandCoins className="size-3.5" />
                {additionalCopy.label}
              </ClayButton>
              {nextPayable == null && !isClosed ? (
                <span className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-success px-3 text-[13px] font-semibold text-success">
                  <CheckCircle2 className="size-4" />
                  Fully paid
                </span>
              ) : (
                <ClayButton variant="primary" className={cn(moneyBtn, "min-w-[9.5rem] flex-1 border-primary-accent-text font-semibold sm:flex-none")} disabled={isClosed || nextPayable == null} onClick={() => onRecordPayment(row)}>
                  <Wallet className="size-4" />
                  {lent ? "Record Repayment" : "Record Payment"}
                </ClayButton>
              )}
            </>
          }
          manage={
            <>
              <ClayButton variant="ghost" size="sm" className={manageBtn} onClick={() => onEdit(row)} disabled={statusBusy}>
                <Pencil className="size-3.5" />
                Edit
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className={manageBtn} onClick={() => onToggleClose(row)} disabled={statusBusy}>
                {isClosed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                {statusBusy ? (isClosed ? "Reopening…" : "Closing…") : isClosed ? "Reopen" : "Close loan"}
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className={cn(manageBtn, "text-expense hover:text-expense")} onClick={() => onDelete(row)} disabled={statusBusy}>
                <Trash2 className="size-3.5" />
                {deleteLabel}
              </ClayButton>
            </>
          }
        />
      }
    />
  );
}

function formatDateLong(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
