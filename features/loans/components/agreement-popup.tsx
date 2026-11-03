"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { StackBase } from "@/components/finance/stack-layer";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AmountDisplay, FilterTabs, InstallmentProgress, LE_RADIUS, Money, dueLabel, type DebtCardBadge } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

/**
 * The compact, centred details popup shared by a Loan and an EMI. A fixed-height popup (so it never grows the page):
 * identity and the outstanding balance with progress on top, then three tabs — Installments (the default: where Pay lives),
 * Details and History — that scroll inside it, and the actions pinned underneath. Every action opens as a stacked layer
 * beside it (see `stack-layer.tsx`); this component only lays things out and owns which tab is showing.
 *
 * Mount it only while there is a record to show — a fresh mount starts on Installments.
 */

type PopupTab = "schedule" | "details" | "history";

/** The one-line "next installment" / "fully paid" strip under the progress bar. */
export function NextStrip({ next, total, overdue }: { next: { dueDate: Date; amount: number; sequenceNumber: number } | null; total: number; overdue: boolean }) {
  if (!next) {
    return (
      <div className={cn(LE_RADIUS.card, "flex items-center gap-2 border border-success bg-card px-3 py-2")}>
        <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={1.75} />
        <span className="text-sm font-semibold text-foreground">Fully paid</span>
        <span className="text-xs text-muted-foreground">Every installment is settled.</span>
      </div>
    );
  }
  return (
    <div className={cn(LE_RADIUS.card, "flex items-center justify-between gap-3 border border-border bg-secondary px-3 py-2")}>
      <div className="flex min-w-0 flex-col">
        <span className={cn("truncate text-[11px] font-semibold", overdue ? "text-expense" : "text-muted-foreground")}>Next installment · {dueLabel(next.dueDate)}</span>
        <Money amount={next.amount} className="text-base text-foreground" />
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        #{next.sequenceNumber} of {total}
      </span>
    </div>
  );
}

export function AgreementPopup({
  open,
  onOpenChange,
  eyebrow,
  title,
  subtitle,
  badges,
  outstandingLabel,
  outstanding,
  paid,
  total,
  partial,
  strip,
  schedule,
  details,
  history,
  scheduleCount,
  historyCount,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Loan" / "EMI". */
  eyebrow: string;
  title: string;
  subtitle: string;
  badges: DebtCardBadge[];
  outstandingLabel: string;
  outstanding: number;
  paid: number;
  total: number;
  partial: number;
  /** Usually a `NextStrip`. Omitted for a closed record. */
  strip?: ReactNode;
  schedule: ReactNode;
  details: ReactNode;
  history: ReactNode;
  scheduleCount: number;
  historyCount: number;
  footer: ReactNode;
  testId?: string;
}) {
  const [tab, setTab] = useState<PopupTab>("schedule");
  return (
    <StackBase
      open={open}
      onOpenChange={onOpenChange}
      testId={testId}
      header={
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">{eyebrow}</span>
          <DialogTitle className="truncate font-heading text-base leading-tight font-semibold">{title}</DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">{subtitle}</DialogDescription>
        </div>
      }
      footer={footer}
    >
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{outstandingLabel}</span>
            <AmountDisplay amount={outstanding} />
          </div>
          {badges.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {badges.map((b) => (
                <ClayBadge key={b.label} tone={b.tone} className="rounded-[5px] font-semibold">
                  {b.label}
                </ClayBadge>
              ))}
            </div>
          )}
        </div>
        {total > 0 && <InstallmentProgress paid={paid} total={total} partial={partial} />}
        {strip}
      </div>

      <FilterTabs<PopupTab>
        ariaLabel="Sections"
        className="mx-4 mt-3 shrink-0"
        options={[
          { value: "schedule", label: "Installments", count: scheduleCount },
          { value: "details", label: "Details" },
          { value: "history", label: "History", count: historyCount },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div role="tabpanel" aria-label={tab === "schedule" ? "Installments" : tab === "details" ? "Details" : "Payment history"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {tab === "schedule" ? schedule : tab === "details" ? <div className="flex flex-col gap-4">{details}</div> : history}
      </div>
    </StackBase>
  );
}

/** The popup's pinned actions: the money actions (primary last), then the quieter record management under a rule. */
export function AgreementFooter({ note, money, manage }: { note?: string; money: ReactNode; manage: ReactNode }) {
  return (
    <div className="flex flex-col">
      {note && <p className="px-4 pt-2 text-xs text-muted-foreground">{note}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2.5">{money}</div>
      <div className="flex flex-wrap items-center gap-0.5 border-t border-border px-2.5 py-1">{manage}</div>
    </div>
  );
}
