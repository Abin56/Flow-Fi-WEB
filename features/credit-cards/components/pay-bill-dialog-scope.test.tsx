// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { cardStatementPaymentScope, type CardBill } from "@/lib/engines/card-cycle-bills";
import { PayBillDialogScope } from "./pay-bill-dialog-scope";

afterEach(cleanup);

function bill(month: number, remaining: number, isClosed: boolean): CardBill {
  return {
    id: String(month),
    cardId: "card",
    isMaterialized: false,
    periodStart: new Date(2026, month - 1, 18),
    periodEnd: new Date(2026, month, 17),
    dueDate: new Date(2026, month + 1, 5),
    totalAmount: remaining,
    amountPaid: 0,
    remaining,
    isClosed,
    minimumDue: null,
    chargeIds: [],
  };
}

it("shows the exact amount paid toward each statement and includes both years across New Year", () => {
  const bills = [bill(0, 100, true), bill(1, 80, true), bill(2, 70, false)];
  const scope = cardStatementPaymentScope(bills, new Date(2026, 2, 8));
  render(<PayBillDialogScope scope={scope} bills={bills} amount={130.25} />);

  const first = screen.getByText("18 Dec 2025 – 17 Jan 2026").closest("div");
  const second = screen.getByText("18 Jan – 17 Feb 2026").closest("div");
  expect(first?.querySelector("dd")?.textContent).toBe("₹100");
  expect(second?.querySelector("dd")?.textContent).toBe("₹30.25");
  expect(screen.queryByText(/Advance payment/)).toBeNull();
});

it("shows no due bill for an open cycle, and identifies its advance payment if an amount is entered", () => {
  const bills = [bill(0, 100, false)];
  const scope = cardStatementPaymentScope(bills, new Date(2026, 0, 6));
  const view = render(<PayBillDialogScope scope={scope} bills={bills} amount={0} />);
  expect(screen.getByText("No bill is due on this card.")).toBeTruthy();
  expect(screen.getByText("Unbilled spending ₹100")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Payment breakdown" })).toBeNull();

  view.rerender(<PayBillDialogScope scope={scope} bills={bills} amount={50} />);
  const advance = screen.getByText("Open cycle · Advance payment").closest("div");
  expect(advance?.textContent).toContain("18 Dec 2025 – 17 Jan 2026");
  expect(advance?.querySelector("dd")?.textContent).toBe("₹50");
});
