import { describe, expect, it } from "vitest";
import { reconcileLoan, scheduledPrincipalAt, type LoanReconInput, type ReconInstallment, type ReconPayment } from "./loan-reconciliation";

// ₹10,000 over 10 monthly installments of ₹1,100 (₹1,000 principal + ₹100 interest), due on the 5th from Jan 2026.
function schedule(paidCount: number, partial?: { seq: number; paid: number }): ReconInstallment[] {
  return Array.from({ length: 10 }, (_, k) => {
    const seq = k + 1;
    const amountPaid = partial?.seq === seq ? partial.paid : seq <= paidCount ? 1100 : 0;
    return { id: `i${seq}`, sequenceNumber: seq, dueDate: new Date(2026, k, 5), amountDue: 1100, amountPaid, isSkipped: false, principalPortion: 1000, interestPortion: 100 };
  });
}

function payment(seq: number, date: Date, over: Partial<ReconPayment> = {}): ReconPayment {
  return { id: `p${seq}`, installmentId: `i${seq}`, amount: 1100, date, deletedAt: null, ...over };
}

function input(over: Partial<LoanReconInput> & { lenderPrincipal: number }): LoanReconInput {
  const { lenderPrincipal, ...rest } = over;
  return {
    kind: "loan",
    principalAmount: 10000,
    ratePercent: 12,
    installments: schedule(6),
    payments: [payment(6, new Date(2026, 5, 5))],
    principalPrepaid: 0,
    cardLinkedName: null,
    supportsPrepaymentAndDisbursement: true,
    asOf: new Date(2026, 8, 10), // after installments 7, 8, 9 were due
    lender: { principal: lenderPrincipal },
    ...rest,
  };
}

describe("reconcileLoan", () => {
  it("reports a match inside ₹1 and offers no causes", () => {
    const r = reconcileLoan(input({ lenderPrincipal: 4000.4 }));
    expect(r.flowfiPrincipal).toBe(4000);
    expect(r.direction).toBe("match");
    expect(r.causes).toHaveLength(0);
  });

  it("lender lower by two installments → strong missingPayment, hand-off to the last matched installment with a what-if", () => {
    const r = reconcileLoan(input({ lenderPrincipal: 2000 }));
    expect(r.direction).toBe("lenderLower");
    expect(r.difference).toBe(-2000);
    const c = r.causes[0]!;
    expect(c.id).toBe("missingPayment");
    expect(c.confidence).toBe("strong");
    expect(c.resolution).toMatchObject({ kind: "recordPayment", installmentId: "i8", view: "pay" });
    expect(c.impact).toMatchObject({ outstandingBefore: 4000, outstandingAfter: 2000, gapAfter: 0, installmentsPaidAfter: 8, remainingInstallmentsAfter: 2, cardAvailableDelta: null });
    expect(r.scheduledPrincipal).toBe(1000);
  });

  it("an EMI is paid one installment at a time — the hand-off is the first matched installment", () => {
    const r = reconcileLoan(input({ kind: "emi", lenderPrincipal: 2000, supportsPrepaymentAndDisbursement: false }));
    expect(r.causes[0]!.resolution).toMatchObject({ kind: "recordPayment", installmentId: "i7" });
    expect(r.causes.some((c) => c.id === "missingPrepayment")).toBe(false);
  });

  it("a part-paid installment is detected from its unpaid principal", () => {
    const r = reconcileLoan(input({ installments: schedule(6, { seq: 7, paid: 550 }), lenderPrincipal: 3500 }));
    // FlowFi: 6 paid + half of #7 → 3500 left… lender says 3000: the remaining half of #7 is unrecorded.
    expect(r.flowfiPrincipal).toBe(3500);
    const r2 = reconcileLoan(input({ installments: schedule(6, { seq: 7, paid: 550 }), lenderPrincipal: 3000 }));
    expect(r2.causes[0]).toMatchObject({ id: "partialPayment", confidence: "strong" });
    expect(r2.causes[0]!.resolution).toMatchObject({ kind: "recordPayment", installmentId: "i7" });
  });

  it("card-linked agreements show the available-credit effect of a payment", () => {
    const r = reconcileLoan(input({ lenderPrincipal: 3000, cardLinkedName: "HDFC Regalia" }));
    expect(r.causes[0]!.impact?.cardAvailableDelta).toBe(1000);
  });

  it("lender higher: a payment recorded after the as-of date is a timing difference, no action", () => {
    const r = reconcileLoan(input({
      installments: schedule(7),
      payments: [payment(7, new Date(2026, 8, 12))],
      lenderPrincipal: 4000,
    }));
    expect(r.direction).toBe("lenderHigher");
    expect(r.causes[0]).toMatchObject({ id: "paymentTiming", confidence: "strong" });
    expect(r.causes[0]!.resolution.kind).toBe("explainedNoAction");
  });

  it("lender higher: a payment recorded before as-of that the lender lacks points to the agreement, never an overwrite", () => {
    const r = reconcileLoan(input({
      installments: schedule(7),
      payments: [payment(7, new Date(2026, 8, 3))],
      lenderPrincipal: 4000,
    }));
    const c = r.causes.find((x) => x.id === "paymentNotAppliedByLender")!;
    expect(c.resolution.kind).toBe("openAgreement");
    expect(c.impact).toMatchObject({ outstandingAfter: 4000, gapAfter: 0 });
  });

  it("lender higher with no match: charges are explained, an unmatched gap names the missing write and applies none", () => {
    const r = reconcileLoan(input({ lenderPrincipal: 4213.5 }));
    const charges = r.causes.find((x) => x.id === "accruedInterestOrCharges")!;
    expect(charges.resolution).toMatchObject({ kind: "needsApproval" });
    const unknown = r.causes.find((x) => x.id === "unknown")!;
    expect(unknown.resolution).toMatchObject({ kind: "needsApproval", method: expect.stringContaining("recordPrincipalAdjustment") });
    expect(r.causes.at(-1)!.id).toBe("unknown");
    expect(r.causes.some((c) => c.resolution.kind === "recordPayment")).toBe(false);
  });

  it("loan top-up and extra principal are offered only for Loans", () => {
    const higher = reconcileLoan(input({ lenderPrincipal: 5000 }));
    expect(higher.causes.find((c) => c.id === "unrecordedDisbursement")!.resolution.kind).toBe("addDisbursement");
    const lower = reconcileLoan(input({ lenderPrincipal: 3500 }));
    expect(lower.causes.find((c) => c.id === "missingPrepayment")!.resolution.kind).toBe("payExtraPrincipal");
  });

  it("compares EMI, rate and remaining installments, and flags only the ones that differ", () => {
    const r = reconcileLoan(input({ lenderPrincipal: 3000, lender: { principal: 3000, emiAmount: 1100, ratePercent: 13.5, remainingInstallments: 3 } }));
    const by = Object.fromEntries(r.terms.map((t) => [t.key, t]));
    expect(by.emiAmount!.status).toBe("match");
    expect(by.ratePercent!.status).toBe("differs");
    expect(by.remainingInstallments).toMatchObject({ flowfi: 4, lender: 3, status: "differs" });
    expect(r.causes.find((c) => c.id === "termsMismatch")!.confidence).toBe("possible");
  });

  it("prepaid principal lowers both FlowFi's figure and the schedule's expectation", () => {
    expect(scheduledPrincipalAt({ principalAmount: 10000, installments: schedule(6), principalPrepaid: 500 }, new Date(2026, 8, 10))).toBe(500);
    expect(reconcileLoan(input({ principalPrepaid: 500, lenderPrincipal: 3500 })).direction).toBe("match");
  });

  it("deleted payments never appear in the history and nothing mutates the inputs", () => {
    const base = input({ lenderPrincipal: 2000, payments: [payment(6, new Date(2026, 5, 5)), payment(5, new Date(2026, 4, 5), { deletedAt: new Date() })] });
    const frozen = JSON.stringify(base);
    const r = reconcileLoan(base);
    expect(r.history.map((p) => p.id)).toEqual(["p6"]);
    expect(JSON.stringify(base)).toBe(frozen);
  });
});
