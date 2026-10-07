// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * Add / edit Expense → "Money I Borrowed" → HOW DID YOU BORROW FROM <person>?
 *  - "Money received into my account": a pure borrowing — `recordBorrowedCash` (People "borrowed" entry +
 *    cash-IN leg on the chosen account). Never an expense: no category, no `createTransaction`.
 *  - "<person> paid this expense for me": the expense is saved through `createPersonFundedExpense` (no
 *    account in the payload at all) — an account selected earlier in the form is never sent, so it can't move.
 * The old "I paid from my account" option (an expense that created no debt despite "Money I Borrowed") is gone.
 * The money itself (balances, People, My Spend) is proven in `lib/repositories/person-funded-expense.test.ts`
 * and `lib/repositories/borrowed-cash-flow.test.ts`.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const addLedgerEntryWithTransaction = vi.fn(async () => {});
vi.mock("@/features/people/hooks/use-people-data", () => ({
  usePeopleActions: () => ({ addLedgerEntryWithTransaction }),
}));

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

const accounts = [
  { id: "sbi", name: "SBI", type: "cash" },
  { id: "hdfc", name: "HDFC", type: "bank" },
  { id: "card", name: "Amex", type: "card" },
] as unknown as Account[];
const categories = [{ id: "food", name: "Food", type: "expense" }] as unknown as Category[];
const people = [{ id: "amma", name: "AMMA" }] as unknown as Person[];

function makeActions() {
  return {
    createTransaction: vi.fn(async (input: Record<string, unknown>) => ({ id: "t1", ...input })),
    createTransferPair: vi.fn(async () => {}),
    createPersonFundedExpense: vi.fn(async () => ({})),
    recordBorrowedCash: vi.fn(async () => ({})),
    changeExpenseFunding: vi.fn(async () => {}),
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
});

function renderModal(transaction: Transaction | null = null) {
  render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={transaction ? ({ transaction, account: accounts.find((a) => a.id === transaction.accountId), category: categories[0] } as never) : null}
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
const fundingGroup = () => document.querySelector<HTMLElement>('[data-field="personFunding"]')!;
const paidDirectly = () => within(fundingGroup()).getByRole("radio", { name: /amma paid this expense for me/i });
const receivedCash = () => within(fundingGroup()).getByRole("radio", { name: /money received into my account/i });
const recordButton = () => screen.getByRole("button", { name: /record borrowing/i });

async function assignTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = screen
    .getAllByText("No one")
    .map((el) => el.closest<HTMLElement>('[role="combobox"]'))
    .find(Boolean)!;
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name }));
}

/** SBI is preselected in Add mode (first account) — the exact reported sequence. */
async function borrowedFromAmma(user: ReturnType<typeof userEvent.setup>, description = "Restaurant") {
  renderModal();
  await user.type(amountInput(), "1000");
  if (description) await user.type(descriptionInput(), description);
  await assignTo(user, "AMMA");
  await user.click(screen.getByRole("radio", { name: /money i borrowed/i }));
}

async function pickAccount(user: ReturnType<typeof userEvent.setup>, from: RegExp, to: RegExp) {
  const trigger = screen
    .getAllByRole("combobox")
    .find((el) => from.test(el.textContent ?? ""))!;
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: to }));
}

describe("Add Expense → Money I Borrowed → how did you borrow", () => {
  it("asks HOW DID YOU BORROW FROM AMMA with nothing preselected; the old 'I paid from my account' option is gone", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    expect(screen.getByText("How did you borrow from AMMA?")).toBeTruthy();
    expect(screen.queryByText("How was this paid?")).toBeNull();
    expect(within(fundingGroup()).queryByRole("radio", { name: /i paid from my account/i })).toBeNull();
    expect(paidDirectly().getAttribute("aria-checked")).toBe("false");
    expect(receivedCash().getAttribute("aria-checked")).toBe("false");
    await user.click(submitButton());
    expect(fundingGroup().dataset.invalid).toBe("true");
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(actions.createPersonFundedExpense).not.toHaveBeenCalled();
    expect(actions.recordBorrowedCash).not.toHaveBeenCalled();
  });

  it("1. borrow ₹1,000 into SBI → one recordBorrowedCash (Received into SBI); no expense, no category", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user, "");
    await user.click(receivedCash());

    expect(screen.getByText("Received into *")).toBeTruthy();
    expect(screen.queryByText("Paid from")).toBeNull();
    expect(screen.queryByText("Category *")).toBeNull();
    expect(screen.getByTestId("borrowed-cash-helper").textContent).toMatch(
      /1,000.* will be added to SBI\. You will owe AMMA .*1,000.*\. This is borrowing, not income or spending\./,
    );

    await user.click(recordButton());
    await waitFor(() => expect(actions.recordBorrowedCash).toHaveBeenCalledTimes(1));
    const [person, params] = actions.recordBorrowedCash.mock.calls[0] as unknown as [Person, Record<string, unknown>];
    expect(person.id).toBe("amma");
    expect(params).toMatchObject({ amount: 1000, accountId: "sbi" });
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(actions.createPersonFundedExpense).not.toHaveBeenCalled();
    expect(actions.editTransaction).not.toHaveBeenCalled();
  });

  it("2. borrow ₹1,000 into another account (HDFC) → received into HDFC exactly", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user, "Loan from Amma");
    await user.click(receivedCash());
    await pickAccount(user, /SBI/, /HDFC/);
    await user.click(recordButton());
    await waitFor(() => expect(actions.recordBorrowedCash).toHaveBeenCalledTimes(1));
    expect((actions.recordBorrowedCash.mock.calls[0] as unknown[])[1]).toMatchObject({ amount: 1000, accountId: "hdfc", note: "Loan from Amma" });
  });

  it("borrowed cash can't be received into a credit card", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    await user.click(receivedCash());
    await user.click(screen.getAllByRole("combobox").find((el) => /SBI/.test(el.textContent ?? ""))!);
    expect(await screen.findByRole("option", { name: /HDFC/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Amex/ })).toBeNull();
  });

  it("3. AMMA paid this expense for me → Paid by AMMA, account Not used, saved with NO account", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    await user.click(paidDirectly());

    expect(screen.getByTestId("paid-by-person").textContent).toMatch(/Paid by\s*AMMA\s*Your account\s*Not used\s*No money moved through your accounts\./);
    expect(screen.queryByText("Account *")).toBeNull();
    expect(screen.queryByText("Received into *")).toBeNull();
    expect(screen.getByTestId("person-funded-helper").textContent).toMatch(
      /1,000.* counts as your expense\. You will owe AMMA .*1,000.*\. Your account balances will not change\./,
    );

    await user.click(submitButton());
    await waitFor(() => expect(actions.createPersonFundedExpense).toHaveBeenCalledTimes(1));
    const [person, params] = actions.createPersonFundedExpense.mock.calls[0] as unknown as [Person, Record<string, unknown>];
    expect(person.id).toBe("amma");
    expect(params).toMatchObject({ amount: 1000, categoryId: "food", description: "Restaurant" });
    expect(params).not.toHaveProperty("accountId");
    expect(actions.createTransaction).not.toHaveBeenCalled();
    expect(actions.recordBorrowedCash).not.toHaveBeenCalled();
    expect(addLedgerEntryWithTransaction).not.toHaveBeenCalled();
  });

  it("switching cash ↔ paid-for-me before Save: the last choice alone is saved", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    await user.click(receivedCash());
    await user.click(paidDirectly());
    await user.click(receivedCash());
    await user.click(paidDirectly());
    await user.click(submitButton());
    await waitFor(() => expect(actions.createPersonFundedExpense).toHaveBeenCalledTimes(1));
    expect(actions.recordBorrowedCash).not.toHaveBeenCalled();
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });

  it("20. duplicate submit: a double Ctrl+Enter records the borrowing once", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    await user.click(receivedCash());
    fireEvent.keyDown(descriptionInput(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(descriptionInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(actions.recordBorrowedCash).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.recordBorrowedCash).toHaveBeenCalledTimes(1);
  });

  it("keyboard: Enter lands on the borrowing choice; arrows pick; Ctrl+Enter saves once", async () => {
    const user = userEvent.setup();
    await borrowedFromAmma(user);
    descriptionInput().focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(receivedCash());
    await user.keyboard("{ArrowRight}");
    expect(paidDirectly().getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(receivedCash().getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{ArrowRight}");
    fireEvent.keyDown(descriptionInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(actions.createPersonFundedExpense).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.createPersonFundedExpense).toHaveBeenCalledTimes(1);
  });
});

const savedExpense = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: "tx1",
    type: "expense",
    amount: 1000,
    dateTime: new Date("2026-09-12T10:00:00"),
    accountId: "sbi",
    categoryId: "food",
    description: "Restaurant",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-12T10:00:00"),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...over,
  }) as Transaction;

describe("Edit Expense — switching who paid", () => {
  it("6/9. SBI-paid → AMMA paid directly: one atomic funding change, no account in the edits", async () => {
    const user = userEvent.setup();
    renderModal(savedExpense());
    await assignTo(user, "AMMA");
    await user.click(screen.getByRole("button", { name: /money i borrowed/i }));
    expect(paidDirectly().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("paid-by-person")).toBeTruthy();
    await user.click(submitButton());

    await waitFor(() => expect(actions.changeExpenseFunding).toHaveBeenCalledTimes(1));
    const [tx, to, edits] = actions.changeExpenseFunding.mock.calls[0] as unknown as [Transaction, unknown, Record<string, unknown>];
    expect(tx.id).toBe("tx1");
    expect(to).toEqual({ kind: "person", personId: "amma" });
    expect(edits).not.toHaveProperty("accountId");
    expect(actions.applyOwesPersonChange).not.toHaveBeenCalled();
    expect(actions.editTransaction).not.toHaveBeenCalled();
  });

  it("edit offers only \"paid this expense for me\" — an existing expense never turns into a cash borrowing", async () => {
    renderModal(savedExpense({ accountId: "", fundedByPersonId: "amma", linkedPersonId: "amma" }));
    expect(paidDirectly().getAttribute("aria-checked")).toBe("true");
    expect(within(fundingGroup()).queryByRole("radio", { name: /money received into my account/i })).toBeNull();
  });

  it("7/9. AMMA paid this expense → paid from SBI: un-pick Money I Borrowed, requires an account, then moves to it", async () => {
    const user = userEvent.setup();
    renderModal(savedExpense({ accountId: "", fundedByPersonId: "amma", linkedPersonId: "amma" }));
    expect(paidDirectly().getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: /money i borrowed/i }));
    await user.click(submitButton());
    expect(actions.changeExpenseFunding).not.toHaveBeenCalled(); // no account picked yet

    const trigger = screen.getByText("Select account").closest<HTMLElement>('[role="combobox"]')!;
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /SBI/ }));
    await user.click(submitButton());
    await waitFor(() => expect(actions.changeExpenseFunding).toHaveBeenCalledTimes(1));
    expect((actions.changeExpenseFunding.mock.calls[0] as unknown[])[1]).toEqual({ kind: "account", accountId: "sbi" });
    // Then the usual person assignment — AMMA stays a plain reference (nothing owed by this expense).
    expect(actions.applyOwesPersonChange).toHaveBeenCalledWith(
      expect.objectContaining({ target: { personId: "amma", personName: "AMMA", owesPersonToggle: false } }),
    );
  });

  it("an existing account expense edited without touching who paid keeps the existing path", async () => {
    const user = userEvent.setup();
    renderModal(savedExpense());
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "Lunch");
    await user.click(submitButton());
    await waitFor(() => expect(actions.applyOwesPersonChange).toHaveBeenCalledTimes(1));
    expect(actions.changeExpenseFunding).not.toHaveBeenCalled();
  });
});
