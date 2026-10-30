// @vitest-environment jsdom
/**
 * Balance Control UI polish: the bank column is labelled per figure (never a generic "bank figure"), an empty input
 * shows a neutral "Not compared" state with no difference, a typed figure shows the exact signed difference, the
 * product picker lists every product grouped with its shared-limit tag, and typing writes nothing.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const recordCorrection = vi.fn();
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(() => ({})), query: vi.fn(() => ({})), limit: vi.fn(() => ({})), getDocsFromServer: vi.fn() }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/layout/scroll-nav", () => ({ ScrollNav: () => null }));
vi.mock("next/link", () => ({ default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => <a {...rest}>{children}</a> }));
vi.mock("../hooks/use-limit-correction", () => ({
  useLimitCorrection: () => ({ recordCorrection, reverseCorrection: vi.fn(), historyFor: vi.fn().mockResolvedValue([]) }),
}));

import type { VarianceProduct } from "../lib/build-balance-control";
import { BalanceControlView } from "./balance-control-workspace";

function card(overrides: Partial<VarianceProduct> = {}): VarianceProduct {
  return {
    id: "card:c1",
    kind: "card",
    name: "QA Card",
    subtitle: "Credit card",
    metrics: ["creditLimit", "totalOutstanding", "statementBalance", "availableCredit"],
    flowfi: { creditLimit: 50000, totalOutstanding: 24500, statementBalance: 12000, availableCredit: 25500 },
    notes: {},
    context: { lockedEmiPrincipal: 0 },
    crossEffect: null,
    limitCorrectionTarget: null,
    reconciliation: null,
    ...overrides,
  };
}
const loan: VarianceProduct = {
  ...card(),
  id: "loan:l1",
  kind: "loan",
  name: "QA Loan",
  subtitle: "Loan",
  metrics: ["loanPrincipal", "lenderPayoff"],
  flowfi: { loanPrincipal: 80000, lenderPayoff: 80000 },
};

// jsdom has neither; cmdk (ResizeObserver) and the open-on-current-row scroll (scrollIntoView) need them.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function () {};

afterEach(() => cleanup());
const row = (metric: string) => screen.getByTestId(`variance-row-${metric}`);
const view = (products: VarianceProduct[]) => render(<BalanceControlView products={products} isLoading={false} isError={false} reachability="reachable" />);

describe("bank / lender column labels", () => {
  it("names what the bank shows for each card figure — not a generic 'Bank figure'", () => {
    view([card()]);
    const placeholder = (m: string) => within(row(m)).getByTestId("bank-input").getAttribute("placeholder");
    expect(placeholder("creditLimit")).toBe("Bank-approved credit limit");
    expect(placeholder("totalOutstanding")).toBe("Bank outstanding");
    expect(placeholder("statementBalance")).toBe("Latest statement balance");
    expect(placeholder("availableCredit")).toBe("Bank available credit");
    expect(screen.queryByPlaceholderText("Bank figure")).toBeNull();
    expect(screen.getByTestId("bank-figure-help").textContent).toMatch(/FlowFi\s+compares it with its own calculated figure/);
  });

  it("asks a loan for the lender's remaining principal", () => {
    view([loan]);
    expect(within(row("loanPrincipal")).getByTestId("bank-input").getAttribute("placeholder")).toBe("Lender remaining principal");
    expect(within(row("loanPrincipal")).getByTestId("bank-input").getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("difference and result", () => {
  it("shows a neutral 'Not compared' state and no difference while nothing is typed", () => {
    view([card()]);
    const r = row("totalOutstanding");
    expect(within(r).getByTestId("variance-class").textContent).toBe("Not compared");
    expect(within(r).getByTestId("difference").textContent).toBe("—");
    expect(r.textContent).not.toMatch(/Enter bank figure/);
  });

  it("shows the exact signed difference and a verdict once a figure is typed", () => {
    view([card()]);
    fireEvent.change(within(row("totalOutstanding")).getByTestId("bank-input"), { target: { value: "25,200.50" } });
    expect(within(row("totalOutstanding")).getByTestId("difference").textContent).toMatch(/^\+₹700\.50$/);
    expect(within(row("totalOutstanding")).getByTestId("variance-class").textContent).toMatch(/Bank higher/);
    fireEvent.change(within(row("statementBalance")).getByTestId("bank-input"), { target: { value: "12000" } });
    expect(within(row("statementBalance")).getByTestId("variance-class").textContent).toMatch(/Matches/);
  });

  it("typing a figure never writes anything", () => {
    view([card({ limitCorrectionTarget: { kind: "card", cardId: "c1" } })]);
    fireEvent.change(within(row("creditLimit")).getByTestId("bank-input"), { target: { value: "60000" } });
    expect(within(row("creditLimit")).getByTestId("correct-limit-button")).toBeTruthy();
    expect(recordCorrection).not.toHaveBeenCalled();
  });
});

describe("product picker", () => {
  it("keeps every product in the synced native select, grouped by kind", () => {
    view([card(), card({ id: "card:c2", name: "Pool Card", subtitle: "Shared limit · Family pool" }), loan]);
    const select = screen.getByTestId("product-select") as HTMLSelectElement;
    expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Credit cards", "Loans"]);
    fireEvent.change(select, { target: { value: "loan:l1" } });
    expect(screen.getByTestId("product-picker").textContent).toMatch(/QA Loan/);
    expect(screen.getByTestId("variance-row-loanPrincipal")).toBeTruthy();
  });

  it("opens a grouped list with the shared-limit tag and selects a product on click", () => {
    view([card(), card({ id: "card:c2", name: "Pool Card", subtitle: "Shared limit · Family pool" }), loan]);
    fireEvent.click(screen.getByTestId("product-picker"));
    const pop = screen.getByTestId("product-picker-popover");
    expect(within(pop).getByTestId("picker-shared-limit").textContent).toBe("Shared limit · Family pool");
    expect(pop.textContent).toMatch(/Credit cards/);
    expect(pop.textContent).toMatch(/Loans/);
    fireEvent.click(within(pop).getByText("Pool Card"));
    expect(screen.getByTestId("product-picker").textContent).toMatch(/Pool Card/);
  });
});
