import type {
  UnifiedAgreementDirection,
  UnifiedAgreementKind,
  UnifiedAgreementStatus,
  UnifiedFinanceAgreement,
  UnifiedFundingSource,
} from "@/lib/models/unified-finance-agreement";

export type AgreementFilter = "all" | UnifiedAgreementKind;
export type DirectionFilter = "all" | UnifiedAgreementDirection;
export type FundingFilter = "all" | UnifiedFundingSource;
export type StatusFilter = "all" | UnifiedAgreementStatus;

export interface UnifiedWorkspaceFilters {
  search: string;
  agreement: AgreementFilter;
  direction: DirectionFilter;
  funding: FundingFilter;
  status: StatusFilter;
}

export const DEFAULT_UNIFIED_FILTERS: UnifiedWorkspaceFilters = {
  search: "",
  agreement: "all",
  direction: "all",
  funding: "all",
  status: "all",
};

export interface UnifiedAgreementSummary {
  liabilityPrincipal: number;
  receivablePrincipal: number;
  dueSoonAmount: number;
  dueSoonCount: number;
  overdueAmount: number;
  overdueCount: number;
}

export function summarizeUnifiedAgreements(agreements: UnifiedFinanceAgreement[]): UnifiedAgreementSummary {
  return agreements.reduce<UnifiedAgreementSummary>(
    (summary, agreement) => {
      summary.liabilityPrincipal += agreement.liabilityPrincipal;
      summary.receivablePrincipal += agreement.receivablePrincipal;
      if (agreement.status === "dueSoon") {
        summary.dueSoonCount += 1;
        summary.dueSoonAmount += agreement.installmentAmount ?? 0;
      }
      if (agreement.status === "overdue") {
        summary.overdueCount += 1;
        summary.overdueAmount += agreement.installmentAmount ?? 0;
      }
      return summary;
    },
    { liabilityPrincipal: 0, receivablePrincipal: 0, dueSoonAmount: 0, dueSoonCount: 0, overdueAmount: 0, overdueCount: 0 },
  );
}

export function filterUnifiedAgreements(
  agreements: UnifiedFinanceAgreement[],
  filters: UnifiedWorkspaceFilters,
): UnifiedFinanceAgreement[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return agreements.filter((agreement) => {
    if (filters.agreement !== "all" && agreement.agreementKind !== filters.agreement) return false;
    if (filters.direction !== "all" && agreement.direction !== filters.direction) return false;
    if (filters.funding !== "all" && agreement.fundingSource !== filters.funding) return false;
    if (filters.status !== "all" && agreement.status !== filters.status) return false;
    if (!query) return true;
    return [
      agreement.title,
      agreement.providerName,
      agreement.accountReference,
      agreement.personId,
      agreement.creditCardId,
      agreement.purchaseTransactionId,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

export function agreementDetailHref(agreement: UnifiedFinanceAgreement): string {
  return agreement.sourceType === "loan"
    ? `/loans?agreement=${encodeURIComponent(agreement.sourceId)}`
    : `/emi?agreement=${encodeURIComponent(agreement.sourceId)}`;
}

export const STATUS_LABEL: Record<UnifiedAgreementStatus, string> = {
  active: "Active",
  dueSoon: "Due soon",
  overdue: "Overdue",
  defaulted: "Defaulted",
  closed: "Closed",
};

export const FUNDING_LABEL: Record<UnifiedFundingSource, string> = {
  bank: "Bank",
  financeCompany: "Finance Company",
  creditCard: "Credit Card",
  person: "Person",
  other: "Other",
};

export type UnifiedWorkspaceState = "empty" | "noResults" | "ready";

export function unifiedWorkspaceState(totalCount: number, visibleCount: number): UnifiedWorkspaceState {
  if (totalCount === 0) return "empty";
  return visibleCount === 0 ? "noResults" : "ready";
}

export function agreementCardPresentation(agreement: UnifiedFinanceAgreement) {
  return {
    relationship:
      agreement.direction === "lent"
        ? "Money I Lent"
        : agreement.agreementKind === "installmentPurchase"
          ? `Installment Purchase · ${FUNDING_LABEL[agreement.fundingSource]}`
          : "Money I Borrowed",
    remainingLabel: agreement.direction === "lent" ? "Principal owed to me" : "Principal remaining",
    repaymentLabel:
      agreement.repaymentType === "flexible"
        ? "Flexible"
        : agreement.repaymentType === "oneTime"
          ? "One time"
          : null,
    representedOnCard:
      agreement.creditCardId != null && agreement.cardOwnedLiability === 0 && agreement.status !== "closed",
  };
}
