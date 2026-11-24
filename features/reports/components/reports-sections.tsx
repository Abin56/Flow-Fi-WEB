"use client";

/**
 * Reports detail views — ONE tabbed card below the overview (Spending · Accounts · Debts & cards · People · Net worth)
 * instead of a stack of tall sections. Presentation only: every figure comes from `PeriodDetail` / `CurrentPosition`
 * (shared engines). Display arithmetic is limited to shares of a total, sums of already-computed account lines and
 * picking rows.
 */

import Link from "next/link";
import { ArrowUpRight, CreditCard, HandCoins, Landmark, Layers, Scale, TrendingUp, Users, Wallet, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PeriodDetail, PeriodFigures } from "@/lib/engines/period-report";
import type { ReportPeriod } from "@/lib/engines/report-period";
import { formatCurrency, formatCurrencyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CurrentPosition, ReportAccountInfo } from "@/features/reports/hooks/use-financial-report-data";
import { AXIS, CATEGORY_COLORS, changePercent, DeltaChip, EmptyNote, FigureRow, GRID, InfoHint, MONEY, OTHER_COLOR, RichTooltip, ShareBar, signedCurrency } from "./report-ui";

/** Quiet link to the module a view summarises. */
function ModuleLink({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className="inline-flex items-center gap-0.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {children} <ArrowUpRight className="size-3" aria-hidden />
    </Link>
  );
}

function SubHead({ title, sub, action, hint }: { title: string; sub?: ReactNode; action?: ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          {title}
          {hint && <InfoHint text={hint} />}
        </h3>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</p>;
}

// ---------------------------------------------------------------- Details card (tabs)

export type DetailTab = "spending" | "accounts" | "debts" | "people" | "networth";

const TABS: { value: DetailTab; label: string; icon: typeof Layers }[] = [
  { value: "spending", label: "Spending", icon: Layers },
  { value: "accounts", label: "Accounts", icon: Landmark },
  { value: "debts", label: "Debts & cards", icon: CreditCard },
  { value: "people", label: "People", icon: Users },
  { value: "networth", label: "Net worth", icon: TrendingUp },
];

export function DetailsCard({ tab, onTab, summaries, children }: { tab: DetailTab; onTab: (t: DetailTab) => void; summaries: Record<DetailTab, string>; children: ReactNode }) {
  return (
    <section className="scroll-mt-16 rounded-2xl border border-border/60 bg-card shadow-e1" data-testid="rep-details" id="rep-details">
      <div className="grid grid-cols-2 border-b border-border/60 @3xl:grid-cols-5" role="tablist" aria-label="Report details">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`rep-tab-${t.value}`}
              onClick={() => onTab(t.value)}
              className={cn("relative flex min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors first:rounded-tl-2xl @3xl:last:rounded-tr-2xl", active ? "bg-muted/45" : "hover:bg-muted/25")}
            >
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg transition-colors", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[13px] font-semibold", active ? "text-foreground" : "text-muted-foreground")}>{t.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground tabular-nums">{summaries[t.value]}</span>
              </span>
              {active && <span className="absolute inset-x-3.5 bottom-0 h-0.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
      <div key={tab} className="min-h-[17rem] p-4 animate-in fade-in-0 duration-300 motion-reduce:animate-none" role="tabpanel">
        {children}
      </div>
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/60 px-4 py-2.5" data-testid="rep-links">
        <span className="text-[11px] text-muted-foreground">Open the source:</span>
        <ModuleLink href="/transactions">Transactions</ModuleLink>
        <ModuleLink href="/accounts">Accounts</ModuleLink>
        <ModuleLink href="/my-money">My Money</ModuleLink>
        <ModuleLink href="/loans-installments" testId="rep-link-loans">Loan &amp; EMI</ModuleLink>
        <ModuleLink href="/credit-cards" testId="rep-link-cards">Credit cards</ModuleLink>
        <ModuleLink href="/people">People ledger</ModuleLink>
        <ModuleLink href="/dashboard">Dashboard</ModuleLink>
        <span className="ml-auto hidden text-[11px] text-muted-foreground @7xl:inline">Income &amp; outflow match Month Cycle · Money in &amp; out match the Dashboard · updates live</span>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------- Spending (categories + largest expenses, linked)

export function SpendingTab({
  detail,
  previous,
  categoryName,
  accountInfo,
}: {
  detail: PeriodDetail;
  /** The previous comparable period, or null when it has no records. */
  previous: PeriodFigures | null;
  categoryName: (id: string) => string;
  accountInfo: Map<string, ReportAccountInfo>;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      [...detail.spendByCategory]
        .map(([id, v]) => ({ id, name: categoryName(id), amount: v.amount, count: v.count, prev: previous?.spendByCategory.get(id)?.amount ?? null }))
        .sort((a, b) => b.amount - a.amount),
    [detail.spendByCategory, previous, categoryName],
  );
  // A picked category that has no spending in this period (period changed) is ignored.
  const selected = picked && rows.some((r) => r.id === picked) ? picked : null;
  const total = detail.mySpend;
  const colored = rows.slice(0, CATEGORY_COLORS.length);
  const rest = rows.slice(CATEGORY_COLORS.length);
  const pie = [
    ...colored.map((r, i) => ({ id: r.id, name: r.name, value: r.amount, color: CATEGORY_COLORS[i] })),
    ...(rest.length ? [{ id: "__other", name: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.amount, 0), color: OTHER_COLOR }] : []),
  ];
  const colorAt = (i: number) => (i < CATEGORY_COLORS.length ? CATEGORY_COLORS[i] : OTHER_COLOR);
  const sliceOf = (id: string) => (rows.findIndex((r) => r.id === id) < CATEGORY_COLORS.length ? id : "__other");
  const lit = hover ?? (selected ? sliceOf(selected) : null);
  const focus = hover ? pie.find((p) => p.id === hover) : selected ? { name: categoryName(selected), value: rows.find((r) => r.id === selected)?.amount ?? 0 } : null;

  const expenseRows = selected ? detail.spendRows.filter((r) => r.transaction.categoryId === selected && r.myAmount !== 0) : detail.spendRows.filter((r) => r.myAmount !== 0);
  const shown = expenseRows.slice(0, selected ? 30 : 10);

  return (
    <div className="grid h-full gap-5 @4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="min-w-0" data-testid="rep-categories">
        <SubHead title="Spending by category" sub={`My spend ${formatCurrency(total)} — my share of every purchase · click a category to see its expenses`} />
        {rows.length === 0 ? (
          <EmptyNote className="h-56">No spending in this period.</EmptyNote>
        ) : (
          <div className="grid gap-4 @2xl:grid-cols-[10rem_minmax(0,1fr)] @2xl:items-start">
            <div className="relative mx-auto aspect-square w-full max-w-40">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="64%"
                    outerRadius="97%"
                    paddingAngle={pie.length > 1 ? 1.5 : 0}
                    stroke="var(--card)"
                    strokeWidth={2}
                    cornerRadius={4}
                    onMouseEnter={(_, i) => setHover(pie[i]?.id ?? null)}
                    onMouseLeave={() => setHover(null)}
                    onClick={(_, i) => {
                      const id = pie[i]?.id;
                      if (id && id !== "__other") setPicked((p) => (p === id ? null : id));
                    }}
                    isAnimationActive
                    animationDuration={600}
                    className="cursor-pointer"
                  >
                    {pie.map((p) => (
                      <Cell key={p.id} fill={p.color} fillOpacity={lit && lit !== p.id ? 0.3 : 1} className="transition-[fill-opacity] duration-200" />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
                <span className="max-w-full truncate text-[11px] text-muted-foreground">{focus ? focus.name : "My spend"}</span>
                <span className="font-heading text-base font-semibold tracking-tight tabular-nums">{formatCurrencyCompact(focus ? focus.value : total)}</span>
                {focus && total > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{((focus.value / total) * 100).toFixed(1)}%</span>}
              </div>
            </div>
            <div className="min-w-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-x-3 border-b border-border/60 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                <span>Category</span>
                <span className="text-right">Amount</span>
                <span className="text-right">vs prev</span>
              </div>
              <ul className="max-h-[14.5rem] overflow-y-auto" data-testid="rep-category-rows">
                {rows.map((r, i) => {
                  const on = selected === r.id;
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(on ? null : r.id)}
                        onMouseEnter={() => setHover(sliceOf(r.id))}
                        onMouseLeave={() => setHover(null)}
                        aria-pressed={on}
                        data-testid="rep-category-row"
                        data-count={r.count}
                        className={cn(
                          "grid w-full grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-x-3 rounded-lg px-1 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          on ? "bg-primary/10" : lit && lit === sliceOf(r.id) ? "bg-muted/60" : "hover:bg-muted/40",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="size-2 shrink-0 rounded-full" style={{ background: colorAt(i) }} aria-hidden />
                            <span className="truncate text-[13px] font-medium text-foreground">{r.name}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{r.count}</span>
                          </span>
                          <ShareBar value={r.amount} total={rows[0].amount} color={colorAt(i)} className="mt-1 h-1" />
                        </span>
                        <span className="text-right">
                          <span className="block text-[13px] font-semibold tabular-nums">{formatCurrency(r.amount)}</span>
                          <span className="block text-[11px] text-muted-foreground tabular-nums">{total > 0 ? ((r.amount / total) * 100).toFixed(1) : "0"}%</span>
                        </span>
                        <span className="flex justify-end">
                          {previous == null ? <span className="text-[11px] text-muted-foreground">—</span> : <DeltaChip value={changePercent(r.amount, r.prev ?? 0)} upIsGood={false} />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {detail.othersShare > 0 && (
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                  You also paid {formatCurrency(detail.othersShare)} that was other people&apos;s share — money they owe you, not your spending.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0 border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5" data-testid="rep-top">
        <SubHead
          title={selected ? `${categoryName(selected)} expenses` : "Largest expenses"}
          sub={selected ? `${expenseRows.length} purchase${expenseRows.length === 1 ? "" : "s"} · ${formatCurrency(expenseRows.reduce((s, r) => s + r.myAmount, 0))} my share` : `Top ${shown.length} of ${expenseRows.length} purchases in this period`}
          action={
            selected ? (
              <button type="button" onClick={() => setPicked(null)} data-testid="rep-category-clear" className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                <X className="size-3" aria-hidden /> All categories
              </button>
            ) : (
              <ModuleLink href="/transactions">All</ModuleLink>
            )
          }
        />
        {shown.length === 0 ? (
          <EmptyNote>No purchases in this period.</EmptyNote>
        ) : (
          <ul className="max-h-[16rem] divide-y divide-border/50 overflow-y-auto pr-1" data-testid="rep-top-rows">
            {shown.map((r) => (
              <li key={r.transaction.id} className="flex items-center gap-3 py-1.5">
                <span className="w-11 shrink-0 text-[11px] text-muted-foreground tabular-nums">{r.transaction.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{r.transaction.description || categoryName(r.transaction.categoryId)}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {selected ? "" : `${categoryName(r.transaction.categoryId)} · `}
                    {accountInfo.get(r.transaction.accountId)?.name ?? "Paid by a person / lender"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-semibold tabular-nums">{formatCurrency(r.myAmount)}</p>
                  {r.myAmount !== r.grossAmount && <p className="text-[11px] text-muted-foreground tabular-nums">of {formatCurrency(r.grossAmount)}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Accounts (statement)

export function AccountsTab({ detail, accountInfo }: { detail: PeriodDetail; accountInfo: Map<string, ReportAccountInfo> }) {
  const lines = detail.accounts
    .map((l) => ({ ...l, info: accountInfo.get(l.accountId) }))
    .filter((l) => l.info && (l.count > 0 || Math.abs(l.closing) > 0.005 || Math.abs(l.opening) > 0.005));
  const cash = lines.filter((l) => !l.info!.isCard);
  const cards = lines.filter((l) => l.info!.isCard);
  const sum = (xs: typeof lines, k: "opening" | "closing" | "moneyIn" | "moneyOut" | "transfersIn") => xs.reduce((s, l) => s + l[k], 0);
  const maxFlow = Math.max(1, ...lines.map((l) => Math.max(l.moneyIn, l.moneyOut)));
  const cashOpen = sum(cash, "opening");
  const cashClose = sum(cash, "closing");
  // "|| 0" turns −0 (no card debt) into 0 so it never prints as "−₹0".
  const cardOpen = -sum(cards, "opening") || 0;
  const cardClose = -sum(cards, "closing") || 0;
  const transfers = sum(lines, "transfersIn");

  const Row = ({ l }: { l: (typeof lines)[number] }) => {
    const change = l.closing - l.opening;
    return (
      <tr className="border-t border-border/50 transition-colors hover:bg-muted/40" data-testid="rep-acct-row" data-name={l.info!.name} data-opening={l.opening} data-in={l.moneyIn} data-out={l.moneyOut} data-closing={l.closing}>
        <td className="py-1.5 pr-3">
          <Link href={`/transactions?account=${encodeURIComponent(l.accountId)}`} className="group inline-flex min-w-0 items-center gap-2">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", l.info!.isCard ? "bg-purple/12 text-purple" : "bg-muted text-muted-foreground")}>
              {l.info!.isCard ? <CreditCard className="size-3.5" /> : l.info!.type === "cash" || l.info!.type === "wallet" ? <Wallet className="size-3.5" /> : <Landmark className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground group-hover:underline">{l.info!.name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {l.count} movement{l.count === 1 ? "" : "s"}
                {l.transfersIn + l.transfersOut > 0 ? ` · transfers ${formatCurrencyCompact(l.transfersIn + l.transfersOut)}` : ""}
              </span>
            </span>
          </Link>
        </td>
        <td className="px-3 text-right tabular-nums text-muted-foreground">{formatCurrency(l.opening)}</td>
        <td className="px-3 text-right tabular-nums text-success">{l.moneyIn ? `+${formatCurrency(l.moneyIn)}` : "—"}</td>
        <td className="px-3 text-right tabular-nums text-expense">{l.moneyOut ? `−${formatCurrency(l.moneyOut)}` : "—"}</td>
        <td className="hidden px-3 @4xl:table-cell">
          <FlowBar moneyIn={l.moneyIn} moneyOut={l.moneyOut} max={maxFlow} />
        </td>
        <td className="px-3 text-right font-semibold tabular-nums">{formatCurrency(l.closing)}</td>
        <td className={cn("pl-3 text-right text-xs font-medium tabular-nums", change > 0.005 ? "text-success" : change < -0.005 ? "text-expense" : "text-muted-foreground")}>{signedCurrency(change)}</td>
      </tr>
    );
  };

  return (
    <div data-testid="rep-accounts">
      <SubHead
        title="Account statement"
        sub="Opening balance, money in, money out and closing balance for each account in this period"
        hint="Built from the same records as each account's statement. Closing − opening always equals money in − money out. Transfers between your own accounts appear on both accounts, but they cancel out across your accounts as a whole. Card balances are negative while you owe on the card."
      />
      {lines.length === 0 ? (
        <EmptyNote>No accounts yet.</EmptyNote>
      ) : (
        <>
          <div className="mb-3 grid gap-2 @2xl:grid-cols-3">
            <SummaryChip label="Bank, cash & wallets" from={cashOpen} to={cashClose} upIsGood />
            {cards.length > 0 && <SummaryChip label="Owed on cards" from={cardOpen} to={cardClose} upIsGood={false} />}
            <div className="rounded-xl bg-muted/50 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Moved between my accounts</p>
              <p className="text-[13px] font-semibold tabular-nums">{formatCurrency(transfers)}</p>
              <p className="text-[11px] text-muted-foreground">Transfers cancel out overall</p>
            </div>
          </div>
          <div className="-mx-1 max-h-[22rem] overflow-auto px-1">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="sticky top-0 z-[1] bg-card">
                <tr className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                  <th className="pb-1.5 text-left font-medium">Account</th>
                  <th className="px-3 pb-1.5 text-right font-medium">Opening</th>
                  <th className="px-3 pb-1.5 text-right font-medium">Money in</th>
                  <th className="px-3 pb-1.5 text-right font-medium">Money out</th>
                  <th className="hidden px-3 pb-1.5 text-left font-medium @4xl:table-cell">In / out</th>
                  <th className="px-3 pb-1.5 text-right font-medium">Closing</th>
                  <th className="pb-1.5 pl-3 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {cash.map((l) => (
                  <Row key={l.accountId} l={l} />
                ))}
                {cash.length > 1 && (
                  <tr className="border-t-2 border-border/80 font-semibold" data-testid="rep-accounts-total">
                    <td className="py-2 pr-3 text-[13px]">Bank, cash &amp; wallets</td>
                    <td className="px-3 text-right tabular-nums">{formatCurrency(cashOpen)}</td>
                    <td className="px-3 text-right tabular-nums text-success">+{formatCurrency(sum(cash, "moneyIn"))}</td>
                    <td className="px-3 text-right tabular-nums text-expense">−{formatCurrency(sum(cash, "moneyOut"))}</td>
                    <td className="hidden @4xl:table-cell" />
                    <td className="px-3 text-right tabular-nums">{formatCurrency(cashClose)}</td>
                    <td className="pl-3 text-right text-xs tabular-nums">{signedCurrency(cashClose - cashOpen)}</td>
                  </tr>
                )}
                {cards.length > 0 && (
                  <tr>
                    <td colSpan={7} className="pt-3 pb-0.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Credit cards
                    </td>
                  </tr>
                )}
                {cards.map((l) => (
                  <Row key={l.accountId} l={l} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryChip({ label, from, to, upIsGood }: { label: string; from: number; to: number; upIsGood: boolean }) {
  const change = to - from;
  const good = Math.abs(change) < 0.005 ? null : change > 0 === upIsGood;
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-[13px] font-semibold tabular-nums">
        {formatCurrency(from)} <span className="text-muted-foreground">→</span> {formatCurrency(to)}
      </p>
      <p className={cn("text-[11px] font-medium tabular-nums", good == null ? "text-muted-foreground" : good ? "text-success" : "text-expense")}>{signedCurrency(change)} in this period</p>
    </div>
  );
}

/** Two-sided bar: money in to the right (green), money out to the left (red), scaled to the busiest account. */
function FlowBar({ moneyIn, moneyOut, max }: { moneyIn: number; moneyOut: number; max: number }) {
  return (
    <div className="flex h-2 w-28 items-center" aria-hidden>
      <div className="flex h-full flex-1 justify-end overflow-hidden rounded-l-full bg-muted">
        <div className="h-full rounded-l-full bg-expense/80" style={{ width: `${(moneyOut / max) * 100}%` }} />
      </div>
      <div className="h-3 w-px bg-border" />
      <div className="flex h-full flex-1 overflow-hidden rounded-r-full bg-muted">
        <div className="h-full rounded-r-full bg-success/80" style={{ width: `${(moneyIn / max) * 100}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Debts, EMIs & cards

const LIABILITY_COLORS = ["var(--chart-2)", "var(--purple)", "var(--chart-4)", "var(--chart-1)", OTHER_COLOR];

export function DebtsTab({ detail, position, accountInfo }: { detail: PeriodDetail; position: CurrentPosition; accountInfo: Map<string, ReportAccountInfo> }) {
  const paid = [
    { label: "EMI installments", value: detail.debt.emiPaidDirect, color: "var(--chart-4)" },
    { label: "Loan repayments", value: Math.max(0, detail.debt.loanRepaid - detail.debt.loanRepaidOnCard), color: "var(--purple)" },
    { label: "Card bills", value: detail.debt.cardBillPayments, color: "var(--chart-2)" },
  ];
  const paidTotal = detail.debt.paidTowardsDebts;
  const util = position.cardLimit > 0 ? (position.cardUsedCredit / position.cardLimit) * 100 : null;
  return (
    <div className="grid gap-5 @4xl:grid-cols-3" data-testid="rep-debts">
      <div className="min-w-0">
        <SubHead title="Paid this period" sub={`${formatCurrency(paidTotal)} towards debts`} hint="Payments marked “already paid earlier” are left out because no money moved in FlowFi. Card bill payments are cash leaving your accounts; card purchases are in Total outflow. EMI and loan installments charged to a card are settled by its bill, so they count under Card bills only, never twice." />
        <div className="flex flex-col gap-2.5">
          {paid.map((p) => (
            <div key={p.label}>
              <div className="mb-1 flex items-baseline justify-between text-[13px]">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ background: p.color }} aria-hidden />
                  {p.label}
                </span>
                <span className="font-medium tabular-nums">{formatCurrency(p.value)}</span>
              </div>
              <ShareBar value={p.value} total={paidTotal} color={p.color} />
            </div>
          ))}
          {detail.debt.loanCollected > 0 && <FigureRow label="Loan repayments collected" tone={MONEY.in} value={formatCurrency(detail.debt.loanCollected)} />}
          {detail.debt.loanCollectedLegacy > 0 && (
            <p className="text-[11px] leading-snug text-muted-foreground" data-testid="rep-legacy-collected">
              {formatCurrency(detail.debt.loanCollectedLegacy)} of this is an older record with no account transaction: it counts in cash-basis Money In only, never in Income or any account balance.
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0 border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5">
        <SubHead title="Owed today" sub="Remaining principal, as of today" hint="Remaining principal only; future interest isn't counted. A card EMI is counted once, on its card." />
        {position.liabilities.length === 0 ? (
          <p className="py-2 text-[13px] text-muted-foreground">Nothing owed.</p>
        ) : (
          <div className="flex flex-col gap-2.5" data-testid="rep-liabilities">
            {position.liabilities.map((l, i) => (
              <div key={l.name}>
                <div className="mb-1 flex items-baseline justify-between text-[13px]">
                  <span className="text-muted-foreground">{l.name}</span>
                  <span className="font-medium tabular-nums">{formatCurrency(l.value)}</span>
                </div>
                <ShareBar value={l.value} total={position.totalLiabilities} color={LIABILITY_COLORS[i % LIABILITY_COLORS.length]} />
              </div>
            ))}
            <FigureRow label="Total owed" value={formatCurrency(position.totalLiabilities)} strong />
          </div>
        )}
      </div>

      <div className="min-w-0 border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5">
        <SubHead title="Credit cards" sub={position.cardLimit > 0 ? `${formatCurrency(position.cardUsedCredit)} of ${formatCurrency(position.cardLimit)} limit in use` : "No card limits recorded"} />
        {util != null && (
          <div className="mb-3" data-testid="rep-card-util">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full transition-[width] duration-700", util > 75 ? "bg-expense" : util > 30 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, util)}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {util.toFixed(0)}% used (outstanding + card-EMI principal) · {formatCurrency(position.cardOutstanding)} outstanding
            </p>
          </div>
        )}
        {detail.cards.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No card activity in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[260px] text-[12.5px]" data-testid="rep-cards">
              <thead>
                <tr className="text-[10.5px] tracking-wide text-muted-foreground uppercase">
                  <th className="pb-1 text-left font-medium">Card</th>
                  <th className="pb-1 text-right font-medium">Spent</th>
                  <th className="pb-1 text-right font-medium">Refunds</th>
                  <th className="pb-1 text-right font-medium">Paid</th>
                </tr>
              </thead>
              <tbody>
                {detail.cards.map((c) => (
                  <tr key={c.accountId} className="border-t border-border/40">
                    <td className="max-w-28 truncate py-1.5 pr-2 text-foreground">{accountInfo.get(c.accountId)?.name ?? "Card"}</td>
                    <td className="text-right tabular-nums">{formatCurrency(c.purchases)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{c.refunds ? formatCurrency(c.refunds) : "—"}</td>
                    <td className="text-right tabular-nums text-success">{c.payments ? formatCurrency(c.payments) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- People

export function PeopleTab({ detail, position }: { detail: PeriodDetail; position: CurrentPosition }) {
  const netPos = position.peopleReceivable - position.peoplePayable;
  const flowMax = Math.max(detail.people.receivedFromPeople, detail.people.paidToPeople, detail.othersShare, 1);
  return (
    <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" data-testid="rep-people">
      <div className="min-w-0">
        <SubHead title="Balances today" sub="Money with friends and family" />
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-success/8 p-3">
            <p className="text-[11px] font-medium text-muted-foreground">Owed to me</p>
            <p className="mt-1 font-heading text-lg font-semibold tabular-nums" data-testid="rep-people-receivable">{formatCurrency(position.peopleReceivable)}</p>
          </div>
          <div className="rounded-xl bg-expense/8 p-3">
            <p className="text-[11px] font-medium text-muted-foreground">I owe</p>
            <p className="mt-1 font-heading text-lg font-semibold tabular-nums" data-testid="rep-people-payable">{formatCurrency(position.peoplePayable)}</p>
          </div>
        </div>
        <div className="mt-2 divide-y divide-border/50">
          <FigureRow label="Net with people" value={<span className={netPos >= 0 ? "text-success" : "text-expense"}>{signedCurrency(netPos)}</span>} />
          {position.assignedReceivable > 0 && <FigureRow label="Owed for upcoming EMIs I carry for others" value={formatCurrency(position.assignedReceivable)} />}
          {position.assignedDebt > 0 && <FigureRow label="Debt in my name that others repay" value={formatCurrency(position.assignedDebt)} />}
          {position.lentReceivable > 0 && <FigureRow label="Loans I gave (principal due)" value={formatCurrency(position.lentReceivable)} />}
        </div>
      </div>
      <div className="min-w-0 border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5">
        <SubHead title="This period" sub="Settlements and split bills" />
        <div className="flex flex-col gap-2.5">
          {[
            { label: "Received from people", value: detail.people.receivedFromPeople, color: MONEY.in },
            { label: "Paid / lent to people", value: detail.people.paidToPeople, color: MONEY.out },
            { label: "Others' share I paid (split bills)", value: detail.othersShare, color: "var(--chart-2)" },
          ].map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-baseline justify-between text-[13px]">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-medium tabular-nums">{formatCurrency(r.value)}</span>
              </div>
              <ShareBar value={r.value} total={flowMax} color={r.color} />
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <HandCoins className="mt-px size-3.5 shrink-0" aria-hidden />
          People settlements move money, not spending, so they never change Income or My spend. Others&apos; share of a split bill is in Total outflow but not in My spend.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Net worth

export function NetWorthTab({ points, position, selected }: { points: { period: ReportPeriod; netWorth: number }[]; position: CurrentPosition; selected: ReportPeriod }) {
  const data = points.map((p) => ({ key: p.period.start.getTime(), label: p.period.shortLabel, full: p.period.label, netWorth: p.netWorth }));
  const first = data[0]?.netWorth ?? 0;
  const last = data[data.length - 1]?.netWorth ?? 0;
  const negative = data.some((d) => d.netWorth < 0);
  const sel = data.find((d) => d.key === selected.start.getTime());
  return (
    <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_16rem]" data-testid="rep-networth" data-last={last} data-selected={sel?.netWorth}>
      <div className="min-w-0">
        <SubHead
          title="Net worth over time"
          sub={`At the end of each period · ${signedCurrency(last - first)} over ${data.length} period${data.length === 1 ? "" : "s"}`}
          hint="Today's Net Worth, worked backwards through your records. Each loan or EMI payment changes it by its interest and charges only, since the principal part just lowers what you owe. A split bill changes it by your share only. Transfers and People settlements don't change it. Shares of EMIs that people owe you count from today."
        />
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="rep-nw-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.24} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis {...AXIS} tickFormatter={formatCurrencyCompact} width={56} domain={negative ? ["auto", "auto"] : [0, "auto"]} />
              {negative && <ReferenceLine y={0} stroke="var(--border)" />}
              {sel && <ReferenceLine x={sel.label} stroke="var(--primary)" strokeOpacity={0.35} strokeDasharray="3 3" />}
              <Tooltip cursor={{ stroke: "var(--border)" }} content={<RichTooltip title={(row) => String(row?.full ?? "")} />} />
              <Area type="monotone" dataKey="netWorth" name="Net worth" stroke="var(--primary)" strokeWidth={2} fill="url(#rep-nw-fill)" dot={{ r: 2.5, strokeWidth: 0, fill: "var(--primary)" }} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-center border-t border-border/60 pt-4 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5">
        <Eyebrow>Today</Eyebrow>
        <FigureRow label="What I own" tone={MONEY.in} value={formatCurrency(position.assets)} testId="rep-nw-assets" />
        <FigureRow label="What I owe" tone={MONEY.out} value={formatCurrency(position.debt)} testId="rep-nw-debt" />
        {position.heldForPeople > 0 && <FigureRow label="Held for people" value={formatCurrency(position.heldForPeople)} />}
        <FigureRow label="Net worth today" value={<span data-value={position.netWorth}>{formatCurrency(position.netWorth)}</span>} strong testId="rep-nw-today" />
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2">
          <Scale className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Cash in bank, cash and wallets: <span className="font-medium text-foreground tabular-nums">{formatCurrency(position.liquidBalance)}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
