"use client";

import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import type { PeopleLedgerRow } from "@/features/people/components/people-ledger-list";
import { buildMonthlyPaymentSummary, type PersonMoney } from "@/features/people/lib/monthly-payment-summary";
import { formatCycleLabel, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * "Who paid me this cycle" — a compact two-column list under the cycle figures: money received (how many people paid
 * and each person's amount) and, clearly apart, money paid out. The cycle is the page's own selector. Figures are each
 * person's real cash for the cycle only — no balances, EMI shares or scheduled amounts — and are not income.
 */
const VISIBLE = 5;

function Side({ tone, title, total, people, onOpenPerson }: { tone: "in" | "out"; title: string; total: number; people: PersonMoney[]; onOpenPerson?: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, VISIBLE);
  const incoming = tone === "in";
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  return (
    <div className="min-w-0 bg-card px-3 py-2.5" data-testid={`monthly-${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Icon className={cn("size-3.5", incoming ? "text-success" : "text-expense")} strokeWidth={2.5} aria-hidden />
          {title}
          <span className="font-normal text-muted-foreground">
            · {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        </h3>
        <span className={cn("font-heading text-base font-bold tabular-nums", total > 0 ? (incoming ? "text-success" : "text-expense") : "text-muted-foreground/60")}>{money(total)}</span>
      </div>
      {people.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{incoming ? "No one paid you this cycle." : "You paid no one this cycle."}</p>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onOpenPerson?.(p.id)}
                disabled={!onOpenPerson}
                className="flex w-full items-center gap-2 rounded-[5px] px-1 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-secondary"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{p.name}</span>
                <span className="relative h-1 w-14 shrink-0 overflow-hidden rounded-full bg-secondary" aria-hidden>
                  <span className={cn("absolute inset-y-0 left-0 rounded-full", incoming ? "bg-success/70" : "bg-expense/70")} style={{ width: `${Math.max(6, (p.amount / total) * 100)}%` }} />
                </span>
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{money(p.amount)}</span>
              </button>
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

export function MonthlyPaymentSummary({ rows, cycle, onOpenPerson }: { rows: PeopleLedgerRow[]; cycle: StatementCycle; onOpenPerson?: (id: string) => void }) {
  const s = buildMonthlyPaymentSummary(rows);
  return (
    <section aria-label="Monthly payment summary" data-testid="monthly-payment-summary" className="overflow-hidden rounded-[10px] border border-border bg-card shadow-e1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border bg-secondary/25 px-3 py-1.5">
        <h2 className="font-heading text-sm font-semibold">Payments with people · {formatCycleLabel(cycle, false)}</h2>
        <span className="text-[11px] text-muted-foreground">Actual money only · not income · change the cycle above</span>
      </div>
      <div className="grid gap-px bg-border-subtle sm:grid-cols-2">
        <Side tone="in" title="Received" total={s.received.total} people={s.received.people} onOpenPerson={onOpenPerson} />
        <Side tone="out" title="Paid" total={s.paid.total} people={s.paid.people} onOpenPerson={onOpenPerson} />
      </div>
    </section>
  );
}
