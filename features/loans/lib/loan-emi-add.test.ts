import { describe, expect, it } from "vitest";
import {
  addSections,
  buildLoanEmiCreateRequest,
  emptyLoanEmiAddForm,
  loanEmiAddError,
  recordKindForEmi,
  recordKindForLoan,
  type LoanEmiAddForm,
} from "@/features/loans/lib/loan-emi-add";

const form = (patch: Partial<LoanEmiAddForm>): LoanEmiAddForm => ({ ...emptyLoanEmiAddForm(null, "key-1"), date: "2026-09-27", ...patch });

describe("buildLoanEmiCreateRequest", () => {
  it("Borrowed + Bank → existing createLoan (taken, institutional) with account movement", () => {
    const req = buildLoanEmiCreateRequest(
      form({ kind: "borrowed", lenderName: " HDFC ", amount: "500000", count: "24", useAccount: true, accountId: "acc", hasInterest: true, ratePercent: "9" }),
    );
    expect(req.path).toBe("loan");
    if (req.path !== "loan") return;
    expect(req.params).toMatchObject({
      category: "institutional",
      direction: "taken",
      lenderName: "HDFC",
      personId: null,
      loanAmount: 500000,
      installmentCount: 24,
      interest: { type: "reducingBalance", ratePercent: 9, period: "yearly" },
      movementAccountId: "acc",
      idempotencyKey: "key-1",
    });
  });

  it("Borrowed + Person → personal Loan, no bank reference fields", () => {
    const req = buildLoanEmiCreateRequest(form({ kind: "borrowed", borrowedFrom: "personal", personId: "p1", amount: "1000", loanNumber: "X" }));
    expect(req.params).toMatchObject({ category: "personal", personId: "p1", loanNumber: null, movementAccountId: null });
  });

  it("Money I Lent → given personal Loan, never 'for someone else'", () => {
    const req = buildLoanEmiCreateRequest(form({ kind: "lent", personId: "p1", amount: "2000", ownership: "someoneElse", beneficiaryPersonId: "p2" }));
    expect(req.params).toMatchObject({ direction: "given", category: "personal", beneficiaryPersonId: null, payerPersonId: null });
  });

  it("Purchase → existing createEmi without a card", () => {
    const req = buildLoanEmiCreateRequest(form({ kind: "purchase", name: "iPhone", amount: "60000", provider: "Bajaj", count: "6" }));
    expect(req).toMatchObject({ path: "emi", params: { name: "iPhone", lenderName: "Bajaj", loanType: "other", linkedCreditCardId: null, principalAmount: 60000, interest: null } });
  });

  it("Credit Card → card-linked EMI (locks card credit), no lender", () => {
    const req = buildLoanEmiCreateRequest(form({ kind: "creditCard", cardId: "c1", name: "TV", amount: "30000", provider: "ignored", ownership: "someoneElse", beneficiaryPersonId: "p9" }));
    expect(req).toMatchObject({ path: "emi", params: { loanType: "creditCard", linkedCreditCardId: "c1", lenderName: null, beneficiaryPersonId: "p9" } });
  });
});

describe("loanEmiAddError / addSections", () => {
  it("requires the relevant connection per kind", () => {
    expect(loanEmiAddError(form({}))).toBe("Choose what you're adding");
    expect(loanEmiAddError(form({ kind: "creditCard", name: "TV", amount: "1" }))).toBe("Choose a credit card");
    expect(loanEmiAddError(form({ kind: "lent", amount: "1" }))).toBe("Choose a person");
    expect(loanEmiAddError(form({ kind: "borrowed", lenderName: "SBI", amount: "1", useAccount: true }))).toBe("Choose the account");
    expect(loanEmiAddError(form({ kind: "purchase", name: "Sofa", amount: "1", hasInterest: true }))).toBe("Enter the interest rate");
  });

  it("hides fields that don't apply", () => {
    const bank = addSections({ kind: "borrowed", borrowedFrom: "institutional" });
    expect(bank).toMatchObject({ bankLender: true, card: false, purchase: false, account: true, whoFor: true });
    const card = addSections({ kind: "creditCard", borrowedFrom: "institutional" });
    expect(card).toMatchObject({ bankLender: false, account: false, card: true, firstPaymentDate: true });
    const lent = addSections({ kind: "lent", borrowedFrom: "institutional" });
    expect(lent).toMatchObject({ person: true, card: false, purchase: false, whoFor: false });
  });
});

describe("record classification", () => {
  it("derives badges from existing fields only", () => {
    const base = { direction: "taken" as const, category: "institutional" as const, agreementKind: "loan" as const, fundingSource: null, linkedCreditCardId: null };
    expect(recordKindForLoan(base).label).toBe("Bank Loan");
    expect(recordKindForLoan({ ...base, category: "personal" }).label).toBe("Personal Loan");
    expect(recordKindForLoan({ ...base, direction: "given" }).label).toBe("Lent");
    expect(recordKindForLoan({ ...base, agreementKind: "installmentPurchase" }).label).toBe("Purchase Finance");
    expect(recordKindForEmi({ loanType: "other", linkedCreditCardId: "c" }).label).toBe("Credit Card EMI");
    expect(recordKindForEmi({ loanType: "other", linkedCreditCardId: null }).label).toBe("Purchase Finance");
    expect(recordKindForEmi({ loanType: "home", linkedCreditCardId: null }).label).toBe("Home Loan");
  });
});
