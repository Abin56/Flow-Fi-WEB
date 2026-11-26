// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { PersonOpenItems } from "./person-open-items";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

afterEach(cleanup);

it("shows the paid and pending amounts of a partially paid EMI in separate columns", () => {
  const date = new Date(2024, 9, 1);
  const obligation: PayableObligation = {
    key: "emi-inst:smart",
    title: "Smart loan · EMI share",
    date,
    createdAt: date,
    amount: 2500,
    outstanding: 2000,
    side: "theyOwe",
    typeLabel: "EMI",
    category: "emi",
    target: { kind: "derivedInstallment", obligationRef: "emi-inst:smart", sourceKind: "emiInstallment", max: 2000 },
    isEmi: true,
  };
  const onRecord = vi.fn();
  render(<PersonOpenItems personName="Dad" obligations={[obligation]} onRecord={onRecord} />);

  const table = within(screen.getByRole("table", { name: "Open items across all cycles" }));
  const [, row] = table.getAllByRole("row");
  const cells = within(row).getAllByRole("cell");
  expect(within(cells[1]).getByText("Smart loan")).toBeTruthy();
  expect(within(cells[2]).getByText("₹500")).toBeTruthy();
  expect(cells[3].textContent).toBe("Pending₹2,000");
  expect(within(cells[4]).getByText("Overdue")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: /Record receipt for Smart loan/ }));
  expect(onRecord).toHaveBeenCalledWith(obligation.key);
});
