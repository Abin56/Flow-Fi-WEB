"use client";

import { useMemo } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { formatCurrency } from "@/lib/format";
import { billOccurrenceStatus, type BillOccurrence, type PaymentRecord } from "@/lib/models/bill";

const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const STATUS_LABEL = { paid: "Paid", partiallyPaid: "Part paid", skipped: "Skipped", overdue: "Unpaid", dueToday: "Unpaid", upcoming: "Unpaid" } as const;

export interface BillPaymentHistoryProps {
  /** The cycle the Bills page is currently showing — never the target of an action by itself. */
  currentOccurrenceId: string | null;
  occurrences: BillOccurrence[];
  /** Live (not cancelled) payments of the bill, every cycle. */
  payments: PaymentRecord[];
  accountName: (accountId: string | null | undefined) => string | undefined;
  onEdit: (payment: PaymentRecord, occurrence: BillOccurrence) => void;
  onCancel: (payment: PaymentRecord, occurrence: BillOccurrence) => void;
  onPay: (occurrence: BillOccurrence) => void;
}

/** A payment can be cancelled when it owns a debit or was recorded as "already paid earlier"; legacy records can't. */
export const canCancelPayment = (p: PaymentRecord) => p.transactionId != null || p.recordedEarlier === true;
export const canEditPayment = (p: PaymentRecord) => p.transactionId != null;

/**
 * Compact payment history for one bill, grouped by the exact cycle each stored payment belongs to
 * (`PaymentRecord.occurrenceId`). Every action carries that cycle's own occurrence — nothing is inferred from
 * whichever cycle the page happens to show. Legacy payments with no cycle are listed read-only, never guessed.
 */
export function BillPaymentHistory({ currentOccurrenceId, occurrences, payments, accountName, onEdit, onCancel, onPay }: BillPaymentHistoryProps) {
  const { cycles, orphans } = useMemo(() => {
    const live = occurrences.filter((o) => o.deletedAt == null);
    const ids = new Set(live.map((o) => o.id));
    const cycles = live
      .map((occurrence) => ({ occurrence, payments: payments.filter((p) => p.occurrenceId === occurrence.id) }))
      // A cycle is listed when it has payments, or it is an older cycle that is open again (e.g. after a cancel) so it can be paid.
      .filter(({ occurrence, payments: ps }) => ps.length > 0 || (occurrence.id !== currentOccurrenceId && !occurrence.isSkipped && occurrence.amountPaid < occurrence.amount))
      .sort((a, b) => b.occurrence.dueDate.getTime() - a.occurrence.dueDate.getTime());
    const orphans = payments.filter((p) => p.occurrenceId == null || !ids.has(p.occurrenceId));
    return { cycles, orphans };
  }, [occurrences, payments, currentOccurrenceId]);

  if (cycles.length === 0 && orphans.length === 0) return null;

  const paymentRow = (p: PaymentRecord, occurrence: BillOccurrence | null) => {
    const funded = p.transactionId != null;
    return (
      <div key={p.id} className="flex flex-col gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono font-medium text-foreground">{formatCurrency(p.amount)}</span>
          <span className="text-xs text-muted-foreground">{day(p.date)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {funded ? (
            <>Paid from <span className="font-medium text-foreground">{accountName(p.accountId) ?? "an account that is no longer listed"}</span></>
          ) : p.recordedEarlier ? (
            <>Already paid earlier — no account change</>
          ) : (
            <>Recorded before payments tracked money — read only</>
          )}
        </p>
        {occurrence && (canEditPayment(p) || canCancelPayment(p)) && (
          <div className="flex flex-wrap gap-1.5">
            {canEditPayment(p) && (
              <ClayButton size="sm" variant="secondary" onClick={() => onEdit(p, occurrence)}>
                Edit payment
              </ClayButton>
            )}
            {canCancelPayment(p) && (
              <ClayButton size="sm" variant="secondary" onClick={() => onCancel(p, occurrence)}>
                Cancel payment
              </ClayButton>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section aria-label="Payment history" className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Payment history</span>
      <div className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto pr-0.5">
        {cycles.map(({ occurrence, payments: ps }) => {
          const status = billOccurrenceStatus(occurrence);
          const open = !occurrence.isSkipped && occurrence.amountPaid < occurrence.amount;
          return (
            <div key={occurrence.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  Cycle due {day(occurrence.dueDate)}
                  {occurrence.id === currentOccurrenceId && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(current)</span>}
                </span>
                <ClayBadge tone={status === "paid" ? "success" : status === "overdue" ? "expense" : "neutral"}>{STATUS_LABEL[status]}</ClayBadge>
              </div>
              {ps.map((p) => paymentRow(p, occurrence))}
              {occurrence.id !== currentOccurrenceId && open && (
                <ClayButton size="sm" variant="secondary" className="self-start" onClick={() => onPay(occurrence)}>
                  Pay this cycle ({formatCurrency(occurrence.amount - occurrence.amountPaid)})
                </ClayButton>
              )}
            </div>
          );
        })}
        {orphans.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="font-medium text-foreground">Earlier payments (cycle not recorded)</span>
            {orphans.map((p) => paymentRow(p, null))}
          </div>
        )}
      </div>
    </section>
  );
}
