"use client";

/**
 * Card activity sheet — the Bills, Transactions and Spending views. Presentation only: bill figures come from
 * the card's existing Pay Now scope and `cardBillsForCard` bills; transaction kinds from
 * `classifyCardTransaction` (structured fields only); every action calls a handler the workspace already had.
 */

import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CreditCard as CreditCardIcon,
  FileText,
  HandCoins,
  Landmark,
  MoreHorizontal,
  PieChart as PieChartIcon,
  Receipt,
  RotateCcw,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CardBill } from "@/lib/engines/card-cycle-bills";
import type { Transaction } from "@/lib/models/transaction";
import { statementWindowForDate } from "@/lib/repositories/credit-card-repository";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CreditCardViewItem } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { cardFaceGradient } from "@/features/credit-cards/components/credit-card-tile";
import {
  cardDueStatus,
  classifyCardTransaction,
  summarizeCardActivity,
  type CardBillBreakdown,
  type CardDueTone,
  type CardTxnKind,
  type FinancedPurchases,
} from "@/features/credit-cards/lib/card-usage-breakdown";

/* ───────────────────────── shared bits ───────────────────────── */

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

function dayIndex(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function daysFromToday(date: Date): number {
  return Math.round((dayIndex(date) - dayIndex(new Date())) / 86_400_000);
}
function shortDate(date: Date, year = true): string {
  return date.toLocaleDateString("en-IN", year ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}
function periodLabel(b: { periodStart: Date; periodEnd: Date }): string {
  return `${shortDate(b.periodStart, false)} – ${shortDate(b.periodEnd, false)}`;
}

export const DUE_TONE_CLASS: Record<CardDueTone, string> = {
  overdue: "bg-expense/12 text-expense ring-expense/25",
  soon: "bg-warning/18 text-warning-foreground ring-warning/40 dark:text-warning",
  upcoming: "bg-chart-2/12 text-chart-2 ring-chart-2/25",
  clear: "bg-success/12 text-success ring-success/25",
};

export function DuePill({ tone, label, className }: { tone: CardDueTone; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold ring-1 ring-inset", DUE_TONE_CLASS[tone], className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone === "overdue" && "animate-pulse")} />
      {label}
    </span>
  );
}

export function ActivityEmpty({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-foreground/55">
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {detail && <p className="mt-0.5 text-xs text-foreground/65">{detail}</p>}
      </div>
    </div>
  );
}

const BTN_PRIMARY =
  "flex h-10 items-center justify-center gap-1.5 rounded-[8px] border border-primary-accent-text bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-[0_6px_16px_-8px_rgba(0,0,0,0.35)] outline-none transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring";
const BTN_SECONDARY =
  "flex h-10 items-center rounded-[8px] border border-border-strong bg-card px-3.5 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring";
const BTN_GHOST =
  "flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-foreground/80 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/* ───────────────────────── Bills ───────────────────────── */

function billStatus(b: CardBill): { label: string; tone: CardDueTone | "muted" } {
  if (!b.isClosed) return { label: "Open cycle", tone: "upcoming" };
  if (b.totalAmount <= 0.005) return { label: b.totalAmount < -0.005 ? "Credit" : "No charges", tone: "muted" };
  if (b.remaining <= 0.005) return { label: "Paid", tone: "clear" };
  const overdue = dayIndex(b.dueDate) < dayIndex(new Date());
  if (b.amountPaid > 0.005) return { label: overdue ? "Part paid · overdue" : "Part paid", tone: overdue ? "overdue" : "soon" };
  return { label: overdue ? "Overdue" : "Unpaid", tone: overdue ? "overdue" : "soon" };
}

export function CardBillParts({ split }: { split: CardBillBreakdown | undefined }) {
  if (!split) return null;
  const amounts = split.remaining ?? split.billed;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs" data-testid="card-bill-parts">
      <p className="text-[11px] font-medium text-muted-foreground">{split.remaining ? "Remaining by type" : "Billed by type"}</p>
      <dl className="grid grid-cols-2 gap-x-3 tabular-nums">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <dt className="text-muted-foreground">Purchases</dt>
          <dd className="font-semibold text-foreground">{formatCurrencyExact(amounts.purchases)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <dt className="text-muted-foreground">Loan / EMI</dt>
          <dd className="font-semibold text-foreground">{formatCurrencyExact(amounts.loanEmi)}
            {split.remaining && split.billed.loanEmi > 0.005 && amounts.loanEmi <= 0.005 && (
              <span className="ml-1 font-medium text-success">Paid</span>
            )}
          </dd>
        </div>
      </dl>
      {!split.remaining && <p className="text-[11px] text-muted-foreground">Partial payment allocation is unavailable.</p>}
    </div>
  );
}

/**
 * The selected card's bill — what normal Pay bill pays (`statementPayment.current`), its dates, and every bill on
 * the card (paid and unpaid) from the existing bill list. The status comes from `cardDueStatus`, the same one the
 * tile, panel and header use, so "Due today" and "no bill due" can no longer disagree.
 */
export function CardBillsView({
  card,
  breakdowns,
  nextClose,
  onPayStatement,
  onPayFull,
  onHistory,
}: {
  card: CreditCardViewItem;
  breakdowns?: ReadonlyMap<string, CardBillBreakdown>;
  nextClose: Date;
  onPayStatement: () => void;
  onPayFull: () => void;
  onHistory: () => void;
}) {
  const scope = card.statementPayment;
  const bill = scope.current;
  const due = cardDueStatus(scope);
  const canPayFull = card.ownUsage > scope.statementDue + 0.005;
  const later = Math.round((scope.closedDue - scope.statementDue) * 100) / 100;
  const [showAll, setShowAll] = useState(false);
  const allBills = [...card.bills].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
  const bills = showAll ? allBills : allBills.slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* Amount + action — the thing to act on */}
        <div
          className={cn(
            "relative flex flex-col justify-between gap-4 overflow-hidden rounded-[14px] border p-5 shadow-e1",
            due.tone === "overdue" ? "border-expense/35 bg-expense/[0.05]" : bill ? "border-border-strong/60 bg-card" : "border-success/30 bg-success/[0.05]",
          )}
        >
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1" style={{ background: due.tone === "overdue" ? "var(--expense)" : bill ? cardFaceGradient(card) : "var(--success)" }} />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={LABEL}>{!bill ? "Nothing to pay" : bill.amountPaid > 0.005 ? "Remaining bill" : due.tone === "overdue" ? "Overdue bill" : "Bill amount"}</span>
                <DuePill tone={due.tone} label={due.label} />
              </div>
              <p className={cn("mt-2 text-[34px] leading-none font-bold tracking-tight tabular-nums", due.tone === "overdue" ? "text-expense" : "text-foreground")}>
                {formatCurrencyExact(bill ? scope.statementDue : 0)}
              </p>
              {bill && bill.amountPaid > 0.005 && (
                <p className="mt-1.5 text-xs font-medium text-foreground/80 tabular-nums" data-testid="card-bill-paid-summary">
                  Bill {formatCurrencyExact(bill.totalAmount)} · Paid <span className="font-semibold text-success">{formatCurrencyExact(bill.amountPaid)}</span> · Remaining{" "}
                  <span className="font-semibold text-foreground">{formatCurrencyExact(bill.remaining)}</span>
                </p>
              )}
              {!bill ? (
                <p className="mt-1.5 text-sm text-foreground/70">
                  You&apos;re all clear — no closed bill is unpaid.{" "}
                  {card.ownUsage > 0.005 ? (
                    <>
                      <span className="font-semibold text-foreground tabular-nums">{formatCurrency(card.ownUsage)}</span> spent since will be billed on {shortDate(nextClose, false)}.
                    </>
                  ) : (
                    "Nothing spent since the last statement."
                  )}
                </p>
              ) : (
                scope.cardOutstanding > scope.statementDue + 0.005 && (
                  <p className="mt-1 text-xs font-medium text-foreground/70 tabular-nums">of {formatCurrency(scope.cardOutstanding)} outstanding on this card</p>
                )
              )}
            </div>
          </div>
          {bill && <CardBillParts split={breakdowns?.get(bill.id)} />}
          <div className="flex flex-wrap items-center gap-2">
            {bill && (
              <button type="button" onClick={onPayStatement} className={BTN_PRIMARY}>
                <Wallet className="size-4" strokeWidth={2} />
                Pay bill {formatCurrencyExact(scope.statementDue)}
              </button>
            )}
            {canPayFull && (
              <button type="button" onClick={onPayFull} className={BTN_SECONDARY}>
                Pay full outstanding {formatCurrency(card.ownUsage)}
              </button>
            )}
            <button type="button" onClick={onHistory} className={cn(BTN_GHOST, "ml-auto")}>
              Statement history
              <ArrowRight className="size-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Dates — when it was billed, when it's due, when the next one closes */}
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border-strong/60 bg-border-strong/40 shadow-e1">
          {[
            { icon: FileText, label: "Statement", value: bill ? periodLabel(bill) : "—", hint: bill ? (bill.isMaterialized ? "Saved statement" : "Worked out from card days") : "No unpaid bill" },
            {
              icon: CalendarClock,
              label: "Payment due",
              value: bill ? shortDate(bill.dueDate) : "—",
              hint: bill ? due.label : "Nothing to pay",
              danger: due.tone === "overdue",
            },
            { icon: Receipt, label: "Minimum due", value: bill?.minimumDue != null ? formatCurrency(bill.minimumDue) : bill ? "Not tracked" : "—", hint: bill?.minimumDue != null ? "From the statement" : "Only on saved statements", muted: bill?.minimumDue == null },
            { icon: RotateCcw, label: "Next statement", value: shortDate(nextClose), hint: `${formatCurrency(scope.unbilled)} not billed yet` },
          ].map((m) => (
            <div key={m.label} className="flex min-w-0 flex-col gap-0.5 bg-card px-4 py-3">
              <dt className={cn(LABEL, "flex items-center gap-1.5")}>
                <m.icon className="size-3.5" strokeWidth={2} />
                {m.label}
              </dt>
              <dd className={cn("truncate text-[15px] font-bold tabular-nums", m.danger ? "text-expense" : m.muted ? "font-medium text-foreground/60" : "text-foreground")}>{m.value}</dd>
              <dd className="truncate text-[11px] text-muted-foreground tabular-nums">{m.hint}</dd>
            </div>
          ))}
        </dl>
      </div>

      {later > 0.005 && (
        <p className="rounded-[10px] bg-secondary/60 px-3.5 py-2 text-xs text-foreground/75 tabular-nums">
          <span className="font-semibold text-foreground">{formatCurrency(later)}</span> in later closed bills stays on the card — not part of this payment.
        </p>
      )}

      {/* Every bill on this card, newest first */}
      <section aria-label="Bills on this card" className="overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
        <div className="flex items-center justify-between gap-3 border-b border-border-strong/50 px-4 py-2.5">
          <p className="text-sm font-semibold text-foreground">
            Bills on this card <span className="ml-0.5 text-xs font-semibold text-muted-foreground tabular-nums">{allBills.length}</span>
          </p>
          {allBills.length > 5 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className={BTN_GHOST}>
              {showAll ? "Show recent" : `Show all ${allBills.length}`}
            </button>
          )}
        </div>
        {bills.length === 0 ? (
          <ActivityEmpty icon={FileText} title="No bills yet" detail="Bills appear once this card has charges." />
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <th className="px-4 py-2 font-semibold">Period</th>
                <th className="w-32 px-3 py-2 font-semibold">Due</th>
                <th className="w-32 px-3 py-2 text-right font-semibold">Bill</th>
                <th className="w-32 px-3 py-2 text-right font-semibold">Paid</th>
                <th className="w-36 px-4 py-2 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const st = billStatus(b);
                const isCurrent = b.id === bill?.id;
                const parts = breakdowns?.get(b.id)?.billed;
                return (
                  <tr key={b.id} className={cn("transition-colors hover:bg-secondary/40 [&>td]:border-t [&>td]:border-border-strong/35", isCurrent && "bg-primary/[0.07]")}>
                    <td className="truncate px-4 py-2 font-medium text-foreground tabular-nums">
                      {periodLabel(b)}
                      {isCurrent && <span className="ml-2 rounded-[4px] bg-primary/25 px-1.5 py-px text-[10px] font-bold text-primary-accent-text">PAY NOW</span>}
                      {parts && (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                          <span>Purchases {formatCurrencyExact(parts.purchases)}</span>
                          <span>Loan / EMI {formatCurrencyExact(parts.loanEmi)}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-foreground/80 tabular-nums">{shortDate(b.dueDate, false)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-foreground tabular-nums">{formatCurrencyExact(b.totalAmount)}</td>
                    <td className="px-3 py-2 text-right text-foreground/75 tabular-nums">{b.amountPaid > 0.005 ? formatCurrencyExact(b.amountPaid) : "—"}</td>
                    <td className="px-4 py-2 text-right">
                      {st.tone === "muted" ? (
                        <span className="text-xs font-medium text-muted-foreground">{st.label}</span>
                      ) : (
                        <DuePill tone={st.tone} label={b.isClosed && b.remaining > 0.005 && b.amountPaid <= 0.005 ? `${st.label} ${formatCurrency(b.remaining)}` : st.label} className="h-5 px-2 text-[10.5px]" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ───────────────────────── Transactions ───────────────────────── */

const KIND_META: Record<Exclude<CardTxnKind, "excluded">, { label: string; icon: LucideIcon; tone: string; incoming: boolean }> = {
  purchase: { label: "Purchase", icon: ShoppingBag, tone: "bg-chart-2/12 text-chart-2", incoming: false },
  loanEmi: { label: "Loan / EMI", icon: Landmark, tone: "bg-purple/12 text-purple", incoming: false },
  refund: { label: "Refund / credit", icon: ArrowDownLeft, tone: "bg-success/12 text-success", incoming: true },
  reimbursement: { label: "Reimbursement", icon: HandCoins, tone: "bg-success/12 text-success", incoming: true },
  payment: { label: "Bill payment", icon: CheckCircle2, tone: "bg-primary/20 text-primary-accent-text", incoming: true },
};

type TxnFilter = "all" | "spend" | "loanEmi" | "in";
const FILTERS: { value: TxnFilter; label: string; match: (k: CardTxnKind) => boolean }[] = [
  { value: "all", label: "All", match: () => true },
  { value: "spend", label: "Purchases", match: (k) => k === "purchase" },
  { value: "loanEmi", label: "Loan / EMI", match: (k) => k === "loanEmi" },
  { value: "in", label: "Payments & credits", match: (k) => k === "payment" || k === "refund" || k === "reimbursement" },
];

function dayLabel(date: Date): string {
  const d = daysFromToday(date);
  if (d === 0) return "Today";
  if (d === -1) return "Yesterday";
  return shortDate(date);
}

export interface ActivityTxnRow {
  transaction: Transaction;
  card: CreditCardViewItem | undefined;
}

export function CardTransactionsView({
  rows,
  showCard,
  financed,
  categoryName,
  loading,
  fullHistoryLabel,
  onFullHistory,
  onCancelPayment,
  onViewHistory,
}: {
  /** Newest first, every live transaction on the card(s) in scope. */
  rows: ActivityTxnRow[];
  showCard: boolean;
  financed: FinancedPurchases;
  categoryName: (id: string) => string | null;
  loading: boolean;
  fullHistoryLabel: string;
  onFullHistory: () => void;
  onCancelPayment: (transactionId: string) => void;
  onViewHistory: (accountId: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [filter, setFilter] = useState<TxnFilter>("all");
  const [limit, setLimit] = useState(12);
  const classified = useMemo(
    () => rows.map((r) => ({ ...r, kind: classifyCardTransaction(r.transaction, financed).kind })).filter((r) => r.kind !== "excluded"),
    [rows, financed],
  );
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, classified.filter((r) => f.match(r.kind)).length])), [classified]);
  const pool = classified.filter((r) => FILTERS.find((f) => f.value === filter)!.match(r.kind));
  const shown = pool.slice(0, limit);
  const groups = shown.reduce<{ day: string; items: typeof shown }[]>((acc, r) => {
    const day = dayLabel(r.transaction.dateTime);
    const last = acc[acc.length - 1];
    if (last && last.day === day) last.items.push(r);
    else acc.push({ day, items: [r] });
    return acc;
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="radiogroup" aria-label="Filter transactions" className="mr-auto flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const selected = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setFilter(f.value);
                  setLimit(12);
                }}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-foreground bg-foreground text-background" : "border-border-strong/70 bg-card text-foreground/75 hover:bg-secondary hover:text-foreground",
                )}
              >
                {f.label}
                <span className={cn("tabular-nums", selected ? "text-background/70" : "text-muted-foreground")}>{counts[f.value]}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-foreground/60 tabular-nums">
          {pool.length > shown.length ? `Showing latest ${shown.length} of ${pool.length}` : `${shown.length} transaction${shown.length === 1 ? "" : "s"}`}
        </p>
        <button type="button" onClick={onFullHistory} className="group flex h-8 items-center gap-1.5 rounded-full border border-border-strong/70 bg-card px-3 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          {fullHistoryLabel}
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border-strong/70 bg-card">
          <ActivityEmpty
            icon={Receipt}
            title={loading ? "Loading transactions…" : filter === "all" ? "No transactions on this card yet" : "Nothing of this kind"}
            detail={loading ? undefined : "Older or filtered transactions are in the full history."}
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h3 className="flex items-center gap-2 border-b border-border-strong/35 bg-secondary/70 px-4 py-1 text-[10.5px] font-semibold tracking-[0.08em] text-foreground/60 uppercase">
                {g.day}
                <span className="font-medium tracking-normal normal-case text-foreground/45">· {g.items.length}</span>
              </h3>
              <ul className="divide-y divide-border-strong/30">
                {g.items.map((r, i) => {
                  const meta = KIND_META[r.kind as Exclude<CardTxnKind, "excluded">];
                  const t = r.transaction;
                  const cat = r.kind === "purchase" ? categoryName(t.categoryId) : null;
                  const movedOut = r.kind === "purchase" && t.transferId != null;
                  return (
                    <motion.li
                      key={t.id}
                      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i, 8) * 0.02 }}
                      className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-secondary/40"
                    >
                      <span className="relative shrink-0">
                        <span className={cn("flex size-8 items-center justify-center rounded-[10px]", meta.tone)}>
                          {movedOut ? <ArrowUpRight className="size-4" strokeWidth={2} /> : <meta.icon className="size-4" strokeWidth={2} />}
                        </span>
                        {showCard && r.card && (
                          <span aria-hidden className="absolute -right-1 -bottom-1 h-2.5 w-4 rounded-[3px] ring-2 ring-card" style={{ background: cardFaceGradient(r.card) }} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{t.description || meta.label}</p>
                        <p className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground/70">{movedOut ? "Money moved out" : meta.label}</span>
                          {cat && <span className="truncate">· {cat}</span>}
                          {showCard && r.card && (
                            <span className="inline-flex min-w-0 items-center gap-1 truncate">
                              · <CreditCardIcon className="size-3 shrink-0" strokeWidth={2} />
                              {r.card.name} •••• {r.card.last4}
                            </span>
                          )}
                        </p>
                      </div>
                      <span className={cn("shrink-0 text-sm font-bold whitespace-nowrap tabular-nums", meta.incoming ? "text-success" : "text-foreground")}>
                        {meta.incoming ? "+" : "−"}
                        {formatCurrency(t.amount)}
                      </span>
                      {r.kind === "payment" ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label="Payment actions"
                              className="flex size-7 shrink-0 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary"
                            >
                              <MoreHorizontal className="size-4" strokeWidth={1.75} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-52 rounded-[8px]">
                            <DropdownMenuItem className="text-expense" onSelect={() => onCancelPayment(t.id)}>
                              Cancel recorded payment
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onViewHistory(t.accountId)}>View history</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span aria-hidden className="size-7 shrink-0" />
                      )}
                    </motion.li>
                  );
                })}
              </ul>
            </section>
          ))}
          {pool.length > shown.length && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + 20)}
              className="flex h-10 w-full items-center justify-center border-t border-border-strong/40 text-xs font-semibold text-foreground/75 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              Show {Math.min(20, pool.length - shown.length)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Spending ───────────────────────── */

type SpendPeriod = "cycle" | "last" | "all";
const CATEGORY_COLORS = ["var(--chart-2)", "var(--chart-4)", "var(--chart-3)", "var(--chart-5)", "var(--chart-1)"];

/**
 * Where this card's money went. "Card spending" = purchases + Loan/EMI charges (gross). Bill payments, refunds and
 * reimbursements are money coming IN — shown beside it, never inside the spending total (the old chart summed
 * every transaction, so a ₹12,000 payment read as ₹12,000 "spent").
 */
export function CardSpendingView({
  card,
  transactions,
  financed,
  categoryName,
}: {
  card: CreditCardViewItem;
  transactions: Transaction[];
  financed: FinancedPurchases;
  categoryName: (id: string) => string | null;
}) {
  const [period, setPeriod] = useState<SpendPeriod>("all");
  const ranges = useMemo(() => {
    const now = new Date();
    const cycle = statementWindowForDate(card.card, now);
    const prev = statementWindowForDate(card.card, new Date(cycle.periodStart.getTime() - 86_400_000));
    return {
      cycle: { start: cycle.periodStart, end: cycle.periodEnd },
      last: { start: prev.periodStart, end: prev.periodEnd },
      all: null,
    } as const;
  }, [card.card]);
  const s = useMemo(() => summarizeCardActivity(transactions, financed, ranges[period]), [transactions, financed, ranges, period]);
  const spend = Math.round((s.purchases + s.loanEmi) * 100) / 100;
  const moneyIn = s.payments + s.refunds + s.reimbursements;

  const top = s.purchasesByCategory.slice(0, 5);
  const otherAmount = s.purchasesByCategory.slice(5).reduce((x, c) => x + c.amount, 0);
  const slices = [
    ...top.map((c, i) => ({ key: c.categoryId, label: categoryName(c.categoryId) ?? "Uncategorised", amount: c.amount, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]! })),
    ...(otherAmount > 0 ? [{ key: "__other", label: "Other categories", amount: otherAmount, color: "var(--muted-foreground)" }] : []),
    ...(s.loanEmi > 0 ? [{ key: "__emi", label: "Loan / EMI charges", amount: s.loanEmi, color: "var(--purple)" }] : []),
  ];
  const [hover, setHover] = useState<string | null>(null);
  const rangeLabel = period === "all" ? "All time" : `${shortDate(ranges[period]!.start, false)} – ${shortDate(ranges[period]!.end, false)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Spending period" className="flex items-center rounded-full bg-secondary p-0.5">
          {(
            [
              { value: "cycle", label: "This cycle" },
              { value: "last", label: "Last statement" },
              { value: "all", label: "All time" },
            ] as const
          ).map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={period === p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                "h-8 rounded-full px-3.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                period === p.value ? "bg-card font-semibold text-foreground shadow-[0_1px_4px_-1px_rgba(0,0,0,0.2)]" : "font-medium text-foreground/65 hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{rangeLabel}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Spending composition */}
        <section aria-label="Spending summary" className="rounded-[14px] border border-border-strong/60 bg-card p-5 shadow-e1">
          {spend <= 0 ? (
            <ActivityEmpty icon={PieChartIcon} title="No spending in this period" detail={`Purchases and EMI charges on ${card.name} will be grouped here.`} />
          ) : (
            <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-center gap-6">
              <div className="relative size-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={slices} dataKey="amount" nameKey="label" innerRadius="72%" outerRadius="100%" paddingAngle={slices.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
                      {slices.map((sl) => (
                        <Cell key={sl.key} fill={sl.color} opacity={hover && hover !== sl.key ? 0.3 : 1} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[10px] font-semibold tracking-[0.08em] text-foreground/60 uppercase">Card spending</span>
                  <span className="text-xl font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(spend)}</span>
                </div>
              </div>
              <ul className="flex min-w-0 flex-col gap-1">
                {slices.map((sl) => {
                  const pct = Math.round((sl.amount / spend) * 1000) / 10;
                  return (
                    <li
                      key={sl.key}
                      onPointerEnter={() => setHover(sl.key)}
                      onPointerLeave={() => setHover(null)}
                      className={cn("flex flex-col gap-1 rounded-[8px] px-2.5 py-1.5 transition-colors hover:bg-secondary/60", hover && hover !== sl.key && "opacity-60")}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: sl.color }} />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{sl.label}</span>
                        <span className="shrink-0 font-bold text-foreground tabular-nums">{formatCurrency(sl.amount)}</span>
                        <span className="w-11 shrink-0 text-right text-[11px] font-semibold text-muted-foreground tabular-nums">{pct}%</span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: sl.color }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {/* What came in — never spending */}
        <section aria-label="Money in" className="flex flex-col rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
          <div className="border-b border-border-strong/50 px-4 py-2.5">
            <p className="text-sm font-semibold text-foreground">Money in · not spending</p>
            <p className="text-[11px] text-muted-foreground">Lowers what the card owes; never counted as spending.</p>
          </div>
          <dl className="flex flex-1 flex-col divide-y divide-border-strong/35">
            {[
              { icon: CheckCircle2, tone: "bg-primary/20 text-primary-accent-text", label: "Bill payments", value: s.payments },
              { icon: ArrowDownLeft, tone: "bg-success/12 text-success", label: "Refunds & credits", value: s.refunds },
              { icon: HandCoins, tone: "bg-success/12 text-success", label: "Reimbursements", value: s.reimbursements },
            ].map((m) => (
              <div key={m.label} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px]", m.tone)}>
                  <m.icon className="size-4" strokeWidth={2} />
                </span>
                <dt className="min-w-0 flex-1 truncate text-sm text-foreground/80">{m.label}</dt>
                <dd className={cn("shrink-0 text-sm font-bold tabular-nums", m.value > 0 ? "text-success" : "text-muted-foreground")}>{formatCurrency(m.value)}</dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center justify-between gap-2 border-t border-border-strong/50 bg-secondary/40 px-4 py-2 text-xs">
            <span className="text-foreground/70">Spent {formatCurrency(spend)} · in {formatCurrency(moneyIn)}</span>
            <span className="font-semibold text-foreground tabular-nums">
              Net {spend - moneyIn >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(spend - moneyIn))}
            </span>
          </div>
        </section>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Card spending counts purchases and Loan/EMI charges once each. Bill payments, refunds and reimbursements reduce the card balance and are shown separately.
      </p>
    </div>
  );
}
