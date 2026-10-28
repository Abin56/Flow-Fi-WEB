import { describe, expect, it } from "vitest";
import { compareFigure, impactPreviewFor, VARIANCE_METRIC_DEFINITION } from "./balance-variance";

describe("compareFigure — read-only variance", () => {
  it("nothing typed yet: no difference, asks for the figure", () => {
    const r = compareFigure({ metric: "totalOutstanding", flowfi: 12000, bank: null });
    expect(r.classification).toBe("notEntered");
    expect(r.difference).toBeNull();
  });

  it("matches to the paisa", () => {
    const r = compareFigure({ metric: "totalOutstanding", flowfi: 12000, bank: 12000 });
    expect(r).toMatchObject({ classification: "match", difference: 0, severity: "ok" });
  });

  it("bank rounding (≤ ₹1) is rounding, not a gap", () => {
    expect(compareFigure({ metric: "statementBalance", flowfi: 4999.6, bank: 5000 }).classification).toBe("rounding");
    expect(compareFigure({ metric: "statementBalance", flowfi: 5000, bank: 4999.1 }).classification).toBe("rounding");
  });

  it("missing GST/fees: a bank outstanding higher by ₹18 is a real, signed gap", () => {
    const r = compareFigure({ metric: "totalOutstanding", flowfi: 10000, bank: 10018 });
    expect(r.classification).toBe("bankHigher");
    expect(r.difference).toBe(18);
    expect(r.hint).toMatch(/fees, GST or interest/);
  });

  it("a bank figure lower than FlowFi points at an unrecorded payment/refund, not a charge", () => {
    const r = compareFigure({ metric: "totalOutstanding", flowfi: 10000, bank: 9500 });
    expect(r.classification).toBe("bankLower");
    expect(r.difference).toBe(-500);
    expect(r.hint).toMatch(/payment or refund/);
  });

  it("credit limit is a setting: any real difference is 'limit differs'", () => {
    const r = compareFigure({ metric: "creditLimit", flowfi: 100000, bank: 150000 });
    expect(r.classification).toBe("limitDiffers");
    expect(r.hint).toMatch(/setting/);
  });

  it("a card-EMI lock explains an outstanding / available gap of exactly the locked principal", () => {
    // FlowFi total outstanding includes the locked principal; a bank that lists it separately reports less.
    const out = compareFigure({ metric: "totalOutstanding", flowfi: 30000, bank: 20000, context: { lockedEmiPrincipal: 10000 } });
    expect(out.classification).toBe("emiLockExplains");
    const avail = compareFigure({ metric: "availableCredit", flowfi: 60000, bank: 70000, context: { lockedEmiPrincipal: 10000 } });
    expect(avail.classification).toBe("emiLockExplains");
    // …but only when the gap really equals the lock.
    expect(compareFigure({ metric: "availableCredit", flowfi: 60000, bank: 70500, context: { lockedEmiPrincipal: 10000 } }).classification).toBe("bankHigher");
    // …and never when no EMI is locked.
    expect(compareFigure({ metric: "availableCredit", flowfi: 60000, bank: 70000, context: { lockedEmiPrincipal: 0 } }).classification).toBe("bankHigher");
  });

  it("statement balance and total outstanding keep separate definitions", () => {
    expect(VARIANCE_METRIC_DEFINITION.statementBalance).toMatch(/latest closed statement/i);
    expect(VARIANCE_METRIC_DEFINITION.totalOutstanding).toMatch(/unbilled/i);
    expect(VARIANCE_METRIC_DEFINITION.statementBalance).not.toBe(VARIANCE_METRIC_DEFINITION.totalOutstanding);
  });

  it("remaining principal vs lender payoff: payoff above principal is interest & charges, not an error", () => {
    const r = compareFigure({ metric: "lenderPayoff", flowfi: 50000, bank: 51250 });
    expect(r.classification).toBe("payoffImplied");
    expect(r.difference).toBe(1250);
    expect(r.severity).toBe("info");
  });

  it("a payoff BELOW the principal is flagged for review", () => {
    expect(compareFigure({ metric: "lenderPayoff", flowfi: 50000, bank: 48000 }).classification).toBe("payoffBelowPrincipal");
  });

  it("the same bank number is a variance for remaining principal but only a floor check for payoff", () => {
    const principal = compareFigure({ metric: "loanPrincipal", flowfi: 50000, bank: 51250 });
    const payoff = compareFigure({ metric: "lenderPayoff", flowfi: 50000, bank: 51250 });
    expect(principal.classification).toBe("bankHigher");
    expect(payoff.classification).toBe("payoffImplied");
  });

  it("no FlowFi figure → not comparable, never a fabricated difference", () => {
    const r = compareFigure({ metric: "statementBalance", flowfi: null, bank: 100 });
    expect(r.classification).toBe("notComparable");
    expect(r.difference).toBeNull();
  });

  it("NaN input is treated as nothing entered", () => {
    expect(compareFigure({ metric: "creditLimit", flowfi: 1, bank: Number.NaN }).classification).toBe("notEntered");
  });
});

describe("impactPreviewFor — preview only", () => {
  it("no preview when nothing needs correcting", () => {
    expect(impactPreviewFor("totalOutstanding", "match")).toBeNull();
    expect(impactPreviewFor("totalOutstanding", "rounding")).toBeNull();
    expect(impactPreviewFor("lenderPayoff", "payoffImplied")).toBeNull();
  });

  it("a limit correction moves limit-derived figures only — never accounts, history or Net Worth", () => {
    const p = impactPreviewFor("creditLimit", "limitDiffers")!;
    expect(p.wouldChange).toEqual(expect.arrayContaining(["Available credit", "Utilization"]));
    expect(p.mustNotChange).toEqual(expect.arrayContaining(["Accounts", "Net Worth", "Transaction history", "Card outstanding"]));
  });

  it("an outstanding correction reaches accounts and Net Worth but never transaction history or loan schedules", () => {
    const p = impactPreviewFor("totalOutstanding", "bankHigher")!;
    expect(p.wouldChange).toEqual(expect.arrayContaining(["Accounts", "Net Worth", "Card bills"]));
    expect(p.mustNotChange).toEqual(expect.arrayContaining(["Transaction history", "Paid installments", "Loan/EMI schedule", "People"]));
  });

  it("a principal correction must never touch paid installments or transaction history", () => {
    const p = impactPreviewFor("loanPrincipal", "bankLower")!;
    expect(p.wouldChange).toContain("Loan/EMI schedule");
    expect(p.mustNotChange).toEqual(expect.arrayContaining(["Paid installments", "Transaction history", "People"]));
  });

  it("every area is classified exactly once", () => {
    const p = impactPreviewFor("totalOutstanding", "bankHigher")!;
    expect(new Set([...p.wouldChange, ...p.mustNotChange]).size).toBe(p.wouldChange.length + p.mustNotChange.length);
  });
});
