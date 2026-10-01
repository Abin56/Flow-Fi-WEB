"use client";

import { Check, CircleCheckBig, CornerDownRight } from "lucide-react";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import {
  allocationLine,
  cyclePosition,
  isInboundPayment,
  matchesStatusFilter,
  matchesTypeFilter,
  paymentGroupLabel,
  paymentGroups,
  settlementKind,
  signedSideLabel,
  TYPE_FILTER_LABEL,
  type SettlementLookups,
  type SettlementStatusFilter,
  type SettlementTypeFilter,
} from "@/features/people/lib/settlement-presentation";
import { formatStatementDate, type PersonCycleStatement, type StatementRow } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { round2 } from "@/lib/engines/person-payment";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------------

const STATUS_OPTIONS: { value: SettlementStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "partial", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
];

const TYPE_ORDER: SettlementTypeFilter[] = ["all", "emi", "loan", "assigned", "split", "manual", "payments"];

export function applySettlementFilters(
  rows: readonly LedgerRow[],
  status: SettlementStatusFilter,
  type: SettlementTypeFilter,
  lookups: SettlementLookups,
): LedgerRow[] {
  return rows.filter((r) => matchesStatusFilter(r, status) && matchesTypeFilter(settlementKind(r, lookups), type));
}

/** Compact status chips (with counts) + a type selector listing only the types present. */
export function SettlementFilters({
  rows,
  lookups,
  status,
  onStatusChange,
  type,
  onTypeChange,
  className,
}: {
  rows: readonly LedgerRow[];
  lookups: SettlementLookups;
  status: SettlementStatusFilter;
  onStatusChange: (s: SettlementStatusFilter) => void;
  type: SettlementTypeFilter;
  onTypeChange: (t: SettlementTypeFilter) => void;
  className?: string;
}) {
  const typed = rows.filter((r) => matchesTypeFilter(settlementKind(r, lookups), type));
  const count = (s: SettlementStatusFilter) => typed.filter((r) => matchesStatusFilter(r, s)).length;
  const present = TYPE_ORDER.filter((t) => t === "all" || t === type || rows.some((r) => matchesTypeFilter(settlementKind(r, lookups), t)));
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div role="radiogroup" aria-label="Status" className="flex items-center rounded-[7px] border border-border-strong bg-card p-[2px]">
        {STATUS_OPTIONS.map((o) => {
          const c = count(o.value);
          if (o.value === "overdue" && c === 0 && status !== "overdue") return null;
          const on = status === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onStatusChange(o.value)}
              className={cn(
                "flex h-6 items-center gap-1 rounded-[5px] px-2 text-[12px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                on ? "bg-foreground font-bold text-background" : "font-semibold text-foreground/75 hover:bg-secondary hover:text-foreground",
                o.value === "overdue" && !on && "text-expense",
              )}
            >
              {o.label}
              <span className={cn("tabular-nums", on ? "text-background/75" : "text-foreground/55")}>{c}</span>
            </button>
          );
        })}
      </div>
      {present.length > 2 && (
        <label className="relative">
          <span className="sr-only">Type</span>
          <select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as SettlementTypeFilter)}
            className="h-7 rounded-[7px] border border-border-strong bg-card pr-7 pl-2 text-[12px] font-semibold text-foreground outline-none focus:border-primary-accent-text"
          >
            {present.map((t) => (
              <option key={t} value={t}>
                {TYPE_FILTER_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Cycle reconciliation — a mini monthly statement, engine totals only
// ---------------------------------------------------------------------------------------------------

function Row({ label, value, side, strong, tone: t }: { label: React.ReactNode; value: number; side?: string | null; strong?: boolean; tone?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-[3px]", strong && "font-semibold")}>
      <dt className="min-w-0 text-foreground/80">
        {label}
        {side && <span className="ml-1.5 text-[11px] font-medium text-foreground/60">· {side}</span>}
      </dt>
      <dd className={cn("shrink-0 tabular-nums", strong ? "font-bold" : "font-semibold", t ?? "text-foreground")}>{money(value)}</dd>
    </div>
  );
}

export function CycleReconciliation({ statement, personName, className }: { statement: PersonCycleStatement; personName: string; className?: string }) {
  const pos = cyclePosition(statement, personName);
  const first = personName.split(" ")[0];
  const previous = pos.lines.find((l) => l.key === "previous")!;
  const added = pos.lines.find((l) => l.key === "added")!;
  const payments = pos.lines.filter((l) => l.key === "received" || l.key === "paid" || l.key === "advanceApplied");
  const cashIn = pos.cashReceived;
  const appliedIn = pos.lines.find((l) => l.key === "received")?.value ?? 0;
  const totalDue = statement.previousPending + statement.cycleActivity;
  const advanceIn = round2(statement.rows.filter((r) => r.category === "advance" && r.advanceDelta < 0).reduce((s, r) => s + r.amount, 0));
  const bothSides = statement.toReceive > 0 && statement.toGive > 0;
  const settled = statement.direction === "settled" && !bothSides;
  const tone = statement.direction === "theyOwe" ? "text-settle-receivable-text" : statement.direction === "iOwe" ? "text-settle-payable-text" : "text-success";

  return (
    <div className={className}>
      <dl className="text-[13px]">
        <Row
          label="Previous pending"
          value={previous.value}
          side={signedSideLabel(previous.signed, personName)}
          tone={Math.abs(previous.signed) >= 0.005 ? "text-settle-carried-text" : undefined}
        />
        <Row label="Added this cycle" value={added.value} side={signedSideLabel(added.signed, personName)} />
        <div className="my-0.5 border-t border-dashed border-border-strong/80" />
        <Row label="Total due" value={Math.abs(totalDue)} side={signedSideLabel(totalDue, personName)} strong />
        {payments.map((l) => (
          <Row
            key={l.key}
            label={l.label}
            value={l.value}
            tone={l.value > 0 ? (l.key === "advanceApplied" ? "text-settle-advance-text" : "text-success") : undefined}
          />
        ))}
        <div className="mt-0.5 border-t-2 border-border-strong" />
        {bothSides ? (
          // Both directions open: each is its own obligation, settled on its own — never offset.
          <>
            <div className="flex items-baseline justify-between gap-3 pt-1.5">
              <dt className="text-[12px] font-bold tracking-[0.06em] text-settle-receivable-text uppercase">You need to receive</dt>
              <dd className="font-heading text-[16px] font-bold tabular-nums text-settle-receivable-text">{money(statement.toReceive)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 pt-0.5">
              <dt className="text-[12px] font-bold tracking-[0.06em] text-settle-payable-text uppercase">You need to give</dt>
              <dd className="font-heading text-[16px] font-bold tabular-nums text-settle-payable-text">{money(statement.toGive)}</dd>
            </div>
            <p className="mt-0.5 text-right text-[11px] font-medium text-foreground/70">
              Net position {money(statement.amount)} {statement.direction === "theyOwe" ? "to receive" : statement.direction === "iOwe" ? "to give" : ""} · summary only — payments are
              settled separately.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3 pt-1.5">
              <dt className="text-[12px] font-bold tracking-[0.06em] text-foreground uppercase">{settled ? "Settled" : "Current pending"}</dt>
              <dd className={cn("font-heading text-[16px] font-bold tabular-nums", tone)}>{money(statement.amount)}</dd>
            </div>
            {!settled && <p className={cn("text-right text-[11.5px] font-semibold", tone)}>{pos.headline}</p>}
          </>
        )}
        {cashIn - appliedIn >= 0.005 && (
          <p className="mt-1 text-right text-[11.5px] font-medium text-foreground/75">
            {money(cashIn)} received from {first} this cycle · {money(appliedIn)} applied to what was due
            {advanceIn >= 0.005 && <> · {money(advanceIn)} held as advance</>}
          </p>
        )}
      </dl>
      {(pos.advance || Math.abs(statement.previousAdvance) >= 0.005) && <AdvancePosition statement={statement} personName={personName} />}
    </div>
  );
}

/**
 * Advance next to what is owed — never netted away silently. Gross outstanding stays visible; the
 * advance is money already received (or paid) ahead, and the net is what is left to collect (or pay)
 * once the user applies it. Opening → closing advance shows how it carried across cycles.
 */
function AdvancePosition({ statement, personName }: { statement: PersonCycleStatement; personName: string }) {
  const first = personName.split(" ")[0];
  const adv = statement.advanceBalance;
  const theirs = adv < 0; // they paid me ahead
  const held = Math.abs(adv);
  const opening = Math.abs(statement.previousAdvance);
  // Advance only offsets obligations on the side it can settle: their advance ↔ what they owe me.
  const offsets = held >= 0.005 && ((theirs && statement.direction === "theyOwe") || (!theirs && statement.direction === "iOwe"));
  const net = round2(statement.amount - held);
  return (
    <div className="mt-2.5 rounded-[6px] border-l-[3px] border-settle-advance-edge bg-settle-advance-tint px-2.5 py-2">
      <p className="text-[10.5px] font-bold tracking-[0.08em] text-settle-advance-text uppercase">Current position</p>
      <dl className="mt-1 space-y-0.5 text-[12.5px]">
        {opening >= 0.005 && (
          <div className="flex justify-between gap-3">
            <dt className="text-foreground/80">Opening advance</dt>
            <dd className="font-semibold tabular-nums">{money(opening)}</dd>
          </div>
        )}
        {offsets && (
          <div className="flex justify-between gap-3">
            <dt className="text-foreground/80">{statement.direction === "theyOwe" ? `You need to receive from ${first} (gross)` : `You need to give to ${first} (gross)`}</dt>
            <dd className="font-semibold tabular-nums">{money(statement.amount)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="font-semibold text-settle-advance-text">{theirs ? `Advance available from ${first}` : `Advance you paid ${first}`}</dt>
          <dd className="font-bold text-settle-advance-text tabular-nums">
            {offsets ? "− " : ""}
            {money(held)}
          </dd>
        </div>
        {offsets && (
          <div className="flex justify-between gap-3 border-t border-settle-advance-edge/50 pt-0.5">
            <dt className="font-bold text-foreground">
              {net >= 0 ? (statement.direction === "theyOwe" ? "Net to collect" : "Net to pay") : "Advance left after settling"}
            </dt>
            <dd className="font-bold tabular-nums">{money(Math.abs(net))}</dd>
          </div>
        )}
      </dl>
      <p className="mt-1 text-[11px] font-medium text-foreground/75">
        {held < 0.005
          ? "Advance fully applied this cycle."
          : theirs
            ? `Already received from ${first} — not income. Stays available across cycles until you apply it.`
            : `Already paid to ${first}. Stays available across cycles until you apply it.`}
      </p>
    </div>
  );
}

/** "✓ Settled" completion block for a cycle whose position is zero after real activity. */
export function SettledCycleNote({ statement, personName }: { statement: PersonCycleStatement; personName: string }) {
  const pos = cyclePosition(statement, personName);
  const obligations = Math.abs(statement.previousPending + statement.cycleActivity);
  const paid = pos.lines.filter((l) => l.key === "received" || l.key === "paid" || l.key === "advanceApplied").reduce((s, l) => s + l.value, 0);
  if (statement.direction !== "settled" || (obligations < 0.005 && paid < 0.005)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[8px] border border-success/60 bg-settle-receivable-tint px-3 py-2">
      <p className="flex items-center gap-1.5 text-[13px] font-bold tracking-[0.05em] text-success uppercase">
        <CircleCheckBig className="size-4" strokeWidth={2.25} />
        Settled
      </p>
      <p className="text-[12.5px] font-medium text-foreground">Everything for this cycle is settled.</p>
      <dl className="ml-auto flex gap-4 text-[12px]">
        <div>
          <dt className="inline text-foreground/70">Obligations </dt>
          <dd className="inline font-bold tabular-nums">{money(obligations)}</dd>
        </div>
        <div>
          <dt className="inline text-foreground/70">Paid </dt>
          <dd className="inline font-bold tabular-nums">{money(paid)}</dd>
        </div>
        <div>
          <dt className="inline text-foreground/70">Remaining </dt>
          <dd className="inline font-bold tabular-nums">{money(0)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Payment history for the cycle — every payment, where it went and what it was applied to
// ---------------------------------------------------------------------------------------------------

export function CyclePaymentHistory({
  statement,
  personName,
  accountForEntry,
  incomeForEntry,
  className,
}: {
  statement: PersonCycleStatement;
  personName: string;
  accountForEntry: (entryId: string | null) => string | null;
  /** The part of a payment recorded as separate income — so the history reconciles every rupee received. */
  incomeForEntry?: (entryId: string | null) => number;
  className?: string;
}) {
  const first = personName.split(" ")[0];
  const groups = paymentGroups(statement);
  if (groups.length === 0) return null;
  return (
    <section aria-label="Payment history" className={className}>
      <h3 className="mb-1.5 text-[11px] font-bold tracking-[0.08em] text-foreground/75 uppercase">Payment history · this cycle</h3>
      <ul className="divide-y divide-border-strong/50 border-y border-border-strong/70 text-[12.5px]">
        {groups.map((g) => (
          <PaymentGroup key={g[0].key} rows={g} first={first} accountForEntry={accountForEntry} incomeForEntry={incomeForEntry} />
        ))}
      </ul>
      <dl className="mt-1 space-y-0.5 text-[12.5px]">
        {statement.cashReceived > 0 && (
          <div className="flex justify-between font-semibold text-foreground">
            <dt className="flex items-center gap-1">
              <Check className="size-3.5 text-success" />
              Total received from {first}
            </dt>
            <dd className="tabular-nums">{money(statement.cashReceived)}</dd>
          </div>
        )}
        {statement.cashPaid > 0 && (
          <div className="flex justify-between font-semibold text-foreground">
            <dt className="flex items-center gap-1">
              <Check className="size-3.5" />
              Total paid to {first}
            </dt>
            <dd className="tabular-nums">{money(statement.cashPaid)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** One real payment — a single line, or (for a payment split across obligations) its allocation. */
function PaymentGroup({
  rows,
  first,
  accountForEntry,
  incomeForEntry,
}: {
  rows: StatementRow[];
  first: string;
  accountForEntry: (entryId: string | null) => string | null;
  incomeForEntry?: (entryId: string | null) => number;
}) {
  const head = rows[0];
  const entryId = head.key.startsWith("ledger:") ? head.key.slice("ledger:".length) : null;
  const account = head.category === "advanceApplied" ? null : accountForEntry(entryId);
  const inbound = isInboundPayment(head);
  const cash = rows.filter((r) => r.category !== "advanceApplied");
  // Part of the same receipt recorded as income (a separate Income transaction — every entry of a payment shares it).
  const income = incomeForEntry?.(entryId) ?? 0;
  const total = round2(cash.reduce((s, r) => s + r.amount, 0) + income);
  const label = paymentGroupLabel(rows, first);
  const edge =
    head.category === "advanceApplied" || head.category === "advance"
      ? "border-l-settle-advance-edge"
      : inbound
        ? "border-l-settle-receivable-edge"
        : "border-l-settle-carried-edge";
  const applied = rows.filter((r) => r.category !== "advance");
  const held = rows.filter((r) => r.category === "advance");
  return (
    <li className={cn("border-l-[3px] py-1.5 pr-1 pl-2", edge)}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-semibold text-foreground tabular-nums">{formatStatementDate(head.date, true)}</span>
        <span className="min-w-0 flex-1 font-semibold text-foreground">
          {label}
          {account && <span className="font-medium text-foreground/70"> → {account}</span>}
        </span>
        <span className={cn("font-bold tabular-nums", inbound ? "text-success" : "text-foreground")}>{money(rows.length > 1 || income > 0 ? total : head.amount)}</span>
      </div>
      {rows.length === 1 && income <= 0 ? (
        <p className="flex items-start gap-1 text-[11.5px] font-medium text-foreground/70">
          <CornerDownRight className="mt-0.5 size-3 shrink-0" />
          {allocationLine(head, money)}
        </p>
      ) : (
        <dl className="mt-1 ml-1 max-w-md border-l border-dashed border-border-strong pl-3 text-[12px]">
          <dt className="text-[10.5px] font-bold tracking-[0.07em] text-foreground/65 uppercase">Applied to</dt>
          {applied.map((r) => (
            <div key={r.key} className="flex justify-between gap-3">
              <dd className="flex min-w-0 items-center gap-1 text-foreground">
                <Check className="size-3 shrink-0 text-success" strokeWidth={2.5} />
                <span className="truncate">{r.settles?.title ?? "Overall balance"}</span>
              </dd>
              <dd className="font-semibold tabular-nums">{money(r.amount)}</dd>
            </div>
          ))}
          <div className="mt-0.5 flex justify-between gap-3 border-t border-border-strong/60 pt-0.5 font-semibold">
            <dt>Applied</dt>
            <dd className="tabular-nums">{money(applied.reduce((s, r) => s + r.amount, 0))}</dd>
          </div>
          {held.map((r) => (
            <div key={r.key} className="mt-1 flex justify-between gap-3 rounded-[4px] bg-settle-advance-tint px-1.5 font-bold text-settle-advance-text">
              <dt>Advance created</dt>
              <dd className="tabular-nums">{money(r.amount)}</dd>
            </div>
          ))}
          {income > 0 && (
            <div className="mt-1 flex justify-between gap-3 px-1.5 font-bold text-foreground">
              <dt>Recorded as income</dt>
              <dd className="tabular-nums">{money(income)}</dd>
            </div>
          )}
          <div className="mt-1 flex justify-between gap-3 border-t border-border-strong pt-0.5 text-[11.5px] font-semibold text-foreground/80">
            <dt>Received = applied + advance + income</dt>
            <dd className="tabular-nums">{money(total)}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}
