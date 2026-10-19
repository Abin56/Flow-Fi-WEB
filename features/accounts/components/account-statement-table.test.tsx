// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStatementTable } from "@/features/accounts/components/account-statement-table";
import type { AccountStatement } from "@/features/accounts/lib/account-statement";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => <a href={href} {...p}>{children}</a> }));

const row = (id: string, day: number, debit: number, credit: number, balance: number) => ({
  id, date: new Date(2026, 9, day), description: id, accountId: "a", accountName: "A", debit, credit, balance,
});
const statement: AccountStatement = {
  opening: 10,
  rows: [row("Expense", 12, 5, 0, 5), row("Salary", 13, 0, 20, 25), row("EMI", 14, 10, 0, 15)],
  fromRecords: 15,
  stored: 15,
  difference: 0,
  notCountedCount: 0,
};

afterEach(cleanup);

describe("AccountStatementTable", () => {
  it("lists newest first with the balance after each row and the opening balance", () => {
    render(<AccountStatementTable statement={statement} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("EMI");
    expect(items[0].textContent).toContain("₹15.00");
    expect(items[2].textContent).toContain("₹5.00");
    expect(items[3].textContent).toContain("Opening balance");
  });

  it("keeps the true balance when filtered", () => {
    render(<AccountStatementTable statement={statement} />);
    fireEvent.click(screen.getByRole("button", { name: "Money in" }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("₹25.00");
  });

  it("shows a difference indicator only on mismatch", () => {
    const { rerender } = render(<AccountStatementTable statement={statement} />);
    expect(screen.queryByText(/Nothing was adjusted/)).toBeNull();
    rerender(<AccountStatementTable statement={{ ...statement, stored: 20, difference: 5 }} />);
    expect(screen.getByText(/Nothing was adjusted/)).toBeTruthy();
  });
});
