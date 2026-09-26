import { describe, expect, it } from "vitest";
import type { UnifiedFinanceAgreement } from "@/lib/models/unified-finance-agreement";
import {
  agreementDetailHref,
  agreementCardPresentation,
  DEFAULT_UNIFIED_FILTERS,
  filterUnifiedAgreements,
  summarizeUnifiedAgreements,
  unifiedWorkspaceState,
} from "./unified-workspace-model";

const base: UnifiedFinanceAgreement = {
  sourceType: "loan", sourceId: "loan-1", agreementKind: "loan", direction: "borrowed", repaymentType: "scheduled",
  fundingSource: "bank", personId: null, creditCardId: null, purchaseTransactionId: null, linkedAccountId: null,
  accountReference: "LN-42", title: "SBI Personal Loan", providerName: "SBI", purchaseAmount: null, downPayment: null,
  originalPrincipal: 100000, remainingPrincipal: 80000, liabilityPrincipal: 80000, receivablePrincipal: 0,
  cardOwnedLiability: 0, nonCardEmiLiability: 0, paidPrincipal: 20000, paidInterest: 1000, futureInterest: 4000,
  interestRate: 8, interestType: "reducingBalance", repaymentFrequency: "monthly", installmentCount: 12,
  installmentAmount: 8450, nextDueDate: new Date("2026-10-05"), status: "dueSoon", sourceStatus: "active",
  scheduleId: "schedule-1", createdAt: new Date("2026-01-01"),
};
const lent = { ...base, sourceId: "loan-2", title: "Rahul Personal Loan", providerName: "Rahul", direction: "lent", fundingSource: "person", liabilityPrincipal: 0, receivablePrincipal: 25000, remainingPrincipal: 25000 } satisfies UnifiedFinanceAgreement;
const emi = { ...base, sourceType: "emi", sourceId: "emi-1", agreementKind: "installmentPurchase", title: "iPhone 17 Pro", providerName: "HDFC", fundingSource: "creditCard", creditCardId: "card-hdfc", accountReference: null, remainingPrincipal: 38800, liabilityPrincipal: 0, status: "active" } satisfies UnifiedFinanceAgreement;
const defaulted = { ...emi, sourceId: "emi-2", title: "Laptop", fundingSource: "financeCompany", status: "defaulted", liabilityPrincipal: 12000 } satisfies UnifiedFinanceAgreement;
const closed = { ...base, sourceId: "loan-3", title: "Closed Loan", status: "closed", liabilityPrincipal: 0, remainingPrincipal: 0 } satisfies UnifiedFinanceAgreement;
const agreements = [base, lent, emi, defaulted, closed];

describe("unified workspace model", () => {
  it("shows Loan and EMI records in one list", () => expect(filterUnifiedAgreements(agreements, DEFAULT_UNIFIED_FILTERS)).toHaveLength(5));
  it("summarizes borrowed and lent principal separately", () => expect(summarizeUnifiedAgreements(agreements)).toMatchObject({ liabilityPrincipal: 92000, receivablePrincipal: 25000 }));
  it("does not inflate liability for a card-owned EMI plan", () => expect(summarizeUnifiedAgreements([emi]).liabilityPrincipal).toBe(0));
  it("presents borrowed, lent, standard EMI, and card EMI relationships plainly", () => {
    expect(agreementCardPresentation(base).relationship).toBe("Money I Borrowed");
    expect(agreementCardPresentation(lent).relationship).toBe("Money I Lent");
    expect(agreementCardPresentation({ ...emi, fundingSource: "other", creditCardId: null }).relationship).toBe("Installment Purchase · Other");
    expect(agreementCardPresentation(emi)).toMatchObject({ relationship: "Installment Purchase · Credit Card", representedOnCard: true });
  });
  it("summarizes reliable due-soon amount and count", () => expect(summarizeUnifiedAgreements([base, lent])).toMatchObject({ dueSoonAmount: 16900, dueSoonCount: 2 }));
  it("searches names across Loan and EMI", () => expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, search: "iphone" })).toEqual([emi]));
  it("searches provider and account reference", () => {
    expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, search: "Rahul" })).toEqual([lent]);
    expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, search: "LN-42" })).toContain(base);
  });
  it("filters agreement kind", () => expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, agreement: "installmentPurchase" })).toEqual([emi, defaulted]));
  it("filters direction", () => expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, direction: "lent" })).toEqual([lent]));
  it("filters funding", () => expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, funding: "creditCard" })).toEqual([emi]));
  it("filters normalized status including closed/defaulted", () => {
    expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, status: "closed" })).toEqual([closed]);
    expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, status: "defaulted" })).toEqual([defaulted]);
  });
  it("combines search and filters", () => expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, search: "hdfc", agreement: "installmentPurchase", direction: "borrowed", funding: "creditCard", status: "active" })).toEqual([emi]));
  it("returns no results without changing source data", () => {
    const before = [...agreements];
    expect(filterUnifiedAgreements(agreements, { ...DEFAULT_UNIFIED_FILTERS, search: "missing" })).toEqual([]);
    expect(agreements).toEqual(before);
  });
  it("distinguishes no-agreement and no-result states", () => {
    expect(unifiedWorkspaceState(0, 0)).toBe("empty");
    expect(unifiedWorkspaceState(5, 0)).toBe("noResults");
    expect(unifiedWorkspaceState(5, 2)).toBe("ready");
  });
  it("routes Loan and EMI details to their preserved workspaces", () => {
    expect(agreementDetailHref(base)).toBe("/loans?agreement=loan-1");
    expect(agreementDetailHref(emi)).toBe("/emi?agreement=emi-1");
  });
  it("reflects live Loan and EMI replacement values without cached objects", () => {
    expect(summarizeUnifiedAgreements([base, emi]).liabilityPrincipal).toBe(80000);
    expect(summarizeUnifiedAgreements([{ ...base, liabilityPrincipal: 70000 }, { ...emi, liabilityPrincipal: 30000 }]).liabilityPrincipal).toBe(100000);
  });
});
