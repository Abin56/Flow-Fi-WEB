// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceBreakdownSheet, type BalanceScope } from "./balance-breakdown-sheet";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";

/**
 * The sheet shows exactly the balance the Accounts screen shows (stored `currentBalance`), explains it from the
 * records, and is honest when the records don't add up. Display only.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const state: { accounts: Account[]; cards: { accountId: string }[]; transactions: Transaction[] } = { accounts: [], cards: [], transactions: [] };
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: state.accounts, isLoading: false, isError: false }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: state.cards, isLoading: false }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: state.transactions, isLoading: false, isError: false }) }));

afterEach(cleanup);

const acct = (id: string, name: string, type: Account["type"], opening: number, current: number): Account =>
  ({ id, name, type, openingBalance: opening, currentBalance: current, deletedAt: null }) as Account;

let n = 0;
const tx = (accountId: string, type: "income" | "expense", amount: number, patch: Partial<Transaction> = {}): Transaction =>
  ({
    id: `t${++n}`, type, amount, accountId, description: `${type} ${n}`, dateTime: new Date(2026, 9, 1 + n), transferId: null,
    excludeFromCalculations: false, loanId: null, emiId: null, paymentAllocationType: null, isPersonLedgerMovement: false,
    fundedByPersonId: null, transferFeeForId: null, deletedAt: null, ...patch,
  }) as Transaction;

function open(scope: BalanceScope) {
  render(<BalanceBreakdownSheet scope={scope} onClose={() => {}} />);
}

describe("BalanceBreakdownSheet", () => {
  it("total: matches the Accounts total (cards excluded) and splits holding vs below-zero accounts", () => {
    state.accounts = [acct("a", "HDFC", "bank", 1000, 1500), acct("b", "Wallet", "wallet", 0, -200.25), acct("card", "Visa", "card", 0, -9000)];
    state.cards = [{ accountId: "card" }];
    state.transactions = [tx("a", "income", 500), tx("b", "expense", 200.25), tx("card", "expense", 9000)];
    open({ kind: "total" });
    // 1500 − 200.25 = 1299.75; the card's −9,000 is not part of it.
    expect(screen.getAllByText("₹1,299.75").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Visa/)).toBeNull();
    expect(screen.getByText("Accounts with money")).toBeTruthy();
    expect(screen.getByText("Accounts below zero")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull(); // fully explained → no warning
  });

  it("account: shows starting + added − deducted = current, and filters money in / out", () => {
    state.accounts = [acct("a", "HDFC", "bank", 1000, 1500)];
    state.cards = [];
    state.transactions = [tx("a", "income", 700, { description: "Salary" }), tx("a", "expense", 200, { description: "Rent" })];
    open({ kind: "account", accountId: "a" });
    const calc = screen.getByLabelText("How this is calculated");
    expect(within(calc).getByText("Starting balance")).toBeTruthy();
    expect(within(calc).getByText("+ ₹700.00")).toBeTruthy();
    expect(within(calc).getByText("− ₹200.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Money out" }));
    expect(screen.queryByText("Salary")).toBeNull();
    expect(screen.getByText("Rent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Money in" }));
    expect(screen.getByText("Salary")).toBeTruthy();
  });

  it("links a row to the existing transaction detail without exposing the raw id as text", () => {
    state.accounts = [acct("a", "HDFC", "bank", 0, 50)];
    state.cards = [];
    const t = tx("a", "income", 50, { description: "Refund" });
    state.transactions = [t];
    open({ kind: "account", accountId: "a" });
    const link = screen.getByText("Refund").closest("a");
    expect(link?.getAttribute("href")).toBe(`/transactions?transaction=${t.id}`);
    expect(screen.queryByText(t.id)).toBeNull();
  });

  it("says so honestly when the records don't explain the balance", () => {
    state.accounts = [acct("a", "HDFC", "bank", 0, 175.5)];
    state.cards = [];
    state.transactions = [tx("a", "income", 100)];
    open({ kind: "account", accountId: "a" });
    expect(screen.getByRole("status").textContent).toContain("₹75.50");
  });

  it("empty history: only the starting balance", () => {
    state.accounts = [acct("a", "Cash", "cash", 300, 300)];
    state.cards = [];
    state.transactions = [];
    open({ kind: "account", accountId: "a" });
    expect(screen.getByText(/just the starting balance/)).toBeTruthy();
  });

  it("pages a large history instead of rendering it all", () => {
    state.accounts = [acct("a", "HDFC", "bank", 0, 1000)];
    state.cards = [];
    state.transactions = Array.from({ length: 100 }, () => tx("a", "income", 10));
    open({ kind: "account", accountId: "a" });
    expect(screen.getAllByRole("link")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: /more/ }));
    expect(screen.getAllByRole("link")).toHaveLength(60);
  });
});
