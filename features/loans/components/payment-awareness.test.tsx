// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AwarenessInput } from "@/features/loans/lib/payment-awareness";
import { PaymentAwareness, type UpcomingPayment, PaymentAwarenessProvider, PaymentAwarenessPublisher } from "./payment-awareness";

/** The header indicator, driven the way the Record Payment dialog drives it: a publisher mounted while the dialog is open. */

const input = (over: Partial<AwarenessInput> = {}): AwarenessInput => ({
  earlier: false,
  directPayer: false,
  lent: false,
  debitsAccount: true,
  creditsAccount: false,
  cardLabel: null,
  account: { name: "SBI", type: "bank", currentBalance: 1500 },
  amount: 2500,
  payerName: "Shambu",
  agreement: "Loan",
  success: false,
  ...over,
});

function Harness({ dialog, upcoming }: { dialog: AwarenessInput | null | "closed"; upcoming?: UpcomingPayment | null }) {
  return (
    <PaymentAwarenessProvider>
      <PaymentAwareness upcoming={upcoming} progressPercent={40} />
      {dialog !== "closed" && <PaymentAwarenessPublisher input={dialog} />}
    </PaymentAwarenessProvider>
  );
}

const shown = () => screen.getByTestId("payment-awareness").querySelector("[data-awareness]");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PaymentAwareness (header)", () => {
  it("is empty while no payment is being set up, but keeps its place", () => {
    render(<Harness dialog="closed" />);
    expect(screen.getByTestId("payment-awareness")).toBeTruthy();
    expect(shown()).toBeNull();
  });

  it("shows the low-balance shortfall from the account's own balance", () => {
    render(<Harness dialog={input()} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("low");
    expect(screen.getByRole("status").textContent).toContain("Low balance · Short by ₹1,000");
  });

  it("switching the mode changes only the indicator: paid directly shows no bank warning", () => {
    const { rerender } = render(<Harness dialog={input()} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("low");
    rerender(<Harness dialog={input({ earlier: true, directPayer: true, debitsAccount: false })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("direct");
    expect(screen.getByRole("status").textContent).toContain("My account unchanged");
    expect(screen.getByRole("status").textContent).not.toContain("Low balance");
    rerender(<Harness dialog={input({ earlier: true, debitsAccount: false })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("recorded");
    expect(screen.getByRole("status").textContent).toContain("No new debit");
  });

  it("amount edits update the warning in place", () => {
    const { rerender } = render(<Harness dialog={input({ amount: 1000 })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("pay");
    rerender(<Harness dialog={input({ amount: 3000 })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("low");
    expect(screen.getByRole("status").textContent).toContain("Short by ₹1,500");
  });

  it("cancelling (the dialog unmounting) returns the header to neutral", () => {
    const { rerender } = render(<Harness dialog={input()} />);
    expect(shown()).not.toBeNull();
    rerender(<Harness dialog="closed" />);
    expect(shown()).toBeNull();
  });

  it("a payment that has not reported success never shows the confirmation", () => {
    render(<Harness dialog={input({ account: { name: "SBI", type: "bank", currentBalance: 9000 } })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("pay");
    expect(screen.getByRole("status").textContent).not.toContain("recorded");
  });

  it("shows the confirmation only once the dialog reports success, keeps it after the dialog closes, then clears", () => {
    const rich = { name: "SBI", type: "bank" as const, currentBalance: 9000 };
    const { rerender } = render(<Harness dialog={input({ account: rich })} />);
    rerender(<Harness dialog={input({ account: rich, success: true })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("done");
    expect(screen.getByRole("status").textContent).toContain("Payment recorded · ₹2,500 from SBI");
    rerender(<Harness dialog="closed" />);
    expect(shown()?.getAttribute("data-awareness")).toBe("done");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(shown()).toBeNull();
  });

  it("a retry after success was withdrawn (the dialog stays open) drops the confirmation", () => {
    const rich = { name: "SBI", type: "bank" as const, currentBalance: 9000 };
    const { rerender } = render(<Harness dialog={input({ account: rich, success: true })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("done");
    rerender(<Harness dialog={input({ account: rich, success: false })} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("pay");
  });

  it("shows the next installment while no payment is open, and gives way to the payment being set up", () => {
    const next: UpcomingPayment = { amount: 2500, dueDate: new Date(2026, 11, 1), sequenceNumber: 5, overdue: false };
    const { rerender } = render(<Harness dialog="closed" upcoming={next} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("upcoming");
    expect(screen.getByRole("status").textContent).toContain("Next · ₹2,500 · 1 Dec");
    expect(screen.getByRole("status").textContent).not.toContain("Overdue");
    rerender(<Harness dialog={input()} upcoming={next} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("low");
    rerender(<Harness dialog="closed" upcoming={next} />);
    expect(shown()?.getAttribute("data-awareness")).toBe("upcoming");
  });

  it("only an installment the schedule already flags overdue is called overdue", () => {
    const late: UpcomingPayment = { amount: 2500, dueDate: new Date(2026, 9, 1), sequenceNumber: 3, overdue: true };
    render(<Harness dialog="closed" upcoming={late} />);
    expect(screen.getByRole("status").textContent).toContain("Overdue");
  });

  it("publishing without a provider (the list windows) is a harmless no-op", () => {
    expect(() => render(<PaymentAwarenessPublisher input={input()} />)).not.toThrow();
  });
});
