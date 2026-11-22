"use client";

import { CalendarClock, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const BTN =
  "inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type Kind = "overdue" | "due" | "postponed" | "later" | "youOwe";

const KIND: Record<Kind, { label: string; chip: string }> = {
  overdue: { label: "Overdue", chip: "bg-expense/10 text-expense" },
  due: { label: "Due", chip: "bg-settle-receivable-tint text-settle-receivable-text" },
  postponed: { label: "Postponed", chip: "bg-primary/20 text-primary-accent-text" },
  later: { label: "Upcoming", chip: "bg-secondary text-foreground/65" },
  youOwe: { label: "You owe", chip: "bg-settle-payable-tint text-settle-payable-text" },
};

const TH = "px-2 py-1.5 text-[10.5px] font-bold tracking-[0.06em] text-foreground/50 uppercase";

/**
 * "Open items" — one table of what is still unpaid: Due · Item · Status · Amount · actions, overdue first, then by date.
 * Totals close the table (open total, already received but not linked to an item, still to collect).
 * Actions: Received / Paid (Record payment with that item picked) and Postpone (money they owe).
 * Rows are `payableObligations` (the same list Record payment offers); nothing is computed here beyond layout.
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
  const items = obligations.map((o) => {
    const theirs = o.side === "theyOwe";
    const moved = theirs ? postponedOf(o.key) : null;
    const future = dayStart(o.date) > today;
    const pastDue = !moved && dayStart(o.date) < today && o.isEmi;
    const kind: Kind = !theirs ? "youOwe" : moved ? "postponed" : pastDue ? "overdue" : future ? "later" : "due";
    return { o, theirs, moved, kind };
  });

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] bg-success/8 px-3 py-2 text-[13px]" data-testid="open-items-empty">
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        <p className="font-semibold text-foreground">Nothing open with {first}</p>
      </div>
    );
  }

  const theirTotal = items.filter((r) => r.theirs).reduce((t, r) => t + r.o.outstanding, 0);
  const covered = generalCreditOwed != null && theirTotal > generalCreditOwed + 0.005 ? theirTotal - generalCreditOwed : 0;
  // Money received in general (no item chosen) covers the oldest items first — shown that way, nothing is written.
  const coveredKeys = new Set<string>();
  let credit = covered;
  for (const r of [...items].filter((x) => x.theirs).sort((a, b) => a.o.date.getTime() - b.o.date.getTime())) {
    if (credit >= r.o.outstanding - 0.005 && r.o.outstanding > 0.005) {
      coveredKeys.add(r.o.key);
      credit -= r.o.outstanding;
    }
  }
  const ordered = [...items].sort((a, b) => Number(b.kind === "overdue") - Number(a.kind === "overdue") || a.o.date.getTime() - b.o.date.getTime());
  const shown = showAll ? ordered : ordered.slice(0, 8);
  const foot = "px-2 py-1 text-[12px] tabular-nums";

  return (
    <div data-testid="open-items">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border-strong/60">
            <th scope="col" className={cn(TH, "w-16")}>Due</th>
            <th scope="col" className={TH}>Item</th>
            <th scope="col" className={cn(TH, "w-32")}>Status</th>
            <th scope="col" className={cn(TH, "w-24 text-right")}>Amount</th>
            <th scope="col" className={cn(TH, "w-[10.5rem]")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-strong/30">
          {shown.map(({ o, theirs, moved, kind }) => {
            const isCovered = coveredKeys.has(o.key);
            return (
            <tr key={o.key} className="transition-colors hover:bg-secondary/40">
              <td className="px-2 py-1.5 text-[12px] whitespace-nowrap text-foreground/70 tabular-nums">{shortDate(o.date)}</td>
              <td className="max-w-0 px-2 py-1.5">
                <span className="block truncate text-[13px] font-semibold text-foreground">
                  {o.title} <span className="text-[11px] font-normal text-foreground/45">{o.typeLabel}</span>
                </span>
              </td>
              <td className="px-2 py-1.5">
                {isCovered ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-px text-[10.5px] font-semibold whitespace-nowrap text-success" title="You already received money from them toward the overall balance. It covers this item, but it isn't linked to it — so the item stays listed.">
                    <CheckCircle2 className="size-3" aria-hidden />
                    Covered
                  </span>
                ) : (
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-px text-[10.5px] font-semibold whitespace-nowrap", KIND[kind].chip)}>
                    {kind === "postponed" && <CalendarClock className="size-3" aria-hidden />}
                    {kind === "postponed" ? `To ${moved?.date ? shortDate(moved.date) : `${moved?.name} cycle`}` : KIND[kind].label}
                  </span>
                )}
              </td>
              <td className={cn("px-2 py-1.5 text-right font-heading text-[13.5px] font-bold whitespace-nowrap tabular-nums", theirs ? "text-settle-receivable-text" : "text-settle-payable-text")}>
                {money(o.outstanding)}
                {o.outstanding < o.amount - 0.005 && <span className="block text-[10px] font-medium text-foreground/45">of {money(o.amount)}</span>}
              </td>
              <td className="px-2 py-1.5">
                <span className="flex items-center justify-end gap-1">
                  {onPostpone && theirs && o.isEmi && !moved && !isCovered && kind !== "later" && (
                    <button type="button" title={`Move collecting this to a later date — ${first} still owes it`} onClick={() => onPostpone(o.key)} className={cn(BTN, "border border-border-strong text-foreground/80 hover:border-primary-accent-text hover:text-foreground")}>
                      Postpone
                    </button>
                  )}
                  {onRecord && !isCovered && (
                    <button type="button" title={theirs ? `Record money ${first} paid you for this item` : `Record money you paid ${first} for this item`} onClick={() => onRecord(o.key)} className={cn(BTN, "bg-primary text-primary-foreground hover:brightness-95")} aria-label={`${theirs ? "Received" : "Paid"} · ${o.title}`}>
                      {theirs ? "Received" : "Paid"}
                    </button>
                  )}
                </span>
              </td>
            </tr>
            );
          })}
        </tbody>
        {covered > 0.005 && generalCreditOwed != null && (
          <tfoot data-testid="open-items-general" className="border-t border-border-strong/60">
            <tr>
              <th scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")}>Total open</th>
              <td className={cn(foot, "text-right font-semibold text-foreground")}>{money(theirTotal)}</td>
              <td />
            </tr>
            <tr>
              <th scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")} title="Money they paid you toward the overall balance, not linked to any one item">
                Already received (not linked to an item)
              </th>
              <td className={cn(foot, "text-right font-semibold text-success")}>− {money(covered)}</td>
              <td />
            </tr>
            <tr className="border-t border-border-strong/60">
              <th scope="row" colSpan={3} className={cn(foot, "text-left font-semibold text-foreground")}>Still to collect</th>
              <td className={cn(foot, "text-right font-heading text-[14px] font-bold", generalCreditOwed < 0.005 ? "text-success" : "text-settle-receivable-text")}>{money(generalCreditOwed)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      {items.length > 8 && (
        <button type="button" onClick={() => setShowAll((s) => !s)} className="mt-1 rounded-[4px] text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
