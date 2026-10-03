// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * A transaction opened from a People ledger: "Back to <name>" is shown (and only then), it writes nothing,
 * and the modal only reports "closed" (which the workspace turns into the return navigation) after a
 * SUCCESSFUL Save or Delete — a failed write keeps the editor open. Delete goes through the linked-effect
 * `actions.deleteTransaction(transaction, expense)`, never a plain soft delete.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/people/hooks/use-people-data", () => ({ usePeopleActions: () => ({ addLedgerEntryWithTransaction: vi.fn() }) }));

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

const accounts = [{ id: "sbi", name: "SBI", type: "bank" }] as unknown as Account[];
const categories = [{ id: "edu", name: "Education", type: "expense" }] as unknown as Category[];
const people = [{ id: "amma", name: "AMMA" }] as unknown as Person[];

const exam = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: "txn-exam",
    type: "expense",
    amount: 1000,
    dateTime: new Date("2026-09-20T10:00:00"),
    accountId: "sbi",
    categoryId: "edu",
    description: "Exam",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: "amma",
    owesPersonToggle: true,
    createdAt: new Date("2026-09-20T10:00:00"),
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

function makeActions() {
  return {
    createTransaction: vi.fn(async () => ({})),
    createTransferPair: vi.fn(async () => {}),
    changeExpenseFunding: vi.fn(async () => {}),
    applyOwesPersonChange: vi.fn(async () => {}),
    editTransaction: vi.fn(async () => {}),
    deleteTransaction: vi.fn(async () => {}),
    expenseRepository: { convertToSplit: vi.fn(async () => {}), editExpense: vi.fn(async () => {}) },
    installmentRepositoryFor: vi.fn(),
  };
}
let actions: ReturnType<typeof makeActions>;
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
beforeEach(() => {
  actions = makeActions();
  onOpenChange = vi.fn<(open: boolean) => void>();
});

const assignedExpense = { id: "exp-1", transactionId: "txn-exam", participants: [{ personId: "amma", name: "AMMA", isMe: false, share: 1000 }] };

function renderDetails(returnLabel: string | null, transaction = exam()) {
  render(
    <TransactionDetailsModal
      open
      onOpenChange={onOpenChange}
      row={{ transaction, account: accounts[0], category: categories[0] } as never}
      expense={assignedExpense as never}
      people={people}
      accounts={accounts}
      categories={categories}
      actions={actions as never}
      returnLabel={returnLabel}
    />,
  );
}

const descriptionInput = () => screen.getByPlaceholderText("e.g. Blue Tokai Coffee") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /save/i });
const noWrites = () => {
  for (const fn of [actions.applyOwesPersonChange, actions.editTransaction, actions.deleteTransaction, actions.changeExpenseFunding, actions.createTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
};

describe("People-origin transaction details", () => {
  it("shows a contextual 'Back to AMMA' — and it writes nothing", async () => {
    const user = userEvent.setup();
    renderDetails("AMMA");
    await user.click(screen.getByRole("button", { name: "Back to AMMA" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    noWrites();
  });

  it("Transactions-origin: no People back control (existing behaviour)", () => {
    renderDetails(null);
    expect(screen.queryByRole("button", { name: /back to/i })).toBeNull();
  });

  it("the edit form opens with the transaction's existing values", () => {
    renderDetails("AMMA");
    expect(descriptionInput().value).toBe("Exam");
    expect((document.getElementById("txn-amount") as HTMLInputElement).value).toBe("1000");
    expect(screen.getAllByText("AMMA").length).toBeGreaterThan(0);
  });

  it("Cancel writes nothing and closes (→ the workspace returns to the ledger)", async () => {
    const user = userEvent.setup();
    renderDetails("AMMA");
    await user.type(descriptionInput(), " edited");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    noWrites();
  });

  it("Save changes: the description edit goes through the canonical person path, then closes", async () => {
    const user = userEvent.setup();
    renderDetails("AMMA");
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "KSEB Bill");
    await user.click(saveButton());
    await waitFor(() => expect(actions.applyOwesPersonChange).toHaveBeenCalledTimes(1));
    const call = (actions.applyOwesPersonChange.mock.calls[0] as unknown[])[0] as { target: { personId: string }; transactionEdits: { description: string; amount: number } };
    expect(call.target.personId).toBe("amma");
    expect(call.transactionEdits).toMatchObject({ description: "KSEB Bill", amount: 1000 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("a failed Save keeps the editor open — never navigates back over a failed write", async () => {
    const user = userEvent.setup();
    actions.applyOwesPersonChange.mockRejectedValueOnce(new Error("offline"));
    renderDetails("AMMA");
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "KSEB Bill");
    await user.click(saveButton());
    await waitFor(() => expect(actions.applyOwesPersonChange).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 350));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(descriptionInput().value).toBe("KSEB Bill");
  });

  it("rapid double Save applies the edit once", async () => {
    const user = userEvent.setup();
    renderDetails("AMMA");
    await user.clear(descriptionInput());
    await user.type(descriptionInput(), "KSEB Bill");
    await user.dblClick(saveButton());
    await waitFor(() => expect(actions.applyOwesPersonChange).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.applyOwesPersonChange).toHaveBeenCalledTimes(1);
  });

  it("Delete uses the linked-effect deletion (transaction + its Expense), then closes", async () => {
    const user = userEvent.setup();
    renderDetails("AMMA");
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete this transaction/i });
    await user.click(within(dialog).getByRole("button", { name: /^delete transaction$/i }));
    await waitFor(() => expect(actions.deleteTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: "txn-exam" }), assignedExpense));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("a failed Delete keeps the editor open", async () => {
    const user = userEvent.setup();
    actions.deleteTransaction.mockRejectedValueOnce(new Error("offline"));
    renderDetails("AMMA");
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete this transaction/i });
    await user.click(within(dialog).getByRole("button", { name: /^delete transaction$/i }));
    await waitFor(() => expect(actions.deleteTransaction).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
