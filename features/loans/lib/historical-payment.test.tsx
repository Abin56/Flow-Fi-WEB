// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentTransactionsCard } from "@/features/dashboard/components/recent-transactions-card";
import { PaymentHistoryList } from "@/features/loans/components/payment-rows";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { RECORDED_EARLIER_DESCRIPTION_SUFFIX } from "@/lib/engines/recorded-earlier";
import { HISTORICAL_PAYMENT_LABEL, historicalPaymentExplanation, isHistoricalPaymentCandidate, resolveHistoricalPayment } from "./historical-payment";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
afterEach(cleanup);

/** D-04: an "Already paid earlier" payment says, wherever it is listed, that no new account debit was recorded. */

const historicalTxn = {
  loanId: "loan1",
  excludeFromCalculations: true,
  installmentId: "inst1",
  installmentPaymentId: "pay1",
  description: `Loan payment — Car${RECORDED_EARLIER_DESCRIPTION_SUFFIX}`,
};

describe("resolveHistoricalPayment — the structured flag decides; the description is only a provisional hint", () => {
  it("a candidate whose payment document carries recordedEarlier is historical", () => {
    expect(resolveHistoricalPayment(historicalTxn, true)).toBe(true);
  });
  it("survives a description edit: structured true wins even when the marker text is gone", () => {
    expect(resolveHistoricalPayment({ ...historicalTxn, description: "Car loan, October" }, true)).toBe(true);
  });
  it("a look-alike description cannot fake it: structured false wins over the marker text (legacy / ordinary payment)", () => {
    expect(resolveHistoricalPayment(historicalTxn, false)).toBe(false);
  });
  it("while the structured read is pending/unavailable only the marker is used, and only for a candidate", () => {
    expect(resolveHistoricalPayment(historicalTxn, undefined)).toBe(true);
    expect(resolveHistoricalPayment({ ...historicalTxn, description: "Car loan, October" }, undefined)).toBe(false);
  });
  it("a non-candidate is never historical, whatever its description or flag: not excluded, not a loan payment, no payment link", () => {
    expect(resolveHistoricalPayment({ ...historicalTxn, excludeFromCalculations: false }, true)).toBe(false);
    expect(resolveHistoricalPayment({ ...historicalTxn, loanId: null }, true)).toBe(false);
    expect(resolveHistoricalPayment({ ...historicalTxn, installmentPaymentId: null }, true)).toBe(false);
    expect(isHistoricalPaymentCandidate({ ...historicalTxn, installmentId: null })).toBe(false);
  });
});

describe("Dashboard → Recent transactions", () => {
  const base = { id: "t1", merchant: "Loan payment — Car (already paid earlier)", category: "Uncategorized", date: "13 Oct" };
  it("shows the amount, muted and unsigned, with an explicit no-debit label", () => {
    render(createElement(RecentTransactionsCard, { recentTransactions: [{ ...base, amount: -5330.93, historical: true }] }));
    expect(screen.getByText(`${HISTORICAL_PAYMENT_LABEL} · no account debit`)).toBeTruthy();
    expect(screen.getByText("₹5,331")).toBeTruthy(); // the genuine payment amount is still shown…
    expect(screen.queryByText("−", { exact: false, selector: "p" })).toBeNull(); // …without a minus sign that would read as money out
    expect(screen.getByTitle(historicalPaymentExplanation(false))).toBeTruthy();
  });
  it("an ordinary expense is unchanged: signed, no label", () => {
    const { container } = render(createElement(RecentTransactionsCard, { recentTransactions: [{ ...base, id: "t2", merchant: "Groceries", amount: -850 }] }));
    expect(container.textContent).toContain("−₹850");
    expect(screen.queryByText(/no account debit/)).toBeNull();
  });
});

describe("Loan/EMI payment history rows", () => {
  const action = (over: Partial<RecordedPaymentAction>): RecordedPaymentAction => ({
    id: "a1",
    source: "loan",
    portions: [],
    overflow: null,
    amount: 5330.93,
    date: new Date("2026-10-13T00:00:00"),
    note: "",
    createdAt: new Date("2026-10-13T00:00:00"),
    allocationType: "regularEmi",
    transactionId: "t1",
    installmentSeqs: [1],
    remainingAfter: 0,
    reversed: false,
    recordedEarlier: { dateKnown: true },
    ...over,
  });
  it("labels the row and says no account debit was recorded", () => {
    const { container } = render(createElement(PaymentHistoryList, { actions: [action({})], onOpen: () => {} }));
    expect(screen.getByText(HISTORICAL_PAYMENT_LABEL)).toBeTruthy();
    expect(screen.getByText(/no account debit recorded/)).toBeTruthy();
    expect(container.textContent).toContain("₹5,330.93"); // exact — the row is not rounded either
  });
  it("a Loan I gave says no account CREDIT; an ordinary payment gets neither label", () => {
    const { rerender } = render(createElement(PaymentHistoryList, { actions: [action({})], lent: true, onOpen: () => {} }));
    expect(screen.getByText(/no account credit recorded/)).toBeTruthy();
    rerender(createElement(PaymentHistoryList, { actions: [action({ recordedEarlier: null })], onOpen: () => {} }));
    expect(screen.queryByText(HISTORICAL_PAYMENT_LABEL)).toBeNull();
    expect(screen.queryByText(/no account/)).toBeNull();
  });
});
