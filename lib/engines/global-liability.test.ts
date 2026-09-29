import { describe, expect, it } from "vitest";
import { liabilityTotals, loanBalanceSheet, netWorthWithLoans } from "./loan-balance-sheet";
import { outstandingPrincipalAfterPrepaymentsFor, principalPrepaidFor, type OutstandingInstallment, type PrepaymentRecord } from "./loan-outstanding";

/**
 * Global Loan/EMI liability regression (A–I): outstanding principal comes from the Loan engine, flows
 * once into the balance sheet, `liabilityTotals` and Net Worth — never the original amount, the
 * schedule total, or this cycle's installment.
 */

const inst = (amountDue: number, amountPaid: number, principalPortion: number | null = null): OutstandingInstallment => ({
  amountDue,
  amountPaid,
  isSkipped: false,
  principalPortion,
});

const borrowed = (outstandingPrincipal: number, ownedByTrackedCard = false) => ({ direction: "taken" as const, outstandingPrincipal, ownedByTrackedCard });

describe("global Loan/EMI liability", () => {
  it("A — a new ₹1,00,000 Loan is a ₹1,00,000 liability; received into an account, Net Worth is unchanged", () => {
    const principal = outstandingPrincipalAfterPrepaymentsFor(100000, [inst(10000, 0)], 0);
    const sheet = loanBalanceSheet([borrowed(principal)], []);
    expect(liabilityTotals(sheet, 0).loanDebt).toBe(100000);
    expect(netWorthWithLoans(100000 /* the borrowed money in the bank */, sheet)).toBe(0);
  });

  it("B — ₹10,000 principal repaid: debt ₹90,000, and Net Worth does not drop a second time", () => {
    const principal = outstandingPrincipalAfterPrepaymentsFor(100000, [inst(10000, 10000), inst(10000, 0)], 0);
    const sheet = loanBalanceSheet([borrowed(principal)], []);
    expect(liabilityTotals(sheet, 0).loanDebt).toBe(90000);
    // Bank fell ₹10,000 (the payment Transaction) and the liability fell ₹10,000 → Net Worth still 0.
    expect(netWorthWithLoans(90000, sheet)).toBe(0);
  });

  it("C — EMI ₹5,000 = ₹4,000 principal + ₹1,000 interest: liability falls ₹4,000, Net Worth falls only the ₹1,000 interest", () => {
    const principal = outstandingPrincipalAfterPrepaymentsFor(100000, [inst(5000, 5000, 4000)], 0);
    expect(principal).toBe(96000);
    const sheet = loanBalanceSheet([borrowed(principal)], []);
    expect(netWorthWithLoans(100000 - 5000, sheet)).toBe(-1000);
  });

  it("D — multiple Loans sum their remaining principal", () => {
    const sheet = loanBalanceSheet([borrowed(50000), borrowed(20000)], []);
    expect(liabilityTotals(sheet, 0).loanDebt).toBe(70000);
  });

  it("E — a Person Loan is one liability (People only presents it) — ₹20,000, never ₹40,000", () => {
    const sheet = loanBalanceSheet([borrowed(20000)], []);
    expect(liabilityTotals(sheet, 0).total).toBe(20000);
    // Net Worth's People term is the DIRECT ledger balance, which excludes Loans (person-position.ts).
    expect(netWorthWithLoans(0, sheet, 0)).toBe(-20000);
  });

  it("F/G — an extra principal payment lowers debt at once; reversing it (soft-delete) restores it", () => {
    const payment: PrepaymentRecord = { allocationType: "principalPrepayment", prepaymentPrincipalAmount: 10000, amount: 10000, deletedAt: null };
    const before = outstandingPrincipalAfterPrepaymentsFor(50000, [], principalPrepaidFor([]));
    const after = outstandingPrincipalAfterPrepaymentsFor(50000, [], principalPrepaidFor([payment]));
    const reversed = outstandingPrincipalAfterPrepaymentsFor(50000, [], principalPrepaidFor([{ ...payment, deletedAt: new Date() }]));
    expect([before, after, reversed]).toEqual([50000, 40000, 50000]);
  });

  it("H — a fully repaid Loan contributes ₹0", () => {
    const principal = outstandingPrincipalAfterPrepaymentsFor(20000, [inst(10000, 10000), inst(10000, 10000)], 0);
    expect(liabilityTotals(loanBalanceSheet([borrowed(principal)], []), 0).total).toBe(0);
  });

  it("I — a card-linked EMI is counted once, on the card line, never again as an EMI", () => {
    const sheet = loanBalanceSheet([], [{ outstandingPrincipal: 15000, ownedByTrackedCard: true }], 15000 /* card's locked principal */);
    const totals = liabilityTotals(sheet, 5000 /* card statement outstanding */);
    expect(totals.emis).toBe(0);
    expect(totals.creditCards).toBe(20000);
    expect(totals.total).toBe(20000);
  });

  it("lent principal is an asset, never a liability", () => {
    const sheet = loanBalanceSheet([{ direction: "given", outstandingPrincipal: 8000 }], []);
    expect(liabilityTotals(sheet, 0).total).toBe(0);
    expect(netWorthWithLoans(0, sheet)).toBe(8000);
  });
});
