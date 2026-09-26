"use client";

import { Banknote, Briefcase, Car, CreditCard, GraduationCap, Home, User, UserRound } from "lucide-react";
import { DebtCard, EMI_ICON, daysUntil, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { EmiLoanType } from "@/lib/models/emi";
import { remainingAmount } from "@/lib/models/payment-schedule";

export const EMI_TYPE_ICON: Record<EmiLoanType, typeof Home> = {
  home: Home,
  personal: User,
  vehicle: Car,
  education: GraduationCap,
  gold: Banknote,
  business: Briefcase,
  creditCard: CreditCard,
  other: EMI_ICON,
};

export const EMI_TYPE_LABEL: Record<EmiLoanType, string> = {
  home: "Home",
  personal: "Personal",
  vehicle: "Vehicle",
  education: "Education",
  gold: "Gold",
  business: "Business",
  creditCard: "Credit Card EMI",
  other: "Other",
};

/** "HDFC Card ••1234" style label for an EMI's linked card, or null. */
export function emiCardLabel(row: EmiRow): string | null {
  if (!row.linkedCard) return row.emi.linkedCreditCardId ? "Credit card" : null;
  return row.linkedCard.lastFourDigits ? `Card ••${row.linkedCard.lastFourDigits}` : "Credit card";
}

/** Non-routine states only; an active EMI carries no badge. */
export function emiBadges(row: EmiRow): DebtCardBadge[] {
  switch (row.status) {
    case "overdue":
      return [{ label: "Missed payment", tone: "expense" }];
    case "defaulted":
      return [{ label: "Defaulted", tone: "expense" }];
    case "completed":
      return [{ label: "Completed", tone: "success" }];
    case "closed":
      return [{ label: "Closed", tone: "neutral" }];
    default:
      return [];
  }
}

interface EmiCardProps {
  row: EmiRow;
  onClick: () => void;
}

/** Same card as LoanCard (see `DebtCard`) — installment-count progress, outstanding amount first. */
export function EmiCard({ row, onClick }: EmiCardProps) {
  const { emi, status, installmentsPaid, remainingBalance, nextInstallment } = row;
  const cardLabel = emiCardLabel(row);
  const source = emi.lenderName ?? cardLabel ?? row.category?.name ?? EMI_TYPE_LABEL[emi.loanType];
  const done = status === "closed" || status === "completed";

  return (
    <DebtCard
      icon={EMI_TYPE_ICON[emi.loanType]}
      name={emi.name}
      source={source}
      badges={emiBadges(row)}
      outstandingLabel="Outstanding"
      outstanding={remainingBalance}
      nextAmount={done || !nextInstallment ? null : remainingAmount(nextInstallment)}
      nextDate={done ? null : (nextInstallment?.dueDate ?? null)}
      overdue={status === "overdue" || (nextInstallment != null && daysUntil(nextInstallment.dueDate) < 0)}
      paid={installmentsPaid}
      total={emi.installmentCount}
      links={[
        cardLabel && cardLabel !== source ? { icon: CreditCard, label: cardLabel } : null,
        emi.beneficiaryPersonId ? { icon: UserRound, label: `For ${row.beneficiaryName ?? "someone else"}` } : null,
      ].filter((l) => l != null)}
      muted={status === "closed"}
      onClick={onClick}
    />
  );
}
