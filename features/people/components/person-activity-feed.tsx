"use client";

import { CheckCircle2, ChevronDown, History, Maximize2, Plus, Search } from "lucide-react";
import { useState } from "react";
import type { EntryEditValues, EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { WS_SECONDARY } from "@/features/people/components/workspace/person-workspace-ui";
import { flowOf, SettlementTable, viewOf } from "@/features/people/components/workspace/settlement-table";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PaymentLine, StatementBalance } from "@/features/people/lib/statement-balance";
import { linkedTrailFor } from "@/features/people/components/linked-funds";
import type { SettlementLookupsWithAccounts } from "@/features/people/hooks/use-settlement-lookups";
import { filterLedgerRows, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { rowMatchesTypeFilter, settlementKind } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { repaymentMix } from "@/features/people/lib/repayment-mix";
import { cn } from "@/lib/utils";

/** The filters — Money in / Money out are cash that really moved; Still owed includes part-paid items; one EMI filter. */
type LensId = "all" | "in" | "out" | "owed" | "overdue" | "emi" | "settled";
const LENSES: { id: LensId; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "in", label: "Money in" },
  { id: "out", label: "Money out" },
  { id: "owed", label: "Still owed" },
  { id: "overdue", label: "Overdue" },
  { id: "emi", label: "EMI" },
  { id: "settled", label: "Settled" },
];

export type LedgerScope = "cycle" | "all";

/**
 * One compact financial summary above the table (it replaces the two long banners): what came in this cycle, how much of it went
 * toward the overall balance, what is postponed, and what is still outstanding — each direction on its own, never netted. Every
 * figure is an existing value (`repaymentMix`, the deferral views, the person's breakdown); only shown when there is something to say.
 * "How is this counted?" holds the one-time explanation of general (no item chosen) payments.
 */
function LedgerSummary({
  statement,
  personName,
  lookups,
  outstanding,
  postponed,
  showCycle,
}: {
  statement: PersonCycleStatement | null;
  personName: string;
  lookups: SettlementLookupsWithAccounts;
  outstanding?: { toReceive: number; toGive: number };
  postponed?: { amount: number; until: string | null };
  showCycle: boolean;
}) {
  const [why, setWhy] = useState(false);
  const first = personName.split(" ")[0];
  const mix = statement && showCycle ? repaymentMix(statement) : null;
  const inbound = mix && mix.in.total >= 0.005 ? mix.in : null;
  const outbound = mix && mix.out.total >= 0.005 ? mix.out : null;
  const hasPostponed = postponed != null && postponed.amount >= 0.005;
  const credit = lookups.generalCredit;
  const sides = [
    credit && credit.theyOwe.credit >= 0.005 && { key: "in", who: first, ...credit.theyOwe },
    credit && credit.iOwe.credit >= 0.005 && { key: "out", who: "You", ...credit.iOwe },
  ].filter(Boolean) as { key: string; who: string; credit: number; owed: number }[];
  if (!inbound && !outbound && !hasPostponed && sides.length === 0) return null;

  const stats: { key: string; label: string; value: number; sub?: string; tone?: string }[] = [];
  if (inbound) stats.push({ key: "in", label: "Received this cycle", value: inbound.total, tone: "text-success", sub: inbound.toItems >= 0.005 ? `${money(inbound.toItems)} to ${inbound.itemCount} ${inbound.itemCount === 1 ? "item" : "items"}` : undefined });
  if (outbound) stats.push({ key: "out", label: "Paid this cycle", value: outbound.total, tone: "text-expense", sub: outbound.toItems >= 0.005 ? `${money(outbound.toItems)} to ${outbound.itemCount} ${outbound.itemCount === 1 ? "item" : "items"}` : undefined });
  const toBalance = (inbound?.toBalance ?? 0) + (outbound?.toBalance ?? 0);
  if (toBalance >= 0.005) stats.push({ key: "bal", label: "Toward overall balance", value: toBalance, sub: "no item chosen" });
  if (hasPostponed) stats.push({ key: "pp", label: "Postponed", value: postponed.amount, tone: "text-primary-accent-text", sub: postponed.until ? `until ${postponed.until}` : "still owed" });
  if (outstanding && outstanding.toReceive >= 0.005) stats.push({ key: "rec", label: "Outstanding · to receive", value: outstanding.toReceive, tone: "text-settle-receivable-text" });
  if (outstanding && outstanding.toGive >= 0.005) stats.push({ key: "give", label: "Outstanding · to give", value: outstanding.toGive, tone: "text-settle-payable-text" });

  return (
    <section data-testid="ledger-summary" aria-label="Financial summary" className="mb-3 rounded-[12px] border border-border bg-card px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <dl className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-2 divide-x divide-border-strong/50 [&>div:not(:first-child)]:pl-6">
          {stats.map((st) => (
            <div key={st.key} className="min-w-0" data-stat={st.key}>
              <dt className="text-[11px] font-medium text-foreground/55">{st.label}</dt>
              <dd className={cn("font-heading text-[16px] leading-tight font-bold tabular-nums", st.tone ?? "text-foreground")}>{money(st.value)}</dd>
              {st.sub && <dd className="text-[11px] leading-tight text-foreground/55 tabular-nums">{st.sub}</dd>}
            </div>
          ))}
        </dl>
        {sides.length > 0 && (
          <button
            type="button"
            aria-expanded={why}
            onClick={() => setWhy((o) => !o)}
            className="ml-auto inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[12px] font-semibold text-foreground/65 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            How is this counted?
            <ChevronDown className={cn("size-3.5 transition-transform", why && "rotate-180")} aria-hidden />
          </button>
        )}
      </div>
      {why && (
        <ul className="mt-2 list-disc space-y-0.5 border-t border-border-strong/40 pt-2 pl-5 text-[11.5px] leading-snug text-foreground/70 duration-150 animate-in fade-in-0">
          {sides.map((sd) => (
            <li key={sd.key} className="tabular-nums">
              {sd.who} paid {money(sd.credit)} toward the overall balance without choosing items · {sd.owed < 0.005 ? "nothing" : money(sd.owed)} still owed overall.
            </li>
          ))}
          <li>Those payments reduce the overall balance, but no single item was chosen — so open items stay open and read <b>Partial</b>.</li>
          <li>A postponed amount is not paid: it stays in the outstanding balance and only its due date moves.</li>
          <li>Paying the bank for an EMI (Bank paid) is separate: it never counts as {first}&apos;s payment to you.</li>
        </ul>
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
  counts: Record<LedgerScope, number>;
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
          <span className={cn("rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums", scope === value ? "bg-primary/25 text-foreground" : "bg-card/70 text-foreground/60")}>{counts[value]}</span>
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
  counts,
  cycleLabel,
  onAdd,
  onExpand,
  handlers,
  lookups,
  statement,
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
  counts: Record<LedgerScope, number>;
  cycleLabel: string;
  onAdd?: () => void;
  onExpand: () => void;
  handlers: LedgerRowHandlers;
  lookups: SettlementLookupsWithAccounts;
  /** The selected cycle's statement — its payment history and settled state. */
  statement: PersonCycleStatement | null;
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

  // Overdue respects a postponement: an amount moved to a later date is not overdue (and never paid) until that date passes.
  const isOverdue = (r: LedgerRow) =>
    r.state != null && r.state !== "settled" && (r.direction === "theyOwe" || r.direction === "iOwe") &&
    (r.overdue || (r.category === "emi" && new Date(r.date.getFullYear(), r.date.getMonth(), r.date.getDate()).getTime() < today && postponedOf(r.key) == null));
  const rowMatches = (r: LedgerRow): boolean => {
    switch (lens) {
      case "all": return true;
      case "in": return flowOf(viewOf(r, personName, lookups))?.dir === "in";
      case "out": return flowOf(viewOf(r, personName, lookups))?.dir === "out";
      case "owed": return r.state === "open" || r.state === "partial";
      case "overdue": return isOverdue(r);
      case "emi": return rowMatchesTypeFilter(r, settlementKind(r, lookups), "emi");
      case "settled": return r.state === "settled";
    }
  };
  const lineMatches = (l: PaymentLine): boolean => {
    const cash = l.payment.source === "cash";
    switch (lens) {
      case "all": return true;
      case "in": return cash && l.payment.direction === "theyPaid";
      case "out": return cash && l.payment.direction === "youPaid";
      case "emi": return l.parent.category === "emi";
      case "settled": return l.parent.state === "settled";
      default: return false;
    }
  };

  const visible = filterLedgerRows(rows, "all", search).filter(rowMatches);
  const showCarried = scope === "cycle" && !isLoading;
  const carried = showCarried ? filterLedgerRows(carriedRows, "all", search).filter(rowMatches) : [];
  const shownKeys = new Set([...rows, ...carriedRows].map((r) => r.key));
  const q = search.trim().toLowerCase();
  const visibleLines = paymentLines.filter((l) => !shownKeys.has(l.key) && lineMatches(l) && (!q || l.parent.title.toLowerCase().includes(q) || "payment".includes(q)));

  const changeScope = (next: LedgerScope) => {
    onScopeChange(next);
  };

  const empty =
    rows.length === 0 && carriedRows.length === 0 ? (
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
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 pb-2.5">
        <h2 className="sr-only">
          Transactions · {counts[scope]}
        </h2>
        <ScopeSwitch scope={scope} onScopeChange={changeScope} counts={counts} cycleLabel={cycleLabel} />
        <span className="hidden h-5 w-px bg-border-strong/60 xl:block" aria-hidden />
        {/* Quick lenses — presets over the same status / type filters */}
        <div role="group" aria-label="Quick view" className="flex min-w-0 shrink-0 flex-wrap items-center gap-1">
          {LENSES.map((l) => {
            const on = lens === l.id;
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={on}
                onClick={() => setLens(l.id)}
                className={cn(
                  "inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "bg-foreground text-background" : "text-foreground/70 hover:bg-secondary hover:text-foreground",
                )}
              >
                                {l.label}
              </button>
            );
          })}
        </div>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          {rows.length > 5 && (
            <div className="relative min-w-0 flex-1 sm:w-44 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/55" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search transactions"
                className="h-7 w-full rounded-[6px] border border-border-strong bg-card pr-3 pl-8 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground/50 focus:border-primary-accent-text"
              />
            </div>
          )}
          <button type="button" onClick={onExpand} title="Open the full transaction workspace" className={cn(WS_SECONDARY, "h-7 shrink-0 px-2.5 text-[12.5px]")}>
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
            Expand
          </button>
        </div>
      </div>

      <LedgerSummary statement={statement} personName={personName} lookups={lookups} outstanding={outstanding} postponed={postponed} showCycle={scope === "cycle"} />

      {/* The "Settled cycle" banner is retired from the main view — the totals strip above already reads Remaining ₹0. */}
      {showCarried && carriedRows.length === 0 && <CarriedForwardNote carried={carriedForward} personName={personName} className="mb-2 shrink-0" />}

      {/* Only the table scrolls on larger screens; its header row sticks */}
      <div
        key={scope}
        className={cn(
          "animate-in overflow-x-hidden rounded-[14px] border border-border bg-card duration-200 fade-in-0 sm:max-h-[calc(100dvh-13rem)] sm:min-h-[16rem] sm:overflow-y-auto sm:overscroll-contain",
        )}
      >
        <SettlementTable
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
