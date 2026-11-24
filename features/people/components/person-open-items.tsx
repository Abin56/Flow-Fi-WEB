"use client";

import { CalendarClock, CheckCircle2, HandCoins } from "lucide-react";
import { ICON_BTN, TD, TH } from "@/features/people/components/money-in-out-list";
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

type Kind = "overdue" | "due" | "postponed" | "later" | "youOwe";

const KIND: Record<Kind, { label: string; chip: string }> = {
  overdue: { label: "Overdue", chip: "text-expense" },
  due: { label: "Due", chip: "text-settle-receivable-text" },
  postponed: { label: "Postponed", chip: "text-primary-accent-text" },
  later: { label: "Upcoming", chip: "text-muted-foreground" },
  youOwe: { label: "You owe", chip: "text-settle-payable-text" },
};

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
    <div data-testid="open-items" className="@container overflow-x-auto">
      <table role="table" aria-label="Open items across all cycles" className="isolate w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(TH, "w-[6.25rem]")}>Date</th>
            <th scope="col" className={TH}>Description</th>
            <th scope="col" className={cn(TH, "w-40")}>Status</th>
            <th scope="col" className={cn(TH, "w-28 text-right sm:w-36")}>Amount</th>
            <th scope="col" className={cn(TH, "w-[6.25rem]")}>
              <span className="sr-only sm:not-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {shown.map(({ o, theirs, moved, kind }, index) => {
            const isCovered = coveredKeys.has(o.key);
            return (
              <tr key={o.key} role="row" className={cn("group transition-colors hover:bg-secondary/70", !showAll && index >= DESKTOP_PREVIEW_LIMIT && "lg:hidden")}>
                <td role="cell" className={cn(TD, "whitespace-nowrap")}>
                  <span className="text-[13px] font-semibold text-foreground">{o.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>{" "}
                  <span className="text-[11px] text-muted-foreground tabular-nums">{o.date.getFullYear()}</span>
                </td>
                <td role="cell" className={cn(TD, "max-w-0")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-[35%] shrink truncate text-[13px] leading-tight font-semibold text-foreground">{o.title}</p>
                    {!(o.isEmi && o.title.endsWith(" · EMI share")) && <span className="truncate text-[11.5px] text-muted-foreground">{o.typeLabel}</span>}
                  </div>
                </td>
                <td role="cell" className={TD}>
                  {isCovered ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success" title="You already received money from them toward the overall balance. It covers this item, but it isn't linked to it — so the item stays listed.">
                      <CheckCircle2 className="size-3.5" aria-hidden />
                      Covered
                    </span>
                  ) : (
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap", KIND[kind].chip)}>
                      {kind === "postponed" ? <CalendarClock className="size-3.5 shrink-0" aria-hidden /> : <span className="size-[5px] shrink-0 rounded-full bg-current" aria-hidden />}
                      {kind === "postponed" ? `Moved to ${moved?.date ? shortDate(moved.date, year) : `${moved?.name} cycle`}` : KIND[kind].label}
                    </span>
                  )}
                </td>
                <td role="cell" className={cn(TD, "text-right whitespace-nowrap")}>
                  <p className={cn("text-[13.5px] font-semibold tabular-nums", theirs ? "text-foreground" : "text-settle-payable-text")}>{money(o.outstanding)}</p>
                  {o.outstanding < o.amount - 0.005 && <p className="text-[11px] text-muted-foreground tabular-nums">of {money(o.amount)}</p>}
                </td>
                <td role="cell" className={cn(TD, "px-1.5")}>
                  <span className="flex items-center justify-end gap-0.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                    {onPostpone && theirs && o.isEmi && !moved && !isCovered && kind !== "later" && (
                      <button type="button" title={`Postpone — move collecting this to a later date; ${first} still owes it`} aria-label={`Postpone ${o.title}`} onClick={() => onPostpone(o.key)} className={cn(ICON_BTN, "hover:bg-primary/25")}>
                        <CalendarClock className="size-3.5" strokeWidth={1.75} aria-hidden />
                      </button>
                    )}
                    {onRecord && !isCovered && (
                      <button type="button" title={theirs ? `Record receipt — money ${first} paid you for this item` : `Record payment — money you paid ${first} for this item`} onClick={() => onRecord(o.key)} className={cn(ICON_BTN, "hover:bg-primary/25")} aria-label={`${theirs ? "Record receipt" : "Record payment"} for ${o.title}`}>
                        <HandCoins className="size-3.5" strokeWidth={1.75} aria-hidden />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        {covered > 0.005 && generalCreditOwed != null && (
          <tfoot data-testid="open-items-general" className="bg-secondary/35">
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
            <tr>
              <th scope="row" colSpan={3} className={cn(foot, "border-t border-border-strong/60 text-left font-semibold text-foreground")}>Still to collect</th>
              <td className={cn(foot, "border-t border-border-strong/60 text-right font-heading text-[14px] font-bold", generalCreditOwed < 0.005 ? "text-success" : "text-settle-receivable-text")}>{money(generalCreditOwed)}</td>
              <td className="border-t border-border-strong/60" />
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
