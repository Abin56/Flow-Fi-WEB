"use client";

import { CalendarClock, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { usePostponedLookup } from "@/features/people/components/linked-emis-panel";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const shortDate = (d: Date, year: number) => d.toLocaleDateString("en-IN", {
  day: "numeric",
  month: "short",
  year: d.getFullYear() === year ? undefined : "numeric",
});
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const BTN =
  "inline-flex min-h-8 shrink-0 items-center rounded-[5px] border px-2.5 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type Kind = "overdue" | "due" | "postponed" | "later" | "youOwe";

const KIND: Record<Kind, { label: string; chip: string }> = {
  overdue: { label: "Overdue", chip: "text-expense" },
  due: { label: "Due", chip: "text-settle-receivable-text" },
  postponed: { label: "Postponed", chip: "text-primary-accent-text" },
  later: { label: "Upcoming", chip: "text-muted-foreground" },
  youOwe: { label: "You owe", chip: "text-settle-payable-text" },
};

const TH = "border-y border-border-subtle px-3 py-2 text-[11px] font-semibold tracking-[0.045em] text-muted-foreground uppercase";
const DESKTOP_PREVIEW_LIMIT = 4;
const PREVIEW_LIMIT = 8;

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
  const now = new Date();
  const today = dayStart(now);
  const year = now.getFullYear();
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
      <div className="flex items-center gap-2.5 border-t border-border-subtle px-3.5 py-4 sm:px-5" data-testid="open-items-empty">
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        <p className="text-sm font-semibold text-foreground">No open items with {first}</p>
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
  const shown = showAll ? ordered : ordered.slice(0, PREVIEW_LIMIT);
  const foot = "px-2 py-1 text-[12px] tabular-nums";

  return (
    <div data-testid="open-items" className="@container">
      <table role="table" aria-label="Open items across all cycles" className="w-full border-collapse text-left @max-[32rem]:block">
        <thead className="@max-[32rem]:sr-only">
          <tr className="bg-secondary/35">
            <th scope="col" className={cn(TH, "w-[6.75rem] pl-5")}>Date</th>
            <th scope="col" className={TH}>Item</th>
            <th scope="col" className={cn(TH, "w-[8.75rem]")}>Status</th>
            <th scope="col" className={cn(TH, "w-[8rem] text-right")}>Amount</th>
            <th scope="col" className={cn(TH, "w-[13.5rem] pr-5 text-right")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup" className="divide-y divide-border-subtle @max-[32rem]:block @max-[32rem]:border-t @max-[32rem]:border-border-subtle">
          {shown.map(({ o, theirs, moved, kind }, index) => {
            const isCovered = coveredKeys.has(o.key);
            return (
              <tr key={o.key} role="row" className={cn("transition-colors hover:bg-secondary/30 @max-[32rem]:grid @max-[32rem]:grid-cols-[minmax(0,1fr)_auto] @max-[32rem]:items-start @max-[32rem]:gap-x-2 @max-[32rem]:gap-y-1 @max-[32rem]:px-3.5 @max-[32rem]:py-2.5 lg:[&>td]:py-1.5", !showAll && index >= DESKTOP_PREVIEW_LIMIT && "lg:hidden")}>
                <td role="cell" className="px-3 py-2 pl-5 text-xs whitespace-nowrap text-muted-foreground tabular-nums @max-[32rem]:col-start-1 @max-[32rem]:row-start-2 @max-[32rem]:p-0">{shortDate(o.date, year)}</td>
                <td role="cell" className="min-w-0 px-3 py-2 @max-[32rem]:col-start-1 @max-[32rem]:row-start-1 @max-[32rem]:p-0">
                  <span className="block text-sm leading-snug font-semibold break-words text-foreground">
                    {o.title}
                  </span>
                  {!(o.isEmi && o.title.endsWith(" · EMI share")) && <span className="mt-0.5 block text-xs text-muted-foreground">{o.typeLabel}</span>}
                </td>
                <td role="cell" className="px-3 py-2 @max-[32rem]:col-start-2 @max-[32rem]:row-start-2 @max-[32rem]:justify-self-end @max-[32rem]:p-0">
                  {isCovered ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success" title="You already received money from them toward the overall balance. It covers this item, but it isn't linked to it — so the item stays listed.">
                      <CheckCircle2 className="size-3" aria-hidden />
                      Covered
                    </span>
                  ) : (
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", KIND[kind].chip)}>
                      {kind === "postponed" ? <CalendarClock className="size-3 shrink-0" aria-hidden /> : <span className="size-[5px] shrink-0 rounded-full bg-current" aria-hidden />}
                      {kind === "postponed" ? `Moved to ${moved?.date ? shortDate(moved.date, year) : `${moved?.name} cycle`}` : KIND[kind].label}
                    </span>
                  )}
                </td>
                <td role="cell" className={cn("px-3 py-2 text-right text-sm font-semibold whitespace-nowrap tabular-nums @max-[32rem]:col-start-2 @max-[32rem]:row-start-1 @max-[32rem]:p-0", theirs ? "text-foreground" : "text-settle-payable-text")}>
                  {money(o.outstanding)}
                  {o.outstanding < o.amount - 0.005 && <span className="block text-[10px] font-medium text-foreground/45">of {money(o.amount)}</span>}
                </td>
                <td role="cell" className="px-3 py-2 pr-5 @max-[32rem]:col-span-2 @max-[32rem]:p-0">
                  <span className="flex items-center justify-end gap-1.5 empty:hidden">
                    {onPostpone && theirs && o.isEmi && !moved && !isCovered && kind !== "later" && (
                      <button type="button" title={`Move collecting this to a later date — ${first} still owes it`} onClick={() => onPostpone(o.key)} className={cn(BTN, "border-border text-foreground hover:border-border-strong hover:bg-secondary")}>
                        Postpone
                      </button>
                    )}
                    {onRecord && !isCovered && (
                      <button type="button" title={theirs ? `Record money ${first} paid you for this item` : `Record money you paid ${first} for this item`} onClick={() => onRecord(o.key)} className={cn(BTN, "border-[#aabeb0] bg-[#edf4ee] text-[#244237] hover:bg-[#deebdf] dark:border-[#527460] dark:bg-[#253a2f] dark:text-[#e0eedf] dark:hover:bg-[#314a3c]")} aria-label={`${theirs ? "Record receipt" : "Record payment"} for ${o.title}`}>
                        {theirs ? "Record receipt" : "Record payment"}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        {covered > 0.005 && generalCreditOwed != null && (
          <tfoot data-testid="open-items-general" className="border-t border-border bg-secondary/35 @max-[32rem]:table @max-[32rem]:w-full">
            <tr>
              <th scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")}>Total open</th>
              <td className={cn(foot, "text-right font-semibold text-foreground")}>{money(theirTotal)}</td>
              <td />
            </tr>
            <tr>
              <th scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")} title="Money they paid you toward the overall balance, not linked to any one item">
                Received toward the overall balance
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
      {items.length > DESKTOP_PREVIEW_LIMIT && (
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)} className={cn("mx-3.5 my-1 min-h-9 rounded-[5px] px-2 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring sm:mx-5 lg:min-h-7", items.length <= PREVIEW_LIMIT && "max-lg:hidden")}>
          {showAll ? "Show fewer items" : `Show all ${items.length} items`}
        </button>
      )}
    </div>
  );
}
