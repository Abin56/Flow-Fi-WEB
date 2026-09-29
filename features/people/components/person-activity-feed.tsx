"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  HandCoins,
  Landmark,
  Maximize2,
  Plus,
  Scale,
  Search,
  Split,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import {
  EntryEditForm,
  EntrySettleForm,
  type EntryEditValues,
  InlineReveal,
  lastPaymentLine,
  LEDGER_TD,
  LEDGER_TH,
  LEDGER_TYPE_SHORT,
  LoanPayLink,
  PaymentHistory,
  RowActionsMenu,
  type EntrySettleValues,
} from "@/features/people/components/workspace/ledger-ui";
import {
  DIRECTION_LABEL,
  filterLedgerRows,
  groupByMonth,
  sequence,
  type LedgerRow,
  type LedgerRowDirection,
  type PaymentRecord,
} from "@/features/people/lib/person-ledger-rows";
import { directionHeadline, directionOf, formatStatementDate, type EmiRowStatus } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { WS_SECONDARY } from "@/features/people/components/workspace/person-workspace-ui";

/**
 * One restrained direction system: the icon tile carries the direction (towards me = positive,
 * my obligation = negative/warning, settlements & neutral = grey, EMI = accent), and every row states
 * the same in words ("They owe you" / "You owe them" / "They paid you") under its amount, so meaning
 * never depends on colour or on a +/− sign.
 */
type Tone = "in" | "out" | "neutral" | "emi";

const TONE_TILE: Record<Tone, string> = {
  in: "bg-success/12 text-success",
  out: "bg-expense/10 text-expense",
  neutral: "bg-secondary text-muted-foreground",
  emi: "bg-primary/25 text-primary-accent-text",
};

export const DIRECTION_TEXT: Record<LedgerRowDirection, string> = {
  theyOwe: "text-success",
  iOwe: "text-expense",
  theyPaid: "text-muted-foreground",
  youPaid: "text-muted-foreground",
  loan: "text-muted-foreground",
};

export function rowVisual(row: LedgerRow): { icon: LucideIcon; tone: Tone } {
  switch (row.category) {
    case "gave":
      return { icon: ArrowUpRight, tone: "in" };
    case "borrowed":
      return { icon: ArrowDownLeft, tone: "out" };
    case "received":
    case "repaid":
      return { icon: HandCoins, tone: "neutral" };
    case "split":
      return { icon: Split, tone: row.direction === "iOwe" ? "out" : "in" };
    case "emi":
      return { icon: CalendarClock, tone: "emi" };
    case "loan":
      return { icon: Landmark, tone: "neutral" };
    default:
      return { icon: Scale, tone: "neutral" };
  }
}

export function RowIcon({ row, className }: { row: LedgerRow; className?: string }) {
  const { icon: Icon, tone } = rowVisual(row);
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", TONE_TILE[tone], className)}>
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}

/**
 * Amount colour by what the row means for the balance: receivable → the positive treatment, my debt →
 * the expense treatment, settlements/loans neutral; a settled obligation steps back. The words next to
 * it always carry the meaning — colour only supports it.
 */
export function amountTone(row: LedgerRow): string {
  if (row.state === "settled") return "text-foreground/70";
  if (row.category === "loan" && row.state == null) return "text-foreground/70"; // Loan principal: context only
  if (row.direction === "theyOwe") return "text-success";
  if (row.direction === "iOwe") return "text-expense";
  return "text-foreground";
}

/**
 * Human-readable state, derived only from the row's existing direction and settlement state:
 * receivable & unsettled → "Awaiting payment", my debt & unsettled → "To pay", partly settled →
 * "Partially settled" + what remains, settled → "Settled". Rows without a settlement state (payments,
 * EMI, adjustments, Loans) say what they mean instead.
 */
function rowStatus(row: LedgerRow): { label: string; detail: string | null; dot: string; icon?: "check"; alert?: boolean } {
  if (row.category === "loan") {
    // A Loan installment's state comes straight from its schedule installment (paid/partial/unpaid,
    // overdue by due date). The Loan's creation row is context only — its principal is never "due".
    if (row.state == null) return { label: row.direction === "theyOwe" ? "Loan I Gave" : "Loan I Took", detail: "Repaid via installments", dot: "bg-muted-foreground/50" };
    const who = row.direction === "iOwe" ? "You owe them" : "They owe you";
    if (row.state === "settled") return { label: "Paid", detail: lastPaymentLine(row), dot: "bg-success", icon: "check" };
    if (row.overdue)
      return { label: "Overdue", detail: row.state === "partial" ? `${money(row.remaining ?? 0)} left · ${who}` : who, dot: "bg-expense", alert: true };
    if (row.state === "partial") return { label: "Partial", detail: `${money(row.remaining ?? 0)} left · ${who}`, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
    return { label: "Pending", detail: who, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
  }
  if (row.state === "settled") return { label: "Settled", detail: lastPaymentLine(row), dot: "bg-success", icon: "check" };
  if (row.state === "partial")
    return { label: "Partially settled", detail: `${money(row.remaining ?? 0)} remaining`, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
  if (row.state === "open")
    return row.direction === "iOwe"
      ? { label: "To pay", detail: "You owe them", dot: "bg-expense" }
      : { label: "Awaiting payment", detail: "They owe you", dot: "bg-success" };
  if (row.direction === "theyPaid" || row.direction === "youPaid") return { label: DIRECTION_LABEL[row.direction], detail: "Settlement", dot: "bg-muted-foreground/50" };
  if (row.direction === "loan") return { label: "Via loan", detail: "Settled from the Loan", dot: "bg-muted-foreground/50" };
  return { label: DIRECTION_LABEL[row.direction], detail: null, dot: row.direction === "iOwe" ? "bg-expense" : "bg-success" };
}

export function StatusCell({ row }: { row: LedgerRow }) {
  const s = rowStatus(row);
  return (
    <div className="flex min-w-0 items-start gap-2">
      {s.icon === "check" ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden />
      ) : (
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", s.dot)} aria-hidden />
      )}
      <div className="min-w-0">
        <p
          className={cn(
            "text-[13px] leading-tight font-semibold whitespace-nowrap",
            s.icon === "check" ? "text-success" : s.alert ? "text-expense uppercase tracking-wide text-[12px]" : "text-foreground",
          )}
        >
          {s.label}
        </p>
        {s.detail && <p className="mt-0.5 text-xs leading-tight whitespace-nowrap text-muted-foreground">{s.detail}</p>}
      </div>
    </div>
  );
}

export const EMI_STATUS: Record<EmiRowStatus, string> = {
  upcoming: "Upcoming",
  partial: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
};

export type LedgerScope = "cycle" | "all";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/** A row's full details — the same statement figures the list summarises. */
export function RowDetails({ row }: { row: LedgerRow }) {
  const s = row.statementRow;
  const balanceAfter = s ? directionOf(s.runningBalance) : null;
  return (
    <>
      <Detail label="Type">{row.typeLabel}</Detail>
      <Detail label="Date">{formatStatementDate(row.date, true)}</Detail>
      <Detail label={s?.settles ? "Payment" : "Amount"}>{money(row.amount)}</Detail>
      <Detail label="Meaning">{DIRECTION_LABEL[row.direction]}</Detail>
      {s?.settles && (
        <Detail label={s.settles.remainingAfter > 0 ? "Against" : "Clears"}>
          {s.settles.title} ({money(s.settles.originalAmount)})
        </Detail>
      )}
      {s?.settles && s.settles.remainingAfter > 0 && <Detail label="Left after this">{money(s.settles.remainingAfter)}</Detail>}
      {row.state != null && <Detail label="Still open">{row.state === "settled" ? "Settled" : money(row.remaining ?? 0)}</Detail>}
      {s?.emi && (
        <>
          <Detail label="Installment">
            #{s.emi.installmentNumber} · {s.emi.sourceName}
          </Detail>
          <Detail label="Bank status">
            <span className={s.emi.status === "overdue" ? "text-expense" : undefined}>{EMI_STATUS[s.emi.status]}</span>
          </Detail>
        </>
      )}
      {s && balanceAfter && (
        <Detail label="Balance after">
          {balanceAfter === "settled" ? "Settled" : `${directionHeadline(balanceAfter)} ${money(Math.abs(s.runningBalance))}`}
        </Detail>
      )}
      {row.category === "loan" && <Detail label="Settled from">The Loan</Detail>}
    </>
  );
}

/** Row meta line: "28 Sep · Money given" (+ EMI bank status). */
export function rowMeta(row: LedgerRow): string {
  const loan = row.statementRow?.loan;
  if (loan && row.statementRow?.kind === "obligation") {
    const month = loan.dueDate.toLocaleDateString("en-IN", { month: "long" });
    return `${month} installment · ${loan.installmentNumber} of ${loan.installmentCount}`;
  }
  const emi = row.statementRow?.emi;
  return `${row.typeLabel}${emi ? ` · Bank: ${EMI_STATUS[emi.status].toLowerCase()}` : ""}`;
}

/** "28 Sep" under a month heading; with the year only when there is no heading and it isn't this year. */
function rowDate(d: Date, grouped: boolean): string {
  return formatStatementDate(d, !grouped && d.getFullYear() !== new Date().getFullYear());
}

/**
 * One ledger row: № · icon · description / date · type · status — amount / meaning · ⋯. Clicking the
 * row expands its details in place; "Settle this entry" opens its settle form in the same place.
 */
/**
 * One ledger row: № · icon · description / date · type · status — amount / meaning · ⋯. A settled
 * transaction carries a quiet green edge and its receipt ("Received ₹500 · 28 Sep"); its payments are
 * its history (in the details), never rows of their own. Clicking the row expands its details in
 * place; "Settle this entry" opens its settle form in the same place.
 */
function FeedRow({
  n,
  row,
  date,
  expanded,
  onToggle,
  settling,
  personName,
  onSettleStart,
  onSettleCancel,
  onSettleSubmit,
  editing,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onDelete,
  onUndo,
}: {
  editing: boolean;
  onEditStart?: () => void;
  onEditCancel: () => void;
  onEditSubmit: (values: EntryEditValues) => Promise<void>;
  n: string;
  row: LedgerRow;
  date: string;
  expanded: boolean;
  onToggle: () => void;
  settling: boolean;
  personName: string;
  onSettleStart?: () => void;
  onSettleCancel: () => void;
  onSettleSubmit: (values: EntrySettleValues) => Promise<void>;
  onDelete?: () => void;
  onUndo?: (payment: PaymentRecord) => void;
}) {
  const open = expanded || settling || editing;
  const settled = row.state === "settled";
  return (
    <li
      className={cn(
        "border-b border-l-2 border-b-border-strong/60 transition-colors duration-200",
        settled ? "border-l-success/60" : "border-l-transparent",
        open ? "bg-secondary/70" : "bg-transparent",
      )}
    >
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[1.25rem_3rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[6px] py-2.5 pl-2 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring min-[520px]:grid-cols-[1.25rem_3rem_minmax(0,1fr)_auto_8.5rem]"
        >
          <span className="text-[11px] font-medium text-muted-foreground tabular-nums" aria-label={`Transaction ${n}`}>
            {n}
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold whitespace-nowrap text-foreground tabular-nums">{formatStatementDate(row.date, false)}</span>
            <span className="text-[10.5px] text-muted-foreground tabular-nums">{row.date.getFullYear()}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2.5">
            <RowIcon row={row} className="size-7" />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5 text-sm leading-snug font-semibold text-foreground">
                <span className="truncate">{row.title}</span>
                {row.category === "emi" && <EmiBadge />}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">{rowMeta(row)}</span>
            </span>
          </span>
          <span className={cn("text-right font-heading text-[15px] font-bold tabular-nums", amountTone(row))}>{money(row.amount)}</span>
          <span className="hidden min-[520px]:block">
            <StatusCell row={row} />
          </span>
        </button>
        {row.category === "loan" && row.loanId != null && row.state != null && row.state !== "settled" && <LoanPayLink loanId={row.loanId} />}
        <RowActionsMenu row={row} onSettle={onSettleStart} onEdit={onEditStart} onDelete={onDelete} onUndo={onUndo} />
      </div>
      <InlineReveal open={open}>
        <div className="px-2 pt-0.5 pb-2.5 sm:pr-11 sm:pl-[5.5rem]">
          {editing ? (
            <EntryEditForm row={row} onCancel={onEditCancel} onSubmit={onEditSubmit} />
          ) : settling ? (
            <EntrySettleForm row={row} personName={personName} onCancel={onSettleCancel} onSubmit={onSettleSubmit} />
          ) : (
            <>
              <div className="mb-1.5 min-[520px]:hidden"><StatusCell row={row} /></div>
              <dl className="grid gap-x-6 text-xs sm:grid-cols-2">
                <RowDetails row={row} />
              </dl>
              <PaymentHistory row={row} onUndo={onUndo} className="mt-2.5" />
            </>
          )}
        </div>
      </InlineReveal>
    </li>
  );
}

/**
 * "Previous pending ₹500 · carried forward" — the selected cycle's opening balance from earlier cycles
 * (the engine's `previousPending`), so old unpaid money never reads as new activity.
 */
export function CarriedForwardNote({ carried, className }: { carried: { amount: number; direction: "theyOwe" | "iOwe" } | null; className?: string }) {
  if (carried == null) return null;
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-[6px] border-l-2 border-warning bg-warning/10 px-3 py-2 text-xs", className)}>
      <span className="font-semibold text-foreground">Previous pending</span>
      <span className="font-heading text-sm font-bold text-foreground tabular-nums">{money(carried.amount)}</span>
      <span className="text-muted-foreground">
        {carried.direction === "theyOwe" ? "They owe you" : "You owe them"} · carried forward from earlier cycles — not new activity
      </span>
    </div>
  );
}

/** Compact month separator — sticks to the top of the scrolling list on larger screens. */
function MonthHeading({ label }: { label: string }) {
  return (
    <li className="z-[1] border-b border-border-strong/60 bg-secondary/70 px-4 py-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase sm:sticky sm:top-0">
      {label}
    </li>
  );
}

/** "Current cycle | All transactions" with counts — shared by the compact list and the expanded ledger. */
export function ScopeSwitch({
  scope,
  onScopeChange,
  counts,
  cycleLabel,
}: {
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycleLabel: string;
}) {
  return (
    <div role="tablist" aria-label="Which transactions" className="flex items-center rounded-[8px] border border-border-strong bg-secondary/60 p-[3px] text-xs">
      {(
        [
          ["cycle", cycleLabel],
          ["all", "All transactions"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={scope === value}
          onClick={() => onScopeChange(value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            scope === value
              ? "bg-card font-semibold text-foreground shadow-[inset_0_0_0_1.5px_var(--color-primary-accent-text)]"
              : "font-medium text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          <span className="font-medium text-muted-foreground tabular-nums">{counts[value]}</span>
        </button>
      ))}
    </div>
  );
}

export interface LedgerRowHandlers {
  settlingKey: string | null;
  onSettleStart: (row: LedgerRow) => void;
  onSettleCancel: () => void;
  onSettleSubmit: (row: LedgerRow, values: EntrySettleValues) => Promise<void>;
  editingKey?: string | null;
  onEditStart?: (row: LedgerRow) => void;
  onEditCancel?: () => void;
  onEditSubmit?: (row: LedgerRow, values: EntryEditValues) => Promise<void>;
  onDelete?: (row: LedgerRow) => void;
  /** Reverses one recorded payment (its confirmation lives in the workspace). */
  onUndoPayment?: (row: LedgerRow, payment: PaymentRecord) => void;
}

/**
 * The Person workspace's transaction list — newest first, numbered in display order, each row with
 * its settlement state and a ⋯ menu. "Current cycle" and "All transactions" read the same statement
 * engine (one cycle vs. the whole history). On larger screens the heading and filters stay put and
 * only the list scrolls (the parent gives this section the remaining workspace height).
 */
export function PersonActivityFeed({
  personName,
  rows,
  isLoading,
  scope,
  onScopeChange,
  counts,
  cycleLabel,
  onAdd,
  onExpand,
  handlers,
  carriedForward = null,
}: {
  personName: string;
  /** The selected scope's rows, newest first. */
  rows: LedgerRow[];
  isLoading: boolean;
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts: Record<LedgerScope, number>;
  cycleLabel: string;
  onAdd?: () => void;
  onExpand: () => void;
  handlers: LedgerRowHandlers;
  /** The selected cycle's previous pending (engine value), shown above the cycle view's rows. */
  carriedForward?: { amount: number; direction: "theyOwe" | "iOwe" } | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const visible = filterLedgerRows(rows, "all", search);
  const groups = groupByMonth(visible, (r) => r.date);
  const firstName = personName.split(" ")[0];

  const changeScope = (next: LedgerScope) => {
    onScopeChange(next);
    setExpanded(null);
  };

  const toggle = (row: LedgerRow) => {
    if (handlers.settlingKey === row.key) handlers.onSettleCancel();
    setExpanded((k) => (k === row.key ? null : row.key));
  };
  const rowProps = (row: LedgerRow) => ({
    settling: handlers.settlingKey === row.key,
    editing: handlers.editingKey === row.key,
    onSettleStart: row.settle ? () => handlers.onSettleStart(row) : undefined,
    onEditStart: handlers.onEditStart ? () => handlers.onEditStart!(row) : undefined,
    onDelete: handlers.onDelete ? () => handlers.onDelete!(row) : undefined,
    onUndo: handlers.onUndoPayment ? (payment: PaymentRecord) => handlers.onUndoPayment!(row, payment) : undefined,
  });

  return (
    <section className="flex min-w-0 flex-col">
      {/* Header row — title and count, period scope, search, Expand (the expanded ledger's toolbar, compact) */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pb-2.5">
        <h2 className="font-heading text-base font-semibold text-foreground">
          Activity{" "}
          <span className="text-sm font-medium text-muted-foreground tabular-nums">
            · {counts[scope]} {counts[scope] === 1 ? "transaction" : "transactions"}
          </span>
        </h2>
        <ScopeSwitch scope={scope} onScopeChange={changeScope} counts={counts} cycleLabel={cycleLabel} />
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          {rows.length > 5 && (
            <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search transactions"
                className="h-8 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-8 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary-accent-text"
              />
            </div>
          )}
          <button type="button" onClick={onExpand} title="Open the full transaction workspace" className={cn(WS_SECONDARY, "h-8 shrink-0 px-3")}>
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
            Expand
          </button>
        </div>
      </div>

      {scope === "cycle" && !isLoading && <CarriedForwardNote carried={carriedForward} className="mb-2.5 shrink-0" />}

      {/* The ledger — sized to its rows; only a long history scrolls, inside this region (header row stays put) */}
      <div
        key={scope}
        className="animate-in overflow-x-hidden border-y border-border-strong/75 duration-200 fade-in-0 sm:max-h-[min(64vh,46rem)] sm:overflow-y-auto sm:overscroll-contain"
      >
        {isLoading ? (
          <div className="space-y-3 px-4 py-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">{scope === "cycle" ? "No activity this cycle" : "No transactions yet"}</p>
              <p className="text-xs text-muted-foreground">Transactions with {firstName} will appear here.</p>
            </div>
            {onAdd && (
              <button
                type="button"
                onClick={onAdd}
                className="flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:text-primary-accent-text"
              >
                <Plus className="size-3.5" strokeWidth={2} />
                Add transaction
              </button>
            )}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No matching transactions.</p>
        ) : (
          <>
            {/* md+: the ledger grid — same header, lines and columns as the expanded view */}
            <table className="hidden w-full border-separate border-spacing-0 text-sm md:table">
              <thead>
                <tr>
                  <th className={cn(LEDGER_TH, "w-10 pl-3 text-right")}>
                    <span className="sr-only">Number</span>#
                  </th>
                  <th className={cn(LEDGER_TH, "w-[5.5rem]")}>Date</th>
                  <th className={LEDGER_TH}>Description</th>
                  <th className={cn(LEDGER_TH, "hidden w-24 lg:table-cell")}>Type</th>
                  <th className={cn(LEDGER_TH, "w-28 text-right")}>Amount</th>
                  <th className={cn(LEDGER_TH, "w-40")}>Status</th>
                  <th className={cn(LEDGER_TH, "w-[9.5rem] pr-2")}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    {g.label && (
                      <tr>
                        <td
                          colSpan={7}
                          className="border-b border-border-strong/60 bg-secondary/70 px-3 py-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase"
                        >
                          {g.label}
                        </td>
                      </tr>
                    )}
                    {g.rows.map(({ row, n }) => {
                      const p = rowProps(row);
                      const open = expanded === row.key || p.settling || p.editing;
                      const settles = row.statementRow?.settles;
                      return (
                        <Fragment key={row.key}>
                          <tr onClick={() => toggle(row)} aria-expanded={open} className={cn("cursor-pointer transition-colors hover:bg-secondary/60", open && "bg-secondary/70")}>
                            <td
                              className={cn(
                                LEDGER_TD,
                                "border-l-2 pl-3 text-right text-[11px] text-muted-foreground tabular-nums",
                                row.state === "settled" ? "border-l-success/60" : "border-l-transparent",
                              )}
                            >
                              {sequence(n, visible.length)}
                            </td>
                            <td className={cn(LEDGER_TD, "whitespace-nowrap tabular-nums")}>
                              <p className="text-sm leading-tight font-semibold text-foreground">{formatStatementDate(row.date)}</p>
                              <p className="text-[11px] leading-tight text-muted-foreground">{row.date.getFullYear()}</p>
                            </td>
                            <td className={LEDGER_TD}>
                              <div className="flex min-w-0 items-center gap-2.5">
                                <RowIcon row={row} className="size-7" />
                                <div className="min-w-0">
                                  <p className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
                                    <span className="truncate">{row.title}</span>
                                    {row.category === "emi" && <EmiBadge />}
                                  </p>
                                  {settles ? (
                                    <p className="truncate text-xs text-muted-foreground">
                                      {settles.remainingAfter > 0 ? "Against" : "Clears"} {settles.title}
                                    </p>
                                  ) : (
                                    <p className={cn("truncate text-xs text-muted-foreground", !row.statementRow?.emi && "lg:hidden")}>{rowMeta(row)}</p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className={cn(LEDGER_TD, "hidden text-[13px] text-muted-foreground lg:table-cell")}>{LEDGER_TYPE_SHORT[row.category]}</td>
                            <td className={cn(LEDGER_TD, "text-right font-heading text-[15px] font-bold tracking-tight whitespace-nowrap tabular-nums", amountTone(row))}>
                              {money(row.amount)}
                            </td>
                            <td className={LEDGER_TD}>
                              <StatusCell row={row} />
                            </td>
                            <td className={cn(LEDGER_TD, "py-1 pr-1.5 pl-2")} onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1">
                                {/* The row's main next step, direct; edit / delete / undo stay in ⋯ */}
                                {row.category === "loan" && row.loanId != null && row.state != null && row.state !== "settled" && <LoanPayLink loanId={row.loanId} />}
                                {p.onSettleStart && (
                                  <button
                                    type="button"
                                    aria-pressed={p.settling}
                                    onClick={() => (p.settling ? handlers.onSettleCancel() : p.onSettleStart!())}
                                    className={cn(
                                      "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                      p.settling
                                        ? "border-primary-accent-text bg-primary/15 text-foreground"
                                        : "border-border-strong bg-card text-foreground hover:border-primary-accent-text hover:bg-primary/10",
                                    )}
                                  >
                                    <HandCoins className="size-3.5 text-primary-accent-text" strokeWidth={2} />
                                    {row.state === "partial" ? "Settle rest" : "Settle"}
                                  </button>
                                )}
                                <RowActionsMenu row={row} onSettle={p.onSettleStart} onEdit={p.onEditStart} onDelete={p.onDelete} onUndo={p.onUndo} />
                              </div>
                            </td>
                          </tr>
                          <tr aria-hidden={!open}>
                            <td colSpan={7} className={cn("p-0", open && "border-b border-border-strong/60 bg-secondary/70")}>
                              <InlineReveal open={open}>
                                <div className="px-3 pt-1 pb-3 md:pl-[8.25rem]">
                                  {p.editing ? (
                                    <EntryEditForm row={row} onCancel={() => handlers.onEditCancel?.()} onSubmit={(values) => handlers.onEditSubmit!(row, values)} />
                                  ) : p.settling ? (
                                    <div className="max-w-xl">
                                      <EntrySettleForm row={row} personName={personName} onCancel={handlers.onSettleCancel} onSubmit={(values) => handlers.onSettleSubmit(row, values)} />
                                    </div>
                                  ) : (
                                    <div className="rounded-[8px] border border-border-strong/75 bg-card px-3.5 py-2.5">
                                      <dl className="grid gap-x-6 text-xs lg:grid-cols-2">
                                        <RowDetails row={row} />
                                      </dl>
                                      <PaymentHistory row={row} onUndo={p.onUndo} className="mt-2.5" />
                                    </div>
                                  )}
                                </div>
                              </InlineReveal>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>

            {/* Below md: one structured card per transaction */}
            <ul className="flex flex-col md:hidden">
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {g.label && <MonthHeading label={g.label} />}
                  {g.rows.map(({ row, n }) => {
                    const p = rowProps(row);
                    return (
                      <FeedRow
                        key={row.key}
                        n={sequence(n, visible.length)}
                        row={row}
                        date={rowDate(row.date, g.label != null)}
                        expanded={expanded === row.key}
                        onToggle={() => toggle(row)}
                        settling={p.settling}
                        personName={personName}
                        onSettleStart={p.onSettleStart}
                        onSettleCancel={handlers.onSettleCancel}
                        onSettleSubmit={(values) => handlers.onSettleSubmit(row, values)}
                        editing={p.editing}
                        onEditStart={p.onEditStart}
                        onEditCancel={() => handlers.onEditCancel?.()}
                        onEditSubmit={(values) => handlers.onEditSubmit!(row, values)}
                        onDelete={p.onDelete}
                        onUndo={p.onUndo}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
