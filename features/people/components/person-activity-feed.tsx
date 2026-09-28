"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
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
  EntrySettleForm,
  InlineReveal,
  lastPaymentLine,
  PaymentHistory,
  RowActionsMenu,
  StatusBadge,
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

export const EMI_STATUS: Record<EmiRowStatus, string> = {
  upcoming: "Upcoming",
  partial: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
};

export type LedgerScope = "cycle" | "all";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/60 py-1">
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
  onDelete,
  onUndo,
}: {
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
  const open = expanded || settling;
  const settled = row.state === "settled";
  const receipt = lastPaymentLine(row);
  return (
    <li
      className={cn(
        "rounded-[6px] border-l-2 transition-colors duration-200",
        settled ? "border-success/60" : "border-transparent",
        open ? "bg-secondary/70" : "bg-transparent",
      )}
    >
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[auto_2rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-[6px] py-2 pl-2 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-[1.125rem] text-right text-[11px] font-medium text-muted-foreground/70 tabular-nums" aria-label={`Transaction ${n}`}>
            {n}
          </span>
          <RowIcon row={row} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5 text-sm leading-snug font-semibold text-foreground">
              <span className="truncate">{row.title}</span>
              {row.category === "emi" && <EmiBadge />}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">
                <span className="font-medium text-foreground/80 tabular-nums">{date}</span> · {rowMeta(row)}
              </span>
              <StatusBadge row={row} compact className="hidden min-[420px]:inline-flex" />
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5 pr-1">
            <span className="font-heading text-[15px] leading-snug font-semibold tracking-tight text-foreground tabular-nums">{money(row.amount)}</span>
            <span
              className={cn(
                "text-[11px] leading-tight font-medium whitespace-nowrap",
                settled ? "text-success" : row.state === "partial" ? "text-foreground" : DIRECTION_TEXT[row.direction],
              )}
            >
              {settled ? (receipt ?? "Settled") : row.state === "partial" ? `${money(row.remaining ?? 0)} remaining` : DIRECTION_LABEL[row.direction]}
            </span>
          </span>
        </button>
        <RowActionsMenu row={row} onSettle={onSettleStart} onDelete={onDelete} onUndo={onUndo} />
      </div>
      <InlineReveal open={open}>
        <div className="px-2 pt-0.5 pb-2.5 sm:pr-11 sm:pl-[4.5rem]">
          {settling ? (
            <EntrySettleForm row={row} personName={personName} onCancel={onSettleCancel} onSubmit={onSettleSubmit} />
          ) : (
            <>
              <StatusBadge row={row} className="mb-1.5 min-[420px]:hidden" />
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
    <li className="z-[1] flex items-center gap-2 bg-card px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase first:pt-0.5 sm:sticky sm:top-0">
      {label}
      <span className="h-px flex-1 bg-border/70" aria-hidden />
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
  // A floor for the scrolling list so a short window never squeezes it to nothing — only once it can scroll.
  const longList = (isLoading ? 0 : visible.length) > 3;

  const changeScope = (next: LedgerScope) => {
    onScopeChange(next);
    setExpanded(null);
  };

  return (
    <section className="flex flex-col sm:min-h-0 sm:flex-1">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <h3 className="font-heading text-base font-semibold tracking-tight text-foreground">
            Transactions <span className="font-medium text-muted-foreground tabular-nums">· {counts[scope]}</span>
          </h3>
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand transactions"
            title="Expand transactions"
            className="ml-1 flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
            <span className="hidden sm:inline">Expand</span>
          </button>
        </div>
        <ScopeSwitch scope={scope} onScopeChange={changeScope} counts={counts} cycleLabel={cycleLabel} />
      </div>

      {rows.length > 5 && (
        <div className="relative mt-2.5 shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by description…"
            aria-label="Search transactions"
            className="h-9 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary-accent-text"
          />
        </div>
      )}

      {scope === "cycle" && !isLoading && <CarriedForwardNote carried={carriedForward} className="mt-2.5 shrink-0" />}

      {/* The only scrolling region of the overview on sm+ — header, position, actions and tabs stay put */}
      <div
        key={scope}
        className={cn(
          "-mx-2 mt-2 animate-in duration-200 fade-in-0 sm:min-h-0 sm:flex-1 sm:overflow-x-hidden sm:overflow-y-auto sm:overscroll-contain",
          longList && "sm:min-h-40",
        )}
      >
        {isLoading ? (
          <div className="space-y-3 px-2 py-2">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-2">
            <div className="mt-1 flex flex-col items-start gap-3 rounded-[8px] border border-dashed border-border-strong px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
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
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">No matching transactions.</p>
        ) : (
          <ul className="flex flex-col">
            {groups.map((g) => (
              <Fragment key={g.key}>
                {g.label && <MonthHeading label={g.label} />}
                {g.rows.map(({ row, n }) => (
                  <FeedRow
                    key={row.key}
                    n={sequence(n, visible.length)}
                    row={row}
                    date={rowDate(row.date, g.label != null)}
                    expanded={expanded === row.key}
                    onToggle={() => {
                      if (handlers.settlingKey === row.key) handlers.onSettleCancel();
                      setExpanded((k) => (k === row.key ? null : row.key));
                    }}
                    settling={handlers.settlingKey === row.key}
                    personName={personName}
                    onSettleStart={row.settle ? () => handlers.onSettleStart(row) : undefined}
                    onSettleCancel={handlers.onSettleCancel}
                    onSettleSubmit={(values) => handlers.onSettleSubmit(row, values)}
                    onDelete={handlers.onDelete ? () => handlers.onDelete!(row) : undefined}
                    onUndo={handlers.onUndoPayment ? (payment) => handlers.onUndoPayment!(row, payment) : undefined}
                  />
                ))}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
