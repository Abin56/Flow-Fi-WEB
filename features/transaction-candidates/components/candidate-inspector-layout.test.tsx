// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Person } from "@/lib/models/person";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { CandidateDetailsModal, describeSplitAllocation } from "./candidate-details-modal";

/**
 * The compact inspector layout: secondary information folded, ownership editors opened only on request, the split
 * reading display-only — and none of it (opening, folding, switching ownership, moving, closing) ever writes.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

/** A repository whose every method records the call and fails — any write attempt shows up in `calls`. */
function trap<T>(calls: string[], name: string): T {
  return new Proxy(
    {},
    {
      get: (_, key) =>
        typeof key === "symbol" || key === "then"
          ? undefined
          : (..._args: unknown[]) => {
              calls.push(`${name}.${String(key)}`);
              throw new Error("no writes expected");
            },
    },
  ) as T;
}

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-1",
    amount: 500,
    direction: "debit",
    eventType: "cardPurchase",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    merchant: "Amazon",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: null,
    cardId: null,
    referenceNumber: "UPI1234",
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

const PEOPLE = [{ id: "p1", name: "Asha" } as Person, { id: "p2", name: "Ravi" } as Person];

function renderDrawer(opts: { onGoTo?: (id: string) => void; onOpenChange?: (open: boolean) => void; direction?: "debit" | "credit" } = {}) {
  const calls: string[] = [];
  render(
    <CandidateDetailsModal
      candidate={candidate({ direction: opts.direction ?? "debit" })}
      onOpenChange={opts.onOpenChange ?? vi.fn()}
      duplicate={null}
      matchedTransaction={null}
      existingTransactions={[]}
      accounts={[]}
      creditCards={[]}
      categories={[]}
      people={PEOPLE}
      transactionRepository={trap<TransactionRepository>(calls, "transactions")}
      candidateRepository={trap<SmsTransactionCandidateRepository>(calls, "candidates")}
      expenseRepository={trap<ExpenseRepository>(calls, "expenses")}
      onCreatePerson={vi.fn()}
      onHide={vi.fn()}
      onUnhide={vi.fn()}
      navigation={opts.onGoTo ? { index: 0, total: 2, prevId: null, nextId: "sms-2", advanceToId: "sms-2", onGoTo: opts.onGoTo } : undefined}
    />,
  );
  return calls;
}

describe("compact transaction inspector", () => {
  it("states merchant, signed amount and source once, in the header", () => {
    renderDrawer();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Amazon" })).toBeTruthy();
    expect(within(dialog).getByText("Transaction Details")).toBeTruthy();
    expect(within(dialog).getAllByLabelText("Debit −₹500.00")).toHaveLength(1);
  });

  it("folds Notes, the original SMS, parsing evidence and technical details until asked", () => {
    const calls = renderDrawer();
    expect(screen.queryByRole("textbox", { name: "Notes" })).toBeNull();
    // The seeded note (the merchant) is part of the chip's accessible name while folded.
    expect(screen.getByRole("button", { name: /^Notes, Amazon/ })).toBeTruthy();
    expect(screen.queryByTestId("original-message-unavailable")).toBeNull();
    expect(screen.queryByTestId("confidence-explanation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Notes/ }));
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Original SMS/ }));
    expect(screen.getByTestId("original-message-unavailable")).toBeTruthy();
    // Parsing evidence and technical details sit together under one "More details" toggle.
    expect(screen.queryByTestId("status-explanation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^More details/ }));
    expect(screen.getByTestId("confidence-explanation")).toBeTruthy();
    expect(screen.getByTestId("status-explanation")).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getAllByText("UPI1234").length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("keeps the unresolved-account warning visible (never folded)", () => {
    renderDrawer();
    expect(within(screen.getByTestId("account-match-evidence")).getByText(/pick the right one before importing/)).toBeTruthy();
  });

  it("opens the person picker and the split editor only when chosen", () => {
    const calls = renderDrawer();
    expect(screen.getByRole("radio", { name: "My own expense" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("combobox", { name: "Assign to a person" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Split participants" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Someone else's expense" }));
    expect(screen.getByRole("combobox", { name: "Assign to a person" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Split participants" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Split expense" }));
    expect(screen.queryByRole("combobox", { name: "Assign to a person" })).toBeNull();
    const participants = screen.getByRole("list", { name: "Split participants" });
    expect(screen.getByTestId("split-allocation").textContent).toBe("No one added yet");
    fireEvent.change(within(participants).getByRole("textbox", { name: "Participant 1 name" }), { target: { value: "Kiran" } });
    expect(screen.getByTestId("split-allocation").textContent).toBe("₹500.00 each · 1 person");

    fireEvent.click(screen.getByRole("radio", { name: "My own expense" }));
    expect(screen.queryByRole("list", { name: "Split participants" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("offers no ownership control on income", () => {
    renderDrawer({ direction: "credit" });
    expect(screen.queryByRole("radiogroup", { name: "Whose expense" })).toBeNull();
  });

  it("never drops an open split silently: moving on asks first and does not move", () => {
    const onGoTo = vi.fn();
    const calls = renderDrawer({ onGoTo });
    fireEvent.click(screen.getByRole("radio", { name: "Split expense" }));
    fireEvent.click(screen.getByRole("button", { name: "Next candidate" }));
    expect(screen.getByText("Discard your changes?")).toBeTruthy();
    expect(onGoTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("list", { name: "Split participants" })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("closing writes nothing", () => {
    const onOpenChange = vi.fn();
    const calls = renderDrawer({ onOpenChange });
    fireEvent.click(screen.getByRole("radio", { name: "Someone else's expense" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls).toEqual([]);
  });
});

describe("describeSplitAllocation (display only)", () => {
  const p = (name: string, value = "", personId: string | null = null) => ({ personId, name, value });
  it("custom amounts: shows what is left against the total", () => {
    expect(describeSplitAllocation({ splitType: "custom", participants: [p("A", "200"), p("B", "100")] }, 500, [])).toMatchObject({ summary: "₹300.00 of ₹500.00 · ₹200.00 left to assign", balanced: false });
    expect(describeSplitAllocation({ splitType: "custom", participants: [p("A", "300"), p("B", "200")] }, 500, [])).toMatchObject({ summary: "₹500.00 of ₹500.00 assigned", balanced: true, hint: null });
    expect(describeSplitAllocation({ splitType: "custom", participants: [p("A", "600")] }, 500, [])).toMatchObject({ summary: "₹600.00 of ₹500.00 · ₹100.00 over", balanced: false });
  });
  it("percentages: must reach 100%", () => {
    expect(describeSplitAllocation({ splitType: "percentage", participants: [p("A", "60"), p("B", "40")] }, 500, [])).toMatchObject({ balanced: true, summary: "100% of 100% assigned" });
    expect(describeSplitAllocation({ splitType: "percentage", participants: [p("A", "60")] }, 500, [])).toMatchObject({ balanced: false, summary: "60% of 100% · 40% left to assign" });
  });
  it("names someone listed twice, the way the import would refuse it", () => {
    expect(describeSplitAllocation({ splitType: "equal", participants: [p("Asha", "", "p1"), p("Asha", "", "p1")] }, 500, PEOPLE).duplicate).toBe("Asha");
    expect(describeSplitAllocation({ splitType: "equal", participants: [p("kiran"), p("Kiran ")] }, 500, []).duplicate).toBe("Kiran");
    expect(describeSplitAllocation({ splitType: "equal", participants: [p("Asha", "", "p1"), p("Ravi", "", "p2")] }, 500, PEOPLE).duplicate).toBeNull();
  });
});

describe("a chosen account follows the reviewer, not only Android's match", () => {
  const account = { id: "acc-1", name: "Bank of India", bankId: "boi", type: "bank", accountNumberLast4: "4821" } as unknown as Account;

  function open(extra: { chosenDestinationKey?: string | null; onDestinationChosen?: (id: string, key: string | null) => void } = {}) {
    render(
      <CandidateDetailsModal
        candidate={candidate()}
        onOpenChange={vi.fn()}
        duplicate={null}
        matchedTransaction={null}
        existingTransactions={[]}
        accounts={[account]}
        creditCards={[]}
        categories={[]}
        people={PEOPLE}
        transactionRepository={trap<TransactionRepository>([], "transactions")}
        candidateRepository={trap<SmsTransactionCandidateRepository>([], "candidates")}
        expenseRepository={trap<ExpenseRepository>([], "expenses")}
        onCreatePerson={vi.fn()}
        onHide={vi.fn()}
        onUnhide={vi.fn()}
        {...extra}
      />,
    );
  }

  it("shows 'Account not matched' while nothing is chosen", () => {
    open();
    expect(within(screen.getByTestId("sheet-header")).getByText("Account not matched")).toBeTruthy();
  });

  it("a choice made earlier this session seeds the account and clears the 'not matched' status", () => {
    open({ chosenDestinationKey: "account:acc-1" });
    const header = screen.getByTestId("sheet-header");
    expect(within(header).queryByText("Account not matched")).toBeNull();
    expect(screen.getAllByText(/Bank of India/).length).toBeGreaterThan(0);
  });

  it("ignores a chosen account that no longer exists", () => {
    open({ chosenDestinationKey: "account:gone" });
    expect(within(screen.getByTestId("sheet-header")).getByText("Account not matched")).toBeTruthy();
  });

  it("offering the last-4 suggestion and clicking it reports the choice and updates the status at once", () => {
    const onDestinationChosen = vi.fn();
    open({ onDestinationChosen });
    fireEvent.click(screen.getByRole("button", { name: /^Use Bank of India/ }));
    expect(onDestinationChosen).toHaveBeenCalledWith("sms-1", "account:acc-1");
    expect(within(screen.getByTestId("sheet-header")).queryByText("Account not matched")).toBeNull();
  });
});
