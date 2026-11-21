"use client";

import { AlertCircle, ArrowDownLeft, ArrowUpRight, CalendarClock, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const BTN =
  "inline-flex h-7 items-center rounded-full px-2.5 text-[11.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * "Open items" — the person's unpaid obligations as a to-do list (overdue first), each with the existing actions:
 * Record (opens Record payment with that item picked) and, for money they owe, Postpone (same sheet, postpone intent).
 * Rows are `payableObligations` (the same list Record payment offers); nothing is computed here beyond ordering.
 */
export function PersonOpenItems({
  personName,
  obligations,
  onRecord,
  onPostpone,
  generalCreditOwed,
}: {
  personName: string;
  obligations: PayableObligation[];
  onRecord?: (key: string) => void;
  onPostpone?: (key: string) => void;
  /** When payments toward the overall balance exist: what is still owed overall (items alone overstate it). */
  generalCreditOwed?: number | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const postponedOf = usePostponedLookup();
  const first = personName.split(" ")[0];
  const today = dayStart(new Date());
  const items = obligations
    .map((o) => {
      const moved = o.side === "theyOwe" ? postponedOf(o.key) : null;
      const pastDue = !moved && dayStart(o.date) < today && o.isEmi;
      const future = dayStart(o.date) > today;
      return { o, moved, pastDue, future };
    })
    .sort((a, b) => Number(b.pastDue) - Number(a.pastDue) || Number(a.future) - Number(b.future) || a.o.date.getTime() - b.o.date.getTime());

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-[12px] bg-success/8 px-3 py-3 text-[13px]" data-testid="open-items-empty">
        <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
        <div>
          <p className="font-semibold text-foreground">Nothing open with {first}</p>
          <p className="text-[12px] text-foreground/60">Every item is settled. New ones appear here with a one-tap Record button.</p>
        </div>
      </div>
    );
  }

  const shown = showAll ? items : items.slice(0, 5);
  const theirTotal = obligations.filter((o) => o.side === "theyOwe").reduce((t, o) => t + o.outstanding, 0);
  return (
    <div data-testid="open-items">
      <ul className="divide-y divide-border-strong/40">
        {shown.map(({ o, moved, pastDue, future }, i) => {
          const theirs = o.side === "theyOwe";
          const Icon = theirs ? ArrowDownLeft : ArrowUpRight;
          return (
            <li
              key={o.key}
              className="group/item flex animate-in items-center gap-2.5 py-1.5 fade-in-0 fill-mode-both slide-in-from-bottom-1"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full",
                  pastDue ? "bg-expense/10 text-expense" : theirs ? "bg-settle-receivable-tint text-settle-receivable-text" : "bg-settle-payable-tint text-settle-payable-text",
                )}
                aria-hidden
              >
                {pastDue ? <AlertCircle className="size-4" strokeWidth={2} /> : <Icon className="size-4" strokeWidth={2.25} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold text-foreground">{o.title}</span>
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-foreground/60">
                  <span>{o.typeLabel}</span>
                  <span aria-hidden>·</span>
                  {moved ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-primary-accent-text">
                      <CalendarClock className="size-3" aria-hidden />
                      Postponed to {moved.date ? shortDate(moved.date) : `${moved.name} cycle`}
                    </span>
                  ) : pastDue ? (
                    <span className="font-semibold text-expense">Overdue since {shortDate(o.date)}</span>
                  ) : (
                    <span>{future ? `Due ${shortDate(o.date)}` : shortDate(o.date)}</span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end">
                <span className={cn("font-heading text-[14px] font-bold tabular-nums", theirs ? "text-settle-receivable-text" : "text-settle-payable-text")}>{money(o.outstanding)}</span>
                <span className="text-[10.5px] font-medium text-foreground/50">
                  {o.outstanding < o.amount - 0.005 ? `left of ${money(o.amount)}` : theirs ? `${first} owes you` : `you owe ${first}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {onRecord && (
                  <button type="button" onClick={() => onRecord(o.key)} className={cn(BTN, "bg-primary text-primary-foreground hover:brightness-95")} aria-label={`${theirs ? "Received" : "Paid"} · ${o.title}`}>
                    {theirs ? "Received" : "Paid"}
                  </button>
                )}
                {onPostpone && theirs && o.isEmi && !moved && (
                  <button type="button" onClick={() => onPostpone(o.key)} className={cn(BTN, "border border-border-strong text-foreground/80 hover:border-primary-accent-text hover:text-foreground")}>
                    Postpone
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > 5 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-1 rounded-[4px] text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
      {/* General payments (no item chosen) stay their own line — they lower what is owed without marking any item paid. */}
      {generalCreditOwed != null && theirTotal > generalCreditOwed + 0.005 && (
        <dl data-testid="open-items-general" className="mt-1.5 rounded-[10px] bg-secondary/50 px-3 py-2 text-[12px] tabular-nums">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-foreground/70">Open items</dt>
            <dd className="font-semibold text-foreground">{money(theirTotal)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-foreground/70">
              <span className="size-2 rounded-[3px] bg-settle-receivable-edge" aria-hidden />
              Paid toward overall balance <span className="text-[11px] text-foreground/50">· no item chosen</span>
            </dt>
            <dd className="font-semibold text-foreground">−{money(theirTotal - generalCreditOwed)}</dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border-strong/60 pt-1">
            <dt className="font-semibold text-foreground">Still owed overall</dt>
            <dd className="font-heading text-[14px] font-bold text-settle-receivable-text">{money(generalCreditOwed)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
