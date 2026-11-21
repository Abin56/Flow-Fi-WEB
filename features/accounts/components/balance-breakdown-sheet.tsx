"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Banknote,
  ChevronRight,
  CircleCheck,
  Info,
  Landmark,
  Wallet,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountStatementTable } from "@/features/accounts/components/account-statement-table";
import { buildAccountStatement, type AccountStatement } from "@/features/accounts/lib/account-statement";
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
/** Shared card surface for every block in the sheet (same 10px radius as the statement table). */
const CARD = "divide-y divide-border-strong/40 overflow-hidden rounded-[10px] border border-border-strong/50 bg-card";
const PAGE = 30;

type Filter = "all" | "in" | "out";
type NavId = "summary" | "accounts" | "came" | "went" | "transactions";

/**
 * Explains an Accounts balance. Reads the SAME shared listeners the page already uses (accounts, cards,
 * transactions) — no extra Firestore subscription — and lays the records out as
 * starting balance + money added − money deducted. Read-only; presentation only.
 */
export function BalanceBreakdownSheet({ scope, onClose }: { scope: BalanceScope | null; onClose: () => void }) {
  return (
    <Sheet open={scope != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        overlayClassName="backdrop-blur-none"
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
  const failed = accountsError || txError;
  const isGroup = effective.kind !== "account";
  const title = headingFor(effective, inScope);
  const explained = Math.abs(breakdown.unexplained) < 0.005;
  const ready = !loading && !failed && inScope.length > 0;

  return (
    <>
      <SheetHeader className="gap-0 border-b border-border-strong/50 bg-muted/40 px-5 pt-5 pr-14 pb-4">
        {drillId && scope.kind !== "account" && (
          <button
            type="button"
            onClick={() => setDrillId(null)}
            className="mb-2 inline-flex w-fit items-center gap-1 rounded-md text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-3.5" />
            Back to {headingFor(scope, [])}
          </button>
        )}
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/15 text-primary-accent-text">
            <ScopeIcon scope={effective} inScope={inScope} className="size-5" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="truncate text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</SheetTitle>
            <div className={cn("text-[30px] leading-tight font-bold tracking-tight tabular-nums", !loading && breakdown.current < 0 ? "text-expense" : "text-foreground")}>
              {loading ? <Skeleton className="mt-1 h-8 w-40" /> : formatCurrencyPrecise(breakdown.current)}
            </div>
          </div>
        </div>
        <SheetDescription id="balance-breakdown-desc" className="mt-2 max-w-prose text-xs leading-relaxed">
          {descriptionFor(effective)}
        </SheetDescription>
        {ready && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isGroup && <Pill>{inScope.length === 1 ? "1 account" : `${inScope.length} accounts`}</Pill>}
            <Pill>{breakdown.movements.length === 1 ? "1 record" : `${breakdown.movements.length} records`}</Pill>
            {explained ? (
              <Pill tone="ok">
                <CircleCheck className="size-3" />
                Matches your records
              </Pill>
            ) : (
              <Pill tone="warn">
                <Info className="size-3" />
                {formatCurrencyPrecise(Math.abs(breakdown.unexplained))} can&apos;t be traced
              </Pill>
            )}
          </div>
        )}
      </SheetHeader>

      <Content
        key={drillId ?? "root"}
        loading={loading}
        failed={failed}
        empty={inScope.length === 0}
        breakdown={breakdown}
        statement={statement}
        isGroup={isGroup}
        onPick={setDrillId}
      />
    </>
  );
}

function Content({
  loading,
  failed,
  empty,
  breakdown,
  statement,
  isGroup,
  onPick,
}: {
  loading: boolean;
  failed: boolean;
  empty: boolean;
  breakdown: BalanceBreakdown;
  statement: AccountStatement;
  isGroup: boolean;
  onPick: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<NavId>("summary");
  const ready = !loading && !failed && !empty;

  const items = useMemo(() => {
    const list: { id: NavId; label: string }[] = [{ id: "summary", label: "Summary" }];
    if (isGroup && breakdown.accounts.length > 0) list.push({ id: "accounts", label: "Accounts" });
    if (breakdown.moneyIn.length > 0) list.push({ id: "came", label: "Came from" });
    if (breakdown.moneyOut.length > 0) list.push({ id: "went", label: "Went to" });
    list.push({ id: "transactions", label: "Transactions" });
    return list;
  }, [isGroup, breakdown.accounts.length, breakdown.moneyIn.length, breakdown.moneyOut.length]);

  const syncActive = () => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    let current = items[0]?.id;
    for (const it of items) {
      const el = root.querySelector(`[data-nav="${it.id}"]`);
      if (el && el.getBoundingClientRect().top - top <= 56) current = it.id;
    }
    // At the very bottom a short last section can never reach the top — treat it as the current one.
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = items[items.length - 1]?.id ?? current;
    if (current) setActive(current);
  };

  const jump = (id: NavId) => {
    const el = scrollRef.current?.querySelector(`[data-nav="${id}"]`);
    if (!el) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
    setActive(id);
  };

  return (
    <>
      {ready && items.length > 2 && (
        <nav aria-label="Jump to section" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-strong/40 bg-popover px-4 py-2 [scrollbar-width:none]">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              aria-current={active === it.id ? "true" : undefined}
              onClick={() => jump(it.id)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active === it.id ? "bg-primary/20 font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {it.label}
            </button>
          ))}
        </nav>
      )}

      <div ref={scrollRef} onScroll={ready ? syncActive : undefined} className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 py-5">
        {failed ? (
          <p className="rounded-[10px] border border-expense/40 bg-expense/8 px-3 py-2 text-sm text-expense">
            Couldn&apos;t load your records. Please close this and try again.
          </p>
        ) : loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28 rounded-[10px]" />
            <Skeleton className="h-24 rounded-[10px]" />
            <Skeleton className="h-40 rounded-[10px]" />
          </div>
        ) : empty ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No accounts to explain here yet.</p>
        ) : (
          <>
            <Calculation breakdown={breakdown} />
            {isGroup && <AccountsSplit breakdown={breakdown} onPick={onPick} />}
            <CategoryList navId="came" title="Where your money came from" items={breakdown.moneyIn} tone="in" />
            <CategoryList navId="went" title="Where your money went" items={breakdown.moneyOut} tone="out" />
            {isGroup ? (
              <Activity breakdown={breakdown} showAccount />
            ) : (
              <div data-nav="transactions" className="scroll-mt-2">
                <AccountStatementTable statement={statement} />
              </div>
            )}
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

function ScopeIcon({ scope, inScope, className }: { scope: BalanceScope; inScope: readonly { type?: string }[]; className?: string }) {
  const kind = scope.kind === "account" ? (inScope[0]?.type ?? "bank") : scope.kind;
  if (kind === "total" || kind === "wallet") return <Wallet className={className} />;
  if (kind === "cash") return <Banknote className={className} />;
  return <Landmark className={className} />;
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

function Pill({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        tone === "ok" && "border-success/40 bg-success/10 text-success",
        tone === "warn" && "border-warning/50 bg-warning/10 text-foreground",
        !tone && "border-border-strong/50 bg-card text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function SectionHead({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className={LABEL}>{title}</p>
      {meta != null && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
    </div>
  );
}

function Row({ label, value, tone, strong }: { label: string; value: number; tone?: "in" | "out"; strong?: boolean }) {
  const Icon = tone === "in" ? ArrowDownLeft : tone === "out" ? ArrowUpRight : null;
  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 py-3 text-sm", strong && "border-t-2 border-border-strong/60 bg-muted/50 font-semibold text-foreground")}>
      <span className={cn("flex items-center gap-2.5", !strong && "text-foreground/80")}>
        {Icon && (
          <span className={cn("flex size-6 items-center justify-center rounded-[6px]", tone === "in" ? "bg-success/15 text-success" : "bg-expense/15 text-expense")}>
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
    <section aria-label="How this is calculated" data-nav="summary" className="flex scroll-mt-2 flex-col gap-2.5">
      <SectionHead title="Balance activity" />
      <div className={CARD}>
        <Row label="Starting balance" value={breakdown.starting} />
        <Row label="Money added" value={breakdown.added} tone="in" />
        <Row label="Money deducted" value={breakdown.deducted} tone="out" />
        <Row label="Current balance" value={explained ? breakdown.current : breakdown.fromRecords} strong />
      </div>
      {!explained && (
        <div role="status" className="flex gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-snug text-foreground">
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
  const group = (label: string, total: number, list: BalanceBreakdown["accounts"], showShare: boolean) =>
    list.length > 0 && (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs font-semibold text-foreground/80">
          <span>{label}</span>
          <span className={cn("tabular-nums", total < 0 ? "text-expense" : "text-foreground")}>{formatCurrencyPrecise(total)}</span>
        </div>
        <ul className={CARD}>
          {list.map((a) => {
            const share = showShare && total > 0 ? Math.max(2, (a.balance / total) * 100) : 0;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onPick(a.id)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-secondary text-muted-foreground">
                    <Landmark className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate font-medium text-foreground">{a.name}</span>
                    {showShare && (
                      <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-secondary">
                        <span className="block h-full rounded-full bg-primary/60" style={{ width: `${share}%` }} />
                      </span>
                    )}
                  </span>
                  <span className={cn("font-medium tabular-nums", a.balance < 0 ? "text-expense" : "text-foreground")}>{formatCurrencyPrecise(a.balance)}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <section aria-label="Accounts included" data-nav="accounts" className="flex scroll-mt-2 flex-col gap-2.5">
      <SectionHead title="Accounts included" meta="Tap an account for its history" />
      {group("Accounts with money", positive.total, positive.accounts, positive.accounts.length > 1)}
      {group("Accounts below zero", negative.total, negative.accounts, false)}
      {negative.accounts.length > 0 && (
        <p className="rounded-[8px] bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {formatCurrencyPrecise(positive.total)} − {formatCurrencyPrecise(Math.abs(negative.total))} ={" "}
          <span className="font-semibold text-foreground tabular-nums">{formatCurrencyPrecise(breakdown.current)}</span>
        </p>
      )}
    </section>
  );
}

function CategoryList({ navId, title, items, tone }: { navId: NavId; title: string; items: CategoryTotal[]; tone: "in" | "out" }) {
  if (items.length === 0) return null;
  const sum = items.reduce((n, c) => n + Math.abs(c.amount), 0);
  return (
    <section aria-label={title} data-nav={navId} className="flex scroll-mt-2 flex-col gap-2.5">
      <SectionHead title={title} meta={`Total ${formatCurrencyPrecise(sum)}`} />
      <ul className={CARD}>
        {items.map((c) => {
          const pct = sum > 0 ? (Math.abs(c.amount) / sum) * 100 : 0;
          return (
            <li key={c.category} className="flex flex-col gap-2 px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{c.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {c.count} {c.count === 1 ? "record" : "records"}
                    {CATEGORY_HINT[c.category] ? ` · ${CATEGORY_HINT[c.category]}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn("block font-medium tabular-nums", tone === "in" ? "text-success" : "text-expense")}>
                    {tone === "in" ? "+ " : "− "}
                    {formatCurrencyPrecise(c.amount)}
                  </span>
                  <span className="block text-[11px] text-muted-foreground tabular-nums">{pct < 1 ? "<1" : Math.round(pct)}% of total</span>
                </span>
              </div>
              <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div className={cn("h-full rounded-full", tone === "in" ? "bg-success/70" : "bg-expense/70")} style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

function Activity({ breakdown, showAccount }: { breakdown: BalanceBreakdown; showAccount: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(
    () => breakdown.movements.filter((m) => (filter === "all" ? true : filter === "in" ? m.amount > 0 : m.amount < 0)),
    [breakdown.movements, filter],
  );

  // Movements are newest-first, so consecutive rows share a month: group them under month headings.
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: typeof rows }[] = [];
    for (const m of rows.slice(0, shown)) {
      const key = `${m.date.getFullYear()}-${m.date.getMonth()}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(m);
      else out.push({ key, label: monthFmt.format(m.date), rows: [m] });
    }
    return out;
  }, [rows, shown]);

  if (breakdown.movements.length === 0) {
    return (
      <section aria-label="Transactions" data-nav="transactions" className="flex scroll-mt-2 flex-col gap-2.5">
        <SectionHead title="Transactions" />
        <p className="rounded-[10px] border border-dashed border-border-strong/60 px-3 py-6 text-center text-sm text-muted-foreground">
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
    <section aria-label="Transactions" data-nav="transactions" className="flex scroll-mt-2 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className={LABEL}>Transactions</p>
        <div role="group" aria-label="Filter transactions" className="inline-flex rounded-[8px] border border-border-strong/60 bg-card p-0.5">
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
                "rounded-[6px] px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === t.id ? "bg-primary/25 font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground",
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
        groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-foreground/70">{g.label}</p>
            <ul className={CARD}>
              {g.rows.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/transactions?transaction=${encodeURIComponent(m.id)}`}
                    className="group flex items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60"
                  >
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", m.amount > 0 ? "bg-success/15 text-success" : "bg-expense/15 text-expense")}>
                      {m.amount > 0 ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
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
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="self-center rounded-[8px] border border-border-strong/60 px-3 py-1.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} left
        </button>
      )}
    </section>
  );
}
