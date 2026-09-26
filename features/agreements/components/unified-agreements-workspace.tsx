"use client";

import { Plus, Search, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { ChipRow, EmptyState, FLAT_INPUT, SmartToolbar } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { UnifiedAgreementCard } from "@/features/agreements/components/unified-agreement-card";
import { UnifiedAgreementSummaryStrip } from "@/features/agreements/components/unified-agreement-summary";
import { UnifiedAgreementCreateDialog } from "@/features/agreements/components/unified-agreement-create-dialog";
import {
  agreementDetailHref,
  DEFAULT_UNIFIED_FILTERS,
  filterUnifiedAgreements,
  summarizeUnifiedAgreements,
  unifiedWorkspaceState,
  type AgreementFilter,
  type DirectionFilter,
  type FundingFilter,
  type StatusFilter,
} from "@/features/agreements/lib/unified-workspace-model";
import { useUnifiedFinanceAgreements } from "@/hooks/use-unified-finance-agreements";
import { cn } from "@/lib/utils";

const AGREEMENT_OPTIONS: { value: AgreementFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "loan", label: "Loans" }, { value: "installmentPurchase", label: "Installment Purchases" },
];
const DIRECTION_OPTIONS: { value: DirectionFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "borrowed", label: "I Borrowed" }, { value: "lent", label: "I Lent" },
];
const FUNDING_OPTIONS: { value: FundingFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "bank", label: "Bank" }, { value: "financeCompany", label: "Finance Company" },
  { value: "creditCard", label: "Credit Card" }, { value: "person", label: "Person" }, { value: "other", label: "Other" },
];
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "dueSoon", label: "Due Soon" },
  { value: "overdue", label: "Overdue" }, { value: "defaulted", label: "Defaulted" }, { value: "closed", label: "Closed" },
];

export function UnifiedAgreementsWorkspace() {
  const router = useRouter();
  const { data: agreements, isLoading, error } = useUnifiedFinanceAgreements();
  const [filters, setFilters] = useState(DEFAULT_UNIFIED_FILTERS);
  const [addOpen, setAddOpen] = useState(false);
  const summary = useMemo(() => summarizeUnifiedAgreements(agreements), [agreements]);
  const visible = useMemo(() => filterUnifiedAgreements(agreements, filters), [agreements, filters]);
  const workspaceState = unifiedWorkspaceState(agreements.length, visible.length);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1" aria-busy="true">
        <Skeleton className="h-10 w-64 rounded-xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1">
      <SmartToolbar
        left={<div><h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Loans &amp; Installments</h1><p className="text-sm text-muted-foreground">Your borrowing, lending, and installment plans in one place.</p></div>}
        actions={<ClayButton size="sm" onClick={() => setAddOpen(true)}><Plus className="size-3.5" />Add</ClayButton>}
      />

      {error ? <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">Couldn&apos;t load all agreements. Live data will retry automatically.</div> : null}
      <UnifiedAgreementSummaryStrip summary={summary} />

      {workspaceState === "empty" ? (
        <EmptyState icon={WalletCards} title="No agreements yet" description="Add money you've borrowed or lent, or a purchase you're paying in installments." actionLabel="Add Agreement" onAction={() => setAddOpen(true)} />
      ) : (
        <>
          <section aria-label="Search and filter agreements" className="flex flex-col gap-3">
            <label className="relative max-w-md">
              <span className="sr-only">Search agreements</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input className={cn(FLAT_INPUT, "pl-9")} type="search" placeholder="Search loans and installment purchases…" value={filters.search} onChange={(event) => setFilters((value) => ({ ...value, search: event.target.value }))} />
            </label>
            <div className="grid gap-3 xl:grid-cols-2">
              <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">Agreement</legend><ChipRow options={AGREEMENT_OPTIONS} value={filters.agreement} onChange={(agreement) => setFilters((value) => ({ ...value, agreement }))} /></fieldset>
              <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">Direction</legend><ChipRow options={DIRECTION_OPTIONS} value={filters.direction} onChange={(direction) => setFilters((value) => ({ ...value, direction }))} /></fieldset>
              <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">Funding</legend><ChipRow options={FUNDING_OPTIONS} value={filters.funding} onChange={(funding) => setFilters((value) => ({ ...value, funding }))} /></fieldset>
              <fieldset><legend className="mb-1 text-xs font-medium text-muted-foreground">Status</legend><ChipRow options={STATUS_OPTIONS} value={filters.status} onChange={(status) => setFilters((value) => ({ ...value, status }))} /></fieldset>
            </div>
          </section>

          {workspaceState === "noResults" ? (
            <EmptyState icon={Search} title="No matching agreements" description="Try a different search or clear one of the filters." />
          ) : (
            <Stagger className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {visible.map((agreement) => (
                <StaggerItem key={`${agreement.sourceType}:${agreement.sourceId}`}>
                  <UnifiedAgreementCard agreement={agreement} onOpen={() => router.push(agreementDetailHref(agreement))} />
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </>
      )}

      <UnifiedAgreementCreateDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
