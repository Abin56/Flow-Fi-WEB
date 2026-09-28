"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  HandCoins,
  Landmark,
  Plus,
  Scale,
  Search,
  Split,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { PersonActivityItem, PersonViewRow } from "@/features/people/hooks/use-people-data";
import {
  formatStatementDate,
  perspectiveAmount,
  type EmiRowStatus,
  type PersonCycleStatement,
  type StatementRow,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { LedgerEntryType } from "@/lib/models/person";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One restrained direction system: the icon tile carries the direction (towards me = positive,
 * my obligation = negative/warning, settlements & neutral = grey, EMI = accent), and every row states
 * the same in words ("They owe you" / "You owe them" / "Settled") under its amount, so meaning never
 * depends on colour or on a +/− sign.
 */
type Tone = "in" | "out" | "neutral" | "emi";

const TONE_TILE: Record<Tone, string> = {
  in: "bg-success/12 text-success",
  out: "bg-expense/10 text-expense",
  neutral: "bg-secondary text-muted-foreground",
  emi: "bg-primary/25 text-primary-accent-text",
};

/** Which way a row moves the relationship — read from the existing sign semantics, never recomputed. */
type Direction = "theyOwe" | "iOwe" | "settled" | "neutral";

const DIRECTION_TEXT: Record<Direction, string> = {
  theyOwe: "text-success",
  iOwe: "text-expense",
  settled: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

const DIRECTION_LABEL: Record<Exclude<Direction, "neutral">, string> = {
  theyOwe: "They owe you",
  iOwe: "You owe them",
  settled: "Settled",
};

function cycleRowVisual(row: StatementRow): { icon: LucideIcon; tone: Tone } {
  switch (row.category) {
    case "gave":
      return { icon: ArrowUpRight, tone: "in" };
    case "borrowed":
      return { icon: ArrowDownLeft, tone: "out" };
    case "received":
    case "repaid":
      return { icon: HandCoins, tone: "neutral" };
    case "split":
      return { icon: Split, tone: row.signedAmount >= 0 ? "in" : "out" };
    case "emi":
      return { icon: CalendarClock, tone: "emi" };
    default:
      return { icon: Scale, tone: "neutral" };
  }
}

/** Statement rows: settlements are "Settled"; obligations by the FlowFi sign (+ they owe me more). */
function cycleRowDirection(row: StatementRow): Direction {
  if (row.kind === "settlement") return "settled";
  return row.signedAmount > 0 ? "theyOwe" : row.signedAmount < 0 ? "iOwe" : "settled";
}

const ENTRY_VISUAL: Partial<Record<LedgerEntryType, { icon: LucideIcon; tone: Tone; label: string }>> = {
  gave: { icon: ArrowUpRight, tone: "in", label: "Money given" },
  borrowed: { icon: ArrowDownLeft, tone: "out", label: "Borrowed" },
  receivedBack: { icon: HandCoins, tone: "neutral", label: "Received back" },
  repaid: { icon: HandCoins, tone: "neutral", label: "Repaid" },
};

/** Loan events ride in `person.activity` as `loan:`/`loan-txn:` items — settled from the Loan, not here. */
const isLoanItem = (item: PersonActivityItem) => item.id.startsWith("loan:") || item.id.startsWith("loan-txn:");

function activityVisual(item: PersonActivityItem): { icon: LucideIcon; tone: Tone; label: string } {
  if (isLoanItem(item)) return { icon: Landmark, tone: "neutral", label: "Loan" };
  return (
    ENTRY_VISUAL[item.entryType] ??
    (item.type === "received" ? { icon: ArrowDownLeft, tone: "neutral", label: "Received" } : { icon: ArrowUpRight, tone: "neutral", label: "Paid" })
  );
}

/**
 * All-time rows. A "gave" entry means they owe you; "borrowed" means you owe them; "receivedBack"/
 * "repaid" are settlements. A ledger adjustment's `type` follows `cashFlowDirection` ("paid" = raises
 * what they owe you). A Loan's creation item maps `signedEffect >= 0` to "received" (lent = they owe
 * you); a Loan payment is a Loan event, so it is labelled neutrally rather than guessed.
 */
function activityDirection(item: PersonActivityItem): Direction {
  switch (item.entryType) {
    case "gave":
      return "theyOwe";
    case "borrowed":
      return "iOwe";
    case "receivedBack":
    case "repaid":
      return "settled";
  }
  if (item.id.startsWith("loan-txn:")) return "neutral";
  if (item.id.startsWith("loan:")) return item.type === "received" ? "theyOwe" : "iOwe";
  return item.type === "paid" ? "theyOwe" : "iOwe";
}

const EMI_STATUS: Record<EmiRowStatus, string> = {
  upcoming: "Upcoming",
  partial: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
};

type Scope = "cycle" | "all";

/** A ledger entry that still has an open remainder — the one kind of row that can be settled on its own. */
function isSettleable(item: PersonActivityItem | undefined): item is PersonActivityItem {
  return item != null && item.remainingAmount != null && item.remainingAmount > 0;
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

/** "01", "02" … — padded to the widest number in the list so the column stays aligned. */
function sequence(n: number, total: number): string {
  return String(n).padStart(Math.max(2, String(total).length), "0");
}

/**
 * Groups newest-first rows by month, numbering each row in display order. No month headings at all
 * for one or two rows — the dates alone are enough.
 */
function groupByMonth<T>(rows: T[], dateOf: (r: T) => Date): { key: string; label: string | null; rows: { row: T; n: number }[] }[] {
  if (rows.length <= 2) return [{ key: "all", label: null, rows: rows.map((row, i) => ({ row, n: i + 1 })) }];
  const groups: { key: string; label: string; rows: { row: T; n: number }[] }[] = [];
  rows.forEach((row, i) => {
    const d = dateOf(row);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push({ row, n: i + 1 });
    else groups.push({ key, label: MONTH_FORMAT.format(d), rows: [{ row, n: i + 1 }] });
  });
  return groups;
}

/** "28 Sep" under a month heading; with the year only when there is no heading and it isn't this year. */
function rowDate(d: Date, grouped: boolean): string {
  return formatStatementDate(d, !grouped && d.getFullYear() !== new Date().getFullYear());
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/60 py-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * One ledger row: № · icon · what it was for / date · type · amount / direction — expanding in place
 * to its details.
 */
function FeedRow({
  n,
  icon: Icon,
  tone,
  title,
  badge,
  date,
  meta,
  amount,
  direction,
  directionLabel,
  expanded,
  onToggle,
  details,
  settleItem,
  onSettle,
}: {
  n: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  badge?: React.ReactNode;
  date: string;
  meta: string;
  amount: string;
  direction: Direction;
  directionLabel: string;
  expanded: boolean;
  onToggle: () => void;
  details: React.ReactNode;
  settleItem?: PersonActivityItem;
  onSettle?: (item: PersonActivityItem) => void;
}) {
  return (
    <li className={cn("rounded-[6px] transition-colors duration-200", expanded ? "bg-secondary/70" : "bg-transparent")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="group grid w-full grid-cols-[auto_2rem_minmax(0,1fr)_auto_1rem] items-center gap-x-2.5 rounded-[6px] px-2 py-2 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-[1.125rem] text-right text-[11px] font-medium text-muted-foreground/70 tabular-nums" aria-label={`Transaction ${n}`}>
          {n}
        </span>
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", TONE_TILE[tone])}>
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-snug font-semibold text-foreground">
            <span className="truncate">{title}</span>
            {badge}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80 tabular-nums">{date}</span>
            {meta && ` · ${meta}`}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="font-heading text-[15px] leading-snug font-semibold tracking-tight text-foreground tabular-nums">{amount}</span>
          <span className={cn("text-[11px] leading-tight font-medium whitespace-nowrap", DIRECTION_TEXT[direction])}>{directionLabel}</span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover:text-muted-foreground",
            expanded && "rotate-180",
          )}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      <div
        className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        inert={!expanded}
      >
        <div className="overflow-hidden">
          <div className="px-2 pt-0.5 pb-2.5 sm:pr-9 sm:pl-[5.125rem]">
            <dl className="grid gap-x-6 text-xs sm:grid-cols-2">{details}</dl>
            {settleItem && onSettle && (
              <button
                type="button"
                onClick={() => onSettle(settleItem)}
                className="mt-2.5 flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text hover:text-primary-accent-text"
              >
                <HandCoins className="size-3.5" strokeWidth={1.75} />
                Settle this entry
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function CycleRowDetails({ statement, row, item }: { statement: PersonCycleStatement; row: StatementRow; item?: PersonActivityItem }) {
  return (
    <>
      <Detail label="Type">{row.typeLabel}</Detail>
      <Detail label="Date">{formatStatementDate(row.date, true)}</Detail>
      <Detail label={row.settles ? "Payment" : "Original amount"}>{money(row.amount)}</Detail>
      {row.settles && (
        <Detail label={row.settles.remainingAfter > 0 ? "Against" : "Clears"}>
          {row.settles.title} ({money(row.settles.originalAmount)})
        </Detail>
      )}
      {row.settles && row.settles.remainingAfter > 0 && <Detail label="Remaining after">{money(row.settles.remainingAfter)}</Detail>}
      {row.remainingNow != null && <Detail label="Still open">{row.remainingNow > 0 ? money(row.remainingNow) : "Settled"}</Detail>}
      {row.remainingNow == null && item?.remainingAmount === 0 && <Detail label="Status">Settled</Detail>}
      {row.emi && (
        <>
          <Detail label="Installment">
            #{row.emi.installmentNumber} · {row.emi.sourceName}
          </Detail>
          <Detail label="Bank status">
            <span className={row.emi.status === "overdue" ? "text-expense" : undefined}>{EMI_STATUS[row.emi.status]}</span>
          </Detail>
        </>
      )}
      <Detail label="Balance after">{money(perspectiveAmount(statement, row.runningBalance))}</Detail>
    </>
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

/**
 * The Person workspace's Activity feed — transactions live here, inside the workspace. "This cycle"
 * reads the cycle statement's rows (incl. EMI rows); "All time" reads `person.activity`. Rows expand in
 * place; a row with an open remainder offers the existing per-entry settle flow. On larger screens the
 * heading and filters stay put and only the list scrolls (the parent gives this section the remaining
 * workspace height).
 */
export function PersonActivityFeed({
  person,
  statement,
  isLoading,
  onSettleEntry,
  onAdd,
}: {
  person: PersonViewRow;
  statement: PersonCycleStatement | null;
  isLoading: boolean;
  onSettleEntry?: (item: PersonActivityItem) => void;
  onAdd?: () => void;
}) {
  const [scope, setScope] = useState<Scope>("cycle");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const activityById = useMemo(() => new Map(person.activity.map((a) => [a.id, a])), [person.activity]);
  const cycleRows = useMemo(() => (statement ? [...statement.rows].reverse() : []), [statement]);
  const cycleGroups = useMemo(() => groupByMonth(cycleRows, (r) => r.date), [cycleRows]);
  const allRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? person.activity.filter((a) => a.description.toLowerCase().includes(q)) : person.activity;
  }, [person.activity, search]);
  const allGroups = useMemo(() => groupByMonth(allRows, (a) => a.rawDate), [allRows]);

  const toggle = (key: string) => setExpanded((k) => (k === key ? null : key));
  const firstName = person.name.split(" ")[0];
  // A floor for the scrolling list so a short window never squeezes it to nothing — only once it can scroll.
  const longList = (scope === "cycle" ? (isLoading ? 0 : cycleRows.length) : allRows.length) > 3;

  return (
    <section className="flex flex-col sm:min-h-0 sm:flex-1">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h3 className="font-heading text-base font-semibold tracking-tight text-foreground">Transactions</h3>
        <div role="tablist" aria-label="Transaction range" className="flex items-center text-xs">
          {(
            [
              ["cycle", "This cycle"],
              ["all", "All time"],
            ] as const
          ).map(([value, label], i) => (
            <Fragment key={value}>
              {i > 0 && <span className="mx-1.5 h-3.5 w-px bg-border-strong" aria-hidden />}
              <button
                type="button"
                role="tab"
                aria-selected={scope === value}
                onClick={() => {
                  setScope(value);
                  setExpanded(null);
                }}
                className={cn(
                  "rounded-[4px] px-1 py-0.5 underline-offset-[6px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  scope === value
                    ? "font-semibold text-foreground underline decoration-primary-accent-text decoration-2"
                    : "font-medium text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {value === "all" && <span className="font-medium text-muted-foreground tabular-nums"> · {person.transactionsCount}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      </div>

      {scope === "all" && person.activity.length > 3 && (
        <div className="relative mt-2.5 shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transactions…"
            aria-label="Search transactions"
            className="h-9 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary-accent-text"
          />
        </div>
      )}

      {/* The only scrolling region of the overview on sm+ — header, position, actions and tabs stay put */}
      <div
        key={scope}
        className={cn(
          "-mx-2 mt-2 animate-in duration-200 fade-in-0 sm:min-h-0 sm:flex-1 sm:overflow-x-hidden sm:overflow-y-auto sm:overscroll-contain",
          longList && "sm:min-h-40",
        )}
      >
        {scope === "cycle" ? (
          isLoading || statement == null ? (
            <div className="space-y-3 px-2 py-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : statement.rows.length === 0 ? (
            <div className="px-2">
              <div className="mt-1 flex flex-col items-start gap-3 rounded-[8px] border border-dashed border-border-strong px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">No activity this cycle</p>
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
          ) : (
            <ul className="flex flex-col">
              {cycleGroups.map((g) => (
                <Fragment key={g.key}>
                  {g.label && <MonthHeading label={g.label} />}
                  {g.rows.map(({ row, n }) => {
                    const item = row.key.startsWith("ledger:") ? activityById.get(row.key.slice("ledger:".length)) : undefined;
                    const { icon, tone } = cycleRowVisual(row);
                    const direction = cycleRowDirection(row);
                    return (
                      <FeedRow
                        key={row.key}
                        n={sequence(n, cycleRows.length)}
                        icon={icon}
                        tone={tone}
                        title={row.title}
                        badge={row.category === "emi" ? <EmiBadge /> : undefined}
                        date={rowDate(row.date, g.label != null)}
                        meta={`${row.typeLabel}${row.emi ? ` · Bank: ${EMI_STATUS[row.emi.status].toLowerCase()}` : ""}`}
                        amount={money(row.amount)}
                        direction={direction}
                        directionLabel={DIRECTION_LABEL[direction as Exclude<Direction, "neutral">]}
                        expanded={expanded === row.key}
                        onToggle={() => toggle(row.key)}
                        details={<CycleRowDetails statement={statement} row={row} item={item} />}
                        settleItem={isSettleable(item) ? item : undefined}
                        onSettle={onSettleEntry}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </ul>
          )
        ) : person.activity.length === 0 ? (
          <div className="px-2">
            <div className="mt-1 rounded-[8px] border border-dashed border-border-strong px-4 py-4">
              <p className="text-sm font-semibold text-foreground">No transactions yet</p>
              <p className="text-xs text-muted-foreground">Ledger activity with {firstName} will show up here.</p>
            </div>
          </div>
        ) : allRows.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">No matching transactions.</p>
        ) : (
          <ul className="flex flex-col">
            {allGroups.map((g) => (
              <Fragment key={g.key}>
                {g.label && <MonthHeading label={g.label} />}
                {g.rows.map(({ row: item, n }) => {
                  const received = item.type === "received";
                  const open = isSettleable(item);
                  const visual = activityVisual(item);
                  const direction = activityDirection(item);
                  return (
                    <FeedRow
                      key={item.id}
                      n={sequence(n, allRows.length)}
                      icon={visual.icon}
                      tone={visual.tone}
                      title={item.description}
                      date={rowDate(item.rawDate, g.label != null)}
                      meta={`${visual.label}${open ? ` · ${formatCurrency(item.remainingAmount!)} open` : ""}`}
                      amount={formatCurrency(item.amount)}
                      direction={direction}
                      directionLabel={direction === "neutral" ? "Via loan" : DIRECTION_LABEL[direction]}
                      expanded={expanded === item.id}
                      onToggle={() => toggle(item.id)}
                      details={
                        <>
                          <Detail label="Type">{visual.label}</Detail>
                          <Detail label="Date">{item.date}</Detail>
                          <Detail label="Original amount">{formatCurrency(item.amount)}</Detail>
                          {!isLoanItem(item) && <Detail label="Direction">{received ? "Received" : "Paid"}</Detail>}
                          {item.remainingAmount != null && (
                            <Detail label="Still open">{item.remainingAmount > 0 ? formatCurrency(item.remainingAmount) : "Settled"}</Detail>
                          )}
                        </>
                      }
                      settleItem={open ? item : undefined}
                      onSettle={onSettleEntry}
                    />
                  );
                })}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
