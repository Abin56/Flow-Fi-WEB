import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Emi } from "./emi";
import type { Loan } from "./loan";
import type { Installment } from "./payment-schedule";
import { emiToUnifiedAgreement, loanToUnifiedAgreement, sortUnifiedAgreements } from "./unified-finance-agreement";

const now = new Date("2026-09-25T00:00:00.000Z");
const base = { deletedAt: null, lastEditedAt: null, editHistory: [] };

function installment(id: string, scheduleId: string, dueDate: string, principal: number, interest = 0, paid = 0): Installment {
  return { ...base, id, scheduleId, ownerType: "loan", ownerId: id, sequenceNumber: 1, dueDate: new Date(dueDate), amountDue: principal + interest, amountPaid: paid, isSkipped: false, principalPortion: principal, interestPortion: interest, createdAt: now };
}

function loan(overrides: Partial<Loan> = {}): Loan {
  return { ...base, id: "loan-1", personId: null, name: "Bank Loan", direction: "taken", category: "institutional", institutionName: "Bank", loanAmount: 1000, interest: null, loanDate: now, repaymentType: "installment", dueDate: null, installmentFrequency: "monthly", installmentCount: 1, notes: "", scheduleId: "schedule-loan", isClosed: false, createdAt: now, ...overrides };
}

function emi(overrides: Partial<Emi> = {}): Emi {
  return { ...base, id: "emi-1", name: "Purchase", lenderName: null, categoryId: null, loanNumber: null, loanType: "other", branch: null, customerId: null, sanctionDate: null, disbursementDate: null, processingFee: 0, insuranceAmount: 0, extraCharges: 0, foreclosureAmount: null, prepaymentCharges: null, isAutoDebitEnabled: false, autoDebitAccount: null, isDefaulted: false, linkedCreditCardId: null, purchaseTransactionId: null, principalAmount: 1000, interest: null, startDate: now, dueDayOfMonth: null, installmentFrequency: "monthly", installmentCount: 1, endDate: now, notes: "", scheduleId: "schedule-emi", isClosed: false, createdAt: now, ...overrides };
}

const activePurchase = { id: "purchase-1", accountId: "account-1", deletedAt: null, excludeFromCalculations: false, transferId: null };

describe("UnifiedFinanceAgreement adapters", () => {
  it.each([
    ["Bank Loan", loan(), "borrowed", "bank"],
    ["Personal borrowed Loan", loan({ category: "personal", personId: "person-1", institutionName: null }), "borrowed", "person"],
    ["Money Lent Loan", loan({ direction: "given", category: "personal", personId: "person-1" }), "lent", "person"],
    ["Closed Loan", loan({ isClosed: true }), "borrowed", "bank"],
  ] as const)("maps %s", (_name, source, direction, funding) => {
    const result = loanToUnifiedAgreement(source, [installment("i", source.scheduleId, "2026-10-01", 1000)], now);
    expect(result).toMatchObject({ sourceType: "loan", agreementKind: "loan", direction, fundingSource: funding });
    expect(result.status).toBe(source.isClosed ? "closed" : "dueSoon");
  });

  it.each([
    ["Standard EMI", emi(), null, 0, 1000, "active"],
    ["Card EMI Case A", emi({ linkedCreditCardId: "card-1", purchaseTransactionId: "purchase-1" }), { cardAccountId: "account-1", purchase: activePurchase }, 0, 0, "active"],
    ["Card EMI Case B", emi({ linkedCreditCardId: "card-1" }), { cardAccountId: "account-1", purchase: null }, 1000, 0, "active"],
    ["Card EMI Case C", emi({ linkedCreditCardId: "card-1", purchaseTransactionId: "purchase-1" }), { cardAccountId: "account-1", purchase: { ...activePurchase, excludeFromCalculations: true } }, 1000, 0, "active"],
    ["Legacy EMI", emi({ linkedCreditCardId: "card-1", purchaseTransactionId: null }), { cardAccountId: "account-1", purchase: null }, 1000, 0, "active"],
    ["Defaulted EMI", emi({ isDefaulted: true }), null, 0, 1000, "defaulted"],
  ] as const)("maps %s", (_name, source, ownership, cardOwned, nonCard, status) => {
    const result = emiToUnifiedAgreement(source, [installment("i", source.scheduleId, "2026-10-10", 1000)], ownership, now);
    expect(result).toMatchObject({ sourceType: "emi", agreementKind: "installmentPurchase", direction: "borrowed", cardOwnedLiability: cardOwned, nonCardEmiLiability: nonCard, status });
  });

  it("keeps a represented ₹60,000 card purchase + EMI at ₹60,000 total liability", () => {
    const result = emiToUnifiedAgreement(emi({ principalAmount: 60_000, linkedCreditCardId: "card-1", purchaseTransactionId: "purchase-1" }), [installment("i", "schedule-emi", "2026-10-10", 60_000)], { cardAccountId: "account-1", purchase: activePurchase }, now);
    expect(60_000 + result.liabilityPrincipal).toBe(60_000);
  });

  it("is deterministic, unique by source pair, and side-effect free", () => {
    const sourceLoan = loan();
    const before = JSON.stringify(sourceLoan);
    const a = loanToUnifiedAgreement(sourceLoan, [], now);
    const b = emiToUnifiedAgreement(emi(), [], null, now);
    expect(sortUnifiedAgreements([b, a]).map((item) => `${item.sourceType}:${item.sourceId}`)).toEqual(["emi:emi-1", "loan:loan-1"]);
    expect(JSON.stringify(sourceLoan)).toBe(before);
  });

  it("matches the shared ten-scenario semantic fixture", () => {
    const rows = JSON.parse(readFileSync("tests/cross-platform-fixtures/unified-finance-agreement-fixture.json", "utf8")) as Array<Record<string, unknown>>;
    const mapped = [
      loanToUnifiedAgreement(loan(), [installment("i", "schedule-loan", "2026-10-01", 1000)], now),
      loanToUnifiedAgreement(loan({ category: "personal", personId: "person-1", institutionName: null }), [installment("i", "schedule-loan", "2026-10-01", 1000)], now),
      loanToUnifiedAgreement(loan({ direction: "given", category: "personal", personId: "person-1" }), [installment("i", "schedule-loan", "2026-10-01", 1000)], now),
      emiToUnifiedAgreement(emi(), [installment("i", "schedule-emi", "2026-10-10", 1000)], null, now),
      emiToUnifiedAgreement(emi({ linkedCreditCardId: "card-1", purchaseTransactionId: "purchase-1" }), [installment("i", "schedule-emi", "2026-10-10", 1000)], { cardAccountId: "account-1", purchase: activePurchase }, now),
      emiToUnifiedAgreement(emi({ linkedCreditCardId: "card-1" }), [installment("i", "schedule-emi", "2026-10-10", 1000)], { cardAccountId: "account-1", purchase: null }, now),
      emiToUnifiedAgreement(emi({ linkedCreditCardId: "card-1", purchaseTransactionId: "purchase-1" }), [installment("i", "schedule-emi", "2026-10-10", 1000)], { cardAccountId: "account-1", purchase: { ...activePurchase, excludeFromCalculations: true } }, now),
      emiToUnifiedAgreement(emi({ linkedCreditCardId: "card-1" }), [installment("i", "schedule-emi", "2026-10-10", 1000)], { cardAccountId: "account-1", purchase: null }, now),
      loanToUnifiedAgreement(loan({ isClosed: true }), [installment("i", "schedule-loan", "2026-10-01", 1000)], now),
      emiToUnifiedAgreement(emi({ isDefaulted: true }), [installment("i", "schedule-emi", "2026-10-10", 1000)], null, now),
    ];
    expect(mapped.map((value, index) => ({ name: rows[index].name, sourceType: value.sourceType, direction: value.direction, fundingSource: value.fundingSource, status: value.status, liabilityPrincipal: value.liabilityPrincipal, receivablePrincipal: value.receivablePrincipal }))).toEqual(rows);
  });
});
