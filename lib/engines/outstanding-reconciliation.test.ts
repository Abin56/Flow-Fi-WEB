import { describe, expect, it } from "vitest";
import { allReconciliationCauses, applicableCauses, describeCause, reconciliationCausesFor } from "./outstanding-reconciliation";

const BASE_CTX = { cardAccountId: "acct-1", amount: 700, lockedEmiPrincipal: 0, onSharedLimit: false, hasOpeningBalance: false };

describe("applicableCauses", () => {
  it("bankHigher includes charge-side causes, not payment/refund", () => {
    const causes = applicableCauses("bankHigher");
    expect(causes).toContain("missingPurchase");
    expect(causes).toContain("interestCharge");
    expect(causes).toContain("gst");
    expect(causes).toContain("lateFee");
    expect(causes).toContain("otherCharge");
    expect(causes).toContain("openingOutstanding");
    expect(causes).not.toContain("missingPayment");
    expect(causes).not.toContain("refundOrCredit");
  });

  it("bankLower includes payment/refund causes, not charge causes", () => {
    const causes = applicableCauses("bankLower");
    expect(causes).toContain("missingPayment");
    expect(causes).toContain("refundOrCredit");
    expect(causes).not.toContain("missingPurchase");
    expect(causes).not.toContain("interestCharge");
  });

  it("both directions include the non-directional explanatory causes", () => {
    for (const dir of ["bankHigher", "bankLower"] as const) {
      const causes = applicableCauses(dir);
      expect(causes).toContain("cardEmiOrSharedLimit");
      expect(causes).toContain("statementTiming");
      expect(causes).toContain("unknown");
    }
  });

  it("allReconciliationCauses covers every cause exactly once", () => {
    const all = allReconciliationCauses();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("missingPurchase");
    expect(all).toContain("unknown");
  });
});

describe("describeCause — resolution shape never invents a transaction for explained/review causes", () => {
  it("missing purchase resolves to Add Expense, never a direct write", () => {
    const c = describeCause("missingPurchase", BASE_CTX);
    expect(c.resolution.kind).toBe("addExpense");
    expect(c.resolution.description).toMatch(/₹700/);
  });

  it("missing payment resolves to Pay bill — explicitly never an ordinary expense", () => {
    const c = describeCause("missingPayment", BASE_CTX);
    expect(c.resolution.kind).toBe("payBill");
    expect(c.resolution.description).toMatch(/Pay bill/);
    expect(c.resolution.description).toMatch(/never.*ordinary expense/);
  });

  it("refund/credit resolves to a recorded payment/income transaction, not an expense", () => {
    const c = describeCause("refundOrCredit", BASE_CTX);
    expect(c.resolution.kind).toBe("addPayment");
  });

  it("card-EMI lock with no locked principal and no shared limit is marked not-applicable, never explained away", () => {
    const c = describeCause("cardEmiOrSharedLimit", BASE_CTX);
    expect(c.resolution.kind).toBe("reviewOnly");
    expect(c.hint).toMatch(/Would explain/);
  });

  it("card-EMI lock WITH locked principal is explained, no action implied", () => {
    const c = describeCause("cardEmiOrSharedLimit", { ...BASE_CTX, lockedEmiPrincipal: 12000 });
    expect(c.resolution.kind).toBe("explainedNoAction");
    expect(c.hint).toMatch(/12,000/);
  });

  it("card-EMI lock cause explained for a shared-limit card even with no locked EMI principal", () => {
    const c = describeCause("cardEmiOrSharedLimit", { ...BASE_CTX, onSharedLimit: true });
    expect(c.resolution.kind).toBe("explainedNoAction");
    expect(c.hint).toMatch(/shares its limit/);
  });

  it("opening outstanding is reviewOnly (not addExpense) when the card has none", () => {
    const c = describeCause("openingOutstanding", BASE_CTX);
    expect(c.resolution.kind).toBe("reviewOnly");
  });

  it("opening outstanding points at Financial Audit, not a new transaction, when the card DOES have one", () => {
    const c = describeCause("openingOutstanding", { ...BASE_CTX, hasOpeningBalance: true });
    expect(c.resolution.kind).toBe("correctLimit");
    expect(c.resolution.description).toMatch(/Financial Audit/);
  });

  it("statement timing never implies a correction", () => {
    const c = describeCause("statementTiming", BASE_CTX);
    expect(c.resolution.kind).toBe("explainedNoAction");
  });

  it("unknown is always reviewOnly and says nothing is changed", () => {
    const c = describeCause("unknown", BASE_CTX);
    expect(c.resolution.kind).toBe("reviewOnly");
    expect(c.resolution.description).toMatch(/nothing is changed/i);
  });

  it("no cause resolution kind is ever a direct 'write the balance' action", () => {
    const kinds = new Set(allReconciliationCauses().map((c) => describeCause(c, BASE_CTX).resolution.kind));
    expect(kinds.has("addExpense" as never)).toBe(true);
    for (const k of kinds) {
      expect(["addExpense", "addPayment", "payBill", "correctLimit", "explainedNoAction", "reviewOnly"]).toContain(k);
    }
  });
});

describe("reconciliationCausesFor", () => {
  it("returns one option per applicable cause, each carrying a resolution", () => {
    const options = reconciliationCausesFor("bankHigher", BASE_CTX);
    expect(options.length).toBe(applicableCauses("bankHigher").length);
    for (const o of options) expect(o.resolution).toBeTruthy();
  });
});
