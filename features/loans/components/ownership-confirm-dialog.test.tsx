// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnershipConfirmDialog, type OwnershipConfirmTarget } from "@/features/loans/components/ownership-confirm-dialog";

vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const confirm: OwnershipConfirmTarget = { source: "emi", id: "e1", name: "Phone EMI", mode: "confirm" };

describe("OwnershipConfirmDialog", () => {
  it("confirms once, then closes; a double click does not submit twice", async () => {
    let release!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((r) => (release = r)));
    const onClose = vi.fn();
    render(<OwnershipConfirmDialog target={confirm} onClose={onClose} onSubmit={onSubmit} />);
    expect(screen.getByText(/Only this label changes/)).toBeTruthy();
    const yes = screen.getByRole("button", { name: /it’s mine/ });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the failure, stays open and lets the user retry", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("This record is closed.")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<OwnershipConfirmDialog target={confirm} onClose={onClose} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /it’s mine/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("This record is closed.");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /it’s mine/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("remove mode explains that the record returns to unconfirmed", () => {
    render(<OwnershipConfirmDialog target={{ ...confirm, mode: "remove" }} onClose={() => {}} onSubmit={async () => {}} />);
    expect(screen.getByText(/go back to “Confirm who owes this EMI”/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });
});
