"use client";

import { CheckCircle2, History, Maximize2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { EntryEditForm, isEditable, type EntryEditValues, type EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { transactionHref } from "@/features/people/lib/people-return-link";
import { WS_SECONDARY } from "@/features/people/components/workspace/person-workspace-ui";
import { cashOf, tableTypeLabel } from "@/features/people/components/workspace/settlement-table";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PaymentLine, StatementBalance } from "@/features/people/lib/statement-balance";
import type { SettlementLookupsWithAccounts } from "@/features/people/hooks/use-settlement-lookups";
import { filterLedgerRows, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { isSplit, type Expense } from "@/lib/models/expense";
import { MoneyInOutList, type MoneyItem } from "@/features/people/components/money-in-out-list";
import { isGenericRowTitle, settlementKind } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { isOriginationTransactionId } from "@/lib/engines/loan-origination";
import { money } from "@/lib/engines/person-cycle-statement-share";
import type { Transaction } from "@/lib/models/transaction";
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
  preview,
  expenses = [],
}: {
  /** Expenses, only to show who shared a paid-for item (display only). */
  expenses?: readonly Expense[];
  /** Overview mode: the same table, newest `limit` rows only, with a "View all" that opens the Transactions tab. */
  preview?: { limit: number; onViewAll: () => void };
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
  const receivedEarlier = (entryId: string | null) => entryId != null && lookups.entriesById.get(entryId)?.recordedEarlier === true;
  const paidDirectly = (entryId: string | null) => entryId != null && isPaidDirectlyEntry(lookups.entriesById.get(entryId));

  // Overdue respects a postponement: an amount moved to a later date is not overdue (and never paid) until that date passes.
  const isOverdue = (r: LedgerRow) =>
    r.state != null && r.state !== "settled" && (r.direction === "theyOwe" || r.direction === "iOwe") &&
    (r.overdue || (r.category === "emi" && new Date(r.date.getFullYear(), r.date.getMonth(), r.date.getDate()).getTime() < today && postponedOf(r.key) == null));
  // What the history lists: every recorded transaction with this person — money received / paid, and the shared,
  // paid-for-them and paid-for-you items (marked, never counted as cash). Loan / EMI schedules, installments and the
  // opening balance are not transactions here, so they never appear.
  const listedKinds = new Set(["split", "assigned", "adjustment", "moneyReceived"]);
  const isListed = (r: LedgerRow): boolean => {
    const meta = metadata.get(r.key);
    return meta != null && (meta.cash != null || listedKinds.has(meta.kind));
  };
  /** Which way a row points for the person: cash direction, else who owes whom. */
  const dirOf = (r: LedgerRow): "in" | "out" | null => {
    const meta = metadata.get(r.key);
    if (meta?.cash) return meta.cash.dir;
    if (meta?.kind === "adjustment") return null;
    return r.direction === "iOwe" ? "in" : "out";
  };
  const rowMatchesLens = (lens: LensId, r: LedgerRow): boolean => (lens === "all" ? isListed(r) : isListed(r) && dirOf(r) === (lens === "in" ? "in" : "out"));
  const lineMatchesLens = (lens: LensId, l: PaymentLine): boolean => {
    if (l.payment.source !== "cash") return false;
    return lens === "all" || (lens === "in" ? l.payment.direction === "theyPaid" : l.payment.direction === "youPaid");
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
  const hasFilters = search.trim() !== "" || lens !== "all";
  const matchingCount = visible.length + carried.length + visibleLines.length;
  const clearFilters = () => {
    setSearch("");
    setLens("all");
  };

  // "Money in & out": one plain line per movement that really happened — never an obligation or a schedule.
  const notesByTransaction = new Map(transactions.map((t) => [t.id, t.notes?.trim() ?? ""]));
  const noteOfEntry = (entryId: string | null): string | null => {
    const ref = entryId ? lookups.entriesById.get(entryId)?.transactionRef : null;
    return (ref ? notesByTransaction.get(ref) : null) || null;
  };
  // The same handlers the table used — nothing new is written from here.
  const paymentActions = (parent: LedgerRow, p: PaymentRecord): MoneyItem["actions"] => [
    ...(handlers.editablePayment?.(p) && handlers.onEditPayment ? [{ id: "edit" as const, onClick: () => handlers.onEditPayment!(p) }] : []),
    ...(p.undo && handlers.onUndoPayment ? [{ id: "revert" as const, onClick: () => handlers.onUndoPayment!(parent, p) }] : []),
  ];
  const splitOfEntry = (entryId: string | null): MoneyItem["split"] => {
    const ref = entryId ? lookups.entriesById.get(entryId)?.transactionRef : null;
    const expense = ref ? expenses.find((e) => e.transactionId === ref && e.deletedAt == null) : null;
    if (!expense || !isSplit(expense)) return undefined;
    return { total: expense.totalAmount, participants: expense.participants.map((p) => ({ name: p.isMe ? "You" : p.name, share: p.share, isMe: p.isMe, isThisPerson: p.personId === personId })) };
  };
  const hrefOfEntry = (entryId: string | null): string | null => {
    const ref = entryId ? lookups.entriesById.get(entryId)?.transactionRef : null;
    return ref ? transactionHref(ref, lookups.sourceReturn) : null;
  };
  const captionOf = (row: LedgerRow): string | null => {
    if (row.state == null || row.remaining == null) return null;
    if (row.state === "settled" || row.remaining < 0.005) return "Settled";
    return `${money(row.remaining)} ${row.direction === "iOwe" ? "to pay" : "to receive"}`;
  };
  const moneyItems: MoneyItem[] = [
    ...visible.flatMap((row): MoneyItem[] => {
      const meta = metadata.get(row.key);
      if (!meta) return [];
      const cash = meta.cash;
      const dir = dirOf(row) ?? "out";
      const manual = meta.kind === "moneyGiven" || meta.kind === "moneyReceived";
      const own = row.ownPayment;
      const editing = handlers.editingKey === row.key;
      const actions: MoneyItem["actions"] = [
        ...(row.settle && row.state !== "settled" && !row.key.startsWith("loan") && row.direction !== "iOwe" ? [{ id: "record" as const, onClick: () => handlers.onSettleStart(row) }] : []),
        ...(own ? paymentActions(row, own) ?? [] : []),
        ...(!own && isEditable(row) && handlers.onEditStart ? [{ id: "edit" as const, onClick: () => (editing ? handlers.onEditCancel?.() : handlers.onEditStart!(row)) }] : []),
        ...(!own && row.deletable && handlers.onDelete ? [{ id: "delete" as const, onClick: () => handlers.onDelete!(row) }] : []),
      ];
      return [{
        key: row.key,
        date: row.date,
        createdAt: row.createdAt,
        dir,
        kind: cash ? "cash" : "owed",
        amount: cash ? cash.amount : row.amount,
        title: cash ? (dir === "in" ? `Received from ${firstName}` : `Paid to ${firstName}`) : meta.kind === "adjustment" ? "Balance correction" : dir === "in" ? `${firstName} paid for you` : `Paid for ${firstName}`,
        description: noteOfEntry(row.entryId) ?? ((manual || !cash) && !row.recordedLoanCash && !isGenericRowTitle(row.title) ? row.title : null),
        account: row.recordedLoanCash?.account ?? lookups.accountForEntry(row.entryId) ?? null,
        earlier: receivedEarlier(row.entryId),
        direct: paidDirectly(row.entryId),
        caption: captionOf(row),
        openHref: hrefOfEntry(row.entryId),
        split: cash ? undefined : splitOfEntry(row.entryId),
        actions,
        extra: editing && handlers.onEditSubmit ? (
          <div className="border-t border-border-subtle px-3 py-2"><EntryEditForm row={row} onCancel={() => handlers.onEditCancel?.()} onSubmit={(values) => handlers.onEditSubmit!(row, values)} /></div>
        ) : undefined,
      }];
    }),
    ...visibleLines.map((l): MoneyItem => ({
      key: l.key,
      date: l.payment.date,
      createdAt: l.payment.date,
      dir: l.payment.direction === "theyPaid" ? "in" : "out",
      kind: "cash",
      amount: l.payment.amount,
      title: l.payment.direction === "theyPaid" ? `Received from ${firstName}` : `Paid to ${firstName}`,
      description: noteOfEntry(l.payment.entryId),
      account: lookups.accountForEntry(l.payment.entryId) ?? null,
      earlier: receivedEarlier(l.payment.entryId),
      direct: paidDirectly(l.payment.entryId),
      caption: null,
      openHref: hrefOfEntry(l.payment.entryId),
      actions: paymentActions(l.parent, l.payment) ?? [],
    })),
  ];
  // Money really received / paid — shared and paid-for items are listed but never added here.
  const moneyIn = moneyItems.filter((m) => m.kind === "cash" && m.dir === "in").reduce((n, m) => n + m.amount, 0);
  const moneyOut = moneyItems.filter((m) => m.kind === "cash" && m.dir === "out").reduce((n, m) => n + m.amount, 0);

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

  if (preview) {
    return (
      <section data-testid="person-overview-transactions" aria-label="Recent transactions" className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <h2 className="font-heading text-base font-semibold">Recent transactions</h2>
            <p className="text-xs text-muted-foreground tabular-nums">{scope === "all" ? "All dates" : cycleRange}</p>
          </div>
          {moneyItems.length > preview.limit && (
            <button type="button" onClick={preview.onViewAll} className="inline-flex min-h-7 items-center gap-1 rounded-[5px] px-1.5 text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              View all transactions ({moneyItems.length})
            </button>
          )}
        </div>
        <MoneyInOutList
          items={moneyItems}
          isLoading={isLoading}
          maxRows={preview.limit}
          empty={<p className="px-3 py-4 text-sm font-medium text-foreground/75">{`No money has moved with ${firstName} in this ${scope === "cycle" ? "cycle" : "history"} yet.`}</p>}
        />
      </section>
    );
  }

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
              {LENSES.filter((o) => o.id === "all" || o.id === "in" || o.id === "out").map((option) => <option key={option.id} value={option.id}>{option.id === "all" ? "All money" : option.label}</option>)}
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

      {!isLoading && (
        <div data-testid="money-summary" className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-[10px] border border-border bg-card px-3 py-2 text-xs shadow-e1">
          <span className="text-muted-foreground">Received <span className="font-heading text-sm font-bold text-success tabular-nums">{money(moneyIn)}</span></span>
          <span className="text-muted-foreground">Paid <span className="font-heading text-sm font-bold text-expense tabular-nums">{money(moneyOut)}</span></span>
          {/* Remaining = the person's actual current balance (same figures as the header), each direction on its own — not Received − Paid. */}
          {(outstanding?.toReceive ?? 0) >= 0.005 && <span className="text-muted-foreground" data-testid="money-remaining">To receive <span className="font-heading text-sm font-bold text-settle-receivable-text tabular-nums">{money(outstanding!.toReceive)}</span></span>}
          {(outstanding?.toGive ?? 0) >= 0.005 && <span className="text-muted-foreground" data-testid="money-remaining-pay">To pay <span className="font-heading text-sm font-bold text-settle-payable-text tabular-nums">{money(outstanding!.toGive)}</span></span>}
          {(outstanding?.toReceive ?? 0) < 0.005 && (outstanding?.toGive ?? 0) < 0.005 && (
            <span className="text-muted-foreground" data-testid="money-remaining">Remaining <span className="font-heading text-sm font-bold text-foreground tabular-nums">{money(0)}</span> <span className="font-semibold text-success">— Settled</span></span>
          )}
        </div>
      )}
      {/* The "Settled cycle" banner is retired from the main view — the totals strip above already reads Remaining ₹0. */}
      {!isLoading && hasFilters && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          <span role="status" className="text-muted-foreground tabular-nums">{matchingCount} matching {matchingCount === 1 ? "entry" : "entries"}</span>
          <button type="button" onClick={clearFilters} className="min-h-7 rounded-[5px] px-1.5 font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">Clear filters</button>
        </div>
      )}

      {/* Only the table scrolls on larger screens; its header row sticks */}
      <MoneyInOutList items={moneyItems} isLoading={isLoading} empty={sourceRows.length === 0 && appliedPayments.length === 0 ? empty : <p className="px-3 py-4 text-sm font-medium text-foreground/75">{hasFilters ? "No money movements match this search or filter." : `No money has moved with ${firstName} in this ${scope === "cycle" ? "cycle" : "history"} yet.`}</p>} />

    </section>
  );
}
