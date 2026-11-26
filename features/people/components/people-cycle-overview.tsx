"use client";

import { ArrowDownLeft, ArrowUpRight, CalendarClock, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { cycleTotals, type PeopleLedgerRow } from "@/features/people/components/people-ledger-list";
import { buildCycleOverview, shareSegments, type Share } from "@/features/people/lib/people-card-model";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The selected cycle as ONE quiet line of figures — no card, no panels. "Receive" and "Give" are two gross totals
 * (`cycleTotals`, from each person's own statement), each with a tiny who-makes-it-up bar; they are never added or
 * netted. Then this cycle's real money (received / paid kept apart), EMI shares and held advance — the last two only
 * when there is something to show.
 */

/** Opacity steps for the people segments — one hue per side, restrained. */
const STEPS = [1, 0.7, 0.5, 0.36, 0.24];

export function PeopleCycleOverview({ rows, receiveDue = null }: { rows: PeopleLedgerRow[]; /** How the Receive total splits — null for a closed cycle or when nothing is postponed. */ receiveDue?: { dueNow: number; postponed: number } | null }) {
  const t = cycleTotals(rows);
  const o = buildCycleOverview(rows);

  return (
    <section aria-label="Cycle summary" className="flex flex-wrap items-center gap-x-0 gap-y-2 border-y border-border py-2.5">
      <SideFigure side="receive" amount={t.toReceive} count={t.receiveCount} shares={o.receiveShares} />
      {receiveDue && (
        <Item label="Of Receive">
          <span className="inline-flex items-baseline gap-1">
            <span className="text-muted-foreground">Due now</span>
            <Money amount={receiveDue.dueNow} exact className="text-sm text-foreground" />
          </span>
          <span className="inline-flex items-baseline gap-1">
            <span className="text-muted-foreground">Postponed</span>
            <Money amount={receiveDue.postponed} exact className="text-sm text-foreground" />
          </span>
        </Item>
      )}
      <SideFigure side="give" amount={t.toPay} count={t.payCount} shares={o.giveShares} />

      <Item label={`This cycle · ${t.activity} ${t.activity === 1 ? "entry" : "entries"}`}>
        <span className="inline-flex items-center gap-1">
          <ArrowDownLeft className="size-3.5 text-success" strokeWidth={2.25} aria-hidden />
          <span className="text-muted-foreground">Received</span>
          <Money amount={o.received} exact className={cn("text-sm", o.received > 0 ? "text-foreground" : "text-muted-foreground/60")} />
        </span>
        <span className="inline-flex items-center gap-1">
          <ArrowUpRight className="size-3.5 text-expense" strokeWidth={2.25} aria-hidden />
          <span className="text-muted-foreground">Paid</span>
          <Money amount={o.paid} exact className={cn("text-sm", o.paid > 0 ? "text-foreground" : "text-muted-foreground/60")} />
        </span>
      </Item>

      {o.emiCount > 0 && (
        <Item label="EMI shares" icon={<CalendarClock className="size-3" strokeWidth={2.25} aria-hidden />}>
          <span className="font-heading text-sm font-bold text-foreground tabular-nums">{o.emiCount}</span>
          {o.emiReceivable > 0 && <span className="font-semibold text-success tabular-nums">↙ {money(o.emiReceivable)}</span>}
          {o.emiPayable > 0 && <span className="font-semibold text-expense tabular-nums">↗ {money(o.emiPayable)}</span>}
          {o.emiOverdue > 0 && (
            <span className="rounded-full border border-warning/60 bg-warning/10 px-1.5 text-[10.5px] font-semibold text-foreground">{o.emiOverdue} overdue</span>
          )}
        </Item>
      )}

      {/* Money people paid ahead and not yet applied — held for them, never added to either total. */}
      {t.advanceHeld > 0 && (
        <Item label="Advance held" icon={<Wallet className="size-3" strokeWidth={2.25} aria-hidden />}>
          <Money amount={Math.round(t.advanceHeld)} className="text-sm text-foreground" />
          <span className="text-muted-foreground">
            {t.advanceHeldCount} {t.advanceHeldCount === 1 ? "person" : "people"}
          </span>
        </Item>
      )}
    </section>
  );
}

/** One figure in the line: a small caption above, values below, a hairline divider before it. */
function Item({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-border px-5 first:border-l-0 first:pl-1">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-3 text-xs">{children}</span>
    </div>
  );
}

function SideFigure({ side, amount, count, shares }: { side: "receive" | "give"; amount: number; count: number; shares: Share[] }) {
  const receive = side === "receive";
  const Icon = receive ? ArrowDownLeft : ArrowUpRight;
  const segments = shareSegments(shares, 4);
  const label = receive ? "Receive" : "Give";
  return (
    <div className="flex min-w-0 items-center gap-3 border-l border-border px-5 first:border-l-0 first:pl-1">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", receive ? "bg-success/12 text-success" : "bg-expense/12 text-expense")}>
        <Icon className="size-4" strokeWidth={2.25} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
          <Money amount={Math.round(amount)} className={cn("text-lg leading-none", amount > 0 ? "text-foreground" : "text-muted-foreground/60")} />
        </span>
        <span className="flex items-center gap-2">
          {/* Who makes it up — a tiny proportional bar; each segment names its person on hover. */}
          {segments.length > 0 ? (
            <span
              className="flex h-1 w-20 gap-px overflow-hidden rounded-full"
              role="img"
              aria-label={`Who makes up ${label.toLowerCase()}: ${segments.map((s) => `${s.label} ${money(s.amount)}`).join(", ")}`}
            >
              {segments.map((s, i) => (
                <span
                  key={s.key}
                  title={`${s.label} · ${money(s.amount)} (${Math.round(s.pct)}%)`}
                  className={cn("h-full min-w-1", receive ? "bg-success" : "bg-expense")}
                  style={{ flexGrow: s.amount, flexBasis: 0, opacity: STEPS[Math.min(i, STEPS.length - 1)] }}
                />
              ))}
            </span>
          ) : (
            <span className="h-1 w-20 rounded-full bg-secondary" aria-hidden />
          )}
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
            {count === 0 ? "nobody" : `${count} ${count === 1 ? "person" : "people"}`}
          </span>
        </span>
      </div>
    </div>
  );
}

export function PeopleCycleOverviewSkeleton() {
  return (
    <div className="flex items-center gap-8 border-y border-border py-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-1 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
