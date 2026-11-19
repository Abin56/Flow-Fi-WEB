// @vitest-environment jsdom
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import { TransactionDetailsModal } from "./transaction-details-modal";

/** Smart description ⇄ category suggestions: display-only chips on the Add form; saving is unchanged. */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={String(href)} {...rest}>
        {children}
      </a>
    );
  }),
}));
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

const accounts = [{ id: "sbi", name: "SBI", type: "bank", bankId: null, currentBalance: 100000 }] as unknown as Account[];
const categories = [
  { id: "food", name: "Food", type: "expense", iconKey: "restaurant", isActive: true },
  { id: "transport", name: "Transport", type: "expense", iconKey: "car", isActive: true },
  { id: "salary", name: "Salary", type: "income", iconKey: "work", isActive: true },
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

function renderAdd(props: Partial<Parameters<typeof TransactionDetailsModal>[0]> = {}) {
  return render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={null}
      expense={null}
      people={[] as Person[]}
      accounts={accounts}
      categories={categories}
      actions={actions as never}
      initialAccountId="sbi"
      {...props}
    />,
  );
}

const amountInput = () => document.getElementById("txn-amount") as HTMLInputElement;
const descriptionInput = () => screen.getByPlaceholderText(/e\.g\. (Blue Tokai Coffee|Salary, Freelance payment)/);
const categorySuggestion = () => screen.queryByTestId("category-suggestion");
const descriptionSuggestion = () => screen.queryByTestId("description-suggestion");
const categoryTrigger = () => screen.getAllByRole("combobox").find((c) => /Optional|Food|Transport|Salary/.test(c.textContent ?? ""))!;
async function pickCategory(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(categoryTrigger());
  await user.click(await screen.findByRole("option", { name }));
}

describe("category suggestion from the description", () => {
  it("1–2. Coffee and Mandi suggest Food", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Coffee");
    expect(categorySuggestion()?.textContent).toMatch(/Food/);
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "Mandi");
    expect(categorySuggestion()?.textContent).toMatch(/Food/);
  });

  it("3. Apply updates the category selector, the chip goes away, and the save carries it", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "120");
    await user.type(descriptionInput(), "Coffee");
    await user.click(screen.getByRole("button", { name: /use food as the category/i }));
    expect(categorySuggestion()).toBeNull();
    expect(categoryTrigger().textContent).toMatch(/Food/);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ type: "expense", amount: 120, description: "Coffee", categoryId: "food" });
  });

  it("4. Dismiss hides it for good; the category stays manual and empty; saving is still uncategorized", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "120");
    await user.type(descriptionInput(), "Coffee");
    await user.click(screen.getByRole("button", { name: /dismiss suggested category/i }));
    expect(categorySuggestion()).toBeNull();
    await user.type(descriptionInput(), " beans"); // typing on does not bring it back
    expect(categorySuggestion()).toBeNull();
    expect(categoryTrigger().textContent).toMatch(/Optional/);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ description: "Coffee beans", categoryId: "" });
  });

  it("ambiguous or unknown text suggests nothing, and no category is ever pre-selected", async () => {
    const user = userEvent.setup();
    renderAdd();
    expect(categoryTrigger().textContent).toMatch(/Optional/);
    await user.type(descriptionInput(), "Birthday gift");
    expect(categorySuggestion()).toBeNull();
  });

  it("7. a manually chosen category is never second-guessed", async () => {
    const user = userEvent.setup();
    renderAdd();
    await pickCategory(user, /Transport/);
    await user.type(descriptionInput(), "Coffee");
    expect(categorySuggestion()).toBeNull();
    expect(categoryTrigger().textContent).toMatch(/Transport/);
  });

  it("8. Income vs Expense: income never gets an expense category; switching kind re-evaluates", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Coffee");
    expect(categorySuggestion()?.textContent).toMatch(/Food/);
    await user.click(screen.getByRole("button", { name: /^income/i }));
    expect(categorySuggestion()).toBeNull();
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "Salary");
    expect(categorySuggestion()?.textContent).toMatch(/Salary/);
    await user.click(screen.getByRole("button", { name: /^expense/i }));
    expect(categorySuggestion()).toBeNull();
  });
});

describe("description suggestion from the category", () => {
  it("5. Food with an empty description offers the name; Apply fills an editable field", async () => {
    const user = userEvent.setup();
    renderAdd();
    await pickCategory(user, /Food/);
    expect(descriptionSuggestion()?.textContent).toMatch(/Food/);
    await user.click(screen.getByRole("button", { name: /use food as the description/i }));
    expect(descriptionInput()).toHaveProperty("value", "Food");
    expect(descriptionSuggestion()).toBeNull();
    await user.type(descriptionInput(), " court"); // editable
    expect(descriptionInput()).toHaveProperty("value", "Food court");
  });

  it("6. a custom description is never overwritten or second-guessed by selecting a category", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Birthday gift");
    await pickCategory(user, /Food/);
    expect(descriptionSuggestion()).toBeNull();
    expect(descriptionInput()).toHaveProperty("value", "Birthday gift");
  });

  it("the description chip can be dismissed, and a category-only save still works", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "80");
    await pickCategory(user, /Food/);
    await user.click(screen.getByRole("button", { name: /dismiss suggested description/i }));
    expect(descriptionSuggestion()).toBeNull();
    // (focus was on the removed chip button, so use the Save button rather than a keyboard shortcut)
    await user.click(screen.getByRole("button", { name: /add expense|save/i }));
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ description: "Food", categoryId: "food" });
  });
});

describe("typing autocomplete under Description", () => {
  const past = [
    { id: "p1", description: "Mandi Kozhikode", type: "expense", amount: 300, dateTime: new Date("2026-11-01"), accountId: "sbi" },
  ] as never;
  const list = () => screen.queryByTestId("description-autocomplete");

  it("typing shows rows; clicking one fills the field, closes the list, and stays editable", async () => {
    const user = userEvent.setup();
    renderAdd({ existingTransactions: past });
    await user.type(descriptionInput(), "Man");
    expect(list()?.textContent).toMatch(/Mandi Kozhikode/);
    await user.click(screen.getByRole("option", { name: /Mandi Kozhikode/ }));
    expect(descriptionInput()).toHaveProperty("value", "Mandi Kozhikode");
    expect(list()).toBeNull();
    await user.type(descriptionInput(), " 2");
    expect(descriptionInput()).toHaveProperty("value", "Mandi Kozhikode 2");
  });

  it("Tab accepts the ready completion; the next Tab moves on", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Foo");
    await user.tab();
    expect(descriptionInput()).toHaveProperty("value", "Food");
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(descriptionInput());
    await user.tab();
    expect(document.activeElement).not.toBe(descriptionInput());
  });

  it("a plain Enter never picks a row (it keeps its normal job); Enter after arrowing does", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Foo");
    await user.keyboard("{Enter}");
    expect(descriptionInput()).toHaveProperty("value", "Foo");
    await user.click(descriptionInput());
    await user.type(descriptionInput(), "d{ArrowDown}");
    // exact "Food" is complete → nothing to suggest, so no list and nothing replaced
    expect(descriptionInput()).toHaveProperty("value", "Food");
  });

  it("ArrowDown then Enter accepts the highlighted row", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Co");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(descriptionInput().getAttribute("value") ?? (descriptionInput() as HTMLInputElement).value).toMatch(/^Co./);
    expect(list()).toBeNull();
  });

  it("Escape closes the list without closing the form; typing freely is never replaced", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(descriptionInput(), "Foo");
    expect(list()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(list()).toBeNull();
    expect(descriptionInput()).toBeTruthy();
    await user.type(descriptionInput(), "tball");
    expect(descriptionInput()).toHaveProperty("value", "Football");
  });

  it("accepting a completion saves the same payload as typing it (saving is untouched)", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "90");
    await user.type(descriptionInput(), "Foo");
    await user.tab();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(actions.createTransaction).toHaveBeenCalledTimes(1));
    expect(actions.createTransaction.mock.calls[0][0]).toMatchObject({ type: "expense", amount: 90, description: "Food" });
  });
});

describe("existing validation is unchanged", () => {
  it("9. neither field → still refused with the same message", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(amountInput(), "80");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await screen.findAllByText("Enter a description or select a category.")).length).toBeGreaterThan(0);
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });
});
