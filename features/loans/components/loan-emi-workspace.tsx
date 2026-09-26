"use client";

import { ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { FloatingCard } from "@/components/foundation/floating-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { loanDisplayName, loanNextDueAmount } from "@/features/loans/components/loan-card";
import { EMI_ICON, KIND_COPY, LOAN_ICON, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { formatCurrency } from "@/lib/format";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

export type LoanEmiTab = "loan" | "emi";

const KINDS: { value: LoanEmiTab; icon: typeof LOAN_ICON }[] = [
  { value: "loan", icon: LOAN_ICON },
  { value: "emi", icon: EMI_ICON },
];

/** The two Add choices — shared by the header's Add popover and the first-run welcome. */
function KindChoice({ kind, onSelect, large = false }: { kind: LoanEmiTab; onSelect: () => void; large?: boolean }) {
  const Icon = kind === "loan" ? LOAN_ICON : EMI_ICON;
  const copy = KIND_COPY[kind];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border border-border bg-card text-left outline-none transition-colors hover:border-foreground/30 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        large ? "p-4 sm:p-5" : "p-3",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl bg-muted text-foreground ring-1 ring-border transition-colors group-hover:bg-primary group-hover:text-primary-foreground group-hover:ring-primary",
          large ? "size-12" : "size-10",
        )}
      >
        <Icon className={large ? "size-6" : "size-5"} strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("font-heading font-semibold text-foreground", large ? "text-base" : "text-sm")}>{copy.label}</span>
        <span className="text-xs leading-snug text-muted-foreground">{copy.description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

/**
 * The single Loan & EMI section: what you owe and what's due next at the top, a Loans | EMIs switch, and one
 * Add that asks "Loan or EMI?" before handing off to that workspace's own form. The summary only sums the
 * per-row figures the cards already show — no separate financial computation.
 */
export function LoanEmiWorkspace({ initialTab = "loan" }: { initialTab?: LoanEmiTab }) {
  const [tab, setTab] = useState<LoanEmiTab>(initialTab);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [addSignals, setAddSignals] = useState({ loan: 0, emi: 0 });
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const isLoading = loansLoading || emisLoading;

  function add(kind: LoanEmiTab) {
    setChooserOpen(false);
    setTab(kind);
    setAddSignals((s) => ({ ...s, [kind]: s[kind] + 1 }));
  }

  const summary = useMemo(() => {
    const activeBorrowed = loanRows.filter((r) => r.status !== "closed" && r.direction === "taken");
    const activeLent = loanRows.filter((r) => r.status !== "closed" && r.direction === "given");
    const activeEmis = emiRows.filter((r) => r.status !== "closed" && r.status !== "completed");
    const upcoming = [
      ...activeBorrowed
        .filter((r) => r.nextDueDate != null)
        .map((r) => ({ kind: "loan" as const, name: loanDisplayName(r), date: r.nextDueDate!, amount: loanNextDueAmount(r) ?? 0 })),
      ...activeEmis
        .filter((r) => r.nextInstallment != null)
        .map((r) => ({ kind: "emi" as const, name: r.emi.name, date: r.nextInstallment!.dueDate, amount: remainingAmount(r.nextInstallment!) })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      owed:
        activeBorrowed.reduce((sum, r) => sum + r.outstandingPrincipal, 0) + activeEmis.reduce((sum, r) => sum + r.remainingBalance, 0),
      toReceive: activeLent.reduce((sum, r) => sum + r.outstandingPrincipal, 0),
      loanCount: activeBorrowed.length + activeLent.length,
      emiCount: activeEmis.length,
      next: upcoming[0] ?? null,
    };
  }, [loanRows, emiRows]);

  const isEmpty = !isLoading && loanRows.length === 0 && emiRows.length === 0;
  const counts: Record<LoanEmiTab, number> = { loan: loanRows.length, emi: emiRows.length };

  return (
    <div className="flex flex-col gap-5 px-1">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">Loan &amp; EMI</h1>
          <p className="text-sm text-muted-foreground">What you owe, and what&apos;s due next.</p>
        </div>
        <Popover open={chooserOpen} onOpenChange={setChooserOpen}>
          <PopoverTrigger asChild>
            <ClayButton className="gap-1.5" aria-haspopup="dialog">
              <Plus className="size-4" />
              Add
            </ClayButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 border border-border p-2">
            <p className="px-1.5 pt-1 pb-0.5 text-xs font-semibold text-muted-foreground">What are you adding?</p>
            {KINDS.map(({ value }) => (
              <KindChoice key={value} kind={value} onSelect={() => add(value)} />
            ))}
          </PopoverContent>
        </Popover>
      </header>

      {isLoading ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : isEmpty ? (
        <FloatingCard interactive={false} elevation={1} className="flex flex-col gap-4 border-border px-5 py-6 sm:px-7">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-lg font-semibold text-foreground">Track what you owe in one place</h2>
            <p className="max-w-xl text-sm text-muted-foreground">
              Add a Loan or an EMI and FlowFi builds its installment schedule, shows what&apos;s due next, and keeps the outstanding
              balance up to date as you pay.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {KINDS.map(({ value }) => (
              <KindChoice key={value} kind={value} large onSelect={() => add(value)} />
            ))}
          </div>
        </FloatingCard>
      ) : (
        <FloatingCard
          interactive={false}
          elevation={1}
          className="grid grid-cols-2 gap-x-6 gap-y-4 border-border px-5 py-5 sm:px-6 lg:grid-cols-[1.4fr_1fr_1.4fr]"
        >
          <div className="col-span-2 flex flex-col gap-1 lg:col-span-1">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Total outstanding</span>
            <span className="font-heading text-3xl leading-none font-semibold tracking-tight text-foreground tabular-nums sm:text-4xl">
              {formatCurrency(summary.owed)}
            </span>
            {summary.toReceive > 0 && (
              <span className="text-xs text-muted-foreground">
                + <span className="font-medium text-success tabular-nums">{formatCurrency(summary.toReceive)}</span> lent, still to receive
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 lg:border-l lg:border-border lg:pl-6">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Active</span>
            <span className="text-sm font-medium text-foreground">
              <span className="font-heading text-xl font-semibold tabular-nums">{summary.loanCount}</span>{" "}
              {summary.loanCount === 1 ? "Loan" : "Loans"}
            </span>
            <span className="text-sm font-medium text-foreground">
              <span className="font-heading text-xl font-semibold tabular-nums">{summary.emiCount}</span>{" "}
              {summary.emiCount === 1 ? "EMI" : "EMIs"}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1 lg:border-l lg:border-border lg:pl-6">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Next installment</span>
            {summary.next ? (
              <>
                <span className="font-heading text-xl font-semibold text-foreground tabular-nums">{formatCurrency(summary.next.amount)}</span>
                <span className="truncate text-sm text-foreground/85">{summary.next.name}</span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    daysUntil(summary.next.date) < 0 ? "text-expense" : daysUntil(summary.next.date) <= 3 ? "text-warning-foreground dark:text-warning" : "text-muted-foreground",
                  )}
                >
                  {dueLabel(summary.next.date)}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Nothing due</span>
            )}
          </div>
        </FloatingCard>
      )}

      {!isEmpty && (
        <div
          role="tablist"
          aria-label="Loans or EMIs"
          className="inline-flex w-full gap-1 self-start rounded-xl border border-border bg-muted p-1 sm:w-auto"
        >
          {KINDS.map(({ value, icon: Icon }) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none",
                  active ? "bg-card text-foreground shadow-e1 ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {KIND_COPY[value].plural}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] tabular-nums",
                    active ? "bg-primary text-primary-foreground" : "bg-card/80 text-muted-foreground",
                  )}
                >
                  {counts[value]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Both stay mounted so an Add pick reaches the target workspace's form (its dialogs portal out). */}
      <div hidden={isEmpty || tab !== "loan"}>
        <LoansWorkspace addSignal={addSignals.loan} />
      </div>
      <div hidden={isEmpty || tab !== "emi"}>
        <EmiWorkspace addSignal={addSignals.emi} />
      </div>
    </div>
  );
}
