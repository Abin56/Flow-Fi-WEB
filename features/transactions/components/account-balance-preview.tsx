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

import { ArrowUpRight, ChevronDown, CreditCard, Filter, Search, Wallet } from "lucide-react";
import Link from "next/link";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { useRef, useState, type ReactNode } from "react";
import { accountLast4 } from "@/components/finance/account-chip";
import { AccountMark, AccountPickerMark, accountKind, groupAccountsByKind, type AccountKind } from "@/components/finance/account-label";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CreditCardStandingView } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
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
      lastFourDigits: string | null;
      loading: boolean;
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
      sharedLimitName: standing.sharedLimit?.name.trim() ?? null,
      cardId: standing.card.id,
      lastFourDigits: standing.card.lastFourDigits,
      loading: standingsLoading,
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
          {active && <AccountPickerMark account={active} size={18} />}
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
            <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {g.kind === "credit" && <CreditCard className="size-3" strokeWidth={2.4} />}
              {KIND_HEADING[g.kind]}
            </DropdownMenuLabel>
            {g.accounts.map((a) => (
              <DropdownMenuItem key={a.id} onSelect={() => onChange(a.id)} className={cn("gap-2.5 py-1.5", a.id === value && "bg-primary/15 font-semibold")}>
                <AccountPickerMark account={a} />
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
        {view.available < 0 ? `Over limit ${formatCurrency(-view.available)}` : `${formatCurrency(view.available)} ${view.sharedLimitName != null ? "shared available credit" : "available credit"}`}
      </span>
    </span>
  );
}

export function SelectedAccountLink({ account, view }: { account: Account; view: AccountBalanceView }) {
  return (
    <Link
      href={openHrefFor(account, view)}
      aria-label={`Open ${accountTitle(account)}`}
      className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15"
    >
      Open <ArrowUpRight aria-hidden className="size-3" strokeWidth={2.25} />
    </Link>
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
                {view.kind === "credit" && view.sharedLimitName != null && (view.sharedLimitName ? ` · shared limit “${view.sharedLimitName}”` : " · shared limit")}
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
                    <p className="text-[10px] font-semibold tracking-[0.06em] text-foreground/60 uppercase">Available credit</p>
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

/** One row of balances with a searchable list anchored to the wallet button. */
export function AccountBalanceOverview({
  accounts,
  balanceFor,
  activeId,
  onSelect,
}: {
  accounts: Account[];
  balanceFor: (account: Account) => AccountBalanceView;
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const directoryHeading = useRef<HTMLHeadingElement>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);

  if (accounts.length === 0) return null;

  const groups = groupAccountsByKind(accounts);
  const active = accounts.find((account) => account.id === activeId);
  const firstCreditCard = groups.find((group) => group.kind === "credit")?.accounts[0];
  const preview = [...new Set([active ?? groups[0].accounts[0], firstCreditCard, ...groups.map((group) => group.accounts[0]), ...accounts])]
    .filter((account): account is Account => account != null)
    .slice(0, 4);

  return (
    <section aria-label="Balances now" className="@container min-w-0 rounded-xl border border-border-strong/60 bg-card px-1 py-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Popover open={directoryOpen} onOpenChange={setDirectoryOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="View all balances" title="View all balances" className="gap-1 px-1.5 text-xs">
              <Wallet aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span className="hidden @lg:inline">Balances</span>
              <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="All balances"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="flex max-h-[min(20rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border-strong/60 p-0"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              directoryHeading.current?.focus();
            }}
          >
            <h2 ref={directoryHeading} tabIndex={-1} className="sr-only">All balances</h2>
            <BalanceDirectory
              accounts={accounts}
              balanceFor={balanceFor}
              activeId={activeId}
              onSelect={(id) => {
                setDirectoryOpen(false);
                onSelect(id);
              }}
            />
          </PopoverContent>
        </Popover>
        <ul className="flex min-w-0 flex-1">
          {preview.map((account, index) => (
            <li key={account.id} className={cn("min-w-0 flex-1 px-0.5", index > 0 && "border-l border-border", index === 1 && "hidden @2xl:block", index > 1 && "hidden @6xl:block")}>
              <BalanceChoice account={account} view={balanceFor(account)} active={account.id === activeId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function balanceLast4(account: Account, view: AccountBalanceView): string | null {
  if (view.kind === "credit" && view.lastFourDigits && /^\d{4}$/.test(view.lastFourDigits)) return view.lastFourDigits;
  return accountLast4(account);
}

function BalanceDirectory({
  accounts,
  balanceFor,
  activeId,
  onSelect,
}: {
  accounts: Account[];
  balanceFor: (account: Account) => AccountBalanceView;
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = accounts.filter((account) => {
    return account.name.toLowerCase().includes(query) || balanceLast4(account, balanceFor(account))?.includes(query);
  });
  const groups = groupAccountsByKind(matches);

  return (
    <>
      <div className="relative m-2 shrink-0">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search balances"
          placeholder="Name or last 4 digits"
          className="h-8 pl-8"
        />
      </div>
      <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {groups.length === 0 && <p role="status" className="py-3 text-center text-xs text-muted-foreground">No matches</p>}
        {groups.map(({ kind, accounts }) => (
          <div key={kind}>
            <h3 className="border-b border-border px-1.5 py-1 text-[11px] font-semibold text-muted-foreground">{KIND_HEADING[kind]}</h3>
            <ul className="divide-y divide-border">
              {accounts.map((account) => (
                <li key={account.id} className="min-w-0">
                  <BalanceChoice account={account} view={balanceFor(account)} active={account.id === activeId} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

function BalanceChoice({
  account,
  view,
  active,
  onSelect,
}: {
  account: Account;
  view: AccountBalanceView;
  active: boolean;
  onSelect: (id: string | null) => void;
}) {
  const last4 = balanceLast4(account, view);
  const name = last4 && account.name.trimEnd().endsWith(last4)
    ? account.name.trimEnd().slice(0, -4).trimEnd().replace(/(?:[•*]+|\s+xx|\s+-)$/i, "").trimEnd() || account.name
    : account.name;
  const shared = view.kind === "credit" ? view.sharedLimitName : null;
  const caption = view.kind === "balance" ? "Balance" : view.kind === "creditFallback" ? "Owed" : shared != null ? "Shared available" : "Available";
  const amount = view.kind === "balance" ? view.balance : view.kind === "credit" ? view.available : view.outstanding;
  const loading = view.kind !== "balance" && view.loading;
  const belowMinimum = view.kind === "balance" && view.minimumBalance != null && view.minimumBalance > 0 && amount < view.minimumBalance;
  const overLimit = view.kind === "credit" && view.limit > 0 && view.utilizationPercent > 100;

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(active ? null : account.id)}
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
        active ? "bg-primary/15" : "hover:bg-secondary/65",
      )}
    >
      <AccountPickerMark account={account} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        <span title={account.name} className="min-w-0 truncate font-semibold text-foreground">{name}</span>
        {last4 && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">••{last4}</span>}
      </span>
      <span title={shared ? `Shared credit limit · ${shared}` : undefined} className="shrink-0 text-right">
        <span className={cn("block text-[10px] leading-3 text-muted-foreground", view.kind === "balance" && "sr-only")}>
          {caption}{view.kind === "credit" && <span className="sr-only"> credit</span>}
        </span>
        <span className={cn("block leading-4 font-semibold tabular-nums", !loading && (amount < 0 || belowMinimum || overLimit) && "text-expense")}>
          {loading ? <span aria-label="Loading balance">…</span> : formatCurrencyExact(amount)}
        </span>
        {belowMinimum && <span className="sr-only">Below minimum balance</span>}
        {overLimit && !loading && <span className="sr-only">Over credit limit</span>}
      </span>
    </button>
  );
}
