"use client";

import { ArrowUpRight, Building2, CreditCard, History, Lock, LockOpen, Pencil, Trash2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { AgreementFooter, AgreementPopup, NextStrip } from "@/features/loans/components/agreement-popup";
import { formatCurrency } from "@/lib/format";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { InstallmentList, PaymentHistoryList } from "@/features/loans/components/payment-rows";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import { EMI_TYPE_LABEL, emiBadges, emiCardLabel } from "@/features/emi/components/emi-card";
import { hasPastDue } from "@/features/loans/lib/record-payment";
import { useInstallmentPeopleStatus } from "@/features/loans/hooks/use-installment-people-status";
import { DetailSectionTitle, FactGrid, LinkedList, LinkedRow, daysUntil } from "@/features/loans/components/loan-emi-ui";
import { LenderPayoffBreakdown } from "@/features/loans/components/lender-payoff-breakdown";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";

interface EmiScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EmiRow | null;
  onDelete: (row: EmiRow) => void;
  onRecordPayment: (row: EmiRow, installment: Installment) => void;
  /** Opens "Record past payments" — EMIs paid before FlowFi, recorded without moving any account or card. */
  onRecordPastPayments?: (row: EmiRow) => void;
  onToggleClose: (row: EmiRow) => void;
  /** Opens "Edit terms" (rate, tenure, frequency, due day of the unpaid installments). */
  onEditTerms?: (row: EmiRow) => void;
  /** True while a Close/Reopen write is in flight — blocks a double click. */
  statusBusy?: boolean;
  /** Recorded payments, grouped per payment action. */
  paymentActions: RecordedPaymentAction[];
  historyLoading: boolean;
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

/** EMI details, laid out exactly like `LoanScheduleDialog` — outstanding balance first, key facts,
 *  what it's linked to, then the installment schedule. `row` is resolved live by the parent from
 *  Firestore-backed rows, so every persisted change re-renders it in place. */
export function EmiScheduleDialog({ open, onOpenChange, row, onDelete, onRecordPayment, onRecordPastPayments, onToggleClose, onEditTerms, statusBusy = false, paymentActions, historyLoading, onViewPayment }: EmiScheduleDialogProps) {
  // Shared EMI: each installment's People side on its row, next to (never merged with) the lender status.
  const peopleStatus = useInstallmentPeopleStatus(row ? { sourceKind: "emi", source: row.emi, installments: row.installments } : null);
  if (!row) return null;

  const totalPaid = row.installments.reduce((sum, i) => sum + i.amountPaid, 0);
  const isClosed = row.status === "closed" || row.status === "completed";
  const nextPayable = row.nextInstallment;
  const nextOverdue = nextPayable != null && daysUntil(nextPayable.dueDate) < 0;
  const cardLabel = emiCardLabel(row);
  const interest = row.emi.interest;
  const installmentAmount = nextPayable?.amountDue ?? row.installments[0]?.amountDue ?? 0;

  const linked = [
    cardLabel ? (
      <LinkedRow key="card" icon={CreditCard} label="Credit card" value={cardLabel} action={<GoTo href="/credit-cards" label="Open Credit Cards" />} />
    ) : null,
    row.emi.lenderName ? <LinkedRow key="lender" icon={Building2} label="Lender" value={row.emi.lenderName} /> : null,
    row.emi.beneficiaryPersonId ? (
      <LinkedRow key="for" icon={UserRound} label="For" value={row.beneficiaryName ?? "Someone else"} action={<GoTo href="/people" label="Open People" />} />
    ) : null,
  ].filter(Boolean);

  // Same rows, handlers and People status in every section — only the scope differs.
  const listProps = {
    installments: row.installments,
    total: row.emi.installmentCount,
    closed: isClosed,
    actions: paymentActions,
    onPay: (i: Installment) => onRecordPayment(row, i),
    onViewPayment,
    fallbackSourceLabel: cardLabel,
    peopleStatus,
  };
  const upcomingCount = row.installments.filter((i) => !i.isSkipped && remainingAmount(i) > 0).length;

  const manageBtn = "h-8 gap-1.5 rounded-[6px] px-2 text-xs font-medium text-foreground hover:bg-card";
  const moneyBtn = "h-10 gap-1.5 rounded-[8px] px-3 text-[13px] whitespace-nowrap";

  return (
    <AgreementPopup
      open={open}
      onOpenChange={onOpenChange}
      testId="emi-popup"
      eyebrow="EMI"
      title={row.emi.name}
      subtitle={`${row.emi.lenderName ?? EMI_TYPE_LABEL[row.emi.loanType]}${interest ? ` · ${+interest.ratePercent.toFixed(2)}% ${interest.period === "monthly" ? "p.m." : "p.a."} ${interest.type === "flat" ? "flat" : "reducing"}` : " · No interest"}`}
      badges={emiBadges(row)}
      outstandingLabel="Outstanding"
      outstanding={row.remainingBalance}
      paid={row.installmentsPaid}
      total={row.emi.installmentCount}
      partial={installmentProgress(row.installments).partial}
      strip={
        isClosed ? undefined : (
          <NextStrip
            next={nextPayable ? { dueDate: nextPayable.dueDate, amount: remainingAmount(nextPayable), sequenceNumber: nextPayable.sequenceNumber } : null}
            total={row.emi.installmentCount}
            overdue={nextOverdue}
          />
        )
      }
      upcomingCount={upcomingCount}
      allCount={row.installments.length}
      historyCount={paymentActions.length}
      allLabel="All EMIs"
      comingUp={!isClosed && nextPayable ? <InstallmentList {...listProps} scope="upcoming" limit={3} /> : undefined}
      upcoming={<InstallmentList {...listProps} scope="upcoming" />}
      all={<InstallmentList {...listProps} />}
      detailsTitle="EMI details"
      details={
        <>
          <FactGrid
            facts={[
              { label: "Original amount", value: formatCurrency(row.emi.principalAmount) },
              { label: "Installment", value: formatCurrency(installmentAmount), strong: true },
              { label: "Paid so far", value: formatCurrency(totalPaid) },
              { label: "Left incl. interest", value: formatCurrency(row.remainingBalance) },
              {
                label: "Next due",
                value: nextPayable ? formatDateLong(nextPayable.dueDate) : "—",
                tone: nextOverdue ? "expense" : undefined,
              },
            ]}
          />
          <LenderPayoffBreakdown kind="emi" agreementId={row.emi.id} principal={outstandingPrincipalFor(row.emi.principalAmount, row.installments)} />
          {linked.length > 0 && (
            <section>
              <DetailSectionTitle>Linked</DetailSectionTitle>
              <LinkedList>{linked}</LinkedList>
            </section>
          )}
        </>
      }
      history={historyLoading && paymentActions.length === 0 ? <p className="text-xs text-muted-foreground">Loading history…</p> : <PaymentHistoryList actions={paymentActions} onOpen={onViewPayment} />}
      footer={
        <AgreementFooter
          note={isClosed ? "This EMI is closed. Reopen it to record payments." : undefined}
          money={
            <>
              {onRecordPastPayments && !isClosed && hasPastDue(row.installments) && (
                <ClayButton
                  variant="secondary"
                  className={cn(moneyBtn, "border-border-strong font-medium text-foreground hover:bg-card")}
                  onClick={() => onRecordPastPayments(row)}
                  title="EMIs paid before you used FlowFi — recorded without changing any account or card balance"
                >
                  <History className="size-3.5" />
                  Record past payments
                </ClayButton>
              )}
              <ClayButton
                variant="primary"
                className={cn(moneyBtn, "border-primary-accent-text font-semibold")}
                disabled={isClosed || nextPayable == null}
                onClick={() => nextPayable && onRecordPayment(row, nextPayable)}
              >
                <Wallet className="size-3.5" />
                Record Payment
              </ClayButton>
            </>
          }
          manage={
            <>
              {onEditTerms && (
                <ClayButton variant="ghost" size="sm" className={manageBtn} onClick={() => onEditTerms(row)} disabled={statusBusy} title="Change the rate, tenure, frequency or due day of the unpaid installments">
                  <Pencil className="size-3.5" />
                  Edit terms
                </ClayButton>
              )}
              <ClayButton variant="ghost" size="sm" className={manageBtn} onClick={() => onToggleClose(row)} disabled={statusBusy}>
                {isClosed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                {statusBusy ? (isClosed ? "Reopening…" : "Closing…") : isClosed ? "Reopen" : "Close EMI"}
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className={cn(manageBtn, "text-expense hover:text-expense")} onClick={() => onDelete(row)} disabled={statusBusy}>
                <Trash2 className="size-3.5" />
                Delete
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
