import { describe, expect, it } from "vitest";
import {
  EMPTY_UNIFIED_CREATE_FORM,
  buildUnifiedCreateRequest,
  movementChoiceLabel,
  unifiedCreateError,
  unifiedCreateFigures,
  type UnifiedCreateForm,
} from "@/features/agreements/lib/unified-create-request";

const TODAY = new Date(2026, 8, 26);
const form = (patch: Partial<UnifiedCreateForm>): UnifiedCreateForm => ({ ...EMPTY_UNIFIED_CREATE_FORM, name: "Test", amount: "50000", ...patch });

describe("unified wizard — account movement choice", () => {
  it("labels the explicit opt-in per agreement kind", () => {
    expect(movementChoiceLabel(form({ kind: "borrowed" }))).toBe("Record money received in an account");
    expect(movementChoiceLabel(form({ kind: "lent" }))).toBe("Record money sent from an account");
    expect(movementChoiceLabel(form({ kind: "installmentPurchase", downPayment: "10000" }))).toBe("Record down payment from an account");
    expect(movementChoiceLabel(form({ kind: "installmentPurchase", downPayment: "0" }))).toBeNull();
  });

  it("selecting an account alone never moves money", () => {
    const request = buildUnifiedCreateRequest(form({ kind: "borrowed", funding: "bank", recordMovement: false, movementAccountId: "hdfc" }), "key-00000001", TODAY);
    expect(request.movementAccountId).toBeNull();
  });

  it("requires an account only when the movement is enabled", () => {
    expect(unifiedCreateError(form({ kind: "borrowed", recordMovement: false }))).toBeNull();
    expect(unifiedCreateError(form({ kind: "borrowed", recordMovement: true }))).toBe("Choose the account");
    expect(unifiedCreateError(form({ kind: "borrowed", recordMovement: true, movementAccountId: "hdfc" }))).toBeNull();
  });

  it("a stale opt-in on a zero down payment is ignored (nothing to record)", () => {
    const f = form({ kind: "installmentPurchase", amount: "60000", downPayment: "0", recordMovement: true });
    expect(unifiedCreateError(f)).toBeNull();
    expect(buildUnifiedCreateRequest(f, "key-00000002", TODAY).movementAccountId).toBeNull();
  });

  it("borrowed movement previews +principal; lent −principal; purchase −down payment only", () => {
    expect(unifiedCreateFigures(form({ kind: "borrowed", recordMovement: true, movementAccountId: "a" })).movementDelta).toBe(50000);
    expect(unifiedCreateFigures(form({ kind: "lent", recordMovement: true, movementAccountId: "a" })).movementDelta).toBe(-50000);
    const purchase = unifiedCreateFigures(form({ kind: "installmentPurchase", amount: "60000", downPayment: "10000", recordMovement: true, movementAccountId: "a" }));
    expect([purchase.principal, purchase.movementDelta]).toEqual([50000, -10000]);
  });
});

describe("unified wizard — one-time repayment", () => {
  it("builds a oneTime Loan with a due date and no fake monthly installments", () => {
    const request = buildUnifiedCreateRequest(form({ kind: "lent", funding: "person", personId: "rahul", repayment: "oneTime", dueDate: "2026-12-31" }), "key-00000003", TODAY);
    expect(request.repaymentType).toBe("oneTime");
    expect(request.installmentCount).toBeNull();
    expect(request.installmentFrequency).toBeNull();
    expect(request.dueDate).toEqual(new Date(2026, 11, 31));
  });

  it("needs a repay-by date", () => {
    expect(unifiedCreateError(form({ kind: "borrowed", repayment: "oneTime", dueDate: "" }))).toBe("Choose when it will be repaid");
  });

  it("never offers one-time to an installment purchase", () => {
    const request = buildUnifiedCreateRequest(form({ kind: "installmentPurchase", amount: "60000", downPayment: "10000", repayment: "oneTime" }), "key-00000004", TODAY);
    expect(request.repaymentType).toBe("installment");
    expect(request.installmentCount).toBe(12);
  });
});

describe("unified wizard — request", () => {
  it("passes the wizard session's idempotency key through unchanged", () => {
    expect(buildUnifiedCreateRequest(form({ kind: "borrowed" }), "session-key-123", TODAY).idempotencyKey).toBe("session-key-123");
  });

  it("installment purchase: financed = purchase − down, both persisted", () => {
    const request = buildUnifiedCreateRequest(form({ kind: "installmentPurchase", funding: "financeCompany", provider: "Bajaj", amount: "60000", downPayment: "10000" }), "k-00000005", TODAY);
    expect([request.purchaseAmount, request.downPayment, request.loanAmount, request.agreementKind, request.direction]).toEqual([60000, 10000, 50000, "installmentPurchase", "taken"]);
  });

  it("tracked card: card + optional purchase link, never a guessed purchase", () => {
    const linked = buildUnifiedCreateRequest(form({ kind: "installmentPurchase", funding: "creditCard", cardId: "card-1", purchaseId: "txn-9", amount: "60000", downPayment: "0" }), "k-00000006", TODAY);
    expect([linked.linkedCreditCardId, linked.purchaseTransactionId]).toEqual(["card-1", "txn-9"]);
    const caseB = buildUnifiedCreateRequest(form({ kind: "installmentPurchase", funding: "creditCard", cardId: "card-1", amount: "60000", downPayment: "0" }), "k-00000007", TODAY);
    expect(caseB.purchaseTransactionId).toBeNull();
  });

  it("'For me' is the default: no beneficiary is stored", () => {
    expect(buildUnifiedCreateRequest(form({ kind: "borrowed" }), "k-00000008", TODAY).beneficiaryPersonId).toBeNull();
  });

  it("card EMI for someone else keeps the card link AND the person", () => {
    const f = form({ kind: "installmentPurchase", funding: "creditCard", cardId: "card-1", amount: "40000", downPayment: "0", forSomeoneElse: true });
    expect(unifiedCreateError(f)).toBe("Choose who this is for");
    const request = buildUnifiedCreateRequest({ ...f, beneficiaryPersonId: "rahul" }, "k-00000009", TODAY);
    expect([request.linkedCreditCardId, request.beneficiaryPersonId, request.loanAmount, request.direction]).toEqual(["card-1", "rahul", 40000, "taken"]);
  });

  it("money I lent can't be 'for someone else' — a stale choice is dropped", () => {
    const request = buildUnifiedCreateRequest(
      form({ kind: "lent", funding: "person", personId: "p1", forSomeoneElse: true, beneficiaryPersonId: "rahul" }),
      "k-00000010",
      TODAY,
    );
    expect(request.beneficiaryPersonId).toBeNull();
  });

  it("person funding requires a person; card funding requires a card", () => {
    expect(unifiedCreateError(form({ kind: "lent", funding: "person" }))).toBe("Choose a person");
    expect(unifiedCreateError(form({ kind: "installmentPurchase", funding: "creditCard", amount: "100" }))).toBe("Choose a credit card");
  });
});
