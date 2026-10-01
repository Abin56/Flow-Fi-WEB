// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * Add Expense submit validation: a failed submit never saves, and lands the user on the FIRST invalid field
 * (form order) — scrolled into view and focused — including the required Money given / Money borrowed choice
 * when the expense is assigned to a person.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const addLedgerEntryWithTransaction = vi.fn(async () => {});
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleActions: () => ({ addLedgerEntryWithTransaction }),
}));

const scrollIntoView = vi.fn();
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const accounts = [{ id: "acc1", name: "SBI", type: "cash" }] as unknown as Account[];
const categories = [{ id: "food", name: "Food", type: "expense" }] as unknown as Category[];
const people = [{ id: "amma", name: "AMMA" }] as unknown as Person[];

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
  addLedgerEntryWithTransaction.mockClear();
  scrollIntoView.mockClear();
});

function renderAdd() {
  render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={null}
      expense={null}
      people={people}
      accounts={accounts}
      categories={categories}
      actions={actions as never}
    />,
  );
}

const amountInput = () => document.getElementById("txn-amount") as HTMLInputElement;
const descriptionInput = () => screen.getByPlaceholderText("e.g. Blue Tokai Coffee") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /add expense|save/i });
const fieldWrapper = (field: string) => document.querySelector<HTMLElement>(`[data-field="${field}"]`)!;

async function assignTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = screen
    .getAllByText("No one")
    .map((el) => el.closest<HTMLElement>('[role="combobox"]'))
    .find(Boolean)!;
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name }));
}

describe("Add Expense — first-invalid-field navigation", () => {
  it("empty Description: no transaction, Description focused and scrolled into view", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await user.click(submitButton());

    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(descriptionInput());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(fieldWrapper("description"));
    expect(fieldWrapper("description").dataset.invalid).toBe("true");
  });

  it("Description + direction both missing → Description first; fix it → direction selector next", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await assignTo(user, "AMMA");
    await user.click(submitButton());
    expect(document.activeElement).toBe(descriptionInput());

    await user.type(descriptionInput(), "Groceries");
    await user.click(submitButton());
    const group = screen.getByRole("radiogroup");
    expect(group).toBe(fieldWrapper("personDirection"));
    expect(group.contains(document.activeElement)).toBe(true);
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(group);
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(within(group).getByText("Select Money given or Money borrowed.")).toBeTruthy();
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(addLedgerEntryWithTransaction).not.toHaveBeenCalled();
  });

  it("direction options: none preselected, mutually exclusive, both valid", async () => {
    const user = userEvent.setup();
    renderAdd();
    await assignTo(user, "AMMA");
    const [gave, borrowed] = screen.getAllByRole("radio");
    expect(gave.getAttribute("aria-checked")).toBe("false");
    expect(borrowed.getAttribute("aria-checked")).toBe("false");

    await user.click(gave);
    expect(gave.getAttribute("aria-checked")).toBe("true");
    expect(borrowed.getAttribute("aria-checked")).toBe("false");
    await user.click(borrowed);
    expect(gave.getAttribute("aria-checked")).toBe("false");
    expect(borrowed.getAttribute("aria-checked")).toBe("true");
    // Clicking the selected option again keeps it (radio semantics — no silent deselect).
    await user.click(borrowed);
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
  });

  it("Money given → saves one assigned expense, never a Split", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await user.type(descriptionInput(), "Medicine");
    await assignTo(user, "AMMA");
    await user.click(screen.getByRole("radio", { name: /money i gave/i }));
    await user.click(submitButton());

    await waitFor(() => expect(actions.applyOwesPersonChange).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction).toHaveBeenCalledTimes(1);
    expect(actions.expenseRepository.convertToSplit).not.toHaveBeenCalled();
  });

  it("Money borrowed → valid direction, then requires who paid; never a borrowed-cash receipt into an account", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "500");
    await user.type(descriptionInput(), "Dinner");
    await assignTo(user, "AMMA");
    await user.click(screen.getByRole("radio", { name: /money i borrowed/i }));
    await user.click(submitButton());

    expect(fieldWrapper("personFunding").dataset.invalid).toBe("true");
    expect(fieldWrapper("personFunding").contains(document.activeElement)).toBe(true);
    expect(addLedgerEntryWithTransaction).not.toHaveBeenCalled();
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(actions.expenseRepository.convertToSplit).not.toHaveBeenCalled();
  });

  it("Assign to a person OFF → direction isn't required", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await user.type(descriptionInput(), "Lunch");
    await user.click(submitButton());
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("Add Expense — keyboard", () => {
  it("Enter with missing Description focuses Description, no save", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await user.type(descriptionInput(), "x");
    await user.clear(descriptionInput());
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(descriptionInput());
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });

  it("Enter with missing direction focuses the selector; arrows/Space then pick a direction", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    await user.type(descriptionInput(), "Groceries");
    await assignTo(user, "AMMA");
    descriptionInput().focus();
    await user.keyboard("{Enter}");

    const [gave, borrowed] = screen.getAllByRole("radio");
    expect(document.activeElement).toBe(gave);
    expect(actions.createTransaction).not.toHaveBeenCalled();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(borrowed);
    expect(borrowed.getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(gave.getAttribute("aria-checked")).toBe("true");
    expect(borrowed.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Select Money given or Money borrowed.")).toBeNull();
  });

  it("repeated Enter while invalid creates zero transactions; once valid, exactly one", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "1000");
    for (let i = 0; i < 3; i++) fireEvent.submit(amountInput().form!);
    await user.click(submitButton());
    expect(actions.createTransaction).not.toHaveBeenCalled();

    await user.type(descriptionInput(), "Lunch");
    const form = amountInput().form!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await user.click(submitButton());
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.createTransaction).toHaveBeenCalledTimes(1);
  });
});
