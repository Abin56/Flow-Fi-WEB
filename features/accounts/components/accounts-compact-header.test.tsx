// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCurrency } from "@/lib/format";

/**
 * Accounts compact bar: title, the SAME Total balance the summary shows, Add Account (same handler) and a ⋯ menu with the
 * two disabled "Soon" utilities. It must stay out of the accessibility tree while hidden and never disturb the page's own
 * state (search, type filter, selection) when it appears or disappears.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const TOTAL = 123456;
const item = (id: string, name: string, typeLabel: string, balance: number) => ({
  id, name, typeLabel, bankId: null, mask: null, balance, balanceLabel: "Current balance", cardStyle: "compact", color: "blue",
  accountHolder: "Me", accountNumberMasked: null, ifsc: null, branch: null, upiId: null, linkedSince: null,
});
const ITEMS = [item("a1", "Salary Bank", "Savings Account", 100000), item("a2", "Wallet Cash", "Cash", 23456)];

vi.mock("@/features/accounts/hooks/use-accounts-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/accounts/hooks/use-accounts-data")>()),
  useAccountsOverview: () => ({ items: ITEMS, isLoading: false }),
  useAccountsStats: () => ({ stats: { totalBalance: TOTAL, totalInBanks: 100000, cashOnHand: 23456 }, isLoading: false }),
  useAccountActions: () => ({}),
  useRecentAccountTransactions: () => ({ rows: [], isLoading: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: [] }) }));
vi.mock("@/features/credit-cards/hooks/use-credit-cards-data", () => ({ useCreditCardActions: () => ({}) }));
vi.mock("@/features/people/hooks/use-linked-funds", () => ({ useLinkedFunds: () => ({ funds: [], isLoading: false }) }));

// Controllable IntersectionObserver: the compact-header hook is the one built with a `threshold` array.
type IoCallback = (entries: unknown[]) => void;
let headerIo: IoCallback | null = null;
class MockIntersectionObserver {
  constructor(cb: IoCallback, options?: { threshold?: unknown }) {
    if (Array.isArray(options?.threshold)) headerIo = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
function titleVisible(ratio: number) {
  act(() => {
    headerIo?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio, boundingClientRect: { top: ratio >= 1 ? 20 : -20 }, rootBounds: { top: 0 } }]);
  });
}

const { AccountsWorkspace } = await import("./accounts-workspace");
const bar = () => screen.getByRole("region", { name: "Accounts quick bar" });
const barEl = () => document.querySelector<HTMLElement>("[data-compact-bar]")!;

beforeEach(() => {
  headerIo = null;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Accounts compact bar — hidden", () => {
  it("is inert and out of the accessibility tree while the title is in view; the header keeps its single set of controls", () => {
    render(<AccountsWorkspace />);
    titleVisible(1);
    expect(screen.queryByRole("region", { name: "Accounts quick bar" })).toBeNull();
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Add Account" })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Accounts" })).toBeTruthy();
  });

  it("without IntersectionObserver the bar never shows and the page is unchanged", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<AccountsWorkspace />);
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Add Account" })).toHaveLength(1);
  });
});

describe("Accounts compact bar — shown", () => {
  it("shows the same Total balance as the summary", () => {
    render(<AccountsWorkspace />);
    titleVisible(0);
    const summary = within(screen.getByRole("region", { name: "Summary" }));
    expect(summary.getByRole("button", { name: "Explain total balance" }).textContent).toContain(formatCurrency(TOTAL));
    expect(within(bar()).getByText(formatCurrency(TOTAL))).toBeTruthy();
    expect(within(bar()).getByText("Accounts")).toBeTruthy();
  });

  it("Add Account in the bar opens the same Add dialog as the header", () => {
    render(<AccountsWorkspace />);
    titleVisible(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add Account" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    cleanup();

    render(<AccountsWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the ⋯ menu keeps Refresh and Groups disabled and marked Soon", async () => {
    render(<AccountsWorkspace />);
    titleVisible(0);
    fireEvent.keyDown(within(bar()).getByRole("button", { name: "More actions" }), { key: "Enter" });
    const refresh = await screen.findByRole("menuitem", { name: /Refresh/ });
    const groups = screen.getByRole("menuitem", { name: /Groups/ });
    for (const el of [refresh, groups]) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.textContent).toContain("Soon");
    }
  });

  it("the header's own Refresh and Groups stay disabled", () => {
    render(<AccountsWorkspace />);
    const header = screen.getByRole("heading", { level: 1, name: "Accounts" }).closest("header")!;
    for (const name of [/Refresh/, /Groups/]) {
      expect((within(header).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("Accounts compact bar — page state is never disturbed", () => {
  it("search, type filter and the account list survive the bar appearing and disappearing", () => {
    render(<AccountsWorkspace />);
    const search = screen.getByRole("textbox", { name: "Search accounts" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "wallet" } });
    fireEvent.click(screen.getByRole("radio", { name: /Cash/ }));
    const before = { search: search.value, accounts: screen.getAllByText(/Wallet Cash/).length };

    titleVisible(0);
    titleVisible(0.5);
    titleVisible(1);
    titleVisible(0);

    expect(screen.getByRole("textbox", { name: "Search accounts" })).toBe(search); // same node: not remounted
    expect(search.value).toBe(before.search);
    expect((screen.getByRole("radio", { name: /Cash/ }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText(/Wallet Cash/).length).toBe(before.accounts);
    expect(within(screen.getByRole("region", { name: "My accounts" })).queryByText("Salary Bank")).toBeNull(); // filtered out of the list (it stays selected in the overview panel)
  });

  it("keeps the bar up while its menu is open", async () => {
    render(<AccountsWorkspace />);
    titleVisible(0);
    const more = within(bar()).getByRole("button", { name: "More actions" });
    fireEvent.keyDown(more, { key: "Enter" });
    await screen.findByRole("menuitem", { name: /Refresh/ });
    titleVisible(1);
    expect(barEl().hasAttribute("inert")).toBe(false);
  });
});
