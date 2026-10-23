// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyCommitmentsSummary } from "@/features/loans/components/my-commitments-summary";

vi.mock("@/features/people/hooks/use-person-cycle-statement", () => ({
  usePeopleCycleStatements: vi.fn(() => {
    throw new Error("People statements must not be subscribed until the user asks");
  }),
}));

vi.mock("@/hooks/use-loans", () => ({ useLoanPersons: () => ({ data: [{ id: "sanju", name: "Sanju" }] }) }));

afterEach(cleanup);

const now = new Date();
const inst = (id: string, day: number, amountDue: number, amountPaid = 0) =>
  ({ id, scheduleId: "s", sequenceNumber: 1, dueDate: new Date(now.getFullYear(), now.getMonth(), day), amountDue, amountPaid, isSkipped: false, deletedAt: null }) as never;

const loanRow = (id: string, loan: object, installments: unknown[], direction = "taken") =>
  ({ loan: { id, name: id, isClosed: false, ...loan }, direction, lenderName: "Bank", installments }) as never;

describe("MyCommitmentsSummary", () => {
  it("counts only confirmed ownership, lists unconfirmed apart, never subscribes to People up front", () => {
    render(
      <MyCommitmentsSummary
        loanRows={[
          loanRow("mine", { ownershipShares: [{ personId: null, amount: 1000 }] }, [inst("a", 5, 1000, 400)]),
          loanRow("plain", {}, [inst("b", 6, 7000)]),
          loanRow("gave", { ownershipShares: [{ personId: null, amount: 1000 }] }, [inst("c", 7, 9999)], "given"),
        ]}
        emiRows={[]}
      />,
    );
    const text = screen.getByRole("region", { name: "My EMI commitments" }).textContent!;
    expect(text).toMatch(/My EMI — Confirmed.*₹1,000/);
    expect(text).toMatch(/Already paid.*₹400/);
    expect(text).toMatch(/Still to pay.*₹600/);
    expect(text).toContain("Not your full EMI yet");
    expect(text).toContain("₹7,000");
    expect(text).not.toContain("9,999");
    expect(text).toMatch(/Still to pay the lender.*₹7,600/);
    expect(text).toMatch(/No shared installments this month/);
  });

  it("switches to next month", () => {
    render(<MyCommitmentsSummary loanRows={[loanRow("mine", { ownershipShares: [{ personId: null, amount: 1000 }] }, [inst("a", 5, 1000)])]} emiRows={[]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Next month" }));
    expect(screen.getByRole("region").textContent).toMatch(/No installments fall due/);
  });
});

describe("MyCommitmentsSummary — overdue-only", () => {
  it("still shows the overdue line when nothing else is due this month", () => {
    const past = ({ id: "p", scheduleId: "s", sequenceNumber: 1, dueDate: new Date(now.getFullYear(), now.getMonth() - 2, 5), amountDue: 800, amountPaid: 0, isSkipped: false, deletedAt: null }) as never;
    render(<MyCommitmentsSummary loanRows={[loanRow("mine", { ownershipShares: [{ personId: null, amount: 800 }] }, [past])]} emiRows={[]} />);
    expect(screen.getByRole("region").textContent).toContain("Overdue carried");
  });
});

describe("MyCommitmentsSummary — labels and EMI breakdown", () => {
  const rows = () => ({
    loanRows: [
      loanRow("Car", { ownershipShares: [{ personId: null, amount: 1000 }] }, [inst("a", 5, 1000, 400)]),
      loanRow("Bajaj", { ownershipShares: [{ personId: "sanju", amount: 3000 }] }, [inst("b", 6, 3000, 3000)]),
      loanRow("Legacy", {}, [inst("c", 7, 7000)]),
      loanRow("Closed one", { ownershipShares: [{ personId: null, amount: 1000 }], isClosed: true }, [inst("d", 8, 900, 900)]),
      loanRow("Card", { ownershipShares: [{ personId: "amma", amount: 1000 }], linkedCreditCardId: "card-1" }, [inst("e", 9, 2500)]),
    ],
    emiRows: [],
  });

  it("uses the clearer labels and explains the lender and reimbursement figures", () => {
    render(<MyCommitmentsSummary {...rows()} />);
    const text = screen.getByRole("region", { name: "My EMI commitments" }).textContent!;
    for (const label of ["My installments", "Still to pay the lender", "Still owed to me this month"]) expect(text).toContain(label);
    for (const gone of ["From my accounts", "Others will repay me"]) expect(text).not.toContain(gone);
    expect(text).toContain("not past account outflow");
    expect(text).toContain("Card-linked and payer-person EMIs may be left out");
    expect(text).toContain("not your whole People Ledger balance");
    expect(screen.getByLabelText(/does not prove you paid/).getAttribute("aria-label")).toMatch(/does not prove/);
  });

  it("the breakdown is collapsed until asked for, then lists every installment with its reason and reconciles", () => {
    render(<MyCommitmentsSummary {...rows()} />);
    const toggle = screen.getByRole("button", { name: /View EMI breakdown/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Adds up to the figures above/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const text = screen.getByRole("region", { name: "My EMI commitments" }).textContent!;
    expect(text).toContain("Adds up to the figures above: My EMI — Confirmed ₹1,000");
    expect(text).toContain("1 installment across 1 agreement");
    // every kind is listed with why it is or is not counted
    expect(text).toMatch(/Car.*Mine/);
    expect(text).toContain("Counted — this EMI is yours.");
    expect(text).toMatch(/Bajaj.*Others/);
    expect(text).toContain("owned by others");
    expect(text).toMatch(/Legacy.*Unconfirmed/);
    expect(text).toContain("who owes this EMI is unconfirmed");
    expect(text).toContain("this agreement is closed");
    expect(text).toContain("card-linked");
    expect(text).toContain("not proof that you paid from your own account");
    expect(screen.queryByRole("alert", { name: "" })?.textContent ?? "").not.toContain("could not be reconciled");
  });

  it("the breakdown follows the month selector and never shows a total it cannot reconcile", () => {
    render(<MyCommitmentsSummary {...rows()} />);
    fireEvent.click(screen.getByRole("button", { name: /View EMI breakdown/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Next month" }));
    const text = screen.getByRole("region").textContent!;
    expect(text).toContain("No installments due in");
    expect(text).not.toContain("Counted — this EMI is yours.");
    expect(text).not.toContain("could not be reconciled");
  });

  it("opening the breakdown still never subscribes to People", () => {
    render(<MyCommitmentsSummary {...rows()} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: /View EMI breakdown/ }))).not.toThrow();
  });
});
