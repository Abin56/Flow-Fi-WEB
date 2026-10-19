"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import type { AccountStatement } from "@/features/accounts/lib/account-statement";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const PAGE = 30;
type Filter = "all" | "in" | "out";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[7.5rem_minmax(0,1fr)_6rem_6rem_6.5rem]";
const money = (n: number) => formatCurrencyPrecise(n);

/**
 * Bank-style statement for one account: Debit, Credit and the balance after every row, shown newest first.
 * Balances come from the full history (`buildAccountStatement`), so filtering or "show more" never restarts them.
 */
export function AccountStatementTable({ statement }: { statement: AccountStatement }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    const newestFirst = [...statement.rows].reverse();
    return newestFirst.filter((r) => (filter === "all" ? true : filter === "in" ? r.credit > 0 : r.debit > 0));
  }, [statement.rows, filter]);

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in", label: "Money in" },
    { id: "out", label: "Money out" },
  ];
  const mismatch = Math.abs(statement.difference) >= 0.005;

  return (
    <section aria-label="Transaction history" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className={LABEL}>Transaction history</p>
        <div role="group" aria-label="Filter transactions" className="inline-flex rounded-[8px] border border-border-strong/60 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={filter === t.id}
              onClick={() => {
                setFilter(t.id);
                setShown(PAGE);
              }}
              className={cn(
                "rounded-[6px] px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === t.id ? "bg-primary/25 text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-border-strong/50">
        <div className={cn(GRID, "border-b border-border-strong/50 bg-secondary/50 px-3 py-1.5", LABEL)}>
          <span className="hidden sm:block">Date</span>
          <span>Description</span>
          <span className="hidden text-right sm:block">Debit</span>
          <span className="hidden text-right sm:block">Credit</span>
          <span className="text-right">Balance</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {statement.rows.length === 0 ? "Nothing has been added or deducted yet — the balance is just the starting balance." : "No transactions in this view."}
          </p>
        ) : (
          <ul className="divide-y divide-border-strong/40">
            {rows.slice(0, shown).map((r) => (
              <li key={r.id}>
                <Link
                  href={`/transactions?transaction=${encodeURIComponent(r.id)}`}
                  className={cn(GRID, "items-center px-3 py-2 outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60")}
                >
                  <span className="hidden text-xs text-foreground/80 sm:block">
                    {dateFmt.format(r.date)}
                    <span className="block text-[11px] text-muted-foreground">{timeFmt.format(r.date)}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{r.description}</span>
                    <span className="block truncate text-[11px] text-muted-foreground sm:hidden">
                      {dateFmt.format(r.date)}, {timeFmt.format(r.date)}
                    </span>
                  </span>
                  <span className="hidden text-right text-sm text-expense tabular-nums sm:block">{r.debit > 0 ? money(r.debit) : "—"}</span>
                  <span className="hidden text-right text-sm text-success tabular-nums sm:block">{r.credit > 0 ? money(r.credit) : "—"}</span>
                  <span className="text-right">
                    <span className={cn("block text-sm font-semibold tabular-nums", r.balance < 0 ? "text-expense" : "text-foreground")}>{money(r.balance)}</span>
                    <span className={cn("block text-[11px] tabular-nums sm:hidden", r.credit > 0 ? "text-success" : "text-expense")}>
                      {r.credit > 0 ? `Credit ${money(r.credit)}` : `Debit ${money(r.debit)}`}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            {rows.length <= shown && filter === "all" && (
              <li className={cn(GRID, "items-center bg-secondary/30 px-3 py-2")}>
                <span className="hidden sm:block" />
                <span className="text-sm text-muted-foreground">Opening balance</span>
                <span className="hidden sm:block" />
                <span className="hidden sm:block" />
                <span className="text-right text-sm font-semibold tabular-nums">{money(statement.opening)}</span>
              </li>
            )}
          </ul>
        )}
      </div>

      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="self-center rounded-[8px] border border-border-strong/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} left
        </button>
      )}

      {mismatch && (
        <div className="flex gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug text-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <p>
            These records end at <strong className="tabular-nums">{money(statement.fromRecords)}</strong>, but the recorded balance is{" "}
            <strong className="tabular-nums">{money(statement.stored)}</strong> — a difference of{" "}
            <strong className="tabular-nums">{money(statement.difference)}</strong> that no record explains. Nothing was adjusted.
          </p>
        </div>
      )}
    </section>
  );
}
