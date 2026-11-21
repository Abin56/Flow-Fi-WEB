"use client";

/**
 * Account balance visibility on the Transactions page — presentation only.
 *
 * Every figure here is READ from what the app already computes: a plain account's stored `currentBalance`
 * (exactly what the Accounts page shows) and, for a credit card, the canonical card standing from
 * `useCreditCardStandings` (outstanding / available / limit, shared limits pooled — exactly what Credit Cards
 * shows). Nothing is recomputed, and no historical / running balance is ever derived: these are balances as of
 * NOW, and the row preview says so whenever the row is from another day.
 */

import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, CreditCard, Filter } from "lucide-react";
import Link from "next/link";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { AccountMark, accountKind, groupAccountsByKind, type AccountKind } from "@/components/finance/account-label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CreditCardStandingView } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";

/** What one account's balance looks like right now — a credit card's standing, or a plain stored balance. */
export type AccountBalanceView =
  | {
      kind: "credit";
      outstanding: number;
      available: number;
      limit: number;
      utilizationPercent: number;
      lockedEmiPrincipal: number;
      sharedLimitName: string | null;
      /** Credit Cards deep link id (`?card=`). */
      cardId: string;
    }
  /** A credit card whose standing isn't available (no profile / still loading): owed from its stored balance, as the Accounts page shows it. */
  | { kind: "creditFallback"; outstanding: number; loading: boolean }
  | { kind: "balance"; balance: number; minimumBalance: number | null };

export function accountBalanceViewFor(account: Account, standingByAccountId: ReadonlyMap<string, CreditCardStandingView>, standingsLoading: boolean): AccountBalanceView {
  const standing = standingByAccountId.get(account.id);
  if (standing) {
    return {
      kind: "credit",
      outstanding: standing.outstanding,
      available: standing.available,
      limit: standing.effectiveCreditLimit,
      utilizationPercent: standing.utilizationPercent,
      lockedEmiPrincipal: standing.lockedEmiPrincipal,
      sharedLimitName: standing.sharedLimit?.name ?? null,
      cardId: standing.card.id,
    };
  }
  if (accountKind(account) === "credit") return { kind: "creditFallback", outstanding: Math.max(0, -account.currentBalance), loading: standingsLoading };
  return { kind: "balance", balance: account.currentBalance, minimumBalance: account.minimumBalance };
}

const KIND_LABEL: Record<AccountKind, string> = { account: "Account", card: "Card", credit: "Credit card" };
const KIND_HEADING: Record<AccountKind, string> = { account: "Bank & cash", card: "Debit & other cards", credit: "Credit cards" };

const signed = (n: number) => (n < 0 ? `−${formatCurrency(Math.abs(n))}` : formatCurrency(n));
/** The last four digits only when the account's own name doesn't already carry them (e.g. a card named "SBI •••• 0282"). */
const needsLast4 = (a: Account) => !!a.accountNumberLast4 && !a.name.includes(a.accountNumberLast4);
const accountTitle = (a: Account) => (needsLast4(a) ? `${a.name} •••• ${a.accountNumberLast4}` : a.name);
/** Short chip label: the name without a trailing "Savings Account"-style suffix; the full name stays in the tooltip. */
const shortName = (a: Account) => a.name.replace(/\s+(savings|current|salary)?\s*account$/i, "").trim() || a.name;
function accountTypeText(a: Account): string {
  if (a.type === "card") return KIND_LABEL[accountKind(a)];
  return `${a.type[0].toUpperCase()}${a.type.slice(1)} account`;
}

/** Where "Open" goes: the card in Credit Cards, else the account selected on Accounts. */
function openHrefFor(account: Account, view: AccountBalanceView): string {
  return view.kind === "credit" ? `/credit-cards?card=${encodeURIComponent(view.cardId)}` : `/accounts?account=${encodeURIComponent(account.id)}`;
}

/** Thin utilization bar — exposure against the limit, the same percentage Credit Cards shows. */
function UtilBar({ percent, className }: { percent: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, percent));
  const tone = percent >= 90 ? "bg-expense" : percent >= 50 ? "bg-warning" : "bg-violet-500 dark:bg-violet-400";
  return (
    <span className={cn("relative block h-1 overflow-hidden rounded-full bg-violet-500/15 dark:bg-violet-400/20", className)} aria-hidden>
      <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", tone)} style={{ width: `${pct}%` }} />
    </span>
  );
}

/* ───────────────────────── Account filter with balances ───────────────────────── */

/**
 * The Account filter, with each account's balance beside its name (grouped bank & cash / cards / credit cards).
 * Same trigger look, same items, same `onChange` as the generic filter menu — only richer rows.
 */
export function AccountFilterMenu({
  accounts,
  value,
  onChange,
  balanceFor,
  triggerClassName,
  activeTriggerClassName,
}: {
  accounts: Account[];
  value: string | null;
  onChange: (id: string | null) => void;
  balanceFor: (a: Account) => AccountBalanceView;
  triggerClassName: string;
  activeTriggerClassName: string;
}) {
  const active = accounts.find((a) => a.id === value);
  const groups = groupAccountsByKind(accounts);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(triggerClassName, active && activeTriggerClassName)}>
          <span className={cn(active && "text-muted-foreground")}>Account</span>
          {active && <AccountMark account={active} size={18} />}
          {active && <span className="max-w-32 truncate font-semibold">{accountTitle(active)}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[26rem] w-80 overflow-y-auto rounded-[10px] p-1">
        <DropdownMenuItem onSelect={() => onChange(null)} className={cn("justify-between", !active && "font-semibold")}>
          All Accounts
          <span className="text-[11px] font-normal text-muted-foreground">Balances as of now</span>
        </DropdownMenuItem>
        {groups.map((g) => (
          <div key={g.kind}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel
              className={cn(
                "flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase",
                g.kind === "credit" && "text-violet-700 dark:text-violet-300",
              )}
            >
              {g.kind === "credit" && <CreditCard className="size-3" strokeWidth={2.4} />}
              {KIND_HEADING[g.kind]}
            </DropdownMenuLabel>
            {g.accounts.map((a) => (
              <DropdownMenuItem key={a.id} onSelect={() => onChange(a.id)} className={cn("gap-2.5 py-1.5", a.id === value && "bg-primary/15 font-semibold")}>
                <AccountMark account={a} size={20} />
                <span className="min-w-0 flex-1 truncate">{accountTitle(a)}</span>
                <OptionBalance view={balanceFor(a)} />
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Right-hand figure of a filter row: balance, or for a credit card what's owed with the available credit under it. */
function OptionBalance({ view }: { view: AccountBalanceView }) {
  if (view.kind === "balance") {
    return <span className={cn("shrink-0 text-xs font-semibold tabular-nums", view.balance < 0 ? "text-expense" : "text-foreground")}>{signed(view.balance)}</span>;
  }
  if (view.kind === "creditFallback") {
    return (
      <span className="flex shrink-0 flex-col items-end leading-tight">
        <span className="text-xs font-semibold text-foreground tabular-nums">{formatCurrency(view.outstanding)}</span>
        <span className="text-[10px] font-normal text-muted-foreground">owed</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 flex-col items-end leading-tight">
      <span className="text-xs font-semibold text-foreground tabular-nums">
        {formatCurrency(view.outstanding)} <span className="font-normal text-muted-foreground">owed</span>
      </span>
      <span className={cn("text-[10px] font-normal tabular-nums", view.available < 0 ? "text-expense" : "text-muted-foreground")}>
        {view.available < 0 ? `Over limit ${formatCurrency(-view.available)}` : `${formatCurrency(view.available)} available`}
      </span>
    </span>
  );
}

/* ───────────────────────── Selected account: one inline balance line ───────────────────────── */

/**
 * When the list is filtered to one account, its balance sits on the filter-chip line (right side) — the place the
 * eye already goes to see what's filtered. One quiet line, not another card.
 */
export function SelectedAccountBalance({ account, view }: { account: Account; view: AccountBalanceView }) {
  return (
    <div
      className="ml-auto flex min-w-0 items-center gap-3 text-xs animate-in fade-in-0 slide-in-from-right-1 duration-300 motion-reduce:animate-none"
      data-testid="selected-account-balance"
      title="Balance as of now — not affected by the date or other filters"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <AccountMark account={account} size={16} />
        <span className="truncate">{accountTitle(account)}</span>
      </span>
      <span className="h-4 w-px shrink-0 bg-border-strong/70" aria-hidden />
      {view.kind === "balance" && (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Current balance</span>
          <span className={cn("text-sm font-bold tabular-nums", view.balance < 0 ? "text-expense" : "text-foreground")}>{signed(view.balance)}</span>
          {view.minimumBalance != null && view.minimumBalance > 0 && (
            <span className={cn("tabular-nums", view.balance < view.minimumBalance ? "font-semibold text-warning-foreground dark:text-warning" : "text-muted-foreground")}>
              · min {formatCurrency(view.minimumBalance)}
            </span>
          )}
        </span>
      )}
      {view.kind === "creditFallback" && (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Outstanding</span>
          <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(view.outstanding)}</span>
        </span>
      )}
      {view.kind === "credit" && (
        <span className="flex items-center gap-2.5 whitespace-nowrap">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Outstanding</span>
            <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(view.outstanding)}</span>
          </span>
          <span className="flex items-center gap-2">
            <UtilBar percent={view.utilizationPercent} className="w-14" />
            <span className={cn("tabular-nums", view.available < 0 ? "font-semibold text-expense" : "text-muted-foreground")}>
              {view.available < 0 ? `Over limit by ${formatCurrency(-view.available)}` : `${formatCurrency(view.available)} available`}
              <span className="text-muted-foreground"> of {formatCurrency(view.limit)}</span>
            </span>
          </span>
        </span>
      )}
      <Link
        href={openHrefFor(account, view)}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold text-primary-accent-text transition-colors hover:bg-primary/15"
      >
        {view.kind === "credit" ? "Open card" : "Open"}
        <ArrowUpRight className="size-3" strokeWidth={2.25} />
      </Link>
    </div>
  );
}

/* ───────────────────────── Row account name: hover / click preview ───────────────────────── */

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Wraps a row's account name: hover (or click / keyboard focus) shows a compact balance card for that account.
 * Clicks inside never reach the row (React events bubble through portals), so the row doesn't expand underneath.
 */
export function AccountBalanceHover({
  account,
  view,
  rowDate,
  isFiltered,
  onFilter,
  children,
}: {
  account: Account;
  view: AccountBalanceView;
  /** The transaction's date — when it isn't today, the card says the balance is today's, not that day's. */
  rowDate: Date;
  isFiltered: boolean;
  onFilter: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const historical = !sameDay(rowDate, new Date());
  return (
    <HoverCardPrimitive.Root open={open} onOpenChange={setOpen} openDelay={350} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label={`${account.name} balance`}
          aria-expanded={open}
          className="-mx-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left decoration-foreground/30 decoration-dotted underline-offset-[3px] transition-colors hover:bg-foreground/[0.05] hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {children}
        </button>
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          className="z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-[12px] border border-border-strong/60 bg-popover p-3 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none"
          style={{ boxShadow: "var(--shadow-e3)" }}
        >
          <div className="flex items-center gap-2.5">
            <AccountMark account={account} size={28} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{accountTitle(account)}</p>
              <p className="text-[11px] text-muted-foreground">
                {accountTypeText(account)}
                {view.kind === "credit" && view.sharedLimitName ? ` · shared limit “${view.sharedLimitName}”` : ""}
              </p>
            </div>
          </div>

          <div className="mt-3 border-t border-border pt-2.5">
            {view.kind === "balance" && (
              <>
                <p className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Current balance</p>
                <p className={cn("text-xl leading-tight font-bold tabular-nums", view.balance < 0 ? "text-expense" : "text-foreground")}>{signed(view.balance)}</p>
                {view.minimumBalance != null && view.minimumBalance > 0 && (
                  <p className={cn("mt-0.5 text-[11px] tabular-nums", view.balance < view.minimumBalance ? "font-semibold text-warning-foreground dark:text-warning" : "text-muted-foreground")}>
                    Minimum balance {formatCurrency(view.minimumBalance)}
                    {view.balance < view.minimumBalance ? " · below minimum" : ""}
                  </p>
                )}
              </>
            )}
            {view.kind === "creditFallback" && (
              <>
                <p className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Outstanding</p>
                <p className="text-xl leading-tight font-bold text-foreground tabular-nums">{formatCurrency(view.outstanding)}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{view.loading ? "Loading limit…" : "No credit limit on record for this card."}</p>
              </>
            )}
            {view.kind === "credit" && (
              <>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Outstanding</p>
                    <p className="text-xl leading-tight font-bold text-foreground tabular-nums">{formatCurrency(view.outstanding)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Available</p>
                    <p className={cn("text-sm leading-tight font-semibold tabular-nums", view.available < 0 ? "text-expense" : "text-success")}>
                      {view.available < 0 ? `−${formatCurrency(-view.available)}` : formatCurrency(view.available)}
                    </p>
                  </div>
                </div>
                <UtilBar percent={view.utilizationPercent} className="mt-2" />
                <p className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
                  <span>{Math.round(view.utilizationPercent)}% used</span>
                  <span>Limit {formatCurrency(view.limit)}</span>
                </p>
                {view.lockedEmiPrincipal > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">Includes {formatCurrency(view.lockedEmiPrincipal)} held by card EMIs</p>
                )}
              </>
            )}
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              {historical
                ? `Balance as of now — not the balance on ${rowDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`
                : "Balance as of now."}
            </p>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
            {!isFiltered && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onFilter();
                }}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-border-strong px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
              >
                <Filter className="size-3" strokeWidth={2.25} />
                Show only this
              </button>
            )}
            <Link
              href={openHrefFor(account, view)}
              className="ml-auto inline-flex h-7 items-center gap-0.5 rounded-full px-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15"
            >
              {view.kind === "credit" ? "Open in Credit Cards" : "Open in Accounts"}
              <ArrowUpRight className="size-3" strokeWidth={2.25} />
            </Link>
          </div>
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

/* ───────────────────────── Always-visible balances rail ───────────────────────── */

/**
 * One slim line of every account's CURRENT balance (bank & cash, then cards, then credit cards), always visible
 * above the list. A chip is the Account filter's shortcut: click to show only that account, click the active chip
 * again to show all. Many accounts stay on one line — the rail scrolls sideways, with arrows only when it overflows.
 */
export function AccountBalanceRail({
  accounts,
  balanceFor,
  activeId,
  onSelect,
}: {
  accounts: Account[];
  balanceFor: (a: Account) => AccountBalanceView;
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [accounts.length]);

  // Keep the filtered account's chip in view (e.g. after picking it from the Account filter).
  useEffect(() => {
    if (!activeId) return;
    const chip = scrollerRef.current?.querySelector<HTMLElement>(`[data-account-chip="${CSS.escape(activeId)}"]`);
    chip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeId]);

  if (accounts.length === 0) return null;
  const groups = groupAccountsByKind(accounts);
  const page = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };
  const mask =
    edges.left && edges.right
      ? "linear-gradient(to right, transparent, #000 40px, #000 calc(100% - 40px), transparent)"
      : edges.left
        ? "linear-gradient(to right, transparent, #000 40px)"
        : edges.right
          ? "linear-gradient(to right, #000 calc(100% - 40px), transparent)"
          : undefined;

  return (
    <div role="group" aria-label="Current balances" className="flex min-w-0 items-center gap-2.5" data-testid="account-balance-rail">
      <span
        className="shrink-0 cursor-help text-[10px] font-semibold tracking-[0.08em] whitespace-nowrap text-foreground/55 uppercase"
        title="Current balances as of now — they don't change with the date or other filters. Click an account to show only its transactions."
      >
        Balances now
      </span>
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollerRef}
          className="flex items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        >
          {groups.map((g, gi) => (
            <Fragment key={g.kind}>
              {gi > 0 && <span className="mx-0.5 h-5 w-px shrink-0 bg-border-strong/60" aria-hidden />}
              {g.accounts.map((a) => (
                <BalanceChip key={a.id} account={a} view={balanceFor(a)} active={a.id === activeId} onClick={() => onSelect(a.id === activeId ? null : a.id)} />
              ))}
            </Fragment>
          ))}
        </div>
        {edges.left && (
          <button
            type="button"
            aria-label="Scroll balances left"
            onClick={() => page(-1)}
            className="absolute top-1/2 left-0 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-card text-foreground/70 shadow-e1 transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" strokeWidth={2.25} />
          </button>
        )}
        {edges.right && (
          <button
            type="button"
            aria-label="Scroll balances right"
            onClick={() => page(1)}
            className="absolute top-1/2 right-0 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-card text-foreground/70 shadow-e1 transition-colors hover:text-foreground"
          >
            <ChevronRight className="size-3.5" strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

function BalanceChip({ account, view, active, onClick }: { account: Account; view: AccountBalanceView; active: boolean; onClick: () => void }) {
  const credit = view.kind !== "balance";
  const belowMin = view.kind === "balance" && view.minimumBalance != null && view.minimumBalance > 0 && view.balance < view.minimumBalance;
  const tip =
    view.kind === "balance"
      ? `${accountTitle(account)} · current balance ${signed(view.balance)}${belowMin ? ` · below minimum ${formatCurrency(view.minimumBalance!)}` : ""}`
      : view.kind === "credit"
        ? `${accountTitle(account)} · outstanding ${formatCurrency(view.outstanding)} · available ${signed(view.available)} of ${formatCurrency(view.limit)} limit (${Math.round(view.utilizationPercent)}% used)`
        : `${accountTitle(account)} · outstanding ${formatCurrency(view.outstanding)}`;
  const pct = view.kind === "credit" ? Math.max(0, Math.min(100, view.utilizationPercent)) : 0;
  const barTone = view.kind === "credit" ? (view.utilizationPercent >= 90 ? "bg-expense" : view.utilizationPercent >= 50 ? "bg-warning" : "bg-violet-500 dark:bg-violet-400") : "";
  return (
    <button
      type="button"
      data-account-chip={account.id}
      aria-pressed={active}
      onClick={onClick}
      title={`${tip}
${active ? "Click to show all accounts" : "Click to show only this account"}`}
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border pr-3 pl-1.5 text-left transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
        active
          ? "border-primary-accent-text/70 bg-primary/20 shadow-e1"
          : credit
            ? "border-violet-500/25 bg-violet-500/[0.05] hover:border-violet-500/50 hover:bg-violet-500/[0.09] dark:border-violet-400/25 dark:bg-violet-400/[0.07]"
            : "border-border-strong/70 bg-card hover:border-border-strong hover:bg-secondary/60",
      )}
    >
      <AccountMark account={account} size={18} />
      <span className="max-w-[8rem] truncate text-xs text-muted-foreground">{shortName(account)}</span>
      {view.kind === "balance" && (
        <span className={cn("flex items-center gap-1 text-[13px] leading-none font-bold whitespace-nowrap tabular-nums", view.balance < 0 ? "text-expense" : "text-foreground")}>
          {belowMin && <span className="size-1.5 rounded-full bg-warning" title="Below minimum balance" aria-label="Below minimum balance" />}
          {signed(view.balance)}
        </span>
      )}
      {view.kind === "creditFallback" && (
        <span className="text-[13px] leading-none font-bold whitespace-nowrap text-foreground tabular-nums">{formatCurrency(view.outstanding)}</span>
      )}
      {view.kind === "credit" && (
        <>
          <span className="text-[13px] leading-none font-bold whitespace-nowrap text-foreground tabular-nums">{formatCurrency(view.outstanding)}</span>
          <span className={cn("text-[11px] leading-none font-semibold whitespace-nowrap tabular-nums", view.available < 0 ? "text-expense" : "text-success")}>
            {view.available < 0 ? `−${formatCurrency(-view.available)}` : `${formatCurrency(view.available)} left`}
          </span>
        </>
      )}
      {/* Credit usage: a hairline along the bottom edge, filled to the % of the limit in use. */}
      {view.kind === "credit" && (
        <span aria-hidden className="absolute inset-x-3 bottom-0 h-[2px] overflow-hidden rounded-full bg-violet-500/15 dark:bg-violet-400/20">
          <span className={cn("block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", barTone)} style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  );
}
