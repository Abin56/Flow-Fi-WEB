"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, ChevronRight, Info, Landmark } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountStatementTable } from "@/features/accounts/components/account-statement-table";
import { buildAccountStatement } from "@/features/accounts/lib/account-statement";
import {
  buildBalanceBreakdown,
  CATEGORY_HINT,
  type BalanceBreakdown,
  type CategoryTotal,
} from "@/features/accounts/lib/balance-breakdown";
import { useAccounts } from "@/hooks/use-accounts";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";

/** Which balance the sheet explains. "banks"/"cash" are the Accounts screen's own "In banks" / "Cash on hand" figures. */
export type BalanceScope = { kind: "total" } | { kind: "banks" } | { kind: "cash" } | { kind: "account"; accountId: string };

const LABEL = "text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase";
/** Shared flat, rectangular card surface for every block in the sheet. */
const CARD = "divide-y divide-border-strong/40 rounded-none border border-border-strong/50 bg-card";
const PAGE = 30;

type Filter = "all" | "in" | "out";

/**
 * Explains an Accounts balance. Reads the SAME shared listeners the page already uses (accounts, cards,
 * transactions) — no extra Firestore subscription — and lays the records out as
 * starting balance + money added − money deducted. Read-only.
 */
export function BalanceBreakdownSheet({ scope, onClose }: { scope: BalanceScope | null; onClose: () => void }) {
  return (
    <Sheet open={scope != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        aria-describedby="balance-breakdown-desc"
      >
        {scope && <SheetBody key={scopeKey(scope)} scope={scope} />}
      </SheetContent>
    </Sheet>
  );
}

const scopeKey = (s: BalanceScope) => (s.kind === "account" ? `account:${s.accountId}` : s.kind);

function SheetBody({ scope }: { scope: BalanceScope }) {
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError } = useAccounts();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: transactions = [], isLoading: txLoading, isError: txError } = useTransactions();
  // Drilling from a group into one of its accounts keeps the sheet open; "Back" returns to the group.
  const [drillId, setDrillId] = useState<string | null>(null);

  const cardAccountIds = useMemo(() => new Set(cards.map((c) => c.accountId)), [cards]);
  const effective = useMemo<BalanceScope>(() => (drillId ? { kind: "account", accountId: drillId } : scope), [drillId, scope]);

  const inScope = useMemo(() => {
    const list = accounts as Account[];
    // Same set the Accounts screen sums: money accounts, never card liabilities.
    const money = list.filter((a) => !cardAccountIds.has(a.id));
    switch (effective.kind) {
      case "total":
        return money;
      case "banks":
        return money.filter((a) => a.type === "bank" || a.type === "business");
      case "cash":
        return money.filter((a) => a.type === "cash");
      case "account":
        return list.filter((a) => a.id === effective.accountId);
    }
  }, [accounts, cardAccountIds, effective]);

  const breakdown = useMemo(
    () => buildBalanceBreakdown({ accounts: inScope, transactions, cardAccountIds }),
    [inScope, transactions, cardAccountIds],
  );

  const statement = useMemo(() => buildAccountStatement({ accounts: inScope, transactions }), [inScope, transactions]);

  const loading = accountsLoading || cardsLoading || txLoading;
  const isGroup = effective.kind !== "account";
  const title = headingFor(effective, inScope);

  return (
    <>
      <SheetHeader className="gap-1 border-b-2 border-border-strong/60 bg-muted/40 px-5 pt-5 pr-14 pb-4">
        {drillId && scope.kind !== "account" && (
          <button
            type="button"
            onClick={() => setDrillId(null)}
            className="mb-1 inline-flex w-fit items-center gap-1 text-xs font-semibold text-primary-accent-text hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            Back to {headingFor(scope, [])}
          </button>
        )}
        <SheetTitle className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</SheetTitle>
        <p className={cn("text-[32px] leading-tight font-bold tracking-tight tabular-nums", !loading && breakdown.current < 0 ? "text-expense" : "text-foreground")}>
          {loading ? <Skeleton className="h-8 w-40" /> : formatCurrencyPrecise(breakdown.current)}
        </p>
        <SheetDescription id="balance-breakdown-desc" className="max-w-prose text-xs leading-relaxed">
          {descriptionFor(effective)}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
        {accountsError || txError ? (
          <p className="rounded-none border border-expense/40 bg-expense/8 px-3 py-2 text-sm text-expense">
            Couldn&apos;t load your records. Please close this and try again.
          </p>
        ) : loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28 rounded-none" />
            <Skeleton className="h-24 rounded-none" />
            <Skeleton className="h-40 rounded-none" />
          </div>
        ) : inScope.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No accounts to explain here yet.</p>
        ) : (
          <>
            <Calculation breakdown={breakdown} />
            {isGroup && <AccountsSplit breakdown={breakdown} onPick={setDrillId} />}
            <Categories breakdown={breakdown} />
            {isGroup ? <Activity breakdown={breakdown} showAccount /> : <AccountStatementTable statement={statement} />}
          </>
        )}
      </div>
    </>
  );
}

function headingFor(scope: BalanceScope, inScope: readonly { name: string }[]): string {
  switch (scope.kind) {
    case "total":
      return "Total balance";
    case "banks":
      return "Money in banks";
    case "cash":
      return "Cash on hand";
    case "account":
      return inScope[0]?.name ?? "Account balance";
  }
}

function descriptionFor(scope: BalanceScope): string {
  switch (scope.kind) {
    case "total":
      return "Your bank, cash and wallet accounts added together. Credit cards aren’t included — they show what you owe.";
    case "banks":
      return "Your bank and business accounts added together.";
    case "cash":
      return "Your cash accounts added together.";
    case "account":
      return "Starting balance, plus what was added, minus what was deducted.";
  }
}

function Row({ label, value, tone, strong }: { label: string; value: number; tone?: "in" | "out"; strong?: boolean }) {
  const Icon = tone === "in" ? ArrowDownLeft : tone === "out" ? ArrowUpRight : null;
  return (
    <div className={cn("flex items-center justify-between gap-3 py-2.5 text-sm", strong && "-mx-3 border-t-2 border-border-strong/60 bg-muted/50 px-3 font-semibold text-foreground")}>
      <span className={cn("flex items-center gap-2", !strong && "text-foreground/80")}>
        {Icon && (
          <span className={cn("flex size-5 items-center justify-center", tone === "in" ? "bg-success/15 text-success" : "bg-expense/15 text-expense")}>
            <Icon className="size-3.5" />
          </span>
        )}
        {label}
      </span>
      <span className={cn("tabular-nums", strong && "text-base", tone === "in" && "text-success", tone === "out" && "text-expense")}>
        {tone === "in" ? "+ " : tone === "out" ? "− " : ""}
        {formatCurrencyPrecise(Math.abs(value) < 0.005 ? 0 : tone ? Math.abs(value) : value)}
      </span>
    </div>
  );
}

function Calculation({ breakdown }: { breakdown: BalanceBreakdown }) {
  const explained = Math.abs(breakdown.unexplained) < 0.005;
  return (
    <section aria-label="How this is calculated" className="flex flex-col gap-2">
      <p className={LABEL}>Balance activity</p>
      <div className={cn(CARD, "px-3")}>
        <Row label="Starting balance" value={breakdown.starting} />
        <Row label="Money added" value={breakdown.added} tone="in" />
        <Row label="Money deducted" value={breakdown.deducted} tone="out" />
        <Row label="Current balance" value={explained ? breakdown.current : breakdown.fromRecords} strong />
      </div>
      {!explained && (
        <div role="status" className="flex gap-2 rounded-none border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug text-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Your records explain <strong className="tabular-nums">{formatCurrencyPrecise(breakdown.fromRecords)}</strong>, but the balance shown is{" "}
            <strong className="tabular-nums">{formatCurrencyPrecise(breakdown.current)}</strong>. The remaining{" "}
            <strong className="tabular-nums">{formatCurrencyPrecise(breakdown.unexplained)}</strong> can&apos;t be traced to a record — it may come from an older edit or
            data added outside the app.
          </p>
        </div>
      )}
      {breakdown.notCountedCount > 0 && (
        <p className="border-l-2 border-border-strong/60 pl-2.5 text-xs leading-snug text-muted-foreground">
          {breakdown.notCountedCount} {breakdown.notCountedCount === 1 ? "record is" : "records are"} marked as already included or not counted, so{" "}
          {breakdown.notCountedCount === 1 ? "it doesn’t" : "they don’t"} move this balance.
        </p>
      )}
    </section>
  );
}

function AccountsSplit({ breakdown, onPick }: { breakdown: BalanceBreakdown; onPick: (id: string) => void }) {
  const { positive, negative } = breakdown;
  if (positive.accounts.length === 0 && negative.accounts.length === 0) return null;
  const group = (label: string, total: number, list: BalanceBreakdown["accounts"]) =>
    list.length > 0 && (
      <div className="flex flex-col">
        <div className="flex items-baseline justify-between py-1 text-xs font-semibold text-foreground/80">
          <span>{label}</span>
          <span className={cn("tabular-nums", total < 0 ? "text-expense" : "text-foreground")}>{formatCurrencyPrecise(total)}</span>
        </div>
        <ul className={CARD}>
          {list.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onPick(a.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60"
              >
                <span className="flex size-7 shrink-0 items-center justify-center bg-secondary text-muted-foreground">
                  <Landmark className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{a.name}</span>
                <span className={cn("tabular-nums", a.balance < 0 ? "text-expense" : "text-foreground")}>{formatCurrencyPrecise(a.balance)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <section aria-label="Accounts included" className="flex flex-col gap-2">
      <p className={LABEL}>Accounts included</p>
      {group("Accounts with money", positive.total, positive.accounts)}
      {group("Accounts below zero", negative.total, negative.accounts)}
      <p className="bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {formatCurrencyPrecise(positive.total)} {negative.accounts.length > 0 ? `− ${formatCurrencyPrecise(Math.abs(negative.total))} ` : ""}={" "}
        <span className="font-semibold text-foreground tabular-nums">{formatCurrencyPrecise(breakdown.current)}</span>
      </p>
    </section>
  );
}

function Categories({ breakdown }: { breakdown: BalanceBreakdown }) {
  if (breakdown.moneyIn.length === 0 && breakdown.moneyOut.length === 0) return null;
  const list = (title: string, items: CategoryTotal[], tone: "in" | "out") => {
    if (items.length === 0) return null;
    const sum = items.reduce((n, c) => n + Math.abs(c.amount), 0);
    return (
      <div className="flex flex-col gap-2">
        <p className={LABEL}>{title}</p>
        <ul className={cn(CARD, "px-3")}>
          {items.map((c) => (
            <li key={c.category} className="flex flex-col gap-1.5 py-2.5 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{c.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {c.count} {c.count === 1 ? "record" : "records"}
                    {CATEGORY_HINT[c.category] ? ` · ${CATEGORY_HINT[c.category]}` : ""}
                  </span>
                </span>
                <span className={cn("shrink-0 font-medium tabular-nums", tone === "in" ? "text-success" : "text-expense")}>
                  {tone === "in" ? "+ " : "− "}
                  {formatCurrencyPrecise(c.amount)}
                </span>
              </div>
              <div aria-hidden className="h-1 w-full bg-secondary">
                <div
                  className={cn("h-full", tone === "in" ? "bg-success/70" : "bg-expense/70")}
                  style={{ width: `${sum > 0 ? Math.max(2, (Math.abs(c.amount) / sum) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  };
  return (
    <section aria-label="Where your money came from and went" className="flex flex-col gap-5">
      {list("Where your money came from", breakdown.moneyIn, "in")}
      {list("Where your money went", breakdown.moneyOut, "out")}
    </section>
  );
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

function Activity({ breakdown, showAccount }: { breakdown: BalanceBreakdown; showAccount: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(
    () => breakdown.movements.filter((m) => (filter === "all" ? true : filter === "in" ? m.amount > 0 : m.amount < 0)),
    [breakdown.movements, filter],
  );

  if (breakdown.movements.length === 0) {
    return (
      <section aria-label="Transactions" className="flex flex-col gap-2">
        <p className={LABEL}>Transactions</p>
        <p className="rounded-none border border-dashed border-border-strong/60 px-3 py-6 text-center text-sm text-muted-foreground">
          Nothing has been added or deducted yet — the balance is just the starting balance.
        </p>
      </section>
    );
  }

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in", label: "Money in" },
    { id: "out", label: "Money out" },
  ];

  return (
    <section aria-label="Transactions" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className={LABEL}>Transactions</p>
        <div role="group" aria-label="Filter transactions" className="inline-flex border border-border-strong/60 bg-card p-0.5">
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
                "rounded-none px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === t.id ? "bg-primary/30 font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No transactions in this view.</p>
      ) : (
        <ul className={CARD}>
          {rows.slice(0, shown).map((m) => (
            <li key={m.id}>
              <Link
                href={`/transactions?transaction=${encodeURIComponent(m.id)}`}
                className="flex items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60"
              >
                <span className={cn("flex size-7 shrink-0 items-center justify-center", m.amount > 0 ? "bg-success/15 text-success" : "bg-expense/15 text-expense")}>
                  {m.amount > 0 ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{m.description}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {dateFmt.format(m.date)} · {m.categoryLabel}
                    {showAccount ? ` · ${m.accountName}` : ""}
                  </span>
                </span>
                <span className={cn("shrink-0 text-sm font-medium tabular-nums", m.amount > 0 ? "text-success" : "text-expense")}>
                  {m.amount > 0 ? "+ " : "− "}
                  {formatCurrencyPrecise(Math.abs(m.amount))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="self-center rounded-none border border-border-strong/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} left
        </button>
      )}
    </section>
  );
}
