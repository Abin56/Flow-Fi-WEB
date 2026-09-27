"use client";

import { ArrowUpRight, Building2, CheckCircle2, HandCoins, Lock, LockOpen, Pencil, Trash2, UserRound, Wallet, X } from "lucide-react";
import Link from "next/link";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { CurrencyCell, DateCell, FinanceTable, type FinanceTableColumn } from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { loanBadges, loanDisplayName } from "@/features/loans/components/loan-card";
import { DetailHero, DetailSectionTitle, FactGrid, LinkedList, LinkedRow, Money, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
import { LoanFinancialHistory } from "@/features/loans/components/loan-financial-history";
import { additionalAmountCopy } from "@/features/loans/lib/loan-labels";

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
  /** Name of the Account the loan's money moved through when it was created, if any. */
  linkedAccountName?: string | null;
  /** Opens the unified Record Payment surface (installment, partial, advance, extra principal, pay-all). */
  onRecordPayment: (row: LoanRow) => void;
  onAdditionalDisbursement: (row: LoanRow) => void;
  onToggleClose: (row: LoanRow) => void;
  /** True while a Close/Reopen write is in flight — blocks a double click. */
  statusBusy?: boolean;
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
export function LoanScheduleDialog({ open, onOpenChange, row, onEdit, onDelete, deleteLabel = "Delete Loan", linkedAccountName, onRecordPayment, onAdditionalDisbursement, onToggleClose, statusBusy = false }: LoanScheduleDialogProps) {
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
      accessor: (i) => <DateCell date={i.dueDate} className="text-sm text-foreground" />,
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

  const linked = [
    <LinkedRow
      key="lender"
      icon={row.category === "personal" ? UserRound : Building2}
      label={lent ? "Lent to" : "Borrowed from"}
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-3xl"
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
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Loan</span>
          <DialogTitle className="font-heading text-lg font-semibold">{loanDisplayName(row)}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {row.lenderName}
            {interest ? ` · ${interest.ratePercent}% p.a. ${interest.type === "flat" ? "flat" : "reducing"}` : " · No interest"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 px-6 py-5">
            <DetailHero
              label={lent ? "Still to receive" : "Outstanding"}
              amount={row.outstandingPrincipal}
              paid={row.installmentsPaid}
              total={row.totalInstallments}
              badges={loanBadges(row)}
            />

            {!isClosed && !nextPayable && (
              <div className="flex items-center gap-3 rounded-[10px] border-2 border-success bg-card px-4 py-3">
                <CheckCircle2 className="size-5 shrink-0 text-success" />
                <div className="flex flex-col">
                  <span className="text-sm font-bold text-foreground">Fully paid</span>
                  <span className="text-xs text-muted-foreground">Every installment is settled. Close the loan to move it out of your active list.</span>
                </div>
              </div>
            )}

            {!isClosed && nextPayable && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border-strong bg-secondary px-4 py-3">
                <div className="flex flex-col">
                  <span className={nextOverdue ? "text-xs font-semibold text-expense" : "text-xs font-medium text-muted-foreground"}>
                    Next installment · {dueLabel(nextPayable.dueDate)}
                  </span>
                  <Money amount={remainingAmount(nextPayable)} className="text-xl text-foreground" />
                </div>
                <span className="text-xs text-muted-foreground">Installment #{nextPayable.sequenceNumber} of {row.totalInstallments}</span>
              </div>
            )}

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

            {linked.length > 0 && (
              <section>
                <DetailSectionTitle>Linked</DetailSectionTitle>
                <LinkedList>{linked}</LinkedList>
              </section>
            )}
          </div>

          <div className="border-t border-border px-6 py-5">
            <DetailSectionTitle aside={!isClosed && <span className="text-xs text-muted-foreground">Click an unpaid installment to pay it</span>}>
              Installments
            </DetailSectionTitle>
            <FinanceTable
              columns={columns}
              data={row.installments}
              getRowId={(i) => i.id}
              className="rounded-[10px] border border-border"
              onRowClick={(i) => !isClosed && remainingAmount(i) > 0 && onRecordPayment(row)}
              rowClassName={(i) => (isClosed || remainingAmount(i) <= 0 ? "cursor-default!" : undefined)}
            />
          </div>
          <div className="border-t border-border px-6 py-5">
            <DetailSectionTitle>Payment history</DetailSectionTitle>
            <LoanFinancialHistory row={row} />
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3 border-t border-border bg-secondary px-6 py-3.5 sm:flex-col">
          {isClosed && (
            <p className="text-xs text-muted-foreground">This loan is closed. Reopen it to record payments or add money.</p>
          )}
          <div className="flex w-full flex-wrap items-center gap-2 sm:justify-between">
            {/* Loan management — deliberately quieter than the money actions on the right. */}
            <div className="flex flex-wrap items-center gap-1">
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-[6px] font-semibold text-foreground hover:bg-card" onClick={() => onEdit(row)} disabled={statusBusy}>
                <Pencil className="size-3.5" />
                Edit
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-[6px] font-semibold text-foreground hover:bg-card" onClick={() => onToggleClose(row)} disabled={statusBusy}>
                {isClosed ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                {statusBusy ? (isClosed ? "Reopening…" : "Closing…") : isClosed ? "Reopen" : "Close loan"}
              </ClayButton>
              <ClayButton variant="ghost" size="sm" className="gap-1.5 rounded-none text-expense hover:text-expense" onClick={() => onDelete(row)} disabled={statusBusy}>
                <Trash2 className="size-3.5" />
                {deleteLabel}
              </ClayButton>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ClayButton
                variant="secondary"
                className="gap-1.5 rounded-[8px] border-border-strong font-semibold text-foreground hover:bg-card"
                disabled={isClosed}
                onClick={() => onAdditionalDisbursement(row)}
              >
                <HandCoins className="size-3.5" />
                {additionalCopy.label}
              </ClayButton>
              {nextPayable == null && !isClosed ? (
                <span className="inline-flex h-10 items-center gap-1.5 rounded-[8px] border-2 border-success px-4 text-sm font-bold text-success">
                  <CheckCircle2 className="size-4" />
                  Fully paid
                </span>
              ) : (
                <ClayButton
                  variant="primary"
                  className="gap-1.5 rounded-[8px] border-primary-accent-text font-bold"
                  disabled={isClosed || nextPayable == null}
                  onClick={() => onRecordPayment(row)}
                >
                  <Wallet className="size-4" />
                  {lent ? "Record Repayment" : "Record Payment"}
                </ClayButton>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDateLong(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
