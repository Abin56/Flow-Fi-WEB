"use client";

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { FloatingCard } from "@/components/foundation/floating-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { loanDisplayName, loanNextDueAmount } from "@/features/loans/components/loan-card";
import { AmountDisplay, EMI_ICON, KIND_COPY, KindChoice, LOAN_ICON, SegmentedControl, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { formatCurrency } from "@/lib/format";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

export type LoanEmiTab = "loan" | "emi";

const KINDS = [
  { value: "loan" as const, icon: LOAN_ICON },
  { value: "emi" as const, icon: EMI_ICON },
];

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 truncate text-sm font-semibold text-foreground tabular-nums">{children}</div>
    </div>
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

  const hasAny = loanRows.length > 0 || emiRows.length > 0;
  const counts: Record<LoanEmiTab, number> = { loan: loanRows.length, emi: emiRows.length };
  const nextDays = summary.next ? daysUntil(summary.next.date) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">Loan &amp; EMI</h1>
          <p className="text-sm text-muted-foreground">Track borrowing, installments and repayments.</p>
        </div>
        <Popover open={chooserOpen} onOpenChange={setChooserOpen}>
          <PopoverTrigger asChild>
            <ClayButton size="sm" className="shrink-0 gap-1.5" aria-haspopup="dialog">
              <Plus className="size-4" />
              Add
            </ClayButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="flex w-[min(21rem,calc(100vw-2rem))] flex-col gap-0.5 rounded-2xl border border-border p-1.5 shadow-lg">
            <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Add new</p>
            {KINDS.map(({ value }) => (
              <KindChoice key={value} kind={value} onSelect={() => add(value)} />
            ))}
          </PopoverContent>
        </Popover>
      </header>

      {isLoading ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : (
        hasAny && (
          <FloatingCard interactive={false} elevation={1} className="flex flex-col gap-5 border-border px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Total outstanding</span>
              <AmountDisplay amount={summary.owed} size="lg" />
              {summary.toReceive > 0 && (
                <span className="text-xs text-muted-foreground">
                  + <span className="font-medium text-success tabular-nums">{formatCurrency(summary.toReceive)}</span> lent, still to receive
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-4">
              <Metric label="Next payment">
                {summary.next ? (
                  <span className="flex min-w-0 flex-col">
                    <span>{formatCurrency(summary.next.amount)}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">{summary.next.name}</span>
                  </span>
                ) : (
                  <span className="font-normal text-muted-foreground">Nothing due</span>
                )}
              </Metric>
              <Metric label="Due date">
                {summary.next && nextDays != null ? (
                  <span
                    className={cn(
                      nextDays < 0 ? "text-expense" : nextDays <= 3 ? "text-warning-foreground dark:text-warning" : "text-foreground",
                    )}
                  >
                    {dueLabel(summary.next.date)}
                  </span>
                ) : (
                  <span className="font-normal text-muted-foreground">—</span>
                )}
              </Metric>
              <Metric label="Active Loans">{summary.loanCount}</Metric>
              <Metric label="Active EMIs">{summary.emiCount}</Metric>
            </div>
          </FloatingCard>
        )
      )}

      <SegmentedControl
        role="tablist"
        ariaLabel="Loans or EMIs"
        options={KINDS.map(({ value, icon }) => ({ value, icon, label: KIND_COPY[value].plural, count: hasAny ? counts[value] : undefined }))}
        value={tab}
        onChange={setTab}
      />

      {/* Both stay mounted so an Add pick reaches the target workspace's form (its dialogs portal out). */}
      <div hidden={tab !== "loan"}>
        <LoansWorkspace addSignal={addSignals.loan} />
      </div>
      <div hidden={tab !== "emi"}>
        <EmiWorkspace addSignal={addSignals.emi} />
      </div>
    </div>
  );
}
