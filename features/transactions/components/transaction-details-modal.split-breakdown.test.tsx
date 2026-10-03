// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Expense, ExpenseParticipant } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionDetailsModal } from "./transaction-details-modal";

/**
 * Transaction details → People & Split: a saved split shows the same read-only `SplitAllocationBreakdown`
 * as the People Ledger, from the stored Expense. Opening it never calls a write action.
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

const accounts = [{ id: "sbi", name: "SBI", type: "cash" }] as unknown as Account[];
const categories = [{ id: "food", name: "Food", type: "expense" }] as unknown as Category[];
const people = [{ id: "A", name: "AMMA" }] as unknown as Person[];

const txn = {
  id: "t-dinner",
  type: "expense",
  amount: 4000,
  dateTime: new Date("2026-10-01T20:00:00"),
  accountId: "sbi",
  categoryId: "food",
  description: "Dinner",
  notes: "",
  transferId: null,
  linkedPersonId: null,
  owesPersonToggle: false,
  createdAt: new Date("2026-10-01T20:00:00"),
  status: "posted",
  deletedAt: null,
  editHistory: [],
} as unknown as Transaction;

const p = (name: string, share: number, personId: string | null, isMe = false) =>
  ({ personId, name, share, installmentId: null, isMe, receivedStatus: isMe ? "notApplicable" : "yetToReceive" }) as ExpenseParticipant;

const split = {
  id: "x1",
  description: "Dinner",
  totalAmount: 4000,
  date: new Date("2026-10-01"),
  categoryId: "food",
  accountId: "sbi",
  transactionId: "t-dinner",
  splitType: "custom",
  participants: [p("Me", 1000, null, true), p("AMMA", 1500, "A"), p("TRIPTHEE", 1000, "T"), p("ANU", 500, "N")],
  scheduleId: "s",
  notes: "",
  createdAt: new Date("2026-10-01"),
  deletedAt: null,
} as unknown as Expense;

function actions() {
  return {
    createTransaction: vi.fn(),
    createTransferPair: vi.fn(),
    createPersonFundedExpense: vi.fn(),
    changeExpenseFunding: vi.fn(),
    applyOwesPersonChange: vi.fn(),
    editTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    expenseRepository: { convertToSplit: vi.fn(), editExpense: vi.fn() },
  };
}

function renderModal(expense: Expense | null, a = actions()) {
  render(
    <TransactionDetailsModal
      open
      onOpenChange={() => {}}
      row={{ transaction: txn, account: accounts[0], category: categories[0] } as never}
      expense={expense}
      people={people}
      accounts={accounts}
      categories={categories}
      actions={a as never}
    />,
  );
  return a;
}

describe("Transaction details — saved split breakdown", () => {
  it("shows the stored original total and every stored (custom) share; writes nothing", () => {
    const a = renderModal(split);
    const section = screen.getByText("Original total").closest("section")!;
    expect(within(section).getByText(formatCurrencyPrecise(4000))).toBeTruthy();
    expect(within(section).getByText("4-way split")).toBeTruthy();
    for (const [name, amt] of [["You", 1000], ["AMMA", 1500], ["TRIPTHEE", 1000], ["ANU", 500]] as const) {
      const cell = within(section).getByText(name).parentElement!;
      expect(within(cell).getByText(formatCurrencyPrecise(amt))).toBeTruthy();
    }
    for (const fn of [a.createTransaction, a.editTransaction, a.deleteTransaction, a.expenseRepository.convertToSplit, a.expenseRepository.editExpense]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("no breakdown for a non-split or deleted expense", () => {
    renderModal(null);
    expect(screen.queryByText("Original total")).toBeNull();
    cleanup();
    renderModal({ ...split, deletedAt: new Date() } as Expense);
    expect(screen.queryByText("Original total")).toBeNull();
  });
});
