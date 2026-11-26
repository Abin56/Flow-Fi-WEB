// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { installmentTableRows } from "@/features/loans/lib/installment-table";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { Installment } from "@/lib/models/payment-schedule";
import { InstallmentDetail, InstallmentGrid } from "./installment-grid";

vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-transactions", () => ({ useTransactions: () => ({ data: [] }) }));
vi.mock("./they-paid-panel", () => ({ TheyPaidPanel: () => null }));
vi.mock("./direct-payment-recovery", () => ({ DirectPaymentRecovery: () => null }));

afterEach(cleanup);

it("shows the selected cycle's People balance, including zero, independently of the lender filter", () => {
  const dueDate = new Date(2026, 11, 1);
  const installments = [2500, 0].map((amountPaid, index) => ({
    id: String(index + 1), scheduleId: "schedule", sequenceNumber: index + 1,
    dueDate, amountDue: 2500, amountPaid, isSkipped: false, deletedAt: null,
  }) as Installment);
  const rows = installmentTableRows({ installments, actions: [], closed: false });
  const props = { rows, selectedId: "2", onSelect: vi.fn(), total: 2, lent: false };
  const label = "1 Dec – 31 Dec 2026";
  const { rerender } = render(<InstallmentGrid {...props} cycleBalance={{ remaining: 7000, label }} />);
  const balance = within(screen.getByTestId("schedule-people-balance"));
  expect(balance.getByText("₹7,000")).toBeTruthy();
  expect(balance.getByText(`· ${label}`)).toBeTruthy();
  expect(balance.getByRole("link", { name: "People Ledger" }).getAttribute("href")).toBe("/people");
  expect(screen.queryByRole("columnheader", { name: "People pending" })).toBeNull();

  fireEvent.click(screen.getByRole("radio", { name: "Unpaid 1" }));
  expect(screen.queryByTestId("installment-row-1")).toBeNull();
  expect(balance.getByText("₹7,000")).toBeTruthy();
  rerender(<InstallmentGrid {...props} cycleBalance={{ remaining: 0, label }} />);
  expect(balance.getByText("₹0")).toBeTruthy();
  rerender(<InstallmentGrid {...props} cycleBalance={null} />);
  expect(screen.queryByTestId("schedule-people-balance")).toBeNull();
});

it("shows only the payment for a personal EMI and links shared pending to the expected People cycle", () => {
  const dueDate = new Date(2026, 11, 1);
  const installment = {
    id: "smart", scheduleId: "schedule", sequenceNumber: 5, dueDate, amountDue: 2500,
    amountPaid: 0, isSkipped: false, deletedAt: null,
  } as Installment;
  const [row] = installmentTableRows({ installments: [installment], actions: [], closed: false, now: new Date(2026, 10, 27) });
  const props = {
    row, lent: false, cycleStartDay: 17, receiptsByPerson: new Map(), receiptsLoading: false,
    returnTo: "/loans", onPay: vi.fn(), onViewPayment: vi.fn(), onTheyPaid: vi.fn(),
  };
  const { rerender } = render(<InstallmentDetail {...props} peopleLines={[]} />);
  expect(screen.getByRole("region", { name: "EMI 5" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pay Now ₹2,500" })).toBeTruthy();
  expect(screen.queryByTestId("installment-person")).toBeNull();
  expect(screen.queryByRole("button", { name: "Receive" })).toBeNull();

  const line: AgreementPeopleLine = {
    personId: "dad", personName: "Dad", key: "emi-inst:smart", installmentId: installment.id,
    sequenceNumber: 5, dueDate, share: 2500, received: 500, remaining: 2000,
    status: "partial", postponedDate: null, bankPaid: false,
  };
  rerender(<InstallmentDetail {...props} peopleLines={[line]} />);
  const person = within(screen.getByTestId("installment-person"));
  expect(person.getByText("₹2,000")).toBeTruthy();
  expect(person.queryByText("₹500")).toBeNull();
  expect(person.getByRole("link", { name: "Dad" }).getAttribute("href")).toBe("/people?person=dad&cycle=2026-11-17");

  const expectedCycle = cycleContaining(new Date(2027, 0, 1), 17);
  rerender(<InstallmentDetail {...props} peopleLines={[{ ...line, status: "postponed", expectedCycle }]} />);
  expect(person.getByText("Postponed to Jan 2027 cycle")).toBeTruthy();
  expect(person.getByRole("link", { name: "Dad" }).getAttribute("href")).toBe("/people?person=dad&cycle=2026-12-17");
});
