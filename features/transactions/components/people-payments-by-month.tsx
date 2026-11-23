"use client";

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { peoplePaymentsForMonth, type PersonMonthMoney } from "@/features/transactions/lib/people-payments-by-month";
import type { Transaction } from "@/lib/models/transaction";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "Who paid me this month" for the Transactions page — a compact two-column list (received / paid) with its own month
 * stepper. Reads only the stored People cash legs; actual money only, never income, never balances or EMI schedules.
 */
const VISIBLE = 4;

function Side({ incoming, total, people, nameOf }: { incoming: boolean; total: number; people: PersonMonthMoney[]; nameOf: (id: string) => string }) {
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, VISIBLE);
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  return (
    <div className="min-w-0 bg-card px-3 py-2" data-testid={incoming ? "tx-people-in" : "tx-people-out"}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className={cn("size-3.5", incoming ? "text-success" : "text-expense")} strokeWidth={2.5} aria-hidden />
          {incoming ? "Received" : "Paid"}
          <span className="font-normal text-muted-foreground">· {people.length} {people.length === 1 ? "person" : "people"}</span>
        </h3>
        <span className={cn("font-heading text-base font-bold tabular-nums", total > 0 ? (incoming ? "text-success" : "text-expense") : "text-muted-foreground/60")}>{formatCurrency(total)}</span>
      </div>
      {people.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{incoming ? "No one paid you this month." : "You paid no one this month."}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {shown.map((p) => (
            <li key={p.personId} className="flex items-center gap-2 px-1 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{nameOf(p.personId)}</span>
              <span className="font-semibold tabular-nums">{formatCurrency(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {people.length > VISIBLE && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 px-1 text-xs font-semibold text-primary-accent-text hover:underline">
          {all ? "Show fewer" : `Show all ${people.length}`}
        </button>
      )}
    </div>
  );
}

export function PeoplePaymentsByMonth({ transactions, personNameById }: { transactions: readonly Transaction[]; personNameById: ReadonlyMap<string, string> }) {
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const data = useMemo(() => peoplePaymentsForMonth(transactions, month.getFullYear(), month.getMonth()), [transactions, month]);
  const step = (d: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + d, 1));
  const nameOf = (id: string) => personNameById.get(id) ?? "Someone";
  const btn = "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground";
  return (
    <section aria-label="Payments with people this month" data-testid="tx-people-payments" className="overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 border-b border-border bg-secondary/25 px-3 py-1">
        <h2 className="font-heading text-sm font-semibold">Payments with people</h2>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" onClick={() => step(-1)} className={btn}><ChevronLeft className="size-4" /></button>
          <span className="min-w-[8.5rem] text-center text-xs font-semibold tabular-nums">{month.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</span>
          <button type="button" aria-label="Next month" onClick={() => step(1)} className={btn}><ChevronRight className="size-4" /></button>
        </div>
        <span className="text-[11px] text-muted-foreground">Actual money only · not income</span>
      </div>
      <div className="grid gap-px bg-border-subtle sm:grid-cols-2">
        <Side incoming total={data.received.total} people={data.received.people} nameOf={nameOf} />
        <Side incoming={false} total={data.paid.total} people={data.paid.people} nameOf={nameOf} />
      </div>
    </section>
  );
}
