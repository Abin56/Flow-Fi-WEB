"use client";

import { Repeat, type LucideIcon } from "lucide-react";
import { StaggerItem } from "@/components/foundation/animated-container";
import { ClayBadge } from "@/components/clay/clay-badge";
import { BankLogo, CurrencyCell, DateCell } from "@/components/finance";
import { billOccurrenceStatus, type BillStatus } from "@/lib/models/bill";
import type { BillRow } from "@/features/bills/hooks/use-bills-data";

const STATUS_TONE: Record<BillStatus, "success" | "warning" | "expense" | "neutral" | "primary"> = {
  paid: "success",
  partiallyPaid: "warning",
  skipped: "neutral",
  overdue: "expense",
  dueToday: "warning",
  upcoming: "primary",
};

const STATUS_LABEL: Record<BillStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partially Paid",
  skipped: "Skipped",
  overdue: "Overdue",
  dueToday: "Due Today",
  upcoming: "Upcoming",
};

const RECURRENCE_LABEL: Record<string, string> = {
  oneTime: "One-time",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  custom: "Custom",
};

export function BillCard({ row, onClick }: { row: BillRow; onClick: () => void }) {
  const { bill, occurrence, account, category } = row;
  const status = occurrence ? billOccurrenceStatus(occurrence) : "upcoming";
  const Icon: LucideIcon = Repeat;

  return (
    <StaggerItem>
      <button
        type="button"
        onClick={onClick}
        className="flex h-full w-full min-w-0 flex-col gap-1.5 rounded-xl border border-border-strong/55 bg-card p-2.5 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-accent-text">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm leading-tight font-semibold text-foreground" title={bill.name}>{bill.name}</p>
              <p className="truncate text-xs text-muted-foreground" title={category?.name}>{category?.name ?? RECURRENCE_LABEL[bill.recurrence]}</p>
            </div>
          </div>
          <ClayBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</ClayBadge>
        </div>

        <div className="mt-auto flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
          <CurrencyCell amount={-(occurrence?.amount ?? bill.amount)} className="text-sm font-semibold" />
          <DateCell date={occurrence?.dueDate ?? bill.nextDueDate} />
        </div>

        {account && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BankLogo bankId={account.bankId} size={16} shape="square" />
            <span className="truncate" title={account.name}>{account.name}</span>
          </div>
        )}
      </button>
    </StaggerItem>
  );
}

export { RECURRENCE_LABEL };
