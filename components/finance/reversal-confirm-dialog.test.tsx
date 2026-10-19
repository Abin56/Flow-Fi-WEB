// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReversalConfirmDialog } from "./reversal-confirm-dialog";

afterEach(cleanup);

const base = { open: true, onOpenChange: vi.fn(), amountLabel: "₹5,683", effects: ["Bill due: ₹0 → ₹5,683", "SBI balance: ₹1,000 → ₹6,683"] };

describe("ReversalConfirmDialog", () => {
  it("shows the amount, the derived effects and the two plain actions", async () => {
    const onConfirm = vi.fn();
    render(<ReversalConfirmDialog {...base} onConfirm={onConfirm} />);
    expect(screen.getByText("Cancel this recorded payment?")).toBeTruthy();
    expect(screen.getByText("₹5,683")).toBeTruthy();
    expect(screen.getByText("Bill due: ₹0 → ₹5,683")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep payment" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel recorded payment" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("blocked: explains why and offers no way to proceed", () => {
    render(<ReversalConfirmDialog {...base} blockedReason="This payment is linked to People. Reverse it there — nothing was changed." onConfirm={vi.fn()} />);
    expect(screen.getByText(/linked to People/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel recorded payment" })).toBeNull();
    expect(screen.queryByText("What will change")).toBeNull();
  });

  it("a failed attempt keeps the dialog open with the reason; busy disables both actions", () => {
    render(<ReversalConfirmDialog {...base} error="Changed in another tab — nothing was changed." busy onConfirm={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toMatch(/nothing was changed/);
    expect((screen.getByRole("button", { name: "Keep payment" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Cancel recorded payment/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
