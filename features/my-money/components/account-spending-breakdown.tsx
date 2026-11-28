import { ChevronRight, Download, Info, Landmark, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { downloadCsv } from "@/features/transaction-studio/lib/export-csv";
import { cycleRangeForMonth } from "@/lib/engines/month-cycle-range";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { accountSpendingCsv, accountSpendingDate, type AccountSpending, type AccountSpendingKind } from "../lib/account-spending";

const GROUPS = {
  loanPayments: { label: "Loan / EMI paid", shortLabel: "Loan / EMI", file: "loan-emi-payments", icon: Landmark, tone: "text-purple", surface: "border-purple/20 bg-purple/7", chip: "bg-purple/14" },
  expenses: { label: "Other expenses", shortLabel: "Other expenses", file: "other-expenses", icon: ShoppingBag, tone: "text-primary-accent-text", surface: "border-primary-accent-text/16 bg-primary/9", chip: "bg-primary/20" },
} as const;
const KINDS: readonly AccountSpendingKind[] = ["loanPayments", "expenses"];
const SHORT_DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long" });
const FULL_DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const SCROLL = "max-h-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const TABLE_HEAD = "sticky top-0 z-10 bg-popover text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]";

type MonthlyAmounts = Readonly<Record<AccountSpendingKind, number>>;

interface AccountSpendingProps {
  spending: AccountSpending;
  range: { start: Date; end: Date };
  startDay: number;
  exportPeriod: string;
  months?: readonly MonthlyAmounts[];
  className?: string;
}

function AccountTotals({ spending, compact = false }: { spending: AccountSpending; compact?: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {KINDS.map((kind) => {
        const { label, icon: Icon, tone, surface, chip } = GROUPS[kind];
        return (
          <div key={kind} className={cn("flex min-w-0 flex-col justify-between rounded-[10px] border", compact ? "px-2 py-1.5" : "px-3 py-2", surface)}>
            <dt className="flex items-center gap-1.5 text-xs leading-tight font-medium text-foreground/85">
              <span className={cn("size-5 shrink-0 place-items-center rounded-md", compact ? "hidden @min-[19rem]/account-summary:grid" : "grid", chip, tone)}>
                <Icon aria-hidden className="size-3" />
              </span>
              {label}
            </dt>
            <dd className="mt-1 font-heading text-base leading-tight font-bold tracking-tight wrap-anywhere text-foreground tabular-nums">
              {formatCurrencyExact(spending[kind].amount)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function MonthlyAccountRows({ months, year, startDay }: { months: readonly MonthlyAmounts[]; year: number; startDay: number }) {
  const rows = months.map((amounts, month) => ({ amounts, ...cycleRangeForMonth(startDay, year, month) })).reverse();
  return (
    <ScrollArea className={SCROLL} role="region" aria-label="Monthly account breakdown" tabIndex={0}>
      <table className="w-full border-separate border-spacing-0 tabular-nums">
        <thead className={TABLE_HEAD}>
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-semibold">{startDay > 1 ? "Cycle ends" : "Month"}</th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">Loan / EMI</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">Other expenses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ amounts, start, end }) => (
            <tr key={end.getMonth()} className="odd:bg-secondary/25 hover:bg-secondary/60">
              <th scope="row" className="border-b border-border/60 px-4 py-2.5 text-left font-semibold">
                {MONTH.format(end)}
                {startDay > 1 && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{SHORT_DATE.format(start)} – {SHORT_DATE.format(end)}</span>}
              </th>
              {KINDS.map((kind) => (
                <td key={kind} className={cn("border-b border-border/60 px-3 py-2.5 text-right whitespace-nowrap last:pr-4", amounts[kind] > 0 ? "font-semibold" : "text-muted-foreground")}>
                  {formatCurrencyExact(amounts[kind])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function AccountTransactionRows({ spending }: { spending: AccountSpending }) {
  const rows = [...spending.loanPayments.rows, ...spending.expenses.rows].sort((a, b) => b.date.getTime() - a.date.getTime());
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No account spending recorded for this period.</p>;

  return (
    <ScrollArea className={SCROLL} role="region" aria-label="Account transactions" tabIndex={0}>
      <table className="w-full border-separate border-spacing-0">
        <thead className={TABLE_HEAD}>
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-semibold">Date</th>
            <th scope="col" className="px-2 py-2.5 text-left font-semibold">Transaction</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { shortLabel, tone } = GROUPS[row.kind];
            return (
              <tr key={row.id} className="odd:bg-secondary/25 hover:bg-secondary/60">
                <td className="border-b border-border/60 px-4 py-3 align-top text-xs whitespace-nowrap text-muted-foreground">{FULL_DATE.format(row.date)}</td>
                <td className="border-b border-border/60 px-2 py-3 align-top">
                  <div className="font-semibold wrap-anywhere">{row.description}</div>
                  <div className="mt-0.5 text-xs wrap-anywhere text-muted-foreground">{row.account} <span aria-hidden>·</span> <span className={tone}>{shortLabel}</span></div>
                </td>
                <td className="border-b border-border/60 px-4 py-3 text-right align-top font-semibold whitespace-nowrap tabular-nums">{formatCurrencyExact(row.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  );
}

export function AccountSpendingBreakdown({ spending, range, startDay, exportPeriod, months, className }: AccountSpendingProps) {
  return (
    <Sheet>
      <div className={cn("@container/account-summary border-t border-border-strong/45 bg-linear-to-b from-secondary/55 to-transparent px-3 py-2", className)}>
        <div className="mb-1.5 flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-sm leading-tight font-semibold">
            From your accounts
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="About spending from your accounts" className="shrink-0 rounded text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  <Info aria-hidden className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                Loan / EMI paid includes the full debit, even for someone else. Other expenses includes your share of each expense. Both use recorded account debits and exclude credit-card purchases and regular card bill payments.
              </TooltipContent>
            </Tooltip>
          </div>
          <SheetTrigger asChild>
            <Button variant="ghost" size="xs" aria-label={`View details for account spending in ${exportPeriod}`} className="font-semibold text-primary-accent-text">
              View details <ChevronRight aria-hidden />
            </Button>
          </SheetTrigger>
        </div>
        <AccountTotals spending={spending} compact />
      </div>

      <SheetContent
        overlayClassName="bg-black/25 backdrop-blur-none dark:bg-black/40"
        className="gap-0 overflow-hidden rounded-2xl border border-border-strong/60 shadow-[var(--shadow-e4)] data-[side=right]:top-4 data-[side=right]:right-4 data-[side=right]:bottom-auto data-[side=right]:h-auto data-[side=right]:max-h-[calc(100dvh-2rem)] data-[side=right]:w-[calc(100%-2rem)] data-[side=right]:sm:max-w-[36rem]"
      >
        <SheetHeader className="border-b border-border/70 bg-linear-to-br from-primary/12 to-transparent px-4 pt-4 pb-3">
          <SheetTitle className="pr-10 text-lg font-bold tracking-tight">From your accounts</SheetTitle>
          <SheetDescription className="tabular-nums">{FULL_DATE.formatRange(range.start, range.end)}</SheetDescription>
          <div className="mt-2"><AccountTotals spending={spending} /></div>
        </SheetHeader>

        {months ? (
          <Tabs defaultValue="months" className="min-h-0 gap-0">
            <div className="shrink-0 border-b border-border/60 px-4 py-2">
              <TabsList aria-label="Account spending detail">
                <TabsTrigger value="months">By month</TabsTrigger>
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="months" className="flex min-h-0 flex-col data-[state=inactive]:hidden">
              <MonthlyAccountRows months={months} year={range.end.getFullYear()} startDay={startDay} />
            </TabsContent>
            <TabsContent value="transactions" className="flex min-h-0 flex-col data-[state=inactive]:hidden">
              <AccountTransactionRows spending={spending} />
            </TabsContent>
          </Tabs>
        ) : <AccountTransactionRows spending={spending} />}

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-secondary/25 px-4 py-2.5">
          <span className="text-xs font-semibold text-muted-foreground">Export CSV</span>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((kind) => {
              const { label, shortLabel, file } = GROUPS[kind];
              const group = spending[kind];
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="sm"
                  aria-label={`Export ${label} CSV for ${exportPeriod}`}
                  disabled={group.rows.length === 0}
                  onClick={() => downloadCsv(`flowfi-${file}-${accountSpendingDate(range.start)}-to-${accountSpendingDate(range.end)}.csv`, accountSpendingCsv(group, startDay))}
                  className="text-xs"
                >
                  <Download aria-hidden className="size-3.5" />
                  {shortLabel}
                </Button>
              );
            })}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
