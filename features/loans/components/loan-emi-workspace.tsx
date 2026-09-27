"use client";

import { CalendarClock, ListChecks, Plus, Search, Trash2, Wallet, type LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { EmptyState } from "@/components/finance";
import { Stagger } from "@/components/foundation/animated-container";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiCard } from "@/features/emi/components/emi-card";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { LoanCard, loanDisplayName, loanNextDueAmount } from "@/features/loans/components/loan-card";
import { LoanEmiAddDialog } from "@/features/loans/components/loan-emi-add-dialog";
import { AmountDisplay, ChoiceChips, LE_RADIUS, LOAN_EMI_INPUT, Money, daysUntil, dueLabel } from "@/features/loans/components/loan-emi-ui";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { useLoanRows, useTrashedLoanRows } from "@/features/loans/hooks/use-loans-data";
import { recordKindForEmi, recordKindForLoan, type AddKind } from "@/features/loans/lib/loan-emi-add";
import { remainingAmount } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "active" | "closed";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];

/** Older `?create=` handoffs (agreement flows, bookmarks) → the unified form's "What is this?". */
const CREATE_HANDOFF: Record<string, AddKind> = { borrowed: "borrowed", lent: "lent", installmentPurchase: "purchase" };

/** Primary CTA in the Loan & EMI style — lime with a dark olive edge so it holds its shape on pale displays. */
const PRIMARY_CTA = "rounded-[8px] border-primary-accent-text font-bold";
const SECONDARY_BTN = "rounded-[8px] border-border-strong font-semibold text-foreground hover:bg-secondary";

/** One list entry — a Loan or an EMI record, as the user sees it. Which collection it lives in stays underneath. */
interface Entry {
  key: string;
  source: "loan" | "emi";
  id: string;
  label: string;
  name: string;
  searchText: string;
  done: boolean;
  nextDate: Date | null;
}

function Metric({ label, icon: Icon, children }: { label: string; icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-3 sm:px-4">
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
    return [{ value: "all", label: "All types" }, ...labels.map((l) => ({ value: l, label: l }))];
  }, [entries]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (typeFilter !== "all" && e.label !== typeFilter) return false;
      if (statusFilter === "active" && e.done) return false;
      if (statusFilter === "closed" && !e.done) return false;
      return query === "" || e.searchText.includes(query);
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
          <Plus className="size-4" strokeWidth={2.5} />
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
        <div className={cn(LE_RADIUS.panel, "flex flex-col gap-2 border border-dashed border-border-strong bg-card pb-4")}>
          <EmptyState
            icon={Wallet}
            title="Nothing here yet"
            description="Add money you borrowed or lent, a purchase on installments, or a credit card EMI."
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
          <section aria-label="Summary" className={cn(LE_RADIUS.panel, "flex flex-col border border-border bg-card shadow-e1 lg:flex-row lg:items-stretch")}>
            <div className="flex flex-col gap-2 px-5 py-4 sm:px-6 lg:min-w-72 lg:border-r lg:border-border">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Total outstanding</span>
              <AmountDisplay amount={summary.owed} size="lg" />
              {summary.toReceive > 0 && (
                <span className="flex items-baseline gap-1 text-xs text-muted-foreground">
                  + <Money amount={summary.toReceive} className="text-sm text-success" /> lent, still to receive
                </span>
              )}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-x-4 border-t border-border px-5 sm:grid-cols-4 sm:gap-x-0 sm:divide-x sm:divide-border sm:px-2 lg:border-t-0">
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
                {summary.next && nextDays != null ? (
                  <span className={cn("font-bold", nextDays < 0 ? "text-expense" : nextDays <= 3 ? "text-warning-foreground dark:text-warning" : "text-foreground")}>
                    {dueLabel(summary.next.date)}
                  </span>
                ) : (
                  <span className="font-normal text-muted-foreground">—</span>
                )}
              </Metric>
              <Metric label="Active" icon={ListChecks}>
                <span className="font-heading text-lg font-bold">{summary.activeCount}</span>
              </Metric>
              <Metric label="Closed">
                <span className="font-heading text-lg font-bold text-muted-foreground">{summary.closedCount}</span>
              </Metric>
            </div>
          </section>

          {/* Obligations — a titled list with a solid rule under its toolbar, then the record cards. */}
          <section aria-label="Loans and EMIs" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-strong pb-3">
              <h2 className="mr-1 font-heading text-base font-bold text-foreground">
                All obligations <span className="ml-1 text-sm font-semibold text-muted-foreground tabular-nums">{entries.length}</span>
              </h2>
              {entries.length > 4 && (
                <div className="relative w-full sm:ml-auto sm:w-60">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={cn(LOAN_EMI_INPUT, "h-9 pl-9")}
                    placeholder="Search"
                    aria-label="Search loans and EMIs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
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
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {showStatus && <ChoiceChips ariaLabel="Status" options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} />}
                {showStatus && showTypes && <span aria-hidden className="hidden h-5 w-px bg-border-strong sm:block" />}
                {showTypes && <ChoiceChips ariaLabel="Type" options={typeOptions} value={typeFilter} onChange={setTypeFilter} />}
              </div>
            )}

            {visible.length === 0 ? (
              <div className={cn(LE_RADIUS.panel, "border border-dashed border-border-strong bg-card")}>
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
              <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((entry) => {
                  if (entry.source === "loan") {
                    const row = loanById.get(entry.id)!;
                    return (
                      <LoanCard
                        key={entry.key}
                        row={row}
                        tag={entry.label}
                        onClick={() => setLoanOpenRequest((r) => ({ id: entry.id, seq: (r?.seq ?? 0) + 1 }))}
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

      <LoanEmiAddDialog
        key={add.seq}
        open={add.open}
        initialKind={add.kind}
        onOpenChange={(open) => setAdd((a) => ({ ...a, open }))}
      />
    </div>
  );
}
