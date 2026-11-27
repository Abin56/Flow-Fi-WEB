// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import { LoanEmiAddDialog } from "./loan-emi-add-dialog";

const { editLoan, editLoanTerms, createLoan } = vi.hoisted(() => ({
  editLoan: vi.fn(async (loan: LoanRow["loan"]) => loan),
  editLoanTerms: vi.fn(),
  createLoan: vi.fn(),
}));

vi.mock("@/features/loans/hooks/use-loans-data", () => ({
  useLoanActions: () => ({ editLoan, editLoanTerms, createLoan }),
}));
vi.mock("@/features/emi/hooks/use-emi-data", () => ({ useEmiActions: () => null }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: [] }) }));
vi.mock("@/hooks/use-loans", () => ({
  useLoanPersons: () => ({ data: [{ id: "amma", name: "AMMA" }, { id: "sanju", name: "Sanju" }] }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row: LoanRow = {
  category: "institutional",
  lenderName: "Super Money",
  direction: "taken",
  payerPersonId: null,
  payerName: null,
  beneficiaryPersonId: null,
  beneficiaryName: null,
  totalInstallments: 12,
  installmentsPaid: 0,
  outstandingPrincipal: 60000,
  principalPrepaid: 0,
  installments: [],
  emiAmount: 5000,
  nextDueDate: null,
  status: "active",
  accent: "primary",
  loan: {
    id: "loan",
    name: "Shared loan",
    personId: null,
    direction: "taken",
    category: "institutional",
    loanDate: new Date(2026, 7, 1),
    loanAmount: 60000,
    interest: null,
    repaymentType: "installment",
    dueDate: null,
    installmentFrequency: "monthly",
    installmentCount: 12,
    scheduleId: "schedule",
    isClosed: false,
    createdAt: new Date(2026, 7, 1),
    lastEditedAt: null,
    deletedAt: null,
    editHistory: [],
    notes: "",
    ownershipShares: [
      { personId: null, amount: 20000, installmentAmount: 1667 },
      { personId: "amma", amount: 10000, installmentAmount: 833.25 },
      { personId: "sanju", amount: 30000, installmentAmount: 2499.75 },
    ],
  },
};

describe("Loan Add and Edit form", () => {
  it("shows saved account and shares in Edit and saves a lender rename through the existing edit action", async () => {
    const user = userEvent.setup();
    render(<LoanEmiAddDialog open editRow={row} editAccountName="Savings" onOpenChange={vi.fn()} />);

    const kind = within(screen.getByRole("radiogroup", { name: "What is this?" }));
    expect(kind.getAllByRole("radio")).toHaveLength(4);
    const selectedKind = kind.getByRole<HTMLButtonElement>("radio", { name: /^Loan I Took/ });
    expect(selectedKind.getAttribute("aria-checked")).toBe("true");
    expect(selectedKind.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("radio", { name: "Bank / Lender" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("radio", { name: "FlowFi account" }).disabled).toBe(true);
    expect(screen.getByText("Savings")).toBeTruthy();

    const shared = screen.getByRole<HTMLButtonElement>("radio", { name: "Shared" });
    expect(shared.getAttribute("aria-checked")).toBe("true");
    expect(shared.disabled).toBe(true);
    const shares = within(screen.getByRole("table", { name: "Saved loan shares" }));
    expect(shares.getByRole("row", { name: /AMMA.*10,000.*833\.25/ })).toBeTruthy();
    expect(shares.getByRole("row", { name: /Sanju.*30,000.*2,499\.75/ })).toBeTruthy();

    const lender = screen.getByPlaceholderText<HTMLInputElement>("e.g. HDFC Bank");
    expect(lender.value).toBe("Super Money");
    await user.clear(lender);
    await user.type(lender, "Updated lender");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(editLoan).toHaveBeenCalledOnce();
    expect(editLoan).toHaveBeenCalledWith(row.loan, expect.objectContaining({ lenderName: "Updated lender" }));
    expect(editLoanTerms).not.toHaveBeenCalled();
    expect(createLoan).not.toHaveBeenCalled();
  });

  it("keeps the matching ownership, account, and loan type choices editable in Add", () => {
    render(<LoanEmiAddDialog open initialKind="borrowed" onOpenChange={vi.fn()} />);

    expect(screen.getByRole<HTMLButtonElement>("radio", { name: /^Loan I Took/ }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("radio", { name: "FlowFi account" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("radio", { name: "Shared" }).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeTruthy();
  });

  it("balances custom principal and manual EMI live and saves the displayed split", async () => {
    const user = userEvent.setup();
    render(<LoanEmiAddDialog open initialKind="borrowed" onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("e.g. HDFC Bank"), "Super Money");
    await user.type(screen.getByPlaceholderText("0"), "60000");
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    await user.click(screen.getByRole("radio", { name: "Custom amount" }));
    await user.selectOptions(screen.getByLabelText("Person 2"), "amma");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.selectOptions(screen.getByLabelText("Person 3"), "sanju");

    await user.type(screen.getByLabelText("Person 2 share"), "10000");
    await user.type(screen.getByLabelText("Person 3 share"), "30000");
    const myShare = screen.getByLabelText<HTMLInputElement>("My share");
    expect(myShare.readOnly).toBe(true);
    expect(myShare.value).toBe("20000");

    await user.click(screen.getByRole("radio", { name: "Manual" }));
    const ammaEmi = screen.getByLabelText<HTMLInputElement>("Person 2 EMI");
    const sanjuEmi = screen.getByLabelText<HTMLInputElement>("Person 3 EMI");
    const myEmi = screen.getByLabelText<HTMLInputElement>("My EMI");
    await user.type(ammaEmi, "2600.25");
    await user.type(sanjuEmi, "2500");
    expect(screen.getByText("EMI over by").nextElementSibling?.textContent).toBe("₹100.25");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(createLoan).not.toHaveBeenCalled();

    await user.clear(ammaEmi);
    await user.type(ammaEmi, "1200.25");
    expect(myEmi.readOnly).toBe(true);
    expect(myEmi.value).toBe("1299.75");

    await user.selectOptions(screen.getByLabelText("Balance remaining EMI on"), "2");
    expect(myEmi.value).toBe("1299.75");
    expect(sanjuEmi.readOnly).toBe(true);
    await user.clear(myEmi);
    await user.type(myEmi, "1300");
    expect(sanjuEmi.value).toBe("2499.75");
    expect(screen.getByText("EMI remaining").nextElementSibling?.textContent).toBe("₹0");

    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(createLoan).toHaveBeenCalledWith(expect.objectContaining({
      ownershipShares: [
        { personId: null, amount: 20000, installmentAmount: 1300 },
        { personId: "amma", amount: 10000, installmentAmount: 1200.25 },
        { personId: "sanju", amount: 30000, installmentAmount: 2499.75 },
      ],
    }));
  });

  it("balances percentages to 100% and keeps the automatic EMI tied to the resulting shares", async () => {
    const user = userEvent.setup();
    render(<LoanEmiAddDialog open initialKind="borrowed" onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("0"), "60000");
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    await user.click(screen.getByRole("radio", { name: "Percentage" }));
    await user.selectOptions(screen.getByLabelText("Person 2"), "amma");
    await user.type(screen.getByLabelText("Person 2 share"), "33.33");

    const myShare = screen.getByLabelText<HTMLInputElement>("My share");
    expect(myShare.value).toBe("66.67");
    expect(screen.getByText("₹3,333.50")).toBeTruthy();
    expect(screen.getByText("₹1,666.50")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Balance remaining share on"), "1");
    expect(myShare.value).toBe("66.67");
    await user.clear(myShare);
    await user.type(myShare, "60");
    expect(screen.getByLabelText<HTMLInputElement>("Person 2 share").value).toBe("40");
    expect(screen.getByText("₹3,000")).toBeTruthy();
    expect(screen.getByText("₹2,000")).toBeTruthy();
  });
});
