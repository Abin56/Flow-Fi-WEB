"use client";

import { HandCoins, UserRound } from "lucide-react";
import { DebtCard, LOAN_ICON, cadenceLabel, daysUntil, interestRateLabel, ownershipChips, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import { classifyOwnership, myShareOfInstallment, ownershipActionMode } from "@/features/loans/lib/my-commitments";
import { useLoanPersons } from "@/hooks/use-loans";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { installmentStatus, remainingAmount } from "@/lib/models/payment-schedule";
import { installmentProgress } from "@/lib/engines/installment-progress";

interface LoanCardProps {
  row: LoanRow;
  /** Record-type tag from the unified Loan & EMI list — replaces the generic "Bank loan" / "Money I lent" wording. */
  tag?: string;
  onClick: () => void;
  /** Opens the one-at-a-time "This EMI is mine" / "Remove confirmation" dialog. */
  onOwnershipAction?: (mode: "confirm" | "remove") => void;
}

/** Display name for a loan — its own name, else the lender, so a card never just says "Loan". */
export function loanDisplayName(row: LoanRow): string {
  return row.loan.name?.trim() || row.lenderName;
}

/** What's still due on the next installment — the same installment `toLoanRow` picks for `nextDueDate`. */
export function loanNextDueAmount(row: LoanRow): number | null {
  const next = row.installments.find((i) => installmentStatus(i) !== "paid" && !i.isSkipped);
  return next ? remainingAmount(next) : null;
}

/** Ownership indicator for a loan I took; My Share is of the next installment, and only for confirmed allocations. */
function loanOwnership(row: LoanRow, isClosed: boolean, onAction?: (mode: "confirm" | "remove") => void) {
  const next = isClosed ? undefined : row.installments.find((i) => installmentStatus(i) !== "paid" && !i.isSkipped);
  const mode = onAction ? ownershipActionMode(row.loan) : null;
  const action = mode && onAction ? { label: mode === "confirm" ? "This EMI is mine" : "Remove confirmation", onClick: () => onAction(mode) } : undefined;
  return { kind: classifyOwnership(row.loan).kind, myShare: next ? myShareOfInstallment(row.loan, next.amountDue) : null, action };
}

/** Non-routine states only; an active borrowed loan carries no badge. */
export function loanBadges(row: LoanRow): DebtCardBadge[] {
  const badges: DebtCardBadge[] = [];
  if (row.direction === "given") badges.push({ label: "Loan I Gave", tone: "success" });
  if (row.status === "overdue") badges.push({ label: "Missed payment", tone: "expense" });
  if (row.status === "closed") badges.push({ label: "Closed", tone: "neutral" });
  // Loans have no persisted "completed" status; derived from the schedule so a settled loan reads as done.
  else if (loanNextDueAmount(row) == null) badges.push({ label: "Fully paid", tone: "success" });
  else if (row.status !== "overdue" && row.nextDueDate != null && daysUntil(row.nextDueDate) >= 0 && daysUntil(row.nextDueDate) <= 3) {
    badges.push({ label: "Due soon", tone: "warning" });
  }
  return badges;
}

/** Installment-count progress (not an amount ratio, which reducing-balance amortization skews early on). */
export function LoanCard({ row, tag, onClick, onOwnershipAction }: LoanCardProps) {
  const { loan, lenderName, outstandingPrincipal, nextDueDate, installmentsPaid, totalInstallments } = row;
  const { data: persons = [] } = useLoanPersons();
  const chips = ownershipChips(loan, loan.loanAmount, (id) => persons.find((p) => p.id === id)?.name);
  const hasOwnName = Boolean(loan.name?.trim());
  const sourceParts = [
    hasOwnName ? lenderName : tag ? null : row.category === "personal" ? "Personal loan" : "Bank loan",
    loan.loanNumber ? `Ref ${loan.loanNumber}` : null,
  ].filter(Boolean);
  const isClosed = row.status === "closed";
  const overdue = row.status === "overdue" || (nextDueDate != null && daysUntil(nextDueDate) < 0);

  return (
    <DebtCard
      icon={LOAN_ICON}
      name={loanDisplayName(row)}
      source={sourceParts.join(" · ")}
      tag={tag}
      rate={interestRateLabel(loan.interest)}
      badges={tag ? loanBadges(row).filter((b) => b.label !== "Loan I Gave") : loanBadges(row)}
      outstandingLabel={row.direction === "given" ? "Still to receive" : "Outstanding"}
      outstanding={outstandingPrincipal}
      totalAmount={loan.loanAmount}
      nextAmount={isClosed ? null : loanNextDueAmount(row)}
      nextDate={isClosed ? null : nextDueDate}
      cadence={cadenceLabel(loan.installmentFrequency)}
      overdue={overdue}
      paid={installmentsPaid}
      total={totalInstallments}
      partial={installmentProgress(row.installments).partial}
      links={[
        ...(chips.length > 0 ? chips : [row.beneficiaryPersonId ? { icon: UserRound, label: `For ${row.beneficiaryName ?? "someone else"}`, person: { name: row.beneficiaryName ?? "Someone else", role: "For" } } : null]),
        row.payerName ? { icon: HandCoins, label: `${row.payerName} pays lender` } : null,
      ].filter((l) => l != null)}
      ownership={row.direction === "taken" ? loanOwnership(row, isClosed, onOwnershipAction) : undefined}
      muted={isClosed}
      onClick={onClick}
    />
  );
}
