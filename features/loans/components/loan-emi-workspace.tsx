"use client";

import { Plus, Search, Trash2, Wallet, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { EmptyState } from "@/components/finance";
import { Stagger } from "@/components/foundation/animated-container";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiCard } from "@/features/emi/components/emi-card";
import { useEmiActions, useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { LoanCard, loanDisplayName, loanNextDueAmount } from "@/features/loans/components/loan-card";
import { LoanEmiAddDialog } from "@/features/loans/components/loan-emi-add-dialog";
import { LE_RADIUS, LOAN_EMI_INPUT, Money, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
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
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary-accent-text bg-primary font-semibold text-primary-foreground" : "border-border bg-card font-medium text-foreground hover:bg-secondary",
            )}
          >
            {o.label}
            <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums", active ? "bg-black/15" : "bg-secondary text-muted-foreground")}>{o.count}</span>
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

/** One cell of the summary strip: a quiet label over its figure. `divided` draws the hairline that separates it from the cell before. */
function Metric({ label, divided, className, children }: { label: string; divided?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 px-4 py-2.5", divided && "border-t border-border @3xl:border-t-0 @3xl:border-l", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm font-semibold text-foreground tabular-nums">{children}</div>
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
  const router = useRouter();
  const handoffKind = CREATE_HANDOFF[searchParams.get("create") ?? ""] ?? null;
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { rows: trashedLoanRows } = useTrashedLoanRows();
  const isLoading = loansLoading || emisLoading;

  // A fresh `key` per open so every Add starts from a clean form with a new idempotency key.
  const [add, setAdd] = useState<{ open: boolean; seq: number; kind: AddKind | null }>({ open: handoffKind != null, seq: 0, kind: handoffKind });
  const [trashRequest, setTrashRequest] = useState(0);
  const [ownershipTarget, setOwnershipTarget] = useState<OwnershipConfirmTarget | null>(null);
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Every deep link into a record (`?agreement=<id>[&pay=1&installment=…][&adjust=…]` from People, My Money, Activity,
  // Balance Control …) now lands on that record's own page, with the rest of the query handed along unchanged.
  const agreementParam = searchParams.get("agreement");
  useEffect(() => {
    if (!agreementParam) return;
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete("agreement");
    const query = rest.toString();
    router.replace(`/loans/${encodeURIComponent(agreementParam)}/${query ? `?${query}` : ""}`);
  }, [agreementParam, searchParams, router]);
  const openDetails = (id: string) => router.push(`/loans/${encodeURIComponent(id)}/`);

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

  if (agreementParam) {
    // Handing over to the record's page — nothing of the list to show meanwhile.
    return <Skeleton className={cn(LE_RADIUS.panel, "mx-1 h-40")} aria-busy="true" />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 px-1">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0">
          <h1 className="font-heading text-xl font-bold tracking-tight text-foreground">Loan &amp; EMI</h1>
          <p className="text-[13px] text-muted-foreground">Track what you owe, installments and repayments.</p>
        </div>
        <ClayButton size="sm" className={cn(PRIMARY_CTA, "shrink-0 gap-1.5 px-3")} onClick={openAdd}>
          <Plus className="size-4" strokeWidth={2} />
          Add
        </ClayButton>
      </header>

      {isLoading ? (
        <>
          <Skeleton className={cn(LE_RADIUS.panel, "h-16")} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className={cn(LE_RADIUS.card, "h-40")} />
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
          {/* Summary — one slim strip: total, next payment (with its date), active count. Every figure is the sum of what the cards below show. */}
          <section aria-label="Summary" className={cn(LE_RADIUS.panel, "@container border border-border bg-card shadow-e1")}>
            <div className="grid grid-cols-2 @3xl:grid-cols-[minmax(13rem,1fr)_minmax(0,1.7fr)_minmax(7rem,0.6fr)]">
              <Metric label="Total outstanding" className="col-span-2 @3xl:col-span-1">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <Money amount={summary.owed} className="text-2xl leading-tight text-foreground" />
                  {summary.toReceive > 0 && (
                    <span className="flex items-baseline gap-1 text-xs font-normal text-muted-foreground">
                      + <Money amount={summary.toReceive} className="text-xs text-success" /> to receive from loans you gave
                    </span>
                  )}
                </span>
              </Metric>
              <Metric label="Next payment" divided>
                {summary.next ? (
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    <Money amount={summary.next.amount} className="text-xl leading-tight text-foreground" />
                    {/* Name, then when — one line, no separate "Due" box. */}
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <span className="truncate">{summary.next.name}</span>
                      {nextDays != null && (
                        <>
                          <span aria-hidden>·</span>
                          <span className={cn("shrink-0 font-semibold", nextDays < 0 ? "text-expense" : nextDays <= 3 ? "text-warning-foreground dark:text-warning" : "text-foreground")}>
                            {dueLabel(summary.next.date)}
                          </span>
                        </>
                      )}
                    </span>
                    {summary.overdueCount > 0 && <span className="text-xs font-semibold text-expense">{summary.overdueCount} overdue</span>}
                  </span>
                ) : (
                  <span className="text-sm font-normal text-muted-foreground">Nothing due</span>
                )}
              </Metric>
              <Metric label="Active" divided>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-heading text-xl leading-tight font-bold">{summary.activeCount}</span>
                  {/* Closed is shown only once something is closed — a permanent "0" is noise. */}
                  {summary.closedCount > 0 && <span className="text-xs font-medium text-muted-foreground">{summary.closedCount} closed</span>}
                </span>
              </Metric>
            </div>
          </section>

          <MyCommitmentsSummary loanRows={loanRows} emiRows={emiRows} defaultExpanded={false} />

          {/* Obligations — a titled list with a solid rule under its toolbar, then the record cards. */}
          {/* Columns follow the section's width (not the viewport), so the sidebar can't squeeze two cards into a tablet. */}
          <section aria-label="Loans and EMIs" className="@container flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="mr-1 font-heading text-base font-semibold text-foreground">
                All obligations <span className="ml-1 rounded-full bg-secondary px-2 py-0.5 align-middle text-xs font-semibold text-muted-foreground tabular-nums">{entries.length}</span>
              </h2>
              {/* Filters live in the heading row — no second boxed bar, no "Filter" caption. Pills show only when there is something to choose between. */}
              {(showStatus || showTypes) && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                  {showTypes && <FilterPills ariaLabel="Type" options={typeOptions} value={typeFilter} onChange={setTypeFilter} />}
                  {showStatus && showTypes && <span aria-hidden className="hidden h-6 w-px shrink-0 bg-border-strong sm:block" />}
                  {showStatus && <FilterPills ariaLabel="Status" options={statusOptions} value={statusFilter} onChange={setStatusFilter} />}
                </div>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {/* Always in the DOM for assistive tech; visible only once a filter narrows the list. */}
                <span className={cn("tabular-nums", filtersActive ? "rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground" : "sr-only")} aria-live="polite">
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
              {entries.length > 4 && (
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={cn(LOAN_EMI_INPUT, "h-8 rounded-full pr-8 pl-9 text-[13px]")}
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
                  className={cn(SECONDARY_BTN, "gap-1.5")}
                  onClick={() => setTrashRequest((n) => n + 1)}
                >
                  <Trash2 className="size-3.5" />
                  Trash ({trashedLoanRows.length})
                </ClayButton>
              )}
            </div>

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
              <Stagger className="grid grid-cols-1 items-start gap-3 @[38rem]:grid-cols-2 @[62rem]:grid-cols-3 @[96rem]:grid-cols-4">
                {visible.map((entry) => {
                  if (entry.source === "loan") {
                    const row = loanById.get(entry.id)!;
                    return (
                      <LoanCard
                        key={entry.key}
                        row={row}
                        tag={entry.label}
                        onClick={() => openDetails(entry.id)}
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
                      onClick={() => openDetails(entry.id)}
                      onOwnershipAction={(mode) => setOwnershipTarget({ source: "emi", id: entry.id, name: row.emi.name, mode })}
                    />
                  );
                })}
              </Stagger>
            )}
          </section>
        </>
      )}

      {/* The Loan trash — list-less. A record's details, payments and edit live on its own page (`/loans/[id]`). */}
      <LoansWorkspace trashRequest={trashRequest} />

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
