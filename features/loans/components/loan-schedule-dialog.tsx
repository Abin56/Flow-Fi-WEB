"use client";

import { Lock, LockOpen, Pencil, Receipt, Trash2, X } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { CurrencyCell, DateCell, FinanceTable, type FinanceTableColumn } from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<InstallmentStatus, "success" | "expense" | "warning" | "neutral"> = {
  paid: "success",
  partiallyPaid: "warning",
  overdue: "expense",
  skipped: "neutral",
  upcoming: "neutral",
};

const STATUS_LABEL: Record<InstallmentStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partial",
  overdue: "Overdue",
  skipped: "Skipped",
  upcoming: "Upcoming",
};

/** Remaining principal across all installments, assuming each installment's own payments settle its
 *  interest portion before its principal portion (the standard repayment convention) — display-only,
 *  port of `LoanDetailScreen._remainingPrincipal`. */
function remainingPrincipal(installments: Installment[]): number {
  return installments.reduce((sum, i) => {
    const interestPortion = i.interestPortion ?? 0;
    const principalPortion = i.principalPortion ?? i.amountDue;
    const paidTowardPrincipal = Math.min(Math.max(i.amountPaid - interestPortion, 0), principalPortion);
    return sum + (principalPortion - paidTowardPrincipal);
  }, 0);
}

/** Port of `LoanDetailScreen._remainingInterest` — see `remainingPrincipal` above for the shared
 *  interest-first convention. */
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
  onRecordPayment: (row: LoanRow, installment: Installment) => void;
  onSettleLumpSum: (row: LoanRow) => void;
  onToggleClose: (row: LoanRow) => void;
}

/** Centered, all-in-one loan detail popup — overview + the complete repayment schedule + Edit/Delete/
 *  Record Payment/Settle Lump Sum/Close, all in one place instead of a side drawer that only shows a
 *  6-row slice of the timeline. This is what clicking a loan card opens. */
export function LoanScheduleDialog({ open, onOpenChange, row, onEdit, onDelete, onRecordPayment, onSettleLumpSum, onToggleClose }: LoanScheduleDialogProps) {
  if (!row) return null;

  const totalReceived = row.installments.reduce((sum, i) => sum + i.amountPaid, 0);
  const totalRemaining = row.installments.reduce((sum, i) => sum + remainingAmount(i), 0);

  const columns: FinanceTableColumn<Installment>[] = [
    {
      id: "seq",
      header: "#",
      accessor: (i) => <span className="font-mono text-xs text-muted-foreground">{i.sequenceNumber}</span>,
      width: "44px",
    },
    {
      id: "dueDate",
      header: "Due Date",
      accessor: (i) => <DateCell date={i.dueDate} className="text-sm" />,
      minWidth: "120px",
    },
    {
      id: "principal",
      header: "Principal",
      accessor: (i) => (i.principalPortion != null ? <CurrencyCell amount={i.principalPortion} signed={false} className="text-sm" /> : <span className="text-muted-foreground">—</span>),
      numeric: true,
      minWidth: "100px",
      hideOnMobile: true,
    },
    {
      id: "interest",
      header: "Interest",
      accessor: (i) => (i.interestPortion != null ? <CurrencyCell amount={i.interestPortion} signed={false} className="text-sm" /> : <span className="text-muted-foreground">—</span>),
      numeric: true,
      minWidth: "100px",
      hideOnMobile: true,
    },
    {
      id: "amount",
      header: "Amount",
      accessor: (i) => <CurrencyCell amount={i.amountDue} signed={false} className="text-sm font-semibold" />,
      numeric: true,
      minWidth: "110px",
    },
    {
      id: "status",
      header: "Status",
      accessor: (i) => {
        const status = installmentStatus(i);
        return <ClayBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</ClayBadge>;
      },
      width: "100px",
      align: "right",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-3xl"
      >
        <div className="h-1 w-full shrink-0 bg-primary" />

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <X className="size-4" />
        </button>

        <DialogHeader className="shrink-0 gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
          <DialogTitle className="font-heading text-lg font-semibold">{row.loan.name ?? "Loan"}</DialogTitle>
          <DialogDescription>
            {row.lenderName}
            {row.loan.interest ? ` • ${row.loan.interest.ratePercent}% p.a.` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border px-6 py-5 text-sm sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Direction</span>
              <ClayBadge tone={row.direction === "given" ? "success" : "neutral"} className="w-fit">
                {row.direction === "given" ? "Money I Lent" : "Money I Borrowed"}
              </ClayBadge>
            </div>
            {row.payerName && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Paid By</span>
                <span className="font-medium text-foreground">{row.payerName}</span>
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Outstanding</span>
              <CurrencyCell amount={row.outstandingPrincipal} signed={false} className="text-base font-semibold" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Original Principal</span>
              <CurrencyCell amount={row.loan.loanAmount} signed={false} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {row.direction === "given" ? "Amount Received" : "Amount Paid Back"}
              </span>
              <CurrencyCell amount={totalReceived} signed={false} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Amount Left</span>
              <CurrencyCell amount={totalRemaining} signed={false} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">EMI Amount</span>
              <CurrencyCell amount={row.emiAmount} signed={false} />
            </div>
            {row.loan.interest && (
              <>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Loan Amount Left</span>
                  <CurrencyCell amount={remainingPrincipal(row.installments)} signed={false} />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Interest Left</span>
                  <CurrencyCell amount={remainingInterest(row.installments)} signed={false} />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Interest Type</span>
                  <ClayBadge tone="neutral" className="w-fit">
                    {row.loan.interest.type === "flat" ? "Flat" : "Reducing Balance"}
                  </ClayBadge>
                </div>
              </>
            )}
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Installments Paid</span>
              <span className="font-medium text-foreground">
                {row.installmentsPaid} / {row.totalInstallments}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Next Due Date</span>
              {row.nextDueDate ? <DateCell date={row.nextDueDate} /> : <span className="text-muted-foreground">—</span>}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Status</span>
              <ClayBadge tone={row.status === "overdue" ? "expense" : row.status === "closed" ? "neutral" : "success"} className="w-fit">
                {row.status}
              </ClayBadge>
            </div>
          </div>

          <div className="px-6 py-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Repayment Schedule</span>
              <span className="text-xs text-muted-foreground">Click an unpaid installment to record a payment</span>
            </div>
            <FinanceTable
              columns={columns}
              data={row.installments}
              getRowId={(i) => i.id}
              className="rounded-2xl"
              onRowClick={(i) => remainingAmount(i) > 0 && onRecordPayment(row, i)}
              rowClassName={(i) => (remainingAmount(i) <= 0 ? "cursor-default!" : undefined)}
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-6 py-4 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <ClayButton variant="secondary" className={cn("gap-1.5 rounded-none text-expense")} onClick={() => onDelete(row)}>
              <Trash2 className="size-3.5" />
              Delete
            </ClayButton>
            <ClayButton variant="secondary" className="gap-1.5 rounded-none" onClick={() => onToggleClose(row)}>
              {row.status === "closed" ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
              {row.status === "closed" ? "Reopen Loan" : "Close Loan"}
            </ClayButton>
          </div>
          <div className="flex flex-wrap gap-2">
            <ClayButton variant="secondary" className="gap-1.5 rounded-none" onClick={() => onSettleLumpSum(row)} disabled={totalRemaining <= 0}>
              <Receipt className="size-3.5" />
              Settle Lump Sum
            </ClayButton>
            <ClayButton variant="secondary" className="rounded-none" onClick={() => onOpenChange(false)}>
              Close
            </ClayButton>
            <ClayButton variant="primary" className="gap-1.5 rounded-none" onClick={() => onEdit(row)}>
              <Pencil className="size-3.5" />
              Edit Loan
            </ClayButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
