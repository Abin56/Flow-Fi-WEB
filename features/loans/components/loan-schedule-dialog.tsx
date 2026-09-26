"use client";

import { ChevronDown, HandCoins, Lock, LockOpen, Pencil, Receipt, TrendingDown, Trash2, Wallet, X, type LucideIcon } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { CurrencyCell, DateCell, FinanceTable, type FinanceTableColumn } from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { LoanFinancialHistory } from "@/features/loans/components/loan-financial-history";
import { additionalAmountCopy, PAY_EXTRA_PRINCIPAL, PAY_MULTIPLE_EMIS } from "@/features/loans/lib/loan-labels";

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
  onRecordPayment: (row: LoanRow, installment: Installment) => void;
  onSettleLumpSum: (row: LoanRow) => void;
  onPrincipalPrepayment: (row: LoanRow) => void;
  onAdditionalDisbursement: (row: LoanRow) => void;
  onToggleClose: (row: LoanRow) => void;
  /** True while a Close/Reopen write is in flight — blocks a double click. */
  statusBusy?: boolean;
}

/** One entry of the "More payment options" menu — label plus a one-line plain-language explanation. */
function PaymentOption({ icon: Icon, label, description, disabled, onSelect }: { icon: LucideIcon; label: string; description: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="items-start gap-2.5 py-2">
      <Icon className="mt-0.5 size-4 text-muted-foreground" />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </DropdownMenuItem>
  );
}

/** Centered, all-in-one loan detail popup — overview + the complete repayment schedule + history, with
 *  one primary money action (Record Payment), the less common money actions grouped under "More
 *  payment options", and loan management (Edit/Close/Delete) kept visually separate. `row` is resolved
 *  live by the parent from the Firestore-backed rows, so every persisted change re-renders it in place.
 *  This is what clicking a loan card opens. */
export function LoanScheduleDialog({ open, onOpenChange, row, onEdit, onDelete, deleteLabel = "Delete Loan", onRecordPayment, onSettleLumpSum, onPrincipalPrepayment, onAdditionalDisbursement, onToggleClose, statusBusy = false }: LoanScheduleDialogProps) {
  if (!row) return null;

  const totalReceived = row.installments.reduce((sum, i) => sum + i.amountPaid, 0);
  const totalRemaining = row.installments.reduce((sum, i) => sum + remainingAmount(i), 0);
  const isClosed = row.status === "closed";
  // Oldest installment still owing money — what "Record Payment" pays toward.
  const nextPayable = row.installments.find((i) => !i.isSkipped && remainingAmount(i) > 0) ?? null;
  const additionalCopy = additionalAmountCopy(row.direction);

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
            {row.beneficiaryPersonId && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">For</span>
                <span className="font-medium text-foreground">{row.beneficiaryName ?? "Someone else"}</span>
              </div>
            )}
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
                  <CurrencyCell amount={row.outstandingPrincipal} signed={false} />
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
                {row.status === "overdue" ? "Missed Payment" : row.status === "closed" ? "Closed" : "Active"}
              </ClayBadge>
            </div>
          </div>

          <div className="px-6 py-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Repayment Schedule</span>
              {!isClosed && <span className="text-xs text-muted-foreground">Click an unpaid installment to record a payment</span>}
            </div>
            <FinanceTable
              columns={columns}
              data={row.installments}
              getRowId={(i) => i.id}
              className="rounded-2xl"
              onRowClick={(i) => !isClosed && remainingAmount(i) > 0 && onRecordPayment(row, i)}
              rowClassName={(i) => (isClosed || remainingAmount(i) <= 0 ? "cursor-default!" : undefined)}
            />
          </div>
          <div className="border-t border-border px-6 py-5">
            <div className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">Payment & principal history</div>
            <LoanFinancialHistory row={row} />
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3 border-t border-border bg-muted/20 px-6 py-4 sm:flex-col">
          {isClosed && (
            <p className="text-xs text-muted-foreground">This loan is closed. Reopen it to record payments or add money.</p>
          )}
          <div className="flex w-full flex-wrap items-center gap-2 sm:justify-between">
            {/* Loan management — deliberately quieter than the money actions on the right. */}
            <div className="flex flex-wrap items-center gap-1">
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-none" onClick={() => onEdit(row)} disabled={statusBusy}>
                <Pencil className="size-3.5" />
                Edit Loan
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-none" onClick={() => onToggleClose(row)} disabled={statusBusy}>
                {isClosed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                {statusBusy ? (isClosed ? "Reopening…" : "Closing…") : isClosed ? "Reopen Loan" : "Close Loan"}
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-none text-expense hover:text-expense" onClick={() => onDelete(row)} disabled={statusBusy}>
                <Trash2 className="size-3.5" />
                {deleteLabel}
              </ClayButton>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <ClayButton variant="secondary" className="gap-1.5 rounded-none" disabled={isClosed}>
                    More payment options
                    <ChevronDown className="size-3.5" />
                  </ClayButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <PaymentOption
                    icon={TrendingDown}
                    label={PAY_EXTRA_PRINCIPAL.label}
                    description={PAY_EXTRA_PRINCIPAL.description}
                    disabled={totalRemaining <= 0}
                    onSelect={() => onPrincipalPrepayment(row)}
                  />
                  <PaymentOption
                    icon={Receipt}
                    label={PAY_MULTIPLE_EMIS.label}
                    description={PAY_MULTIPLE_EMIS.description}
                    disabled={totalRemaining <= 0}
                    onSelect={() => onSettleLumpSum(row)}
                  />
                  <DropdownMenuSeparator />
                  <PaymentOption
                    icon={HandCoins}
                    label={additionalCopy.label}
                    description={additionalCopy.description}
                    onSelect={() => onAdditionalDisbursement(row)}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
              <ClayButton
                variant="primary"
                className="gap-1.5 rounded-none"
                disabled={isClosed || nextPayable == null}
                onClick={() => nextPayable && onRecordPayment(row, nextPayable)}
              >
                <Wallet className="size-3.5" />
                Record Payment
              </ClayButton>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
