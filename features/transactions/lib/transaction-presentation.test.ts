import { describe, expect, it } from "vitest";
import { getTransactionPresentation } from "@/features/transactions/lib/transaction-presentation";

const base = { type: "expense" as const, transferId: null, loanId: null, emiId: null, paymentAllocationType: null, isPersonLedgerMovement: false };
const p = (o: Partial<typeof base> | Record<string, unknown>, ctx?: { touchesCard?: boolean; borrowedFromPerson?: boolean }) => getTransactionPresentation({ ...base, ...o } as never, ctx);

describe("getTransactionPresentation — semantics, never the sign alone", () => {
  it("A — salary is the green Income row", () => {
    expect(p({ type: "income" })).toMatchObject({ kind: "income", row: "income", status: "Money in", settled: false });
  });
  it("B — a normal expense keeps the expense treatment", () => {
    expect(p({})).toMatchObject({ kind: "expense", row: "expense", status: "Money out", settled: false });
  });
  it("C — EMI paid: settlement rail, not income", () => {
    expect(p({ emiId: "e1", paymentAllocationType: "regularEmi" })).toMatchObject({ kind: "emiPayment", row: "settled", status: "EMI paid", incoming: false });
  });
  it("D — loan repayment, both directions, is a settlement — never income", () => {
    expect(p({ loanId: "l1", paymentAllocationType: "regularEmi" })).toMatchObject({ kind: "loanPayment", row: "settled", label: "Loan repayment" });
    expect(p({ type: "income", loanId: "l1", paymentAllocationType: "regularEmi" })).toMatchObject({ kind: "loanRepaymentReceived", row: "settled", incoming: true });
  });
  it("E — a transfer touching a card is a card bill payment on both legs", () => {
    expect(p({ transferId: "t", type: "expense" }, { touchesCard: true })).toMatchObject({ kind: "cardPayment", row: "settled", status: "Card bill paid", incoming: false });
    expect(p({ transferId: "t", type: "income" }, { touchesCard: true })).toMatchObject({ kind: "cardPayment", row: "settled", incoming: true });
  });
  it("F — paid back to a person: settlement rail, money out", () => {
    expect(p({ isPersonLedgerMovement: true })).toMatchObject({ kind: "personRepaid", row: "settled", detail: "Paid back to person", status: "Repaid", incoming: false });
  });
  it("G — a person paying me is money in but never Income", () => {
    expect(p({ type: "income", isPersonLedgerMovement: true })).toMatchObject({ kind: "personReceived", row: "debt", incoming: true });
  });
  it("borrowed from a person: its own ledger-identified cash leg gets the borrowed outline, not Income or plain People", () => {
    expect(p({ type: "income", isPersonLedgerMovement: true }, { borrowedFromPerson: true })).toMatchObject({ kind: "borrowedFromPerson", row: "borrowed", label: "Borrowed", detail: "Borrowed money", status: "You need to repay", incoming: true });
    // Flag only applies to money in — a repayment out is still a settlement.
    expect(p({ isPersonLedgerMovement: true }, { borrowedFromPerson: true })).toMatchObject({ row: "settled" });
  });
  it("H — a plain transfer keeps the transfer treatment", () => {
    expect(p({ transferId: "t", type: "income" })).toMatchObject({ kind: "transfer", row: "transfer", status: "Transfer received" });
  });
  it("I — borrowed / lent principal keeps the debt theme", () => {
    expect(p({ type: "income", loanId: "l1", paymentAllocationType: "additionalDisbursement" })).toMatchObject({ kind: "borrowing", row: "borrowed", status: "You need to repay", incoming: true });
    expect(p({ loanId: "l1", paymentAllocationType: "additionalDisbursement" })).toMatchObject({ kind: "lending", row: "debt" });
  });
});
