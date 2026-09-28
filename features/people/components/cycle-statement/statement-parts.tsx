"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  HandCoins,
  Scale,
  Split,
  type LucideIcon,
} from "lucide-react";
import {
  directionHeadline,
  formatStatementDate,
  perspectiveAmount,
  reconciliationLines,
  type EmiRowStatus,
  type PersonCycleStatement,
  type StatementCategory,
  type StatementRow,
} from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const CATEGORY_ICON: Record<StatementCategory, LucideIcon> = {
  opening: Scale,
  split: Split,
  emi: CalendarClock,
  gave: ArrowUpFromLine,
  borrowed: ArrowDownToLine,
  adjustment: Scale,
  received: HandCoins,
  repaid: HandCoins,
};

/** The lender-side installment state — context only. Paying the bank never settles the Person. */
const EMI_STATUS: Record<EmiRowStatus, { label: string; className: string }> = {
  upcoming: { label: "Bank: upcoming", className: "text-muted-foreground" },
  partial: { label: "Bank: partly paid", className: "text-muted-foreground" },
  paid: { label: "Bank: paid", className: "text-muted-foreground" },
  overdue: { label: "Bank: overdue", className: "text-expense" },
};

/** "They owe you / ₹4,750" — the statement's strongest answer. */
export function StatementHeadline({ statement, size = "lg" }: { statement: PersonCycleStatement; size?: "lg" | "md" }) {
  const tone =
    statement.direction === "theyOwe" ? "text-success" : statement.direction === "iOwe" ? "text-expense" : "text-foreground";
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{directionHeadline(statement.direction)}</p>
      <p className={cn("mt-0.5 font-bold tracking-tight tabular-nums", size === "lg" ? "text-3xl" : "text-2xl", tone)}>
        {money(statement.amount)}
      </p>
    </div>
  );
}

/** Previous pending / This cycle / settlements / Current pending — engine values only. */
export function StatementReconciliation({ statement }: { statement: PersonCycleStatement }) {
  const lines = reconciliationLines(statement);
  return (
    <dl className="text-sm">
      {lines.map((l) => (
        <div
          key={l.label}
          className={cn(
            "flex items-baseline justify-between gap-3 py-1",
            l.emphasis && "mt-1 border-t border-border pt-2 font-semibold text-foreground",
          )}
        >
          <dt className={l.emphasis ? "text-foreground" : "text-muted-foreground"}>{l.label}</dt>
          <dd className="tabular-nums text-foreground">{money(l.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What makes up "This cycle" — only categories that contribute. */
export function StatementBreakdown({ statement }: { statement: PersonCycleStatement }) {
  if (statement.activityBreakdown.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-foreground">
        This cycle · <span className="tabular-nums">{money(perspectiveAmount(statement, statement.cycleActivity))}</span>
      </p>
      <dl className="mt-1.5 text-sm">
        {statement.activityBreakdown.map((b) => {
          const Icon = CATEGORY_ICON[b.category];
          return (
            <div key={b.category} className="flex items-center justify-between gap-3 py-0.5">
              <dt className="flex items-center gap-2 text-muted-foreground">
                <Icon className={cn("size-3.5", b.category === "emi" && "text-primary-accent-text")} />
                {b.label}
              </dt>
              <dd className="tabular-nums text-foreground">{money(perspectiveAmount(statement, b.signedAmount))}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function EmiBadge() {
  return (
    <span className="rounded border border-primary-accent-text/40 bg-primary/25 px-1 text-[10px] leading-4 font-bold tracking-wide text-primary-accent-text">
      EMI
    </span>
  );
}

function rowDetail(row: StatementRow): string | null {
  if (row.settles) {
    return row.settles.remainingAfter > 0
      ? `Against ${row.settles.title} (${money(row.settles.originalAmount)}) · ${money(row.settles.remainingAfter)} remaining`
      : `Clears ${row.settles.title} (${money(row.settles.originalAmount)})`;
  }
  if (row.emi) return `Installment #${row.emi.installmentNumber}`;
  if (row.remainingNow != null && row.remainingNow > 0 && row.remainingNow < row.amount) return `${money(row.remainingNow)} still open`;
  return null;
}

export function StatementActivityRow({ statement, row }: { statement: PersonCycleStatement; row: StatementRow }) {
  const Icon = CATEGORY_ICON[row.category];
  const isEmi = row.category === "emi";
  const value = perspectiveAmount(statement, row.signedAmount);
  const detail = rowDetail(row);
  const status = row.emi ? EMI_STATUS[row.emi.status] : null;
  return (
    <li className={cn("flex items-start gap-3 py-2.5", isEmi && "-mx-2 rounded-md border-l-2 border-primary-accent-text bg-primary/10 px-2")}>
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border",
          isEmi ? "border-primary-accent-text/30 text-primary-accent-text" : "border-border text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
          <span className="truncate">{row.title}</span>
          {isEmi && <EmiBadge />}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatStatementDate(row.date)} · {row.typeLabel}
          {status && (
            <>
              {" · "}
              <span className={cn("rounded px-1 font-medium", status.className)}>{status.label}</span>
            </>
          )}
        </p>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <p className={cn("shrink-0 text-sm font-semibold tabular-nums", value < 0 ? "text-success" : "text-foreground")}>{money(value)}</p>
    </li>
  );
}

/** "How is this calculated?" — the running calculation over the same rows. */
export function StatementCalculation({ statement }: { statement: PersonCycleStatement }) {
  const signed = (v: number) => (v < 0 ? money(v) : `+${money(v)}`);
  return (
    <dl className="font-mono text-xs">
      <div className="flex justify-between gap-3 py-0.5">
        <dt className="text-muted-foreground">Previous pending</dt>
        <dd className="tabular-nums text-foreground">{money(perspectiveAmount(statement, statement.previousPending))}</dd>
      </div>
      {statement.rows.map((r) => (
        <div key={r.key} className="flex justify-between gap-3 py-0.5">
          <dt className="truncate text-muted-foreground">
            {r.title}
            {r.category === "emi" && " (EMI)"}
          </dt>
          <dd className="shrink-0 tabular-nums text-foreground">{signed(perspectiveAmount(statement, r.signedAmount))}</dd>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-3 border-t border-border pt-1.5 font-semibold">
        <dt className="text-foreground">Current pending</dt>
        <dd className="tabular-nums text-foreground">{money(perspectiveAmount(statement, statement.currentPending))}</dd>
      </div>
    </dl>
  );
}
