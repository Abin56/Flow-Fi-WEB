"use client";

import { Banknote, Briefcase, Car, CreditCard, GraduationCap, Home, User, UserRound } from "lucide-react";
import { DebtCard, EMI_ICON, cadenceLabel, daysUntil, interestRateLabel, ownershipChips, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import { classifyOwnership, myShareOfInstallment, ownershipActionMode } from "@/features/loans/lib/my-commitments";
import { useLoanPersons } from "@/hooks/use-loans";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { EmiLoanType } from "@/lib/models/emi";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { installmentProgress } from "@/lib/engines/installment-progress";

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
    default: {
      const next = row.nextInstallment?.dueDate;
      return next && daysUntil(next) >= 0 && daysUntil(next) <= 3 ? [{ label: "Due soon", tone: "warning" }] : [];
    }
  }
}

interface EmiCardProps {
  row: EmiRow;
  /** Record-type tag from the unified Loan & EMI list. */
  tag?: string;
  onClick: () => void;
  /** Opens the one-at-a-time "This EMI is mine" / "Remove confirmation" dialog. */
  onOwnershipAction?: (mode: "confirm" | "remove") => void;
}

/** Same card as LoanCard (see `DebtCard`) — installment-count progress, outstanding amount first. */
export function EmiCard({ row, tag, onClick, onOwnershipAction }: EmiCardProps) {
  const { emi, status, installmentsPaid, remainingBalance, nextInstallment } = row;
  const { data: persons = [] } = useLoanPersons();
  const chips = ownershipChips(emi, emi.principalAmount, (id) => persons.find((p) => p.id === id)?.name);
  const cardLabel = emiCardLabel(row);
  const baseSource = emi.lenderName ?? cardLabel ?? row.category?.name ?? EMI_TYPE_LABEL[emi.loanType];
  const source = [baseSource, emi.loanNumber ? `Ref ${emi.loanNumber}` : null].filter(Boolean).join(" · ");
  const done = status === "closed" || status === "completed";
  const mode = onOwnershipAction && !done ? ownershipActionMode(emi) : null;
  const action = mode && onOwnershipAction ? { label: mode === "confirm" ? "This EMI is mine" : "Remove confirmation", onClick: () => onOwnershipAction(mode) } : undefined;

  return (
    <DebtCard
      icon={EMI_TYPE_ICON[emi.loanType]}
      name={emi.name}
      source={source}
      tag={tag}
      rate={interestRateLabel(emi.interest)}
      badges={emiBadges(row)}
      outstandingLabel="Outstanding"
      outstanding={remainingBalance}
      totalAmount={emi.principalAmount}
      totalLabel="EMI amount"
      nextAmount={done || !nextInstallment ? null : remainingAmount(nextInstallment)}
      nextDate={done ? null : (nextInstallment?.dueDate ?? null)}
      cadence={cadenceLabel(emi.installmentFrequency)}
      overdue={status === "overdue" || (nextInstallment != null && daysUntil(nextInstallment.dueDate) < 0)}
      paid={installmentsPaid}
      total={emi.installmentCount}
      partial={installmentProgress(row.installments).partial}
      links={[
        cardLabel && cardLabel !== baseSource ? { icon: CreditCard, label: cardLabel } : null,
        ...(chips.length > 0 ? chips : [emi.beneficiaryPersonId ? { icon: UserRound, label: `For ${row.beneficiaryName ?? "someone else"}`, person: { name: row.beneficiaryName ?? "Someone else", role: "For" } } : null]),
      ].filter((l) => l != null)}
      ownership={{ kind: classifyOwnership(emi).kind, myShare: done || !nextInstallment ? null : myShareOfInstallment(emi, nextInstallment.amountDue), action }}
      muted={status === "closed"}
      onClick={onClick}
    />
  );
}
