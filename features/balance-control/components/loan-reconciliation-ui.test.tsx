// @vitest-environment jsdom
/**
 * Loan / EMI reconciliation guide in Balance Control: the Reconcile button appears only for a real signed gap on
 * a loan/EMI principal row; the sheet asks for lender figure + as-of date + reason, ranks causes with evidence,
 * shows a before/after preview, and every correction is a prefilled LINK to an existing workflow (or an explicit
 * "not executable yet" notice naming the missing write). Nothing here writes — the sheet has no repository, and
 * the engine is covered in `lib/engines/loan-reconciliation.test.ts`.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loanHistory = vi.fn();
const emiHistory = vi.fn();
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(() => ({})), query: vi.fn(() => ({})), limit: vi.fn(() => ({})), getDocsFromServer: vi.fn() }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/layout/scroll-nav", () => ({ ScrollNav: () => null }));
vi.mock("next/link", () => ({ default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => <a {...rest}>{children}</a> }));
vi.mock("../hooks/use-limit-correction", () => ({ useLimitCorrection: () => ({ recordCorrection: vi.fn(), reverseCorrection: vi.fn(), historyFor: vi.fn().mockResolvedValue([]) }) }));
vi.mock("@/features/loans/hooks/use-payment-history", () => ({
  useLoanPaymentHistory: (row: unknown) => (row ? loanHistory() : { data: undefined, isLoading: false }),
  useEmiPaymentHistory: (row: unknown) => (row ? emiHistory() : { data: undefined, isLoading: false }),
}));

import type { ReconInstallment } from "@/lib/engines/loan-reconciliation";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import type { VarianceProduct } from "../lib/build-balance-control";
import { BalanceControlView } from "./balance-control-workspace";

const q = (id: string) => screen.queryByTestId(id);
const g = (id: string) => screen.getByTestId(id);

const installments: ReconInstallment[] = Array.from({ length: 10 }, (_, k) => ({
  id: `i${k + 1}`, sequenceNumber: k + 1, dueDate: new Date(2026, k, 5), amountDue: 1100, amountPaid: k < 6 ? 1100 : 0,
  isSkipped: false, principalPortion: 1000, interestPortion: 100,
}));

function product(kind: "loan" | "emi" = "loan", cardLinkedName: string | null = null): VarianceProduct {
  const metric = kind === "loan" ? "loanPrincipal" : "emiPrincipal";
  return {
    id: `${kind}:a1`, kind, name: "QA Loan", subtitle: kind === "loan" ? "Loan" : "EMI",
    metrics: [metric], flowfi: { [metric]: 4000 }, notes: {}, context: {}, crossEffect: null,
    limitCorrectionTarget: null, reconciliation: null,
    loanReconciliation: {
      agreementId: "a1",
      source: kind === "loan" ? { kind: "loan", row: {} as LoanRow } : { kind: "emi", row: {} as EmiRow },
      principalAmount: 10000, ratePercent: 12, installments, principalPrepaid: 0, cardLinkedName,
      supportsPrepaymentAndDisbursement: kind === "loan",
    },
  };
}

function open(p: VarianceProduct, typed: string, asOf = "2026-09-10") {
  render(<BalanceControlView products={[p]} isLoading={false} isError={false} reachability="reachable" />);
  const metric = p.metrics[0]!;
  fireEvent.change(within(g(`variance-row-${metric}`)).getByTestId("bank-input"), { target: { value: typed } });
  fireEvent.click(within(g(`variance-row-${metric}`)).getByTestId("reconcile-button"));
  fireEvent.change(g("loan-asof-input"), { target: { value: asOf } });
}

const chooseReason = () => fireEvent.change(g("loan-reason-select"), { target: { value: "statement" } });

beforeEach(() => {
  loanHistory.mockReset();
  emiHistory.mockReset();
  const data = { payments: [{ id: "p6", installmentId: "i6", amount: 1100, date: new Date(2026, 5, 5), deletedAt: null }] };
  loanHistory.mockReturnValue({ data, isLoading: false });
  emiHistory.mockReturnValue({ data, isLoading: false });
});
afterEach(() => cleanup());

describe("Reconcile button (Loan / EMI)", () => {
  it("is hidden until a real gap is typed", () => {
    render(<BalanceControlView products={[product()]} isLoading={false} isError={false} reachability="reachable" />);
    expect(q("reconcile-button")).toBeNull();
    fireEvent.change(g("bank-input"), { target: { value: "4000" } });
    expect(q("reconcile-button")).toBeNull();
    fireEvent.change(g("bank-input"), { target: { value: "2000" } });
    expect(q("reconcile-button")).not.toBeNull();
  });
});

describe("Loan reconciliation sheet", () => {
  it("prefills the typed lender figure and shows FlowFi, lender, difference and the schedule", () => {
    open(product(), "2000");
    expect((g("loan-lender-input") as HTMLInputElement).value).toBe("2000");
    expect(g("loan-flowfi-value").textContent).toMatch(/4,000/);
    expect(g("loan-lender-value").textContent).toMatch(/2,000/);
    expect(g("loan-difference").textContent).toMatch(/−.*2,000/);
    expect(g("loan-scheduled-value").textContent).toMatch(/1,000/);
  });

  it("ranks a strong missing-payment cause with a before/after and keeps the hand-off locked until a reason is chosen", () => {
    open(product(), "2000");
    expect(g("loan-cause-missingPayment").getAttribute("data-confidence")).toBe("strong");
    expect(q("loan-handoff-link")).toBeNull();
    expect(q("loan-handoff-locked")).not.toBeNull();
    expect(g("loan-impact-after").textContent).toMatch(/2,000/);
    expect(g("loan-impact-gap").textContent).toMatch(/Matches the lender/);

    chooseReason();
    expect(g("loan-handoff-link").getAttribute("href")).toBe("/loans?agreement=a1&pay=1&installment=i8");
    expect(g("loan-handoff-past-link").getAttribute("href")).toBe("/loans?agreement=a1&pay=1&installment=i8&view=past");
  });

  it("lists recorded payments so nothing is duplicated", () => {
    open(product(), "2000");
    const rows = screen.getAllByTestId("loan-history-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/Installment 6/);
  });

  it("an EMI hands off to the first installment, and a card-linked agreement shows the card effect", () => {
    open(product("emi", "HDFC Regalia"), "2000");
    chooseReason();
    expect(g("loan-handoff-link").getAttribute("href")).toContain("installment=i7");
    expect(g("loan-impact-card").textContent).toMatch(/HDFC Regalia.*available credit \+.*2,000/);
  });

  it("a standalone agreement shows no card effect", () => {
    open(product(), "2000");
    expect(q("loan-impact-card")).toBeNull();
  });

  it("an unexplained higher gap links to nothing and names the missing write", () => {
    open(product(), "4213.5");
    chooseReason();
    fireEvent.click(g("loan-cause-unknown"));
    expect(g("loan-needs-approval").textContent).toMatch(/recordPrincipalAdjustment/);
    expect(q("loan-handoff-link")).toBeNull();
  });

  it("a top-up and extra principal are offered for loans as existing dialogs", () => {
    open(product(), "5000");
    chooseReason();
    fireEvent.click(g("loan-cause-unrecordedDisbursement"));
    expect(g("loan-handoff-link").getAttribute("href")).toBe("/loans?agreement=a1&adjust=disbursement");
  });

  it("flags differing terms the user enters", () => {
    open(product(), "2000");
    fireEvent.change(g("loan-lender-rate"), { target: { value: "13.5" } });
    fireEvent.change(g("loan-lender-remaining"), { target: { value: "2" } });
    expect(g("loan-term-ratePercent").getAttribute("data-status")).toBe("differs");
    expect(g("loan-term-remainingInstallments").getAttribute("data-status")).toBe("differs");
    expect(g("loan-term-emiAmount").getAttribute("data-status")).toBe("notProvided");
  });

  it("reports a match without offering any correction", () => {
    open(product(), "2000");
    fireEvent.change(g("loan-lender-input"), { target: { value: "4000" } });
    expect(q("loan-recon-match")).not.toBeNull();
    expect(q("loan-cause-list")).toBeNull();
  });
});
