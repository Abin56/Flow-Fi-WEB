"use client";

import { HISTORICAL_PAYMENT_LABEL, historicalPaymentExplanation } from "@/features/loans/lib/historical-payment";
import type { InstallmentPeopleStatus } from "@/features/loans/hooks/use-installment-people-status";
import { ArrowRight, Check, ChevronRight, Receipt, RotateCcw, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ContextPanel } from "@/components/finance/context-panel";
import { LE_RADIUS, Money, dueLabel } from "@/features/loans/components/loan-emi-ui";
import {
  editEligibility,
  installmentRangeLabel,
  installmentRowAction,
  paymentTypeLabel,
  type RecordedPaymentAction,
} from "@/features/loans/lib/recorded-payments";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import { installmentStatus, remainingAmount, type Installment, type InstallmentStatus } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

/**
 * Installment schedule and payment history for the Loan & EMI details views.
 *
 * The schedule is a compact card grid. Each card shows the installment number and month, the amount (the biggest
 * figure), the due / paid date and a Paid · Partly paid · Overdue · Upcoming status. What a card does is explicit:
 *   - the card itself opens its Installment details (a `ContextPanel` beside it: due date, principal / interest,
 *     paid / left, where it was paid from, who shares it) — with Pay and the recorded payment one tap away there;
 *   - still owed (upcoming / overdue / partly paid) → a "Pay" button on the card, the existing Record Payment flow;
 *   - has a recorded payment → a "Details" / "Edit" button opening that payment, where it can be edited or marked unpaid.
 * Nothing here writes data: every action goes through the caller's handlers.
 */

const STATUS_TEXT: Record<InstallmentStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partly paid",
  overdue: "Overdue",
  skipped: "Skipped",
  upcoming: "Upcoming",
};

const STATUS_PILL: Record<InstallmentStatus, string> = {
  paid: "bg-success/12 text-[oklch(0.44_0.13_149)] dark:text-success",
  partiallyPaid: "bg-warning/20 text-warning-foreground dark:text-warning",
  overdue: "bg-expense/10 text-expense",
  skipped: "bg-muted text-muted-foreground",
  upcoming: "bg-secondary text-muted-foreground",
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

/** "5 Oct 2026" on a card — the month and year are part of the date line. */
function dayMonth(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** "Paid" / "Overdue" / … — a small tinted pill. */
function StatusPill({ status }: { status: InstallmentStatus }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap", STATUS_PILL[status])}>
      {status === "paid" && <Check className="size-3" strokeWidth={2.75} aria-hidden />}
      {STATUS_TEXT[status]}
    </span>
  );
}

const CARD_ACTION =
  "inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-[6px] border px-2 text-[11.5px] font-semibold outline-none transition-[background-color,border-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring";

function PayButton({ emphasized, onClick, label }: { emphasized: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        CARD_ACTION,
        "group/pay flex-1",
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

/** One label / value line of the Installment details panel. */
function DetailLine({ label, children, tone }: { label: string; children: ReactNode; tone?: "expense" | "success" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right font-semibold [overflow-wrap:anywhere]", tone === "expense" ? "text-expense" : tone === "success" ? "text-success" : "text-foreground")}>{children}</dd>
    </div>
  );
}

type InstallmentScope = "all" | "upcoming";

/**
 * The installment schedule as a compact grid. `scope="upcoming"` shows only what is still owed (in order); `limit`
 * caps the cards (the Overview's "Coming up"). A schedule spanning several years is grouped by year.
 */
export function InstallmentList({
  installments,
  total,
  closed,
  actions,
  onPay,
  onViewPayment,
  fallbackSourceLabel,
  lent = false,
  peopleStatus,
  scope = "all",
  limit,
}: {
  /**
   * Shared Loan / EMI: each installment's People side ("Priya: ₹1,000 to receive"), shown under the lender status —
   * the two are separate (paying the lender never marks a person as paid).
   */
  peopleStatus?: ReadonlyMap<string, InstallmentPeopleStatus>;
  installments: Installment[];
  total: number;
  closed: boolean;
  actions: RecordedPaymentAction[];
  onPay: (installment: Installment) => void;
  onViewPayment: (action: RecordedPaymentAction) => void;
  /** Shown as "from …" when a payment has no account of its own (e.g. an EMI paid on a credit card). */
  fallbackSourceLabel?: string | null;
  /** A Loan I gave — a paid-earlier repayment says "no account credit" instead of "no account debit". */
  lent?: boolean;
  scope?: InstallmentScope;
  limit?: number;
}) {
  const { data: accounts = [] } = useAccounts();
  const { data: transactions = [] } = useTransactions();
  const accountNameByTxn = useMemo(() => {
    // "HDFC Savings ••1234" — the last 4 digits tell apart two accounts at the same bank.
    const names = new Map(accounts.map((a) => [a.id, a.accountNumberLast4 ? `${a.name} ••${a.accountNumberLast4}` : a.name]));
    const byTxn = new Map<string, string>();
    for (const t of transactions) {
      const name = t.accountId ? names.get(t.accountId) : undefined;
      if (name) byTxn.set(t.id, name);
    }
    return byTxn;
  }, [accounts, transactions]);
  // The one card whose details panel is open.
  const [openId, setOpenId] = useState<string | null>(null);
  const upcoming = installments.filter((i) => !i.isSkipped && remainingAmount(i) > 0);
  const pool = scope === "upcoming" ? upcoming : installments;
  const shown = limit != null ? pool.slice(0, limit) : pool;
  // The one installment to pay next gets the filled "Pay" — overdue ones always do.
  const nextDueId = closed ? null : (upcoming[0]?.id ?? null);

  if (shown.length === 0) {
    return (
      <p className={cn(LE_RADIUS.card, "border border-dashed border-border px-3.5 py-4 text-xs text-muted-foreground")}>
        {scope === "upcoming" ? "Nothing left to pay." : "No installments yet."}
      </p>
    );
  }

  const years = [...new Set(shown.map((i) => i.dueDate.getFullYear()))];
  const groups = limit == null && years.length > 1 ? years.map((year) => ({ year, items: shown.filter((i) => i.dueDate.getFullYear() === year) })) : [{ year: null, items: shown }];
  const counts =
    scope === "all" && limit == null
      ? shown.reduce<Record<InstallmentStatus, number>>(
          (c, i) => {
            c[installmentStatus(i)] += 1;
            return c;
          },
          { paid: 0, partiallyPaid: 0, overdue: 0, skipped: 0, upcoming: 0 },
        )
      : null;

  const card = (i: Installment) => {
    const status = installmentStatus(i);
    const rowAction = installmentRowAction(i, actions, closed);
    const recorded = rowAction?.kind === "view" ? rowAction.action : null;
    // The latest payment can be edited / marked unpaid directly; an older one opens its details (where it
    // can be marked unpaid together with the later payments).
    const editable = recorded != null && editEligibility(recorded, actions, { closed }).ok;
    const remaining = remainingAmount(i);
    const paidFrom = recorded ? ((recorded.transactionId ? accountNameByTxn.get(recorded.transactionId) : null) ?? fallbackSourceLabel ?? null) : null;
    const canPay = !closed && !i.isSkipped && remaining > 0;
    // A payment recorded as "already paid earlier" never moved an account, so it must not read "from <account>".
    const earlier = recorded?.recordedEarlier ?? null;
    const people = peopleStatus?.get(i.id) ?? null;
    const monthLong = i.dueDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const dateLine =
      status === "paid"
        ? recorded
          ? earlier && !earlier.dateKnown
            ? "Paid · date not known"
            : `Paid ${dayMonth(recorded.date)}`
          : `Due ${dayMonth(i.dueDate)}`
        : status === "partiallyPaid"
          ? `${formatCurrency(remaining)} left`
          : status === "skipped"
            ? `Was due ${dayMonth(i.dueDate)}`
            : status === "overdue"
              ? `Was due ${dayMonth(i.dueDate)}`
              : `Due ${dayMonth(i.dueDate)}`;
    const emphasized = status === "overdue" || i.id === nextDueId;
    const viewPayment = (action: RecordedPaymentAction) => {
      setOpenId(null);
      onViewPayment(action);
    };

    return (
      <li
        key={i.id}
        className={cn(
          LE_RADIUS.card,
          "flex min-w-0 flex-col border bg-card transition-colors duration-150",
          status === "overdue" ? "border-expense/45" : i.id === nextDueId ? "border-primary-accent-text" : "border-border",
          openId === i.id && "ring-2 ring-ring/50",
        )}
        data-testid={`installment-card-${i.sequenceNumber}`}
      >
        <ContextPanel
          open={openId === i.id}
          onOpenChange={(o) => setOpenId(o ? i.id : null)}
          width="sm"
          testId={`installment-details-${i.sequenceNumber}`}
          title={`Installment ${i.sequenceNumber}${total > 0 ? ` of ${total}` : ""}`}
          description={`${monthLong} · ${STATUS_TEXT[status]}`}
          onApply={canPay ? () => onPay(i) : undefined}
          applyLabel={lent ? `Record ${formatCurrency(remaining)}` : `Pay ${formatCurrency(remaining)}`}
          cancelLabel="Close"
          trigger={
            <button
              type="button"
              aria-label={`Installment ${i.sequenceNumber}, ${monthLong}: show details`}
              className={cn(
                "flex min-w-0 flex-1 flex-col gap-1 rounded-t-[7px] px-2.5 pt-2 pb-1.5 text-left outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                !canPay && !recorded && "rounded-b-[7px]",
              )}
            >
              <span className="flex min-w-0 items-center justify-between gap-1.5">
                <span className="shrink-0 text-xs font-bold text-foreground tabular-nums">
                  #{i.sequenceNumber}
                  {total > 0 && <span className="font-medium text-muted-foreground"> / {total}</span>}
                </span>
                <StatusPill status={status} />
              </span>
              <Money amount={i.amountDue} className={cn("text-[17px] leading-tight", status === "skipped" ? "text-muted-foreground line-through decoration-1" : "text-foreground")} />
              <span className={cn("truncate text-[11px]", status === "overdue" ? "font-semibold text-expense" : "text-muted-foreground")}>{dateLine}</span>
              {people && (
                <span
                  className={cn("truncate text-[11px]", people.tone === "received" ? "text-success" : "text-settle-receivable-text")}
                  data-testid={`installment-people-${i.sequenceNumber}`}
                  title={`${people.text} — people's shares are separate from the lender payment`}
                >
                  {people.text}
                </span>
              )}
            </button>
          }
        >
          <dl className="flex flex-col divide-y divide-border">
            <DetailLine label={status === "paid" ? "Was due" : "Due date"} tone={status === "overdue" ? "expense" : undefined}>
              {shortDate(i.dueDate)}
              {canPay && <span className="block text-[11px] font-medium">{dueLabel(i.dueDate)}</span>}
            </DetailLine>
            <DetailLine label="Installment amount">
              <Money exact amount={i.amountDue} className="text-sm" />
            </DetailLine>
            {i.principalPortion != null && (
              <DetailLine label="Principal part">
                <Money exact amount={i.principalPortion} className="text-xs" />
              </DetailLine>
            )}
            {i.interestPortion != null && (
              <DetailLine label="Interest part">
                <Money exact amount={i.interestPortion} className="text-xs" />
              </DetailLine>
            )}
            {i.amountPaid > 0 && (
              <DetailLine label={lent ? "Received" : "Paid"} tone="success">
                <Money exact amount={Math.min(i.amountPaid, i.amountDue)} className="text-xs" />
              </DetailLine>
            )}
            {remaining > 0 && !i.isSkipped && (
              <DetailLine label="Still to pay" tone={status === "overdue" ? "expense" : undefined}>
                <Money exact amount={remaining} className="text-xs" />
              </DetailLine>
            )}
            {recorded && (
              <DetailLine label={lent ? "Received on" : "Paid on"}>
                {earlier && !earlier.dateKnown ? "Date not known" : shortDate(recorded.date)}
                {earlier ? (
                  <span className="block text-[11px] font-medium text-muted-foreground">
                    {HISTORICAL_PAYMENT_LABEL.toLowerCase()} — {lent ? "no account credit" : "no account debit"}
                  </span>
                ) : (
                  paidFrom && <span className="block text-[11px] font-medium text-muted-foreground">from {paidFrom}</span>
                )}
              </DetailLine>
            )}
            {people && (
              <DetailLine label="People">
                <span className={people.tone === "received" ? "text-success" : "text-settle-receivable-text"}>{people.text}</span>
                <span className="block text-[11px] font-medium text-muted-foreground">Separate from the lender payment</span>
              </DetailLine>
            )}
          </dl>
          {recorded && (
            <button
              type="button"
              onClick={() => viewPayment(recorded)}
              className={cn(CARD_ACTION, "mt-2.5 h-8 w-full border-border-strong bg-card text-foreground hover:bg-secondary")}
            >
              <Receipt className="size-3.5" strokeWidth={1.75} />
              {editable ? "Edit payment or mark unpaid" : "Open payment details"}
            </button>
          )}
          {!canPay && !recorded && <p className="mt-2 text-[11px] text-muted-foreground">{closed ? "Closed — reopen it to record payments." : "Nothing to pay for this installment."}</p>}
        </ContextPanel>
        {(canPay || recorded) && (
          <div className="flex items-center gap-1.5 px-2.5 pt-0.5 pb-2.5">
            {canPay && <PayButton emphasized={emphasized} onClick={() => onPay(i)} label={`Pay installment ${i.sequenceNumber}, ${formatCurrency(remaining)}`} />}
            {recorded && (
              <button
                type="button"
                onClick={() => onViewPayment(recorded)}
                aria-label={`Installment ${i.sequenceNumber} for ${monthLong}: ${editable ? "edit or mark unpaid" : "view payment details"}`}
                title={editable ? "Edit or mark unpaid" : "Payment details"}
                className={cn(CARD_ACTION, "border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground", canPay ? "w-8 shrink-0 px-0" : "flex-1")}
              >
                <Receipt className="size-3.5" strokeWidth={1.75} />
                {!canPay && (editable ? "Edit" : "Details")}
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {counts && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground" data-testid="installment-counts">
          <span>
            <span className="font-semibold text-foreground tabular-nums">{shown.length}</span> installments
          </span>
          {counts.paid > 0 && <span className="text-[oklch(0.44_0.13_149)] dark:text-success">{counts.paid} paid</span>}
          {counts.partiallyPaid > 0 && <span className="text-warning-foreground dark:text-warning">{counts.partiallyPaid} partly paid</span>}
          {counts.overdue > 0 && <span className="font-semibold text-expense">{counts.overdue} overdue</span>}
          {counts.upcoming > 0 && <span>{counts.upcoming} upcoming</span>}
          {counts.skipped > 0 && <span>{counts.skipped} skipped</span>}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.year ?? "all"} aria-label={g.year != null ? `Installments in ${g.year}` : "Installments"} className="flex flex-col gap-1.5">
          {g.year != null && <h4 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{g.year}</h4>}
          <ul className="grid grid-cols-2 gap-2 @[25rem]:grid-cols-3 @[42rem]:grid-cols-4">{g.items.map(card)}</ul>
        </section>
      ))}
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
  lent = false,
  onOpen,
}: {
  /** A Loan I gave — repayments are money received, so the historical note says "credit", not "debit". */
  lent?: boolean;
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
        const earlierMark = item.kind === "action" ? item.action.recordedEarlier : null;
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
                {earlierMark && (
                  <ClayBadge tone="neutral" className="rounded-[4px] px-1.5 py-0 text-[10.5px] font-medium" title={historicalPaymentExplanation(lent)}>
                    {HISTORICAL_PAYMENT_LABEL}
                  </ClayBadge>
                )}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {earlierMark && !earlierMark.dateKnown ? "Date not known" : item.date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                {detail ? ` · ${detail}` : ""}
                {earlierMark ? ` · ${lent ? "no account credit" : "no account debit"} recorded` : ""}
              </span>
            </span>
            <Money exact amount={amount} className={cn("text-sm font-semibold", reversed ? "text-muted-foreground" : "text-foreground")} />
            {item.kind === "action" && !reversed && <OpenHint label="View" />}
          </>
        );
        const key = item.kind === "action" ? item.action.id : item.extra.id;
        return (
          <li key={key}>
            {item.kind === "action" && !reversed ? (
              <button type="button" className={cn(ROW, ACTIONABLE)} onClick={() => onOpen(item.action)} aria-label={`${title}, ${formatCurrencyExact(amount)}: view payment`}>
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
