"use client";

import { ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronDown, History, Info, Maximize2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { EntryEditValues, EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { WS_SECONDARY } from "@/features/people/components/workspace/person-workspace-ui";
import { cashOf, SettlementTable, tableTypeLabel } from "@/features/people/components/workspace/settlement-table";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PaymentLine, StatementBalance } from "@/features/people/lib/statement-balance";
import { linkedTrailFor } from "@/features/people/components/linked-funds";
import type { SettlementLookupsWithAccounts } from "@/features/people/hooks/use-settlement-lookups";
import { filterLedgerRows, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { rowMatchesTypeFilter, settlementKind } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Transaction } from "@/lib/models/transaction";
import { repaymentMix } from "@/features/people/lib/repayment-mix";
import { cn } from "@/lib/utils";

type LensId = "all" | "in" | "out" | "owed" | "overdue" | "emi" | "settled";
const LENSES: { id: LensId; label: string }[] = [
  { id: "all", label: "All activity" },
  { id: "in", label: "Money received" },
  { id: "out", label: "Money sent" },
  { id: "owed", label: "Still open" },
  { id: "overdue", label: "Overdue" },
  { id: "emi", label: "EMI shares" },
  { id: "settled", label: "Cleared items" },
];

export type LedgerScope = "cycle" | "all";

/** Show posted loan funding once. The agreement row also exists for loans recorded without funding. */
function loanHistoryRows(rows: readonly LedgerRow[], transactions: readonly Transaction[], accountNameOf: SettlementLookupsWithAccounts["accountNameOf"]): LedgerRow[] {
  const agreements = new Map(rows.filter((row) => row.key.startsWith("loan:") && row.loanId != null).map((row) => [row.loanId, row]));
  const funded = new Set<string>();
  const movements: LedgerRow[] = [];
  for (const t of transactions) {
    if (t.deletedAt != null || t.status !== "posted" || t.paymentAllocationType !== "additionalDisbursement" || !t.loanId || t.amount <= 0) continue;
    const agreement = agreements.get(t.loanId);
    if (!agreement) continue;
    const original = isOriginationTransactionId(t.id);
    if (original) funded.add(agreement.key);
    movements.push({
      ...agreement,
      key: original ? agreement.key : `loan-txn:${t.id}`,
      title: original ? agreement.title : t.description?.trim() || (t.type === "income" ? "Borrowed more" : "Lent more"),
      date: t.dateTime,
      createdAt: t.createdAt,
      amount: t.amount,
      recordedLoanCash: { dir: t.type === "income" ? "in" : "out", account: accountNameOf(t.accountId) ?? null },
    });
  }
  return [...movements, ...[...agreements.values()].filter((row) => !funded.has(row.key))];
}

/**
 * One compact financial summary above the table (it replaces the two long banners): what came in this cycle, how much of it went
 * toward the overall balance, what is postponed, and what is still outstanding — each direction on its own, never netted. Every
 * figure is an existing value (`repaymentMix`, the deferral views, the person's breakdown); only shown when there is something to say.
 * The disclosure explains the payment and lender states that apply to the visible scope.
 */
interface RelationshipActivity {
  lent: number;
  receivedBack: number;
  receivedEarlier: number;
  borrowed: number;
  paidBack: number;
}

function LedgerSummary({
  statement,
  personName,
  lookups,
  outstanding,
  postponed,
  activity,
  dateRange,
  hasLenderRows,
}: {
  statement: PersonCycleStatement | null;
  personName: string;
  lookups: SettlementLookupsWithAccounts;
  outstanding?: { toReceive: number; toGive: number };
  postponed?: { amount: number; until: string | null };
  activity: RelationshipActivity;
  dateRange: string;
  hasLenderRows: boolean;
}) {
  const [why, setWhy] = useState(false);
  const first = personName.split(" ")[0];
  const mix = statement ? repaymentMix(statement) : null;
  const inbound = mix && mix.in.total >= 0.005 ? mix.in : null;
  const outbound = mix && mix.out.total >= 0.005 ? mix.out : null;
  const hasPostponed = postponed != null && postponed.amount >= 0.005;
  const credit = lookups.generalCredit;
  const sides = [
    credit && credit.theyOwe.credit >= 0.005 && { key: "in", who: first, ...credit.theyOwe },
    credit && credit.iOwe.credit >= 0.005 && { key: "out", who: "You", ...credit.iOwe },
  ].filter(Boolean) as { key: string; who: string; credit: number; owed: number }[];
  const stats: { key: string; label: string; value: number; sub?: string; tone?: string }[] = [];
  const toBalance = (inbound?.toBalance ?? 0) + (outbound?.toBalance ?? 0);
  if (toBalance >= 0.005) stats.push({ key: "bal", label: "Toward overall balance", value: toBalance, sub: inbound?.toBalance && outbound?.toBalance ? `${money(inbound.toBalance)} received · ${money(outbound.toBalance)} paid` : "No item selected" });
  if (hasPostponed) stats.push({ key: "pp", label: "Postponed", value: postponed.amount, tone: "text-primary-accent-text", sub: postponed.until ? `until ${postponed.until}` : "still owed" });
  const explain = sides.length > 0 || hasPostponed || hasLenderRows;

  return (
    <section data-testid="ledger-summary" aria-label="Financial summary" className="mb-3 overflow-hidden rounded-[10px] border border-border bg-card shadow-e1">
      <div className="@container">
        <div className="grid gap-px bg-border-subtle @min-[32rem]:grid-cols-2">
          <div className="min-w-0 bg-card px-3 py-2.5">
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold">Money between you <span className="font-normal text-muted-foreground">{dateRange}</span></h3>
            <dl className="mt-1.5 grid grid-cols-2 gap-3">
              <div>
                <dt className="flex items-center gap-1 text-xs text-muted-foreground"><ArrowUpRight className="size-3.5 text-expense" aria-hidden /> You gave</dt>
                <dd className="font-heading text-lg font-bold tabular-nums" data-stat="lent">{money(activity.lent)}</dd>
                {activity.paidBack > 0.005 && <dd className="text-xs text-muted-foreground">You paid back {money(activity.paidBack)}</dd>}
              </div>
              <div>
                <dt className="flex items-center gap-1 text-xs text-muted-foreground"><ArrowDownLeft className="size-3.5 text-success" aria-hidden /> Received back</dt>
                <dd className="font-heading text-lg font-bold text-success tabular-nums" data-stat="received-back">{money(activity.receivedBack)}</dd>
                {activity.receivedEarlier > 0.005 && <dd className="text-xs text-muted-foreground">{money(activity.receivedEarlier)} recorded earlier</dd>}
                {activity.borrowed > 0.005 && <dd className="text-xs text-muted-foreground">You borrowed {money(activity.borrowed)}</dd>}
              </div>
            </dl>
          </div>
          <div className="min-w-0 bg-card px-3 py-2.5">
            <h3 className="text-xs font-semibold">Outstanding now</h3>
            <dl className="mt-1.5 grid grid-cols-2 gap-3">
              <div><dt className="text-xs text-muted-foreground">{first} still owes you</dt><dd className="font-heading text-lg font-bold text-settle-receivable-text tabular-nums">{money(outstanding?.toReceive ?? 0)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">You still owe {first}</dt><dd className="font-heading text-lg font-bold text-settle-payable-text tabular-nums">{money(outstanding?.toGive ?? 0)}</dd></div>
            </dl>
          </div>
        </div>
      </div>
      {stats.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border bg-secondary/25 px-3 py-2">
          {stats.map((st) => (
            <div key={st.key} className="flex flex-wrap items-baseline gap-x-1.5 text-xs" data-stat={st.key}>
              <dt className="font-medium text-muted-foreground">{st.label}</dt>
              <dd className={cn("font-semibold tabular-nums", st.tone ?? "text-foreground")}>{money(st.value)}</dd>
              {st.sub && <dd className="text-muted-foreground tabular-nums">· {st.sub}</dd>}
            </div>
          ))}
        </dl>
      )}
      {explain && (
        <div className="border-t border-border bg-secondary/20 px-3">
          <button
            type="button"
            aria-expanded={why}
            onClick={() => setWhy((o) => !o)}
            className="flex min-h-9 w-full items-center gap-2 rounded-[5px] text-left text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5 shrink-0" aria-hidden />
            How balances are counted
            <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", why && "rotate-180")} aria-hidden />
          </button>
        </div>
      )}
      {why && explain && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3 border-t border-border px-3 py-3 text-xs text-muted-foreground">
          {sides.map((sd) => (
            <div key={sd.key} className="space-y-1 tabular-nums">
              <dt className="font-semibold text-foreground">Overall balance payment</dt>
              <dd>{sd.who} paid {money(sd.credit)}. {money(sd.owed)} remains owed overall. Individual items keep their own payment status.</dd>
            </div>
          ))}
          {hasPostponed && <div className="space-y-1"><dt className="font-semibold text-foreground">Postponed collection</dt><dd>{money(postponed.amount)} stays outstanding. Collection is scheduled for a later date.</dd></div>}
          {hasLenderRows && <div className="space-y-1"><dt className="font-semibold text-foreground">Lender payment</dt><dd>Bank status follows the linked installment. {first}&apos;s repayments to you are recorded as People receipts.</dd></div>}
        </dl>
      )}
    </section>
  );
}

/**
 * The selected cycle's starting balance from earlier cycles. `amount` is the engine's `previousPending`
 * (unsigned); `left` is what of it is still unpaid today — the open remaining of the earlier items, never
 * recomputed here. Display only.
 */
export interface CarriedForward {
  amount: number;
  direction: "theyOwe" | "iOwe";
  left: number;
}

/**
 * One compact line about money from before this cycle, in either direction — so old money never reads as new
 * activity, and money already paid never reads as still owed:
 *   still unpaid → "Previous unpaid amount ₹745.49 · Sojan still needs to pay you this"
 *   part paid    → "Previous unpaid amount ₹545.49 left of ₹745.49 · …"
 *   paid since   → "✓ From previous months ₹745.49 · Sojan owed you this when the cycle started · Now fully paid"
 * Shown when no individual open item from earlier cycles is listed in the table.
 */
export function CarriedForwardNote({ carried, personName, className }: { carried: CarriedForward | null; personName: string; className?: string }) {
  if (carried == null) return null;
  const first = personName.split(" ")[0];
  const theirs = carried.direction === "theyOwe";
  const left = Math.min(carried.amount, Math.max(0, carried.left));
  const paid = left < 0.005;
  if (paid) {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[6px] border border-border-strong/70 bg-card px-3 py-1.5 text-xs", className)}>
        <CheckCircle2 className="size-3.5 shrink-0 text-success" strokeWidth={2.25} aria-hidden />
        <span className="font-bold tracking-[0.06em] whitespace-nowrap text-foreground/70 uppercase">From previous months</span>
        <span className="font-heading text-sm font-semibold whitespace-nowrap text-foreground/80 tabular-nums">{money(carried.amount)}</span>
        <span className="font-medium text-foreground/70">
          {theirs ? `${first} owed you this when the cycle started` : `You owed ${first} this when the cycle started`}
        </span>
        <span className="font-semibold whitespace-nowrap text-foreground">· Now fully paid</span>
      </div>
    );
  }
  const tone = theirs
    ? { box: "border-settle-receivable-edge bg-settle-receivable-tint", text: "text-settle-receivable-text" }
    : { box: "border-settle-payable-edge bg-settle-payable-tint", text: "text-settle-payable-text" };
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[6px] border-l-[3px] px-3 py-1.5 text-xs", tone.box, className)}>
      <History className={cn("size-3.5 shrink-0", tone.text)} strokeWidth={2.25} aria-hidden />
      <span className={cn("font-bold tracking-[0.06em] whitespace-nowrap uppercase", tone.text)}>Previous unpaid amount</span>
      <span className="whitespace-nowrap">
        <span className="font-heading text-sm font-bold text-foreground tabular-nums">{money(left)}</span>
        {left < carried.amount - 0.005 && <span className="ml-1 font-medium text-foreground/70 tabular-nums">left of {money(carried.amount)}</span>}
      </span>
      <span className="font-medium text-foreground/75">
        {theirs ? `${first} still needs to pay you this` : `You still need to pay ${first} this`} · from before this cycle
      </span>
    </div>
  );
}

/** "Selected cycle | All transactions" with counts — shared by the compact list and the expanded ledger. */
export function ScopeSwitch({
  scope,
  onScopeChange,
  counts,
  cycleLabel,
}: {
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  counts?: Record<LedgerScope, number>;
  cycleLabel: string;
}) {
  return (
    <div role="tablist" aria-label="Which transactions" className="flex items-center rounded-full bg-secondary/80 p-[3px] text-xs ring-1 ring-border-strong/50 ring-inset">
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
            "flex h-7 items-center gap-1.5 rounded-full px-3 whitespace-nowrap outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
            scope === value
              ? "bg-card font-semibold text-foreground shadow-e1 ring-1 ring-primary-accent-text/60"
              : "font-medium text-foreground/70 hover:text-foreground",
          )}
        >
          {label}
          {counts && <span className={cn("rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums", scope === value ? "bg-primary/25 text-foreground" : "bg-card/70 text-foreground/60")}>{counts[value]}</span>}
        </button>
      ))}
    </div>
  );
}

export interface LedgerRowHandlers {
  settlingKey: string | null;
  /** `alreadyReceived`: Record payment opens on "Already in my account balance" (received outside FlowFi — no account change). */
  onSettleStart: (row: LedgerRow, opts?: { alreadyReceived?: boolean }) => void;
  onSettleCancel: () => void;
  onSettleSubmit: (row: LedgerRow, values: EntrySettleValues) => Promise<void>;
  editingKey?: string | null;
  onEditStart?: (row: LedgerRow) => void;
  onEditCancel?: () => void;
  onEditSubmit?: (row: LedgerRow, values: EntryEditValues) => Promise<void>;
  onDelete?: (row: LedgerRow) => void;
  /** Reverses one recorded payment (its confirmation lives in the workspace). */
  onUndoPayment?: (row: LedgerRow, payment: PaymentRecord) => void;
  /** Opens Record payment in edit mode for one recorded payment — null when it can't be edited here. */
  editablePayment?: (payment: PaymentRecord) => boolean;
  onEditPayment?: (payment: PaymentRecord) => void;
  /** Opens Record payment on the "Postpone" intent for one obligation. */
  onPostpone?: (row: LedgerRow) => void;
}

/**
 * The Person workspace's settlement table — the selected cycle (or the whole history) as a
 * reconciliation table with status/type filters, open items brought forward from earlier cycles, and
 * the cycle's payment history. On larger screens the heading and filters stay put and only the table
 * scrolls. Rows, amounts and states come from the statement engine via `buildLedgerRows`.
 */
export function PersonActivityFeed({
  personId,
  personName,
  rows,
  carriedRows = [],
  isLoading,
  scope,
  onScopeChange,
  cycleLabel,
  cycleRange,
  onAdd,
  onExpand,
  handlers,
  lookups,
  statement,
  historyStatement,
  loanRows,
  transactions,
  cycleLabelOf,
  carriedForward = null,
  paymentLines = [],
  balances,
  outstanding,
  postponed,
}: {
  personId: string;
  personName: string;
  /** The selected scope's rows, newest first. */
  rows: LedgerRow[];
  /** Cycle scope: obligations from earlier cycles that are still open. */
  carriedRows?: LedgerRow[];
  isLoading: boolean;
  scope: LedgerScope;
  onScopeChange: (scope: LedgerScope) => void;
  cycleLabel: string;
  cycleRange: string;
  onAdd?: () => void;
  onExpand: () => void;
  handlers: LedgerRowHandlers;
  lookups: SettlementLookupsWithAccounts;
  /** The selected cycle's statement — its payment history and settled state. */
  statement: PersonCycleStatement | null;
  historyStatement: PersonCycleStatement | null;
  loanRows: readonly LedgerRow[];
  transactions: readonly Transaction[];
  cycleLabelOf: (d: Date) => string;
  /** The selected cycle's previous pending (engine value). */
  carriedForward?: CarriedForward | null;
  /** Payments recorded against an obligation, listed as their own statement lines (already limited to this scope). */
  paymentLines?: readonly PaymentLine[];
  /** Running outstanding balance after every line (from the whole history). */
  balances?: ReadonlyMap<string, StatementBalance>;
  /** The person's overall position (the same figures as the header) — each direction on its own. */
  outstanding?: { toReceive: number; toGive: number };
  /** Open amounts moved to a later date (still owed) and the earliest new date. */
  postponed?: { amount: number; until: string | null };
}) {
  const [search, setSearch] = useState("");
  const [lens, setLens] = useState<LensId>("all");
  const firstName = personName.split(" ")[0];
  const postponedOf = usePostponedLookup();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const loanHistory = useMemo(() => loanHistoryRows(loanRows, transactions, lookups.accountNameOf), [loanRows, transactions, lookups.accountNameOf]);
  const activeStatement = scope === "cycle" ? statement : historyStatement;
  const addedLoans = loanHistory.filter((row) => {
    if (!activeStatement) return false;
    const { start, end } = activeStatement.cycle;
    const nextDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    return row.date >= start && row.date < nextDay;
  });
  const sourceRows = [...rows.filter((row) => !row.key.startsWith("loan:")), ...addedLoans];
  const metadata = new Map([...sourceRows, ...carriedRows].map((row) => {
    const kind = settlementKind(row, lookups);
    const cash = cashOf({ row, kind, typeLabel: tableTypeLabel(kind, row, lookups) });
    return [row.key, { kind, cash }];
  }));
  const shownKeys = new Set([...sourceRows, ...carriedRows].map((r) => r.key));
  const appliedPayments = paymentLines.filter((line) => !shownKeys.has(line.key));
  const activity: RelationshipActivity = { lent: 0, receivedBack: 0, receivedEarlier: 0, borrowed: 0, paidBack: 0 };
  const receivedEarlier = (entryId: string | null) => entryId != null && lookups.entriesById.get(entryId)?.recordedEarlier === true;
  for (const row of sourceRows) {
    const { kind, cash } = metadata.get(row.key)!;
    if (!cash) continue;
    if (kind === "moneyGiven" || (row.recordedLoanCash && cash.dir === "out")) activity.lent += cash.amount;
    if (kind === "moneyReceived" || (row.recordedLoanCash && cash.dir === "in")) activity.borrowed += cash.amount;
    if (kind === "paymentReceived") {
      activity.receivedBack += cash.amount;
      if (receivedEarlier(row.entryId)) activity.receivedEarlier += cash.amount;
    }
    if (kind === "paymentMade") activity.paidBack += cash.amount;
  }
  for (const line of appliedPayments) {
    const payment = line.payment;
    if (payment.source !== "cash") continue;
    activity[payment.direction === "theyPaid" ? "receivedBack" : "paidBack"] += payment.amount;
    if (payment.direction === "theyPaid" && receivedEarlier(payment.entryId)) activity.receivedEarlier += payment.amount;
  }

  // Overdue respects a postponement: an amount moved to a later date is not overdue (and never paid) until that date passes.
  const isOverdue = (r: LedgerRow) =>
    r.state != null && r.state !== "settled" && (r.direction === "theyOwe" || r.direction === "iOwe") &&
    (r.overdue || (r.category === "emi" && new Date(r.date.getFullYear(), r.date.getMonth(), r.date.getDate()).getTime() < today && postponedOf(r.key) == null));
  const rowMatchesLens = (lens: LensId, r: LedgerRow): boolean => {
    switch (lens) {
      case "all": return true;
      case "in": return metadata.get(r.key)?.cash?.dir === "in";
      case "out": return metadata.get(r.key)?.cash?.dir === "out";
      case "owed": return r.state === "open" || r.state === "partial";
      case "overdue": return isOverdue(r);
      case "emi": return rowMatchesTypeFilter(r, settlementKind(r, lookups), "emi");
      case "settled": return r.state === "settled" || (r.statementRow?.settles != null && r.statementRow.settles.remainingAfter < 0.005);
    }
  };
  const lineMatchesLens = (lens: LensId, l: PaymentLine): boolean => {
    const cash = l.payment.source === "cash";
    switch (lens) {
      case "all": return true;
      case "in": return cash && l.payment.direction === "theyPaid";
      case "out": return cash && l.payment.direction === "youPaid";
      case "emi": return l.parent.category === "emi";
      case "settled": return l.payment.remainingAfter < 0.005;
      default: return false;
    }
  };

  const rowMatches = (r: LedgerRow) => rowMatchesLens(lens, r);
  const lineMatches = (l: PaymentLine) => lineMatchesLens(lens, l);
  const q = search.trim().toLowerCase();
  const visible = !q ? sourceRows.filter(rowMatches) : sourceRows.filter((row) => rowMatches(row) && (
    filterLedgerRows([row], "all", search).length > 0 ||
    (row.recordedLoanCash?.account ?? lookups.accountForEntry(row.entryId))?.toLowerCase().includes(q)
  ));
  const showCarried = scope === "cycle" && !isLoading;
  const carried = showCarried ? filterLedgerRows(carriedRows, "all", search).filter(rowMatches) : [];
  const visibleLines = appliedPayments.filter((l) => lineMatches(l) && (!q || l.parent.title.toLowerCase().includes(q) || "payment".includes(q) || lookups.accountForEntry(l.payment.entryId)?.toLowerCase().includes(q)));
  const hasEmis = [...sourceRows, ...carriedRows].some((row) => rowMatchesLens("emi", row)) || appliedPayments.some((line) => lineMatchesLens("emi", line));
  const hasFilters = search.trim() !== "" || lens !== "all";
  const matchingCount = visible.length + carried.length + visibleLines.length;
  const clearFilters = () => {
    setSearch("");
    setLens("all");
  };

  const empty =
    sourceRows.length === 0 && carriedRows.length === 0 && appliedPayments.length === 0 ? (
      <div className="flex flex-col items-start gap-2 px-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-foreground">
          {scope === "cycle" ? `No activity with ${firstName} in this cycle.` : `No transactions with ${firstName} yet.`}
        </p>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            Add transaction
          </button>
        )}
      </div>
    ) : (
      <p className="px-3 py-4 text-sm font-medium text-foreground/75">No transactions match this search or filter.</p>
    );

  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-3 rounded-[10px] border border-border bg-card shadow-e1 lg:mb-2">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:px-4 lg:py-2">
          <div>
            <h2 className="font-heading text-base font-semibold">Transaction history</h2>
            <p className="text-xs text-muted-foreground tabular-nums">
              {scope === "all" ? "All dates" : cycleRange}
              {showCarried && carriedRows.length > 0 && ` · Includes ${carriedRows.length} unpaid from earlier cycles`}
            </p>
          </div>
          <ScopeSwitch scope={scope} onScopeChange={onScopeChange} cycleLabel={cycleLabel} />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border p-2.5 sm:px-4 lg:bg-secondary/20 lg:py-1.5">
          <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            Show
            <select aria-label="Filter transactions" value={lens} onChange={(e) => setLens(e.target.value as LensId)} className="h-8 rounded-[6px] border border-border bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {LENSES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            {(sourceRows.length > 0 || carriedRows.length > 0 || appliedPayments.length > 0) && (
              <div className="relative min-w-0 flex-1 sm:w-44 sm:flex-none">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/55" strokeWidth={1.75} />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search transactions"
                  aria-label="Search transactions"
                  className="h-8 w-full rounded-lg border border-border bg-card pr-3 pl-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            )}
            <button type="button" onClick={onExpand} title="Open the full transaction workspace" className={cn(WS_SECONDARY, "h-8 shrink-0 rounded-lg px-3 text-xs")}>
              <Maximize2 className="size-3.5" strokeWidth={1.75} />
              Expand
            </button>
          </div>
        </div>
      </div>

      {!isLoading && <LedgerSummary statement={activeStatement} personName={personName} lookups={lookups} outstanding={outstanding} postponed={postponed} activity={activity} dateRange={scope === "cycle" ? cycleRange : "All dates"} hasLenderRows={hasEmis} />}

      {/* The "Settled cycle" banner is retired from the main view — the totals strip above already reads Remaining ₹0. */}
      {showCarried && carriedRows.length === 0 && <CarriedForwardNote carried={carriedForward} personName={personName} className="mb-2 shrink-0" />}
      {!isLoading && hasFilters && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          <span role="status" className="text-muted-foreground tabular-nums">{matchingCount} matching {matchingCount === 1 ? "entry" : "entries"}</span>
          <button type="button" onClick={clearFilters} className="min-h-7 rounded-[5px] px-1.5 font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">Clear filters</button>
        </div>
      )}

      {/* Only the table scrolls on larger screens; its header row sticks */}
      <div
        key={scope}
        className={cn(
          "@container overflow-x-hidden rounded-[10px] border border-border bg-card shadow-e1 sm:max-h-[calc(100dvh-13rem)] sm:overflow-y-auto sm:overscroll-contain lg:max-h-[min(60dvh,36rem)]",
        )}
      >
        <SettlementTable
          compactDesktop
          personId={personId}
          personName={personName}
          rows={visible}
          carriedRows={carried}
          paymentLines={visibleLines}
          balances={balances}
          isLoading={isLoading}
          lookups={lookups}
          accountForEntry={lookups.accountForEntry}
          handlers={handlers}
          linkedTrail={linkedTrailFor(lookups, personName)}
          empty={empty}
          cycleLabelOf={cycleLabelOf}
        />
      </div>

    </section>
  );
}
