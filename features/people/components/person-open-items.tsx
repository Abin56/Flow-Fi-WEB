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

/** A paid-for-them expense is stored as a "gave" share, but no cash was handed over — say what it was. */
function captionOf(o: PayableObligation, first: string): string {
  const assigned = (o.target.kind === "split" && o.target.sourceKind === "assignedExpense") || (o.target.kind === "entry" && o.target.entry.sourceKind === "assignedExpense");
  return assigned ? `You paid for ${first}` : o.typeLabel;
}

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
  const cell = cn(TD, "@max-[40rem]:block @max-[40rem]:border-0 @max-[40rem]:p-0");
  const amountCell = cn(cell, "text-right text-[13px] font-semibold whitespace-nowrap tabular-nums");
  const mobileLabel = "mr-1.5 text-xs font-medium text-muted-foreground @min-[40rem]:hidden";

  return (
    <div data-testid="open-items" className="@container">
      <table role="table" aria-label="Open items across all cycles" className="isolate w-full border-separate border-spacing-0 text-sm @max-[40rem]:block">
        <thead role="rowgroup" className="@max-[40rem]:sr-only">
          <tr role="row">
            <th role="columnheader" scope="col" className={cn(TH, "w-[7rem]")}>Date</th>
            <th role="columnheader" scope="col" className={TH}>Item</th>
            <th role="columnheader" scope="col" className={cn(TH, "w-[7rem] text-right")}>Paid</th>
            <th role="columnheader" scope="col" className={cn(TH, "w-[7rem] text-right")}>Pending</th>
            <th role="columnheader" scope="col" className={cn(TH, "w-[9rem]")}>Status</th>
            <th role="columnheader" scope="col" className={cn(TH, "w-[5rem]")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup" className="@max-[40rem]:block @max-[40rem]:space-y-1.5 @max-[40rem]:px-3 @max-[40rem]:pb-2">
          {shown.map(({ o, theirs, moved, kind }, index) => {
            const isCovered = coveredKeys.has(o.key);
            const paid = Math.max(0, o.amount - o.outstanding);
            const title = o.isEmi ? o.title.replace(/ · EMI share$/, "") : o.title;
            const caption = o.isEmi ? (/\bEMI\b/i.test(title) ? null : "EMI") : captionOf(o, first);
            return (
              <tr key={o.key} role="row" className={cn("group transition-colors hover:bg-secondary/50 @max-[40rem]:grid @max-[40rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @max-[40rem]:items-center @max-[40rem]:gap-x-2 @max-[40rem]:gap-y-1 @max-[40rem]:rounded-lg @max-[40rem]:border @max-[40rem]:border-border @max-[40rem]:px-2.5 @max-[40rem]:py-1.5", !showAll && index >= DESKTOP_PREVIEW_LIMIT && "lg:hidden")}>
                <td role="cell" className={cn(cell, "whitespace-nowrap text-xs text-muted-foreground tabular-nums @max-[40rem]:col-start-1 @max-[40rem]:row-start-2")}>
                  {o.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td role="cell" className={cn(cell, "@max-[40rem]:col-span-2 @max-[40rem]:col-start-1 @max-[40rem]:row-start-1 @min-[40rem]:max-w-0")}>
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-[13px] font-semibold text-foreground" title={title}>{title}</span>
                    {caption && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{caption}</span>}
                  </div>
                </td>
                <td role="cell" className={cn(amountCell, "text-muted-foreground @max-[40rem]:col-start-1 @max-[40rem]:row-start-3 @max-[40rem]:text-left")}>
                  <span aria-hidden className={mobileLabel}>Paid</span>
                  <span className={paid > 0.005 ? "text-success" : undefined}>{money(paid)}</span>
                </td>
                <td role="cell" className={cn(amountCell, "@max-[40rem]:col-span-2 @max-[40rem]:col-start-2 @max-[40rem]:row-start-3", isCovered ? "text-muted-foreground" : !theirs ? "text-settle-payable-text" : kind === "overdue" ? "text-expense" : "text-foreground")}>
                  <span aria-hidden className={mobileLabel}>Pending</span>
                  {money(o.outstanding)}
                </td>
                <td role="cell" className={cn(cell, "@max-[40rem]:col-span-2 @max-[40rem]:col-start-2 @max-[40rem]:row-start-2 @max-[40rem]:text-right")}>
                  {isCovered ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success" title="You already received money from them toward the overall balance. It covers this item, but it isn't linked to it — so the item stays listed.">
                      <CheckCircle2 className="size-3.5" aria-hidden />
                      Covered
                    </span>
                  ) : (
                    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-semibold @max-[40rem]:justify-end", KIND[kind].chip)}>
                      {kind === "postponed" ? <CalendarClock className="size-3.5 shrink-0" aria-hidden /> : <span className="size-[5px] shrink-0 rounded-full bg-current" aria-hidden />}
                      {KIND[kind].label}
                      {moved && <span className="text-[11px] font-medium">{moved.date ? shortDate(moved.date, year) : `${moved.name} cycle`}</span>}
                    </span>
                  )}
                </td>
                <td role="cell" className={cn(cell, "px-1.5 @max-[40rem]:col-start-3 @max-[40rem]:row-start-1")}>
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
          <tfoot role="rowgroup" data-testid="open-items-general" className="bg-secondary/35 @max-[40rem]:block @max-[40rem]:px-2">
            <tr role="row" className="@max-[40rem]:flex @max-[40rem]:justify-between">
              <th role="rowheader" scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")}>Total open</th>
              <td role="cell" className={cn(foot, "text-right font-semibold text-foreground")}>{money(theirTotal)}</td>
              <td role="cell" colSpan={2} className="@max-[40rem]:hidden" />
            </tr>
            <tr role="row" className="@max-[40rem]:flex @max-[40rem]:justify-between">
              <th role="rowheader" scope="row" colSpan={3} className={cn(foot, "text-left font-medium text-foreground/65")} title="Money they paid you toward the overall balance, not linked to any one item">
                Received toward the overall balance
              </th>
              <td role="cell" className={cn(foot, "text-right font-semibold whitespace-nowrap text-success")}>− {money(covered)}</td>
              <td role="cell" colSpan={2} className="@max-[40rem]:hidden" />
            </tr>
            <tr role="row" className="@max-[40rem]:flex @max-[40rem]:justify-between @max-[40rem]:border-t @max-[40rem]:border-border">
              <th role="rowheader" scope="row" colSpan={3} className={cn(foot, "text-left font-semibold text-foreground @min-[40rem]:border-t @min-[40rem]:border-border-strong/60")}>Still to collect</th>
              <td role="cell" className={cn(foot, "text-right font-heading text-[14px] font-bold @min-[40rem]:border-t @min-[40rem]:border-border-strong/60", generalCreditOwed < 0.005 ? "text-success" : "text-settle-receivable-text")}>{money(generalCreditOwed)}</td>
              <td role="cell" colSpan={2} className="border-t border-border-strong/60 @max-[40rem]:hidden" />
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
