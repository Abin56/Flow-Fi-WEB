// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { DISMISS_UNDO_WINDOW_MS } from "../lib/delayed-dismiss";
import { CandidateDetailsModal } from "./candidate-details-modal";
import { IgnoreCandidateButton } from "./ignore-candidate-button";

/**
 * Regression: the 24 Sep merge (db38ba9) restored an older CandidateDetailsModal whose Dismiss deleted the
 * candidate immediately — losing the delayed "Dismiss with Undo" added in 6f3c3bc, which the list-level
 * Dismiss (IgnoreCandidateButton) kept. Both now share `scheduleDelayedDismiss`.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

type ToastAction = { label: string; onClick: () => void };
const toastCalls: { title: string; action?: ToastAction }[] = [];
vi.mock("@/store/toast-store", () => ({
  toast: {
    success: (title: string, _description?: string, action?: ToastAction) => toastCalls.push({ title, action }),
    error: (title: string, _description?: string, action?: ToastAction) => toastCalls.push({ title, action }),
    info: vi.fn(),
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
  toastCalls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    cardId: "card-1",
    referenceNumber: null,
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

function setup() {
  const deleteById = vi.fn(async () => {});
  const candidateRepository = { deleteById } as unknown as SmsTransactionCandidateRepository;
  const hidden = new Set<string>();
  const onHide = vi.fn((id: string) => hidden.add(id));
  const onUnhide = vi.fn((id: string) => hidden.delete(id));
  return { deleteById, candidateRepository, hidden, onHide, onUnhide };
}

function renderPopup(ctx: ReturnType<typeof setup>, onOpenChange = vi.fn()) {
  render(
    <CandidateDetailsModal
      candidate={candidate()}
      onOpenChange={onOpenChange}
      duplicate={null}
      matchedTransaction={null}
      existingTransactions={[]}
      accounts={[]}
      creditCards={[]}
      categories={[]}
      people={[]}
      transactionRepository={{} as unknown as TransactionRepository}
      candidateRepository={ctx.candidateRepository}
      expenseRepository={{} as unknown as ExpenseRepository}
      onCreatePerson={vi.fn()}
      onHide={ctx.onHide}
      onUnhide={ctx.onUnhide}
    />,
  );
  return onOpenChange;
}

function dismissFromPopup() {
  fireEvent.click(screen.getByRole("button", { name: /Dismiss Candidate/ }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss candidate" }));
}

describe("candidate details popup — Dismiss with Undo", () => {
  it("1/2. Dismiss hides immediately, defers the delete, closes the popup and offers Undo", () => {
    const ctx = setup();
    const onOpenChange = renderPopup(ctx);
    dismissFromPopup();
    expect(ctx.hidden.has("sms-1")).toBe(true);
    expect(ctx.deleteById).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const dismissed = toastCalls.find((t) => t.title === "Candidate dismissed");
    expect(dismissed?.action?.label).toBe("Undo");
  });

  it("3. Undo restores the candidate and the delete never runs", async () => {
    const ctx = setup();
    renderPopup(ctx);
    dismissFromPopup();
    toastCalls.find((t) => t.action)!.action!.onClick();
    expect(ctx.hidden.has("sms-1")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS + 1000);
    });
    expect(ctx.deleteById).not.toHaveBeenCalled();
  });

  it("4. without Undo the dismissal is committed exactly once after the window", async () => {
    const ctx = setup();
    renderPopup(ctx);
    dismissFromPopup();
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS - 1);
    });
    expect(ctx.deleteById).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(ctx.deleteById).toHaveBeenCalledTimes(1);
    expect(ctx.deleteById).toHaveBeenCalledWith("sms-1");
  });

  it("6. a repeated confirm does not schedule a second dismissal", async () => {
    const ctx = setup();
    renderPopup(ctx);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss Candidate/ }));
    const confirm = screen.getByRole("button", { name: "Dismiss candidate" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS);
    });
    expect(ctx.onHide).toHaveBeenCalledTimes(1);
    expect(ctx.deleteById).toHaveBeenCalledTimes(1);
  });

  it("7. Import remains available alongside Dismiss", () => {
    renderPopup(setup());
    expect(screen.getAllByRole("button", { name: /Import/ }).length).toBeGreaterThan(0);
  });
});

describe("5. list-level Dismiss (IgnoreCandidateButton) — unchanged semantics", () => {
  it("hides, offers Undo, and commits after the window", async () => {
    const ctx = setup();
    render(<IgnoreCandidateButton candidate={candidate()} candidateRepository={ctx.candidateRepository} onHide={ctx.onHide} onUnhide={ctx.onUnhide} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(ctx.hidden.has("sms-1")).toBe(true);
    expect(toastCalls.at(-1)?.action?.label).toBe("Undo");
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS);
    });
    expect(ctx.deleteById).toHaveBeenCalledTimes(1);
  });

  it("Undo restores and cancels the delete", async () => {
    const ctx = setup();
    render(<IgnoreCandidateButton candidate={candidate()} candidateRepository={ctx.candidateRepository} onHide={ctx.onHide} onUnhide={ctx.onUnhide} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    toastCalls.at(-1)!.action!.onClick();
    await act(async () => {
      vi.advanceTimersByTime(DISMISS_UNDO_WINDOW_MS);
    });
    expect(ctx.hidden.has("sms-1")).toBe(false);
    expect(ctx.deleteById).not.toHaveBeenCalled();
  });
});
