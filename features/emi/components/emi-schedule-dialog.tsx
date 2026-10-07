"use client";

import { ArrowUpRight, Building2, CreditCard, Lock, LockOpen, Trash2, UserRound, Wallet, X } from "lucide-react";
import Link from "next/link";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/format";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { InstallmentList, PaymentHistoryList } from "@/features/loans/components/payment-rows";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import { EMI_TYPE_LABEL, emiBadges, emiCardLabel } from "@/features/emi/components/emi-card";
import { DetailHero, DetailSectionTitle, FactGrid, LinkedList, LinkedRow, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";

interface EmiScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EmiRow | null;
  onDelete: (row: EmiRow) => void;
  onRecordPayment: (row: EmiRow, installment: Installment) => void;
  onToggleClose: (row: EmiRow) => void;
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
export function EmiScheduleDialog({ open, onOpenChange, row, onDelete, onRecordPayment, onToggleClose, statusBusy = false, paymentActions, historyLoading, onViewPayment }: EmiScheduleDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[10px] border border-border p-0 shadow-lg ring-0 sm:max-w-3xl"
      >
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-8 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <X className="size-4" />
        </button>

        <DialogHeader className="shrink-0 gap-0.5 border-b border-border px-6 pt-5 pb-4 pr-14 text-left">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">EMI</span>
          <DialogTitle className="font-heading text-lg font-semibold">{row.emi.name}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {row.emi.lenderName ?? EMI_TYPE_LABEL[row.emi.loanType]}
            {interest ? ` · ${interest.ratePercent}% p.a. ${interest.type === "flat" ? "flat" : "reducing"}` : " · No interest"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 px-6 py-5">
            <DetailHero
              label="Outstanding"
              amount={row.remainingBalance}
              paid={row.installmentsPaid}
              total={row.emi.installmentCount}
              partial={installmentProgress(row.installments).partial}
              badges={emiBadges(row)}
            />

            {!isClosed && nextPayable && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-border bg-secondary px-4 py-3">
                <div className="flex flex-col">
                  <span className={nextOverdue ? "text-xs font-semibold text-expense" : "text-xs font-medium text-muted-foreground"}>
                    Next installment · {dueLabel(nextPayable.dueDate)}
                  </span>
                  <span className="font-heading text-lg font-semibold text-foreground tabular-nums">
                    {formatCurrency(remainingAmount(nextPayable))}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  Installment #{nextPayable.sequenceNumber} of {row.emi.installmentCount}
                </span>
              </div>
            )}

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

            {linked.length > 0 && (
              <section>
                <DetailSectionTitle>Linked</DetailSectionTitle>
                <LinkedList>{linked}</LinkedList>
              </section>
            )}
          </div>

          <div className="border-t border-border px-6 py-5">
            <DetailSectionTitle aside={<span className="text-xs text-muted-foreground">Select an installment to pay or view it</span>}>
              Installments
            </DetailSectionTitle>
            <InstallmentList
              installments={row.installments}
              total={row.emi.installmentCount}
              closed={isClosed}
              actions={paymentActions}
              onPay={(i) => onRecordPayment(row, i)}
              onViewPayment={onViewPayment}
            />
          </div>
          <div className="border-t border-border px-6 py-5">
            <DetailSectionTitle>Payment history</DetailSectionTitle>
            {historyLoading && paymentActions.length === 0 ? (
              <p className="text-xs text-muted-foreground">Loading history…</p>
            ) : (
              <PaymentHistoryList actions={paymentActions} onOpen={onViewPayment} />
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3 border-t border-border bg-muted/30 px-6 py-3.5 sm:flex-col">
          {isClosed && <p className="text-xs text-muted-foreground">This EMI is closed. Reopen it to record payments.</p>}
          <div className="flex w-full flex-wrap items-center gap-2 sm:justify-between">
            <div className="flex flex-wrap items-center gap-1">
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-[6px] font-medium text-foreground" onClick={() => onToggleClose(row)} disabled={statusBusy}>
                {isClosed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                {statusBusy ? (isClosed ? "Reopening…" : "Closing…") : isClosed ? "Reopen" : "Close EMI"}
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-[6px] font-medium text-expense hover:text-expense" onClick={() => onDelete(row)} disabled={statusBusy}>
                <Trash2 className="size-3.5" />
                Delete
              </ClayButton>
            </div>

            <ClayButton
              variant="primary"
              className="gap-1.5 rounded-[6px] border-primary-accent-text font-semibold"
              disabled={isClosed || nextPayable == null}
              onClick={() => nextPayable && onRecordPayment(row, nextPayable)}
            >
              <Wallet className="size-3.5" />
              Record Payment
            </ClayButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDateLong(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
