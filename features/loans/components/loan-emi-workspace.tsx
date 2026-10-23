"use client";

import { CalendarClock, ListChecks, Plus, Search, SlidersHorizontal, Trash2, Wallet, X, type LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { EmptyState } from "@/components/finance";
import { Stagger } from "@/components/foundation/animated-container";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiCard } from "@/features/emi/components/emi-card";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { useEmiActions, useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { LoanCard, loanDisplayName, loanNextDueAmount } from "@/features/loans/components/loan-card";
import { LoanEmiAddDialog } from "@/features/loans/components/loan-emi-add-dialog";
import { AmountDisplay, LE_RADIUS, LOAN_EMI_INPUT, Money, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
import { MyCommitmentsSummary } from "@/features/loans/components/my-commitments-summary";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { OwnershipConfirmDialog, type OwnershipConfirmTarget } from "@/features/loans/components/ownership-confirm-dialog";
import { useLoanActions, useLoanRows, useTrashedLoanRows } from "@/features/loans/hooks/use-loans-data";
import { recordKindForEmi, recordKindForLoan, type AddKind } from "@/features/loans/lib/loan-emi-add";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "active" | "closed";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];

/** Pill choices with a count badge — one radio group; scrolls sideways on a narrow screen instead of wrapping into a block. */
function FilterPills<T extends string>({ options, value, onChange, ariaLabel }: { options: { value: T; label: string; count: number }[]; value: T; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border pr-1.5 pl-3 text-xs whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary-accent-text bg-primary font-semibold text-primary-foreground" : "border-border bg-secondary/50 font-medium text-foreground hover:bg-secondary",
            )}
          >
            {o.label}
            <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums", active ? "bg-black/15" : "bg-card text-muted-foreground")}>{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Older `?create=` handoffs (agreement flows, bookmarks) → the unified form's "What is this?". */
const CREATE_HANDOFF: Record<string, AddKind> = { borrowed: "borrowed", lent: "lent", installmentPurchase: "purchase" };

/** Primary CTA in the Loan & EMI style — lime with a dark olive edge so it holds its shape on pale displays. */
const PRIMARY_CTA = "rounded-[6px] border-primary-accent-text font-semibold";
const SECONDARY_BTN = "rounded-[6px] border-border-strong font-medium text-foreground hover:bg-secondary";

const amountDigits = (...values: (number | null | undefined)[]) => values.filter((v): v is number => v != null && Number.isFinite(v)).map((v) => String(Math.round(v)));

/** How close a single typed amount must be to count as "around" it — 700 finds 726. */
const AMOUNT_TOLERANCE = 0.1;

const num = (s: string) => Number(s.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, ""));

/**
 * Reads an amount query: "726" / "₹70,843" (around that amount, or containing those digits), "500-1000" / "500 to 1000"
 * (a range), ">5000" / "<1000" (above / below). Anything else is not an amount — null, so it stays a text search.
 */
function amountMatcher(q: string): ((amounts: string[]) => boolean) | null {
  const t = q.trim();
  const range = t.match(/^([\d₹,.\s]+?)\s*(?:-|–|to|\.\.)\s*([\d₹,.\s]+)$/i);
  if (range) {
    const [a, b] = [num(range[1]), num(range[2])];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return (amounts) => amounts.some((x) => Number(x) >= lo && Number(x) <= hi);
  }
  const cmp = t.match(/^([<>])=?\s*([\d₹,.\s]+)$/);
  if (cmp) {
    const n = num(cmp[2]);
    if (!Number.isFinite(n)) return null;
    return (amounts) => amounts.some((x) => (cmp[1] === ">" ? Number(x) >= n : Number(x) <= n));
  }
  const digits = t.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return (amounts) => amounts.some((x) => x.includes(digits) || Math.abs(Number(x) - n) <= n * AMOUNT_TOLERANCE);
}

/** One list entry — a Loan or an EMI record, as the user sees it. Which collection it lives in stays underneath. */
interface Entry {
  key: string;
  source: "loan" | "emi";
  id: string;
  label: string;
  name: string;
  searchText: string;
  /** Amounts shown on the card (whole rupees, digits only) — so "70843" or "₹70,843" finds it. */
  amounts: string[];
  done: boolean;
  nextDate: Date | null;
}

function Metric({ label, icon: Icon, children }: { label: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-3 @xl:px-4">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        {Icon && <Icon className="size-3.5 text-foreground" />}
        {label}
      </span>
      <div className="min-w-0 truncate text-sm font-semibold text-foreground tabular-nums">{children}</div>
    </div>
  );
}

/**
 * The single Loan & EMI workspace: one summary, one list of every obligation (tagged "Bank Loan", "Credit
 * Card EMI", "Lent", …) and one Add flow. Loans and EMIs still open their own detail/edit/payment dialogs
 * (mounted below, list-less) and are still created through their own repositories — see `loan-emi-add.ts`.
 * The summary only sums the per-row figures the cards already show; no separate financial computation.
 */
export function LoanEmiWorkspace() {
  const searchParams = useSearchParams();
  const handoffKind = CREATE_HANDOFF[searchParams.get("create") ?? ""] ?? null;
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { rows: trashedLoanRows } = useTrashedLoanRows();
  const isLoading = loansLoading || emisLoading;

  // A fresh `key` per open so every Add starts from a clean form with a new idempotency key.
  const [add, setAdd] = useState<{ open: boolean; seq: number; kind: AddKind | null }>({ open: handoffKind != null, seq: 0, kind: handoffKind });
  const [loanOpenRequest, setLoanOpenRequest] = useState<{ id: string; seq: number } | null>(null);
  const [emiOpenRequest, setEmiOpenRequest] = useState<{ id: string; seq: number } | null>(null);
  const [trashRequest, setTrashRequest] = useState(0);
  const [ownershipTarget, setOwnershipTarget] = useState<OwnershipConfirmTarget | null>(null);
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  function openAdd() {
    setAdd((a) => ({ open: true, seq: a.seq + 1, kind: null }));
  }

  const summary = useMemo(() => {
    const activeBorrowed = loanRows.filter((r) => r.status !== "closed" && r.direction === "taken");
    const activeLent = loanRows.filter((r) => r.status !== "closed" && r.direction === "given");
    const activeEmis = emiRows.filter((r) => r.status !== "closed" && r.status !== "completed");
    const upcoming = [
      ...activeBorrowed
        .filter((r) => r.nextDueDate != null)
        .map((r) => ({ name: loanDisplayName(r), date: r.nextDueDate!, amount: loanNextDueAmount(r) ?? 0 })),
      ...activeEmis
        .filter((r) => r.nextInstallment != null)
        .map((r) => ({ name: r.emi.name, date: r.nextInstallment!.dueDate, amount: remainingAmount(r.nextInstallment!) })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      owed:
        activeBorrowed.reduce((sum, r) => sum + r.outstandingPrincipal, 0) + activeEmis.reduce((sum, r) => sum + r.remainingBalance, 0),
      toReceive: activeLent.reduce((sum, r) => sum + r.outstandingPrincipal, 0),
      activeCount: activeBorrowed.length + activeLent.length + activeEmis.length,
      closedCount: loanRows.length + emiRows.length - (activeBorrowed.length + activeLent.length + activeEmis.length),
      next: upcoming[0] ?? null,
      overdueCount: activeBorrowed.filter((r) => r.status === "overdue").length + activeEmis.filter((r) => r.status === "overdue").length,
    };
  }, [loanRows, emiRows]);

  const loanById = useMemo(() => new Map(loanRows.map((r) => [r.loan.id, r])), [loanRows]);
  const emiById = useMemo(() => new Map(emiRows.map((r) => [r.emi.id, r])), [emiRows]);

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...loanRows.map((r) => ({
        key: `loan:${r.loan.id}`,
        source: "loan" as const,
        id: r.loan.id,
        label: recordKindForLoan(r.loan).label,
        name: loanDisplayName(r),
        searchText: [r.loan.name, r.lenderName, r.loan.loanNumber].filter(Boolean).join(" ").toLowerCase(),
        amounts: amountDigits(r.outstandingPrincipal, r.loan.loanAmount, loanNextDueAmount(r)),
        done: r.status === "closed",
        nextDate: r.nextDueDate,
      })),
      ...emiRows.map((r) => ({
        key: `emi:${r.emi.id}`,
        source: "emi" as const,
        id: r.emi.id,
        label: recordKindForEmi(r.emi).label,
        name: r.emi.name,
        searchText: [r.emi.name, r.emi.lenderName, r.emi.loanNumber].filter(Boolean).join(" ").toLowerCase(),
        amounts: amountDigits(r.remainingBalance, r.emi.principalAmount, r.nextInstallment ? remainingAmount(r.nextInstallment) : null),
        done: r.status === "closed" || r.status === "completed",
        nextDate: r.nextInstallment?.dueDate ?? null,
      })),
    ];
    // Active first, soonest payment first; closed/completed at the end.
    return all.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const at = a.nextDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.nextDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return at !== bt ? at - bt : a.name.localeCompare(b.name);
    });
  }, [loanRows, emiRows]);

  const typeOptions = useMemo(() => {
    const labels = [...new Set(entries.map((e) => e.label))];
    const count = (l: string) => entries.filter((e) => e.label === l).length;
    return [{ value: "all", label: "All types", count: entries.length }, ...labels.map((l) => ({ value: l, label: l, count: count(l) }))];
  }, [entries]);

  const statusOptions = useMemo(
    () => STATUS_OPTIONS.map((o) => ({ ...o, count: o.value === "all" ? entries.length : entries.filter((e) => (o.value === "closed" ? e.done : !e.done)).length })),
    [entries],
  );

  // A real example from the user's own list, so "what do I type here?" answers itself.
  const searchExample = useMemo(() => {
    const names = entries.slice(0, 2).map((e) => e.name);
    const amount = entries.find((e) => e.amounts[0])?.amounts[0];
    return names.length > 0 ? `Search name, lender or amount — e.g. ${names.join(", ")}${amount ? `, ${amount}` : ""}` : "Search name, lender, loan number or amount";
  }, [entries]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matchAmount = amountMatcher(query);
    return entries.filter((e) => {
      if (typeFilter !== "all" && e.label !== typeFilter) return false;
      if (statusFilter === "active" && e.done) return false;
      if (statusFilter === "closed" && !e.done) return false;
      if (query === "" || e.searchText.includes(query)) return true;
      return matchAmount != null && matchAmount(e.amounts);
    });
  }, [entries, search, typeFilter, statusFilter]);

  const hasAny = entries.length > 0;
  const nextDays = summary.next ? daysUntil(summary.next.date) : null;
  const filtersActive = search !== "" || typeFilter !== "all" || statusFilter !== "all";
  const showStatus = summary.closedCount > 0;
  const showTypes = typeOptions.length > 2;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Loan &amp; EMI</h1>
          <p className="text-sm text-muted-foreground">Track what you owe, installments and repayments.</p>
        </div>
        <ClayButton className={cn(PRIMARY_CTA, "shrink-0 gap-1.5 px-4")} onClick={openAdd}>
          <Plus className="size-4" strokeWidth={2} />
          Add
        </ClayButton>
      </header>

      {isLoading ? (
        <>
          <Skeleton className={cn(LE_RADIUS.panel, "h-32")} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className={cn(LE_RADIUS.card, "h-48")} />
            ))}
          </div>
        </>
      ) : !hasAny ? (
        <div className={cn(LE_RADIUS.panel, "flex flex-col gap-2 border border-dashed border-border bg-card pb-4")}>
          <EmptyState
            icon={Wallet}
            title="Nothing here yet"
            description="Add a loan you took, a loan you gave, a purchase on installments, or a credit card EMI."
            actionLabel="Add"
            onAction={openAdd}
          />
          {trashedLoanRows.length > 0 && (
            <ClayButton variant="secondary" size="sm" className={cn(SECONDARY_BTN, "gap-1.5 self-center")} onClick={() => setTrashRequest((n) => n + 1)}>
              <Trash2 className="size-3.5" />
              Trash ({trashedLoanRows.length})
            </ClayButton>
          )}
        </div>
      ) : (
        <>
          {/* Summary — one defined panel: the total first and largest, then the next payment and counts. */}
          <section aria-label="Summary" className={cn(LE_RADIUS.panel, "@container border border-border bg-card shadow-e1")}>
           <div className="flex flex-col @4xl:flex-row @4xl:items-stretch">
            <div className="flex flex-col gap-2 px-5 py-4 sm:px-6 @4xl:min-w-72 @4xl:border-r @4xl:border-border">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Total outstanding</span>
              <AmountDisplay amount={summary.owed} size="lg" />
              {summary.toReceive > 0 && (
                <span className="flex items-baseline gap-1 text-xs text-muted-foreground">
                  + <Money amount={summary.toReceive} className="text-sm text-success" /> to receive from loans you gave
                </span>
              )}
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 border-t border-border px-5 @xl:grid-cols-4 @xl:gap-x-0 @xl:divide-x @xl:divide-border @xl:px-2 @4xl:border-t-0">
              <Metric label="Next payment" icon={Wallet}>
                {summary.next ? (
                  <span className="flex min-w-0 flex-col">
                    <Money amount={summary.next.amount} className="text-lg text-foreground" />
                    <span className="truncate text-xs font-medium text-muted-foreground">{summary.next.name}</span>
                  </span>
                ) : (
                  <span className="font-normal text-muted-foreground">Nothing due</span>
                )}
              </Metric>
              <Metric label="Due" icon={CalendarClock}>
                <span className="flex min-w-0 flex-col">
                  {summary.next && nextDays != null ? (
                    <span className={cn("font-semibold", nextDays < 0 ? "text-expense" : nextDays <= 3 ? "text-warning-foreground dark:text-warning" : "text-foreground")}>
                      {dueLabel(summary.next.date)}
                    </span>
                  ) : (
                    <span className="font-normal text-muted-foreground">—</span>
                  )}
                  {summary.overdueCount > 0 && <span className="text-xs font-semibold text-expense">{summary.overdueCount} overdue</span>}
                </span>
              </Metric>
              <Metric label="Active" icon={ListChecks}>
                <span className="font-heading text-lg font-semibold">{summary.activeCount}</span>
              </Metric>
              <Metric label="Closed">
                <span className="font-heading text-lg font-semibold text-muted-foreground">{summary.closedCount}</span>
              </Metric>
            </div>
           </div>
          </section>

          <MyCommitmentsSummary loanRows={loanRows} emiRows={emiRows} defaultExpanded={false} />

          {/* Obligations — a titled list with a solid rule under its toolbar, then the record cards. */}
          {/* Columns follow the section's width (not the viewport), so the sidebar can't squeeze two cards into a tablet. */}
          <section aria-label="Loans and EMIs" className="@container flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
              <h2 className="mr-1 font-heading text-lg font-semibold text-foreground">
                All obligations <span className="ml-1 rounded-full bg-secondary px-2.5 py-0.5 align-middle text-xs font-semibold text-muted-foreground tabular-nums">{entries.length}</span>
              </h2>
              {entries.length > 4 && (
                <div className="relative w-full sm:ml-auto sm:w-80">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={cn(LOAN_EMI_INPUT, "h-9 rounded-full pr-8 pl-9")}
                    placeholder={searchExample}
                    title="Finds a loan or EMI by its name, lender, loan number or an amount — 700 finds amounts around ₹700; try 500-1000, >5000 or <1000 (outstanding, total or next EMI)"
                    aria-label="Search loans and EMIs by name, lender, loan number or amount"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search !== "" && (
                    <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      <X aria-hidden className="size-4" />
                    </button>
                  )}
                </div>
              )}
              {trashedLoanRows.length > 0 && (
                <ClayButton
                  variant="secondary"
                  size="sm"
                  className={cn(SECONDARY_BTN, "gap-1.5", entries.length <= 4 && "ml-auto")}
                  onClick={() => setTrashRequest((n) => n + 1)}
                >
                  <Trash2 className="size-3.5" />
                  Trash ({trashedLoanRows.length})
                </ClayButton>
              )}
            </div>
            {(showStatus || showTypes) && (
              <div className={cn(LE_RADIUS.card, "flex flex-col gap-2 border border-border bg-card p-2.5 shadow-e1 sm:flex-row sm:items-center sm:gap-3")}>
                <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <SlidersHorizontal aria-hidden className="size-3.5" />
                  Filter
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  {showTypes && <FilterPills ariaLabel="Type" options={typeOptions} value={typeFilter} onChange={setTypeFilter} />}
                  {showStatus && showTypes && <span aria-hidden className="hidden h-6 w-px shrink-0 bg-border-strong sm:block" />}
                  {showStatus && <FilterPills ariaLabel="Status" options={statusOptions} value={statusFilter} onChange={setStatusFilter} />}
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground tabular-nums" aria-live="polite">
                    Showing {visible.length} of {entries.length}
                  </span>
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setTypeFilter("all");
                        setStatusFilter("all");
                      }}
                      className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary"
                    >
                      <X aria-hidden className="size-3" />
                      Reset
                    </button>
                  )}
                </div>
              </div>
            )}

            {visible.length === 0 ? (
              <div className={cn(LE_RADIUS.panel, "border border-dashed border-border bg-card")}>
                <EmptyState
                  icon={Search}
                  title="No matches"
                  description="Try a different search or filter."
                  actionLabel={filtersActive ? "Clear filters" : undefined}
                  onAction={() => {
                    setSearch("");
                    setTypeFilter("all");
                    setStatusFilter("all");
                  }}
                />
              </div>
            ) : (
              <Stagger className="grid grid-cols-1 items-start gap-3 @[38rem]:grid-cols-2 @[66rem]:grid-cols-3">
                {visible.map((entry) => {
                  if (entry.source === "loan") {
                    const row = loanById.get(entry.id)!;
                    return (
                      <LoanCard
                        key={entry.key}
                        row={row}
                        tag={entry.label}
                        onClick={() => setLoanOpenRequest((r) => ({ id: entry.id, seq: (r?.seq ?? 0) + 1 }))}
                        onOwnershipAction={(mode) => setOwnershipTarget({ source: "loan", id: entry.id, name: loanDisplayName(row), mode })}
                      />
                    );
                  }
                  const row = emiById.get(entry.id)!;
                  return (
                    <EmiCard
                      key={entry.key}
                      row={row}
                      tag={entry.label}
                      onClick={() => setEmiOpenRequest((r) => ({ id: entry.id, seq: (r?.seq ?? 0) + 1 }))}
                      onOwnershipAction={(mode) => setOwnershipTarget({ source: "emi", id: entry.id, name: row.emi.name, mode })}
                    />
                  );
                })}
              </Stagger>
            )}
          </section>
        </>
      )}

      {/* The records' own dialogs (details, edit, payments, trash) — list-less, opened from the cards above. */}
      <LoansWorkspace openRequest={loanOpenRequest} trashRequest={trashRequest} />
      <EmiWorkspace openRequest={emiOpenRequest} />

      <OwnershipConfirmDialog
        target={ownershipTarget}
        onClose={() => setOwnershipTarget(null)}
        onSubmit={async (t) => {
          const actions = t.source === "loan" ? loanActions : emiActions;
          if (!actions) throw new Error("You're signed out.");
          await (t.mode === "confirm" ? actions.confirmOwnershipMine(t.id) : actions.clearOwnershipConfirmation(t.id));
        }}
      />

      <LoanEmiAddDialog
        key={add.seq}
        open={add.open}
        initialKind={add.kind}
        onOpenChange={(open) => setAdd((a) => ({ ...a, open }))}
      />
      <ScrollNav />
    </div>
  );
}
