// @vitest-environment jsdom
/**
 * Balance Control's outstanding/available-credit reconciliation guide: the "Reconcile" button only appears for
 * a real, signed gap on a product that has reconciliation context; the cause list matches the gap's direction
 * and this card's actual state (locked EMI, shared limit); existing nearby transactions are shown; and every
 * resolution either links to an existing safe workflow or explains the difference without implying a write.
 * This component has no repository of its own — it is pure render + navigation, so no mocked write path is
 * needed here. The underlying cause engine is covered in `lib/engines/outstanding-reconciliation.test.ts`.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordCorrection = vi.fn();
const historyFor = vi.fn();
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(() => ({})), query: vi.fn(() => ({})), limit: vi.fn(() => ({})), getDocsFromServer: vi.fn() }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/layout/scroll-nav", () => ({ ScrollNav: () => null }));
vi.mock("next/link", () => ({ default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => <a {...rest}>{children}</a> }));
vi.mock("../hooks/use-limit-correction", () => ({
  useLimitCorrection: () => ({ recordCorrection, reverseCorrection: vi.fn(), historyFor }),
}));

import type { Transaction } from "@/lib/models/transaction";
import type { VarianceProduct } from "../lib/build-balance-control";
import { BalanceControlView } from "./balance-control-workspace";

const q = (id: string) => screen.queryByTestId(id);

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1", accountId: "acct-card-1", type: "expense", amount: 500, dateTime: new Date("2026-10-20"),
    categoryId: "cat-1", description: "Grocery", notes: "", receiptPurpose: null, transferId: null,
    excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false,
    createdAt: new Date("2026-10-20"), transferMatchedAt: null, status: "settled", isBusiness: false,
    source: null, deletedAt: null, lastEditedAt: null, editHistory: [],
    ...overrides,
  } as Transaction;
}

function cardProduct(overrides: Partial<VarianceProduct> = {}): VarianceProduct {
  return {
    id: "card:c1",
    kind: "card",
    name: "QA Card",
    subtitle: "Credit card",
    metrics: ["totalOutstanding", "availableCredit"],
    flowfi: { totalOutstanding: 24500, availableCredit: 25500 },
    notes: {},
    context: { lockedEmiPrincipal: 0 },
    crossEffect: null,
    limitCorrectionTarget: null,
    reconciliation: { cardAccountId: "acct-card-1", lockedEmiPrincipal: 0, onSharedLimit: false, hasOpeningBalance: false },
    ...overrides,
  };
}

beforeEach(() => {
  recordCorrection.mockReset();
  historyFor.mockReset();
  historyFor.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("Reconcile button visibility", () => {
  it("does not show while nothing is typed", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    expect(q("reconcile-button")).toBeNull();
  });

  it("does not show when the typed figure matches FlowFi's", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(within(screen.getByTestId("variance-row-totalOutstanding")).getByTestId("bank-input"), { target: { value: "24500" } });
    expect(q("reconcile-button")).toBeNull();
  });

  it("shows once a real gap is typed for totalOutstanding", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(within(screen.getByTestId("variance-row-totalOutstanding")).getByTestId("bank-input"), { target: { value: "25200" } });
    expect(screen.getAllByTestId("reconcile-button").length).toBeGreaterThan(0);
  });

  it("never shows for a product with no reconciliation context (loan/EMI)", () => {
    const loan = cardProduct({ id: "loan:l1", kind: "loan", metrics: ["totalOutstanding"], reconciliation: null });
    render(<BalanceControlView products={[loan]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(screen.getByTestId("bank-input"), { target: { value: "25200" } });
    expect(q("reconcile-button")).toBeNull();
  });
});

describe("reconciliation sheet", () => {
  function openSheet(product = cardProduct(), transactions: Transaction[] = []) {
    render(<BalanceControlView products={[product]} isLoading={false} isError={false} reachability="reachable" transactions={transactions} />);
    fireEvent.change(within(screen.getByTestId("variance-row-totalOutstanding")).getByTestId("bank-input"), { target: { value: "25200" } });
    fireEvent.click(within(screen.getByTestId("variance-row-totalOutstanding")).getByTestId("reconcile-button"));
  }

  it("shows FlowFi, bank and the signed difference", () => {
    openSheet();
    expect(screen.getByTestId("reconcile-flowfi-value").textContent).toMatch(/24,500/);
    expect(screen.getByTestId("reconcile-bank-value").textContent).toMatch(/25,200/);
    expect(screen.getByTestId("reconcile-difference").textContent).toMatch(/700/);
  });

  it("a bank-higher gap (bank owes more) offers charge-side causes, not payment/refund", () => {
    openSheet();
    const list = screen.getByTestId("cause-list");
    expect(within(list).queryByTestId("cause-missingPurchase")).not.toBeNull();
    expect(within(list).queryByTestId("cause-interestCharge")).not.toBeNull();
    expect(within(list).queryByTestId("cause-missingPayment")).toBeNull();
    expect(within(list).queryByTestId("cause-refundOrCredit")).toBeNull();
  });

  it("shows existing nearby transactions on this card, for duplicate prevention", () => {
    openSheet(cardProduct(), [txn({ description: "Supermarket run", amount: 700, dateTime: new Date() })]);
    const rows = screen.getAllByTestId("relevant-transaction-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toMatch(/Supermarket run/);
  });

  it("selecting 'Missing purchase' links to Transactions filtered to this card, never writes anything itself", () => {
    openSheet();
    fireEvent.click(screen.getByTestId("cause-missingPurchase"));
    const panel = screen.getByTestId("resolution-panel");
    expect(within(panel).getByTestId("resolution-link-add-expense").getAttribute("href")).toBe("/transactions?account=acct-card-1");
    expect(recordCorrection).not.toHaveBeenCalled();
  });

  it("selecting 'Missing payment' (bank shows MORE available credit — it sees less owed) links to Pay bill, never Add Expense", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(within(screen.getByTestId("variance-row-availableCredit")).getByTestId("bank-input"), { target: { value: "27000" } });
    fireEvent.click(within(screen.getByTestId("variance-row-availableCredit")).getByTestId("reconcile-button"));
    fireEvent.click(screen.getByTestId("cause-missingPayment"));
    const panel = screen.getByTestId("resolution-panel");
    expect(within(panel).getByTestId("resolution-link-pay-bill").getAttribute("href")).toBe("/credit-cards?card=acct-card-1&pay=1");
    expect(within(panel).queryByTestId("resolution-link-add-expense")).toBeNull();
  });

  it("card-EMI lock is explained with no action when this card actually has locked principal", () => {
    openSheet(cardProduct({ context: { lockedEmiPrincipal: 12000 }, reconciliation: { cardAccountId: "acct-card-1", lockedEmiPrincipal: 12000, onSharedLimit: false, hasOpeningBalance: false } }));
    fireEvent.click(screen.getByTestId("cause-cardEmiOrSharedLimit"));
    expect(q("resolution-link-add-expense")).toBeNull();
    expect(q("resolution-link-pay-bill")).toBeNull();
    expect(screen.getByTestId("resolution-panel").textContent).toMatch(/Nothing is changed/);
  });

  it("'unknown' cause shows the review notice and implies no correction", () => {
    openSheet();
    fireEvent.click(screen.getByTestId("cause-unknown"));
    expect(screen.getByTestId("reconcile-review-notice")).toBeTruthy();
    expect(q("resolution-link-add-expense")).toBeNull();
  });

  it("opening-outstanding cause links to Financial Audit, not a transaction, when this card has an opening balance", () => {
    openSheet(cardProduct({ reconciliation: { cardAccountId: "acct-card-1", lockedEmiPrincipal: 0, onSharedLimit: false, hasOpeningBalance: true } }));
    fireEvent.click(screen.getByTestId("cause-openingOutstanding"));
    const panel = screen.getByTestId("resolution-panel");
    expect(within(panel).getByText("Open Financial Audit").getAttribute("href")).toBe("/financial-audit");
  });
});
