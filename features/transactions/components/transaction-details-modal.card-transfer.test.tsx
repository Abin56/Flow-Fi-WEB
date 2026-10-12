// @vitest-environment jsdom
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * Add Transaction → Transfer to my own account (Credit Card → bank via a payment app): the preview shows the
 * exact effect, the fee is validated, and Save sends ONE atomic `createTransferPair` carrying the fee —
 * never a second, unrelated transaction. A saved leg shows its linked records.
 */

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

const accounts = [
  { id: "hdfc-card", name: "HDFC Credit Card", type: "card" },
  { id: "sbi", name: "SBI Savings", type: "bank", bankId: null },
] as unknown as Account[];
const categories = [
  { id: "food", name: "Food", type: "expense", deletedAt: null },
  { id: "bills", name: "Bills & Utilities", type: "expense", deletedAt: null },
  { id: "transfer", name: "Transfer", type: "both", deletedAt: null },
  { id: "salary", name: "Salary", type: "income", deletedAt: null },
] as unknown as Category[];

function makeActions() {
  return {
    createTransaction: vi.fn(async (input: Record<string, unknown>) => ({ id: "t1", ...input })),
    createTransferPair: vi.fn(async (_input: Record<string, unknown>) => {}),
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

function renderTransfer(props: Partial<Parameters<typeof TransactionDetailsModal>[0]> = {}) {
  return render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={null}
      expense={null}
      people={[]}
      accounts={accounts}
      categories={categories}
      actions={actions as never}
      defaultKind="transfer"
      initialDestinationAccountId="sbi"
      cardAvailableCredit={new Map([["hdfc-card", 50_000]])}
      {...props}
    />,
  );
}

const amountInput = () => document.getElementById("txn-amount") as HTMLInputElement;

describe("Add Transaction → Transfer to my account", () => {
  it("Transfer is offered from plain Add Expense too", () => {
    renderTransfer({ defaultKind: "expense", initialDestinationAccountId: undefined });
    const modes = within(screen.getByRole("group", { name: "Transaction type" }));
    expect(modes.getByRole("button", { name: /transfer/i })).toBeTruthy();
  });

  it("A. no fee: previews card dues +20,000 / bank +20,000, and saves one linked pair with no fee", async () => {
    const user = userEvent.setup();
    renderTransfer();
    await user.type(amountInput(), "20000");
    const preview = within(screen.getByTestId("transfer-preview"));
    expect(preview.getByText("HDFC Credit Card · added to card dues")).toBeTruthy();
    expect(preview.getAllByText("+₹20,000.00")).toHaveLength(2); // card dues and bank receipt
    expect(preview.getByText("SBI Savings · received")).toBeTruthy();
    expect(preview.getByText(/Net Worth doesn't change/)).toBeTruthy();
    expect(preview.getByText("₹30,000.00")).toBeTruthy(); // available credit after

    await user.click(screen.getByRole("button", { name: /add transfer/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20_000, sourceAccountId: "hdfc-card", destinationAccountId: "sbi", categoryId: "transfer", fee: null }),
    );
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });

  it("B. fee added to the card + payment app: card charged 20,400; one atomic save carries the fee", async () => {
    const user = userEvent.setup();
    renderTransfer();
    await user.type(amountInput(), "20000");
    await user.type(screen.getByRole("textbox", { name: "Transfer fee" }), "400");
    await user.type(screen.getByRole("textbox", { name: "Payment app" }), "CRED");
    expect(screen.getByRole("radio", { name: "Added to card" }).getAttribute("aria-checked")).toBe("true");
    const preview = within(screen.getByTestId("transfer-preview"));
    expect(preview.getByText("+₹20,400.00")).toBeTruthy();
    expect(preview.getByText("+₹20,000.00")).toBeTruthy();
    expect(preview.getByText("Fee · expense on HDFC Credit Card")).toBeTruthy();
    expect(preview.getByText(/Only the ₹400.00 fee counts in My Spend/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /add transfer/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    expect(actions.createTransferPair).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 20_000,
        description: "Via CRED",
        fee: { amount: 400, chargedTo: "source", categoryId: "bills", description: "Transfer fee · CRED" },
      }),
    );
  });

  it("C. fee cut from the amount received: bank receives 19,600", async () => {
    const user = userEvent.setup();
    renderTransfer();
    await user.type(amountInput(), "20000");
    await user.type(screen.getByRole("textbox", { name: "Transfer fee" }), "400");
    await user.click(screen.getByRole("radio", { name: "Cut from amount received" }));
    const preview = within(screen.getByTestId("transfer-preview"));
    expect(preview.getByText("+₹19,600.00")).toBeTruthy();
    expect(preview.getByText("Fee · expense on SBI Savings")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /add transfer/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledWith(expect.objectContaining({ fee: expect.objectContaining({ chargedTo: "destination", amount: 400 }) })));
  });

  it("an invalid deducted fee blocks Save with a message; nothing is sent", async () => {
    const user = userEvent.setup();
    renderTransfer();
    await user.type(amountInput(), "400");
    await user.type(screen.getByRole("textbox", { name: "Transfer fee" }), "400");
    await user.click(screen.getByRole("radio", { name: "Cut from amount received" }));
    await user.click(screen.getByRole("button", { name: /add transfer/i }));
    expect((await screen.findAllByText(/must be less than the transfer amount/)).length).toBeGreaterThan(0);
    expect(actions.createTransferPair).not.toHaveBeenCalled();
  });

  it("warns (without blocking) when the card's available credit is exceeded", async () => {
    const user = userEvent.setup();
    renderTransfer();
    await user.type(amountInput(), "60000");
    expect(screen.getByText(/more than the card's available credit/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /add transfer/i }));
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
  });

  it("a double click saves once (same action, in-flight guard)", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    actions.createTransferPair.mockImplementation(() => new Promise<void>((r) => (release = r)));
    renderTransfer();
    await user.type(amountInput(), "20000");
    const save = screen.getByRole("button", { name: /add transfer/i });
    await user.dblClick(save);
    await waitFor(() => expect(actions.createTransferPair).toHaveBeenCalledTimes(1));
    release();
    expect(actions.createTransferPair).toHaveBeenCalledTimes(1);
  });

  it("a card bill payment (To = a card) keeps its own flow: no fee section", () => {
    renderTransfer({ initialDestinationAccountId: "hdfc-card" });
    expect(screen.queryByRole("textbox", { name: "Transfer fee" })).toBeNull();
    expect(screen.queryByTestId("transfer-preview")).toBeNull();
  });
});

describe("a saved transfer shows its linked records", () => {
  const leg = (over: Partial<Transaction>): Transaction =>
    ({
      id: "x",
      type: "expense",
      amount: 20_000,
      dateTime: new Date(2026, 9, 10),
      accountId: "hdfc-card",
      categoryId: "transfer",
      description: "Via CRED",
      notes: "",
      transferId: "xfer_k",
      transferFeeForId: null,
      excludeFromCalculations: false,
      accountingMonth: null,
      linkedPersonId: null,
      owesPersonToggle: false,
      createdAt: new Date(2026, 9, 10),
      deletedAt: null,
      editHistory: [],
      ...over,
    }) as unknown as Transaction;
  const out = leg({ id: "xfer_k_out" });
  const inn = leg({ id: "xfer_k_in", type: "income", accountId: "sbi" });
  const fee = leg({ id: "xfer_k_fee", amount: 400, transferId: null, transferFeeForId: "xfer_k", categoryId: "bills" });

  it.each([
    ["the card leg", out],
    ["the bank leg", inn],
    ["the fee", fee],
  ])("opening %s shows From → To, amount and the fee", (_label, current) => {
    render(
      <TransactionDetailsModal
        open
        onOpenChange={() => {}}
        row={{ transaction: current } as never}
        expense={null}
        people={[]}
        accounts={accounts}
        categories={categories}
        actions={actions as never}
        existingTransactions={[out, inn, fee]}
      />,
    );
    const linked = within(screen.getByTestId("linked-transfer"));
    expect(linked.getByText("HDFC Credit Card")).toBeTruthy();
    expect(linked.getByText("SBI Savings")).toBeTruthy();
    expect(linked.getByText("₹20,000.00")).toBeTruthy();
    expect(linked.getByText(/Fee ₹400.00 · expense on HDFC Credit Card/)).toBeTruthy();
  });
});
