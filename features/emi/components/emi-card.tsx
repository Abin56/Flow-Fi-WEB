"use client";

import { Banknote, Briefcase, Building2, Car, CreditCard, GraduationCap, Home, User } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FloatingCard } from "@/components/foundation/floating-card";
import { StaggerItem } from "@/components/foundation/animated-container";
import { CurrencyCell, DateCell } from "@/components/finance";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { EmiLoanType, EmiStatus } from "@/lib/models/emi";
import { cn } from "@/lib/utils";

const LOAN_TYPE_ICON: Record<EmiLoanType, typeof Home> = {
  home: Home,
  personal: User,
  vehicle: Car,
  education: GraduationCap,
  gold: Banknote,
  business: Briefcase,
  creditCard: CreditCard,
  other: Building2,
};

const STATUS_TONE: Record<EmiStatus, "success" | "warning" | "expense" | "neutral" | "primary"> = {
  active: "primary",
  completed: "success",
  overdue: "expense",
  defaulted: "expense",
  closed: "neutral",
};

const STATUS_LABEL: Record<EmiStatus, string> = {
  active: "Active",
  completed: "Completed",
  overdue: "Overdue",
  defaulted: "Defaulted",
  closed: "Closed",
};

interface EmiCardProps {
  row: EmiRow;
  onClick: () => void;
}

/** Installment-progress card — mirrors LoanCard's "N of M installments paid" posture (see that component's doc
 *  comment) rather than an amount-ratio ring, since amortized EMI balances skew early in the schedule. */
export function EmiCard({ row, onClick }: EmiCardProps) {
  const { emi, category, status, installmentsPaid, remainingBalance, nextInstallment } = row;
  const Icon = LOAN_TYPE_ICON[emi.loanType];
  const installmentPercent = emi.installmentCount > 0 ? Math.round((installmentsPaid / emi.installmentCount) * 100) : 0;
  const remainingInstallments = emi.installmentCount - installmentsPaid;

  return (
    <StaggerItem>
      <FloatingCard
        role="button"
        tabIndex={0}
        onClick={onClick}
        className="flex h-full cursor-pointer flex-col gap-4 px-5 py-5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-e1">
              <Icon className="size-4.5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h3 className="truncate font-heading text-base font-semibold text-foreground">{emi.name}</h3>
              <p className="truncate text-xs text-muted-foreground">{emi.lenderName ?? category?.name ?? "EMI"}</p>
            </div>
          </div>
          <ClayBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</ClayBadge>
        </div>

        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" style={{ boxShadow: "var(--shadow-pressed-sm)" }}>
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
              style={{ width: `${installmentPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-medium tabular-nums text-foreground">
              {installmentsPaid} of {emi.installmentCount} installments paid
            </span>
            <span className="text-muted-foreground">{Math.max(remainingInstallments, 0)} left</span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Remaining Balance</span>
          <CurrencyCell amount={remainingBalance} signed={false} className="text-base font-semibold" />
        </div>

        <div className={cn("mt-auto flex items-end justify-between gap-2 border-t border-border/60 pt-3")}>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Next EMI</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {(nextInstallment?.amountDue ?? 0).toLocaleString("en-IN")}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-xs text-muted-foreground">Next due</span>
            {nextInstallment ? <DateCell date={nextInstallment.dueDate} /> : <span className="text-xs text-muted-foreground">—</span>}
          </div>
        </div>
      </FloatingCard>
    </StaggerItem>
  );
}
