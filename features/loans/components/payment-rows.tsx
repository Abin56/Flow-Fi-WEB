"use client";

import { ArrowRight, Check, ChevronRight, Receipt, RotateCcw, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FilterTabs, LE_RADIUS, Money, dueLabel } from "@/features/loans/components/loan-emi-ui";
import {
  installmentRangeLabel,
  installmentRowAction,
  paymentTypeLabel,
  type RecordedPaymentAction,
} from "@/features/loans/lib/recorded-payments";
import { formatCurrency } from "@/lib/format";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

/**
 * Installment schedule and payment history rows for the Loan & EMI details views.
 *
 * An installment row reads "Installment 4 of 12 / Due 5 Oct" on the left and the amount with a light status
 * line on the right. What it does is always explicit, never a bare click-target:
 *   - still owed (upcoming / overdue / partly paid) → a "Pay →" button, the existing Record Payment flow;
 *   - has a recorded payment → the row itself opens that payment ("Details ›"), where it can be edited or
 *     marked as unpaid.
 * A partly paid installment has both. Rows that do nothing (skipped, or closed and unpaid) are plain.
 */

const STATUS_TEXT: Record<InstallmentStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partly paid",
  overdue: "Overdue",
  skipped: "Skipped",
  upcoming: "Upcoming",
};

const STATUS_TONE: Record<InstallmentStatus, string> = {
  paid: "text-success",
  partiallyPaid: "text-warning-foreground dark:text-warning",
  overdue: "text-expense",
  skipped: "text-muted-foreground",
  upcoming: "text-muted-foreground",
};

const ROW = "flex w-full items-center gap-3 px-3.5 py-3 text-left";
const ACTIONABLE =
  "group cursor-pointer outline-none transition-colors duration-150 hover:bg-secondary active:bg-muted focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function OpenHint({ label }: { label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
      <span className="hidden sm:inline">{label}</span>
      <ChevronRight className="size-4 transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={1.75} />
    </span>
  );
}

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-muted-foreground">
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** "Upcoming" / "✓ Paid" / "Overdue" — a light, coloured status line under the amount, not a badge. */
function StatusText({ status }: { status: InstallmentStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] leading-none font-medium", STATUS_TONE[status])}>
      {status === "paid" && <Check className="size-3" strokeWidth={2.5} aria-hidden />}
      {STATUS_TEXT[status]}
    </span>
  );
}

function PayButton({ emphasized, onClick, label }: { emphasized: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        LE_RADIUS.control,
        "group/pay inline-flex h-8 shrink-0 items-center gap-1 border px-2.5 text-xs font-semibold outline-none transition-[background-color,border-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        emphasized
          ? "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85"
          : "border-border-strong bg-card text-foreground hover:border-primary-accent-text hover:bg-primary hover:text-primary-foreground",
      )}
    >
      Pay
      <ArrowRight className="size-3.5 transition-transform duration-150 group-hover/pay:translate-x-0.5" strokeWidth={2} />
    </button>
  );
}

type ScheduleTab = "all" | "upcoming" | "paid";

/**
 * The installment schedule. Upcoming / Paid / All filter the same rows — the interaction is identical in each.
 */
export function InstallmentList({
  installments,
  total,
  closed,
  actions,
  onPay,
  onViewPayment,
}: {
  installments: Installment[];
  total: number;
  closed: boolean;
  actions: RecordedPaymentAction[];
  onPay: (installment: Installment) => void;
  onViewPayment: (action: RecordedPaymentAction) => void;
}) {
  const [tab, setTab] = useState<ScheduleTab>("all");
  const upcoming = installments.filter((i) => !i.isSkipped && remainingAmount(i) > 0);
  const paid = installments.filter((i) => i.amountPaid > 0);
  const shown = tab === "upcoming" ? upcoming : tab === "paid" ? paid : installments;
  // The one installment to pay next gets the filled "Pay" — overdue ones always do.
  const nextDueId = closed ? null : (upcoming[0]?.id ?? null);

  return (
    <div className="flex flex-col gap-2.5">
      <FilterTabs<ScheduleTab>
        ariaLabel="Show installments"
        options={[
          { value: "all", label: "All", count: installments.length },
          { value: "upcoming", label: "Upcoming", count: upcoming.length },
          { value: "paid", label: "Paid", count: paid.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      {shown.length === 0 ? (
        <p className={cn(LE_RADIUS.card, "border border-dashed border-border px-3.5 py-4 text-xs text-muted-foreground")}>
          {tab === "paid" ? "No payments recorded yet." : "Nothing left to pay."}
        </p>
      ) : (
        <ul className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border overflow-hidden border border-border bg-card")}>
          {shown.map((i) => {
            const status = installmentStatus(i);
            const rowAction = installmentRowAction(i, actions, closed);
            const recorded = rowAction?.kind === "view" ? rowAction.action : null;
            const remaining = remainingAmount(i);
            const canPay = !closed && !i.isSkipped && remaining > 0;
            const dateLine =
              status === "paid"
                ? recorded
                  ? `Paid ${shortDate(recorded.date)}`
                  : `Due ${shortDate(i.dueDate)}`
                : status === "partiallyPaid"
                  ? `${formatCurrency(i.amountPaid)} paid · ${formatCurrency(remaining)} left`
                  : status === "skipped"
                    ? `Was due ${shortDate(i.dueDate)}`
                    : dueLabel(i.dueDate);

            const content = (
              <>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm font-semibold text-foreground">Installment {i.sequenceNumber}</span>
                    {total > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">of {total}</span>}
                  </span>
                  <span className={cn("truncate text-xs", status === "overdue" ? "font-medium text-expense" : "text-muted-foreground")}>{dateLine}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <Money amount={i.amountDue} className={cn("text-[15px] leading-none", status === "skipped" ? "text-muted-foreground" : "text-foreground")} />
                  <StatusText status={status} />
                </span>
                {recorded && <OpenHint label="Details" />}
              </>
            );

            return (
              <li key={i.id} className={cn("flex items-center", canPay && "pr-3.5")}>
                {recorded ? (
                  <button
                    type="button"
                    className={cn(ROW, ACTIONABLE, "min-w-0 flex-1")}
                    onClick={() => onViewPayment(recorded)}
                    aria-label={`Installment ${i.sequenceNumber}: view payment details`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={cn(ROW, "min-w-0 flex-1")}>{content}</div>
                )}
                {canPay && (
                  <PayButton
                    emphasized={status === "overdue" || i.id === nextDueId}
                    onClick={() => onPay(i)}
                    label={`Pay installment ${i.sequenceNumber}, ${formatCurrency(remaining)}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface HistoryExtraItem {
  id: string;
  title: string;
  amount: number;
  date: Date;
  reversed: boolean;
  detail: string | null;
}

/** Payment history: one row per recorded payment (the amount the user entered), newest first. Active payments open their details. */
export function PaymentHistoryList({
  actions,
  titleFor,
  detailFor,
  extras = [],
  onOpen,
}: {
  actions: RecordedPaymentAction[];
  titleFor?: (action: RecordedPaymentAction) => string;
  detailFor?: (action: RecordedPaymentAction) => string | null;
  /** Non-payment events shown in the same timeline (e.g. a Loan's additional amounts) — not openable here. */
  extras?: HistoryExtraItem[];
  onOpen: (action: RecordedPaymentAction) => void;
}) {
  type Item = { kind: "action"; action: RecordedPaymentAction; date: Date } | { kind: "extra"; extra: HistoryExtraItem; date: Date };
  const items: Item[] = [
    ...actions.map((action): Item => ({ kind: "action", action, date: action.date })),
    ...extras.map((extra): Item => ({ kind: "extra", extra, date: extra.date })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());
  if (items.length === 0) return <p className="text-xs text-muted-foreground">No payment history yet.</p>;

  return (
    <ul className={cn(LE_RADIUS.card, "flex flex-col divide-y divide-border overflow-hidden border border-border bg-card")}>
      {items.map((item) => {
        const reversed = item.kind === "action" ? item.action.reversed : item.extra.reversed;
        const title = item.kind === "action" ? (titleFor?.(item.action) ?? paymentTypeLabel(item.action)) : item.extra.title;
        const detail =
          item.kind === "action"
            ? (detailFor?.(item.action) ?? (item.action.installmentSeqs.length > 0 ? `Installment ${installmentRangeLabel(item.action.installmentSeqs)}` : null))
            : item.extra.detail;
        const amount = item.kind === "action" ? item.action.amount : item.extra.amount;
        const content = (
          <>
            <RowIcon icon={reversed ? RotateCcw : Receipt} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn("truncate text-sm font-medium", reversed ? "text-muted-foreground line-through decoration-1" : "text-foreground")}>{title}</span>
                {reversed && (
                  <ClayBadge tone="neutral" className="rounded-[4px] px-1.5 py-0 text-[10.5px] font-medium">
                    Reversed
                  </ClayBadge>
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                {detail ? ` · ${detail}` : ""}
              </span>
            </span>
            <Money amount={amount} className={cn("text-sm font-semibold", reversed ? "text-muted-foreground" : "text-foreground")} />
            {item.kind === "action" && !reversed && <OpenHint label="View" />}
          </>
        );
        const key = item.kind === "action" ? item.action.id : item.extra.id;
        return (
          <li key={key}>
            {item.kind === "action" && !reversed ? (
              <button type="button" className={cn(ROW, ACTIONABLE)} onClick={() => onOpen(item.action)} aria-label={`${title}, ${formatCurrency(amount)}: view payment`}>
                {content}
              </button>
            ) : (
              <div className={ROW}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
