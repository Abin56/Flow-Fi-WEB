"use client";

import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { peopleMonth, type PersonMonth } from "@/features/transactions/lib/people-payments-by-month";
import { formatCurrency } from "@/lib/format";
import type { Transaction } from "@/lib/models/transaction";
import { cn } from "@/lib/utils";

/**
 * The Transactions page's "People" view: one compact, spreadsheet-style table of EVERY person — what they paid you
 * (Incoming) and what you paid them (Outgoing) in the chosen month — with a total row. Click a row to expand that
 * person's individual payments inline. Built only from the stored People cash legs of the month: actual money, never
 * EMI schedules, unpaid amounts or balances; each payment is one stored leg, so nothing is counted twice. Not income.
 */
const TH = "border-b border-r border-border-strong/50 bg-secondary/80 px-3 py-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-foreground/65 uppercase last:border-r-0";
const TD = "border-b border-r border-border-subtle px-3 py-1 last:border-r-0";

export function PeoplePaymentsByMonth({ transactions, personNameById }: { transactions: readonly Transaction[]; personNameById: ReadonlyMap<string, string> }) {
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [open, setOpen] = useState<string | null>(null);
  const moved = useMemo(() => peopleMonth(transactions, month.getFullYear(), month.getMonth()), [transactions, month]);

  // Everyone in the People Ledger, people with money first (largest first), then the rest by name.
  const rows = useMemo(() => {
    const byId = new Map(moved.map((p) => [p.personId, p]));
    const quiet: PersonMonth[] = [...personNameById.keys()]
      .filter((id) => !byId.has(id))
      .sort((a, b) => (personNameById.get(a) ?? "").localeCompare(personNameById.get(b) ?? ""))
      .map((personId) => ({ personId, received: 0, paid: 0, movements: [] }));
    // A person who moved money but is no longer listed still shows (named "Someone") so the total stays whole.
    return [...moved, ...quiet];
  }, [moved, personNameById]);

  const nameOf = (id: string) => personNameById.get(id) ?? "Someone";
  const totalIn = moved.reduce((n, p) => n + p.received, 0);
  const totalOut = moved.reduce((n, p) => n + p.paid, 0);
  const step = (d: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + d, 1));
  const arrow = "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground";
  const cell = (v: number, tone: string) => (v > 0 ? <span className={cn("font-semibold", tone)}>{formatCurrency(v)}</span> : <span className="text-muted-foreground/40">—</span>);

  return (
    <section aria-label="People summary" data-testid="tx-people-panel" className="overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-secondary/25 px-3 py-1">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" onClick={() => step(-1)} className={arrow}><ChevronLeft className="size-4" /></button>
          <span className="min-w-[8.5rem] text-center text-sm font-semibold tabular-nums">{month.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</span>
          <button type="button" aria-label="Next month" onClick={() => step(1)} className={arrow}><ChevronRight className="size-4" /></button>
        </div>
        <span className="text-[11px] text-muted-foreground">Actual money only · not income</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">No people yet.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full border-separate border-spacing-0 text-xs" data-testid="tx-people-table">
            <thead className="sticky top-0 z-[1]">
              <tr>
                <th className={cn(TH, "text-left")}>Person</th>
                <th className={cn(TH, "w-32 text-right sm:w-40")}>Incoming (Received)</th>
                <th className={cn(TH, "w-32 text-right sm:w-40")}>Outgoing (Paid)</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((p) => {
                const expandable = p.movements.length > 0;
                const isOpen = open === p.personId && expandable;
                return (
                  <Fragment key={p.personId}>
                    <tr
                      onClick={expandable ? () => setOpen(isOpen ? null : p.personId) : undefined}
                      aria-expanded={expandable ? isOpen : undefined}
                      data-testid="tx-people-row"
                      className={cn(expandable && "cursor-pointer hover:bg-secondary/50", isOpen && "bg-primary/10", !expandable && "text-muted-foreground")}
                    >
                      <td className={cn(TD, "font-medium")}>
                        <span className="flex items-center gap-1.5">
                          <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", expandable ? "text-foreground/60" : "opacity-0", !isOpen && "-rotate-90")} aria-hidden />
                          <span className="truncate">{nameOf(p.personId)}</span>
                          {expandable && <span className="text-[10.5px] font-normal text-muted-foreground">{p.movements.length}</span>}
                        </span>
                      </td>
                      <td className={cn(TD, "text-right")}>{cell(p.received, "text-success")}</td>
                      <td className={cn(TD, "text-right")}>{cell(p.paid, "text-expense")}</td>
                    </tr>
                    {isOpen &&
                      p.movements.map((m) => (
                        <tr key={m.id} className="bg-secondary/30 text-[11.5px]" data-testid="tx-people-movement">
                          <td className={cn(TD, "pl-9")}>
                            <span className="inline-block w-14 text-muted-foreground">{m.date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                            <span className="font-medium">{m.dir === "in" ? "Received" : "Paid"}</span>
                            {m.note && <span className="text-muted-foreground"> · {m.note}</span>}
                          </td>
                          <td className={cn(TD, "text-right text-success")}>{m.dir === "in" ? formatCurrency(m.amount) : ""}</td>
                          <td className={cn(TD, "text-right text-expense")}>{m.dir === "out" ? formatCurrency(m.amount) : ""}</td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0">
              <tr className="bg-secondary/90 font-bold">
                <td className="border-t border-r border-border-strong/60 px-3 py-1.5">Total</td>
                <td className="border-t border-r border-border-strong/60 px-3 py-1.5 text-right text-success tabular-nums" data-testid="tx-people-total-in">{formatCurrency(totalIn)}</td>
                <td className="border-t border-border-strong/60 px-3 py-1.5 text-right text-expense tabular-nums" data-testid="tx-people-total-out">{formatCurrency(totalOut)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
