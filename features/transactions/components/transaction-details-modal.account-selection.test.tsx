// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * D-02: Add Transaction never starts with an account taken from the order the accounts arrive in. Every
 * ordering of Cash / Bank / Credit Card behaves the same; saving without a deliberate choice is refused.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/people/hooks/use-people-data", () => ({ usePeopleActions: () => ({ addLedgerEntryWithTransaction: vi.fn(async () => {}) }) }));

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

const cash = { id: "cash", name: "Wallet Cash", type: "cash", currentBalance: 5000 };
const bank = { id: "bank", name: "Main Bank", type: "bank", bankId: null, currentBalance: 100000 };
const card = { id: "card", name: "Visa Card", type: "card", currentBalance: 0 };
const ORDERINGS = [
  [cash, bank, card],
  [cash, card, bank],
  [bank, cash, card],
  [bank, card, cash],
  [card, cash, bank],
  [card, bank, cash],
];
const categories = [
  { id: "food", name: "Food", type: "expense", deletedAt: null },
  { id: "salary", name: "Salary", type: "income", deletedAt: null },
] as unknown as Category[];

function makeActions() {
  return {
    createTransaction: vi.fn(async (input: Record<string, unknown>) => ({ id: "t1", ...input })),
    createTransferPair: vi.fn(async () => {}),
    applyOwesPersonChange: vi.fn(async () => {}),
    editTransaction: vi.fn(async () => {}),
    deleteTransaction: vi.fn(async () => {}),
    expenseRepository: { convertToSplit: vi.fn(async () => {}), editExpense: vi.fn(async () => {}) },
  };
}
let actions: ReturnType<typeof makeActions>;
beforeEach(() => {
  actions = makeActions();
});

function renderAdd(order: object[], props: Partial<Parameters<typeof TransactionDetailsModal>[0]> = {}) {
  return render(
    <TransactionDetailsModal open onOpenChange={() => {}} row={null} expense={null} people={[]} accounts={order as unknown as Account[]} categories={categories} actions={actions as never} {...props} />,
  );
}
const amountInput = () => document.getElementById("txn-amount") as HTMLInputElement;
const descriptionInput = () => screen.getByPlaceholderText("e.g. Blue Tokai Coffee") as HTMLInputElement;
const accountTrigger = () => screen.getAllByRole("combobox").find((c) => /Select account|Wallet Cash|Main Bank|Visa Card/.test(c.textContent ?? ""))!;
const names = (o: object[]) => (o as { id: string }[]).map((a) => a.id).join(" > ");

describe("Add Expense — account is a deliberate choice, whatever the Firestore order", () => {
  it.each(ORDERINGS.map((o) => [names(o), o] as const))("starts empty and refuses to save until an account is chosen (%s)", async (_n, order) => {
    const user = userEvent.setup();
    renderAdd(order);
    expect(accountTrigger().textContent).toMatch(/Select account/i);

    await user.type(amountInput(), "250");
    await user.type(descriptionInput(), "Coffee");
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-field="account"]')?.getAttribute("data-invalid")).toBe("true");
    expect(screen.getAllByText("Select an account.").length).toBeGreaterThan(0);

    await user.click(accountTrigger());
    await user.click(await screen.findByRole("option", { name: /Main Bank/ }));
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    await vi.waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ accountId: "bank", amount: 250 }));
  });

  it.each(ORDERINGS.map((o) => [names(o), o] as const))("an explicit account context pre-fills exactly that account (%s)", (_n, order) => {
    renderAdd(order, { initialAccountId: "cash" });
    expect(accountTrigger().textContent).toMatch(/Wallet Cash/);
  });
});

describe("Add Income — eligibility rules stay intact", () => {
  it.each(ORDERINGS.map((o) => [names(o), o] as const))("starts empty and offers no credit card (%s)", async (_n, order) => {
    const user = userEvent.setup();
    renderAdd(order, { defaultKind: "income" });
    expect(accountTrigger().textContent).toMatch(/Select account/i);
    await user.click(accountTrigger());
    expect(screen.queryByRole("option", { name: /Visa Card/ })).toBeNull();
    expect(await screen.findByRole("option", { name: /Main Bank/ })).toBeTruthy();
  });

  it("a card context is not carried into income; switching Expense→Income clears a card instead of substituting another account", async () => {
    const user = userEvent.setup();
    renderAdd([card, bank, cash], { defaultKind: "income", initialAccountId: "card" });
    expect(accountTrigger().textContent).toMatch(/Select account/i);
    cleanup();

    renderAdd([cash, bank, card], { initialAccountId: "card" });
    expect(accountTrigger().textContent).toMatch(/Visa Card/);
    await user.click(screen.getByRole("button", { name: /^income$/i }));
    expect(accountTrigger().textContent).toMatch(/Select account/i);
  });
});
