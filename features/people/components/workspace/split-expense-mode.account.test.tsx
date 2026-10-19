// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import { SplitExpenseMode } from "./split-expense-mode";

/**
 * People Ledger → Split expense: the paying account is a deliberate choice. It never starts as "the first account
 * Firestore returned"; it is empty unless the form was opened from an explicit account context, and Save refuses
 * without it. Split calculations are the engine's and are not exercised here.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
const createSplitTransaction = vi.fn(async () => ({}));
vi.mock("@/features/transactions/hooks/use-transactions-data", () => ({ useTransactionActions: () => ({ createSplitTransaction }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);
beforeEach(() => createSplitTransaction.mockClear());

const cash = { id: "cash", name: "Wallet Cash", type: "cash", currentBalance: 5000, deletedAt: null };
const bank = { id: "bank", name: "Main Bank", type: "bank", bankId: null, currentBalance: 100000, deletedAt: null };
const card = { id: "card", name: "Visa Card", type: "card", currentBalance: 0, deletedAt: null };
const ORDERINGS = [
  [cash, bank, card],
  [cash, card, bank],
  [bank, cash, card],
  [bank, card, cash],
  [card, cash, bank],
  [card, bank, cash],
];
const names = (o: object[]) => (o as { id: string }[]).map((a) => a.id).join(" > ");
const categories = [{ id: "food", name: "Food", type: "expense", deletedAt: null }] as unknown as Category[];
const person = { id: "priya", name: "Priya" } as unknown as Person;

function renderSplit(order: object[], props: Partial<Parameters<typeof SplitExpenseMode>[0]> = {}) {
  return render(<SplitExpenseMode person={person} accounts={order as unknown as Account[]} categories={categories} people={[]} onBack={() => {}} onDone={() => {}} {...props} />);
}
const accountTrigger = () => screen.getAllByRole("combobox").find((c) => /Select account|Wallet Cash|Main Bank|Visa Card/.test(c.textContent ?? ""))!;

describe("Split expense — no silent account", () => {
  it.each(ORDERINGS.map((o) => [names(o), o] as const))("starts empty and refuses to save until an account is chosen (%s)", async (_n, order) => {
    const user = userEvent.setup();
    renderSplit(order);
    expect(accountTrigger().textContent).toMatch(/Select account/i);

    await user.type(screen.getByPlaceholderText(/e\.g\./i), "Dinner");
    await user.type(document.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[inputmode="numeric"]')!, "900");
    await user.click(screen.getByRole("button", { name: /save split/i }));
    expect(createSplitTransaction).not.toHaveBeenCalled();
    expect(screen.getByText("Select the account this expense was paid from.")).toBeTruthy();

    await user.click(accountTrigger());
    await user.click(await screen.findByRole("option", { name: /Main Bank/ }));
    await user.click(screen.getByRole("button", { name: /save split/i }));
    await waitFor(() => expect(createSplitTransaction).toHaveBeenCalledTimes(1));
    expect(createSplitTransaction).toHaveBeenCalledWith(expect.objectContaining({ accountId: "bank", totalAmount: 900 }));
  });

  it.each(ORDERINGS.map((o) => [names(o), o] as const))("an explicit account context pre-fills exactly that account (%s)", (_n, order) => {
    renderSplit(order, { initialAccountId: "cash" });
    expect(accountTrigger().textContent).toMatch(/Wallet Cash/);
  });

  it("a context account that isn't in the list is ignored — never replaced by another account", () => {
    renderSplit([cash, bank, card], { initialAccountId: "gone" });
    expect(accountTrigger().textContent).toMatch(/Select account/i);
  });
});
