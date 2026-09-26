"use client";

import { HandCoins, UserRound } from "lucide-react";
import { DebtCard, LOAN_ICON, daysUntil, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { installmentStatus, remainingAmount } from "@/lib/models/payment-schedule";

interface LoanCardProps {
  row: LoanRow;
  onClick: () => void;
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

/** Non-routine states only; an active borrowed loan carries no badge. */
export function loanBadges(row: LoanRow): DebtCardBadge[] {
  const badges: DebtCardBadge[] = [];
  if (row.direction === "given") badges.push({ label: "Money I lent", tone: "success" });
  if (row.status === "overdue") badges.push({ label: "Missed payment", tone: "expense" });
  if (row.status === "closed") badges.push({ label: "Closed", tone: "neutral" });
  return badges;
}

/** Installment-count progress (not an amount ratio, which reducing-balance amortization skews early on). */
export function LoanCard({ row, onClick }: LoanCardProps) {
  const { loan, lenderName, outstandingPrincipal, nextDueDate, installmentsPaid, totalInstallments } = row;
  const hasOwnName = Boolean(loan.name?.trim());
  const sourceParts = [
    hasOwnName ? lenderName : row.category === "personal" ? "Personal loan" : "Bank loan",
    loan.interest ? `${loan.interest.ratePercent}% p.a.` : null,
  ].filter(Boolean);
  const isClosed = row.status === "closed";
  const overdue = row.status === "overdue" || (nextDueDate != null && daysUntil(nextDueDate) < 0);

  return (
    <DebtCard
      icon={LOAN_ICON}
      name={loanDisplayName(row)}
      source={sourceParts.join(" · ")}
      badges={loanBadges(row)}
      outstandingLabel={row.direction === "given" ? "Still to receive" : "Outstanding"}
      outstanding={outstandingPrincipal}
      nextAmount={isClosed ? null : loanNextDueAmount(row)}
      nextDate={isClosed ? null : nextDueDate}
      overdue={overdue}
      paid={installmentsPaid}
      total={totalInstallments}
      links={[
        row.beneficiaryPersonId ? { icon: UserRound, label: `For ${row.beneficiaryName ?? "someone else"}` } : null,
        row.payerName ? { icon: HandCoins, label: `Paid by ${row.payerName}` } : null,
      ].filter((l) => l != null)}
      muted={isClosed}
      onClick={onClick}
    />
  );
}
