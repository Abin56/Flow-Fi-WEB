// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillPaymentHistory } from "@/features/bills/components/bill-payment-history";
import type { BillOccurrence, PaymentRecord } from "@/lib/models/bill";

const base = { deletedAt: null, lastEditedAt: null, editHistory: [], createdAt: new Date(2026, 0, 1) };
const occ = (id: string, month: number, paid: number, extra: Partial<BillOccurrence> = {}): BillOccurrence => ({
  ...base, id, billId: "b1", dueDate: new Date(2026, month, 18, 12), amount: 1_000, amountPaid: paid, isSkipped: false, ...extra,
});
const pay = (id: string, occurrenceId: string | null, extra: Partial<PaymentRecord> = {}): PaymentRecord => ({
  ...base, id, billId: "b1", occurrenceId, amount: 1_000, date: new Date(2026, 8, 20, 12), note: "", ...extra,
});

const names: Record<string, string> = { acc1: "Savings" };
function renderHistory(over: Partial<React.ComponentProps<typeof BillPaymentHistory>> = {}) {
  const props = {
    currentOccurrenceId: "o3",
    occurrences: [occ("o1", 8, 1_000), occ("o2", 9, 1_000), occ("o3", 10, 0)],
    payments: [pay("p1", "o1", { transactionId: "t1", accountId: "acc1" }), pay("p2", "o2", { recordedEarlier: true })],
    accountName: (id: string | null | undefined) => (id ? names[id] : undefined),
    onEdit: vi.fn(),
    onCancel: vi.fn(),
    onPay: vi.fn(),
    ...over,
  };
  render(<BillPaymentHistory {...props} />);
  return props;
}

afterEach(cleanup);

describe("BillPaymentHistory", () => {
  it("lists paid cycles newest first and does not list the empty current cycle", () => {
    renderHistory();
    const headings = screen.getAllByText(/^Cycle due/).map((n) => n.textContent);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toMatch(/Oct/);
    expect(headings[1]).toMatch(/Sep/);
  });

  it("an account-funded payment shows its account and both actions; an 'already paid earlier' one only cancel", () => {
    renderHistory();
    expect(screen.getByText("Savings")).toBeTruthy();
    expect(screen.getByText(/Already paid earlier/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Edit payment" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel payment" })).toHaveLength(2);
  });

  it("actions carry the payment's OWN cycle, not the current one", () => {
    const p = renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "Edit payment" }));
    expect(p.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), expect.objectContaining({ id: "o1" }));
    fireEvent.click(within(screen.getByLabelText("Payment history")).getAllByRole("button", { name: "Cancel payment" })[0]);
    expect(p.onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "p2" }), expect.objectContaining({ id: "o2" }));
  });

  it("a legacy payment (no cycle, no debit) is listed read-only and never attached to a guessed cycle", () => {
    renderHistory({ payments: [pay("legacy", null)], occurrences: [occ("o3", 10, 0)] });
    expect(screen.getByText(/Earlier payments \(cycle not recorded\)/)).toBeTruthy();
    expect(screen.getByText(/Recorded before payments tracked money/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit payment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel payment" })).toBeNull();
  });

  it("an older cycle reopened by a cancel is listed as unpaid and can be paid as itself", () => {
    const p = renderHistory({ payments: [], occurrences: [occ("o1", 8, 0), occ("o3", 10, 0)] });
    expect(screen.getByText("Unpaid")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pay this cycle/ }));
    expect(p.onPay).toHaveBeenCalledWith(expect.objectContaining({ id: "o1" }));
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(
      <BillPaymentHistory currentOccurrenceId="o3" occurrences={[occ("o3", 10, 0)]} payments={[]} accountName={() => undefined} onEdit={vi.fn()} onCancel={vi.fn()} onPay={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
