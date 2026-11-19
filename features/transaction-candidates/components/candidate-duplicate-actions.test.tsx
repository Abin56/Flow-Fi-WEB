// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { DISMISS_UNDO_WINDOW_MS } from "../lib/delayed-dismiss";
import { CandidateDetailsModal } from "./candidate-details-modal";

/**
 * The review sheet's three duplicate choices, and what each is allowed to write:
 *  - Ignore warning  → nothing at all (view only).
 *  - Already recorded → the existing delayed dismiss (one "dismissed" mark, Undo-able); never a transaction.
 *  - Import as new   → the normal import; with an incomplete form it writes nothing.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

const toastTitles: string[] = [];
vi.mock("@/store/toast-store", () => ({
  toast: {
    success: (title: string) => toastTitles.push(title),
    error: (title: string) => toastTitles.push(title),
    info: (title: string) => toastTitles.push(title),
  },
}));

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

beforeEach(() => {
  vi.useFakeTimers();
  toastTitles.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const candidate: SmsTransactionCandidate = {
  id: "sms-1",
  amount: 350,
  direction: "debit",
  eventType: "upiDebit" as SmsTransactionCandidate["eventType"],
  transactionDate: new Date("2026-11-04T10:00:00.000Z"),
  merchant: "Bank of India",
  bankName: "BOI",
  rawLastFour: "9585",
  accountId: null,
  cardId: null,
  referenceNumber: null,
  confidenceLevel: "high",
  confidenceScore: 0.9,
  needsReview: false,
  needsReviewReasons: [],
  source: "sms",
  createdAt: new Date("2026-11-04T10:00:00.000Z"),
  deletedAt: null,
};

function setup() {
  const markHandled = vi.fn(async () => ({ outcome: "dismissed" as const, mismatched: false }));
  // Any touch of the transaction repository means money could move — these flows must never reach it.
  const txnTouched: string[] = [];
  const transactionRepository = new Proxy({}, { get: (_t, prop) => (txnTouched.push(String(prop)), undefined) }) as unknown as TransactionRepository;
  const onHide = vi.fn();
  const onUnhide = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CandidateDetailsModal
      candidate={candidate}
      onOpenChange={onOpenChange}
      duplicate={{ duplicateOfTransactionId: "t1", confidence: 0.9, reason: "Same amount and date" }}
      matchedTransaction={{ id: "t1", amount: 350, dateTime: new Date("2026-11-04T09:00:00.000Z"), description: "Google Pay", accountId: null, type: "expense" } as never}
      existingTransactions={[]}
      accounts={[]}
      creditCards={[]}
      categories={[]}
      people={[]}
      transactionRepository={transactionRepository}
      candidateRepository={{ markHandled } as unknown as SmsTransactionCandidateRepository}
      expenseRepository={{} as unknown as ExpenseRepository}
      onCreatePerson={vi.fn()}
      onHide={onHide}
      onUnhide={onUnhide}
    />,
  );
  return { markHandled, txnTouched, onHide, onOpenChange };
}

describe("review sheet — duplicate choices", () => {
  it("shows one compact 'Possible duplicate found' card naming both sides; the header doesn't repeat it", () => {
    setup();
    const card = screen.getByTestId("duplicate-comparison");
    expect(within(card).getByText("Possible duplicate found")).toBeTruthy();
    expect(within(card).getByTestId("duplicate-existing").textContent).toMatch(/Google Pay/);
    expect(within(card).getByTestId("duplicate-new").textContent).toMatch(/Bank of India/);
    expect(screen.getAllByText(/Possible duplicate/)).toHaveLength(1);
  });

  it("Ignore warning folds the card and writes nothing; Show brings it back", async () => {
    const ctx = setup();
    fireEvent.click(screen.getByTestId("duplicate-ignore"));
    expect(screen.queryByTestId("duplicate-comparison")).toBeNull();
    expect(screen.getByTestId("duplicate-folded")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS + 1000);
    });
    expect(ctx.markHandled).not.toHaveBeenCalled();
    expect(ctx.onHide).not.toHaveBeenCalled();
    expect(ctx.onOpenChange).not.toHaveBeenCalled();
    expect(ctx.txnTouched).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Show/ }));
    expect(screen.getByTestId("duplicate-comparison")).toBeTruthy();
  });

  it("Already recorded resolves through the delayed dismiss — once, no transaction", async () => {
    const ctx = setup();
    fireEvent.click(screen.getByTestId("duplicate-already-recorded"));
    expect(ctx.onHide).toHaveBeenCalledWith("sms-1");
    expect(ctx.onOpenChange).toHaveBeenCalledWith(false);
    expect(toastTitles).toContain("Marked as already recorded");
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS);
    });
    expect(ctx.markHandled).toHaveBeenCalledTimes(1);
    expect(ctx.markHandled).toHaveBeenCalledWith("sms-1", "dismissed", null);
    expect(ctx.txnTouched).toEqual([]);
  });

  it("Import as new with no category/account writes nothing and keeps the sheet open", async () => {
    const ctx = setup();
    fireEvent.click(screen.getByTestId("duplicate-import-new"));
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(ctx.txnTouched).toEqual([]);
    expect(ctx.markHandled).not.toHaveBeenCalled();
    expect(ctx.onOpenChange).not.toHaveBeenCalled();
  });
});
