// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreditCard, Landmark, Users } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebtCard, interestRateLabel, type DebtCardProps } from "@/features/loans/components/loan-emi-ui";

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

const base: DebtCardProps = {
  icon: Landmark,
  name: "Home loan",
  source: "HDFC Bank",
  tag: "Bank Loan",
  outstandingLabel: "Outstanding",
  outstanding: 300000,
  totalAmount: 500000,
  nextAmount: 12000,
  nextDate: inDays(20),
  cadence: "month",
  paid: 4,
  total: 12,
  onClick: () => {},
};

const card = (props: Partial<DebtCardProps> = {}) => render(<DebtCard {...base} {...props} />).container;

afterEach(cleanup);

describe("DebtCard — Loan & EMI list card (display only)", () => {
  it("shows both primary metrics, the original amount, the actual due date and installment-count progress", () => {
    const el = card({ rate: "10.5% p.a." });
    const text = el.textContent!;
    expect(text).toMatch(/Outstanding₹3,00,000/);
    expect(text).toMatch(/Loan amount ₹5,00,000/);
    expect(text).toMatch(/Next EMI₹12,000/);
    expect(text).toContain(base.nextDate!.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: base.nextDate!.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }));
    expect(text).toContain("Bank Loan");
    expect(text).toContain("HDFC Bank · 10.5% p.a.");
    expect(text).toMatch(/Installments paid4 of 12 · 8 left/);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("4 of 12 installments paid, 8 left");
  });

  it("omits the rate when the record has no interest terms, and no People row without participants", () => {
    const text = card({ rate: interestRateLabel(null) }).textContent!;
    expect(text).not.toMatch(/p\.a\.|p\.m\./);
    expect(text).not.toMatch(/Split between|Repays|Share/);
  });

  it("keeps a long name intact (truncated by CSS, full name in the tooltip)", () => {
    const name = "Very long personal loan name that would never fit on a single card line at all";
    card({ name });
    expect(screen.getByRole("heading", { name }).getAttribute("title")).toBe(name);
  });

  it("lists every assigned person under 'Split between', keeping non-person links", () => {
    const text = card({
      links: [
        { icon: Users, label: "You ₹2,00,000", person: { name: "You", role: "Your share", amount: "₹2,00,000" } },
        { icon: Users, label: "Sanju ₹1,50,000", person: { name: "Sanju", role: "Share", amount: "₹1,50,000" } },
        { icon: Users, label: "Shan ₹1,50,000", person: { name: "Shan", role: "Share", amount: "₹1,50,000" } },
        { icon: CreditCard, label: "Card ••1234" },
      ],
    }).textContent!;
    expect(text).toContain("Split between");
    expect(text).toMatch(/Sanju₹1,50,000/);
    expect(text).toMatch(/Shan₹1,50,000/);
    expect(text).toMatch(/You₹2,00,000/);
    expect(text).toContain("Card ••1234");
  });

  it("uses the single person's role as the label", () => {
    const text = card({ links: [{ icon: Users, label: "Sanju repays ₹5,00,000", person: { name: "Sanju", role: "Repays this loan", amount: "₹5,00,000" } }] }).textContent!;
    expect(text).toContain("Repays this loan");
    expect(text).not.toContain("Split between");
  });

  it("flags an overdue next installment from its own due date", () => {
    const text = card({ nextDate: inDays(-2), overdue: true }).textContent!;
    expect(text).toContain("2 days overdue");
  });

  it("drops the Next EMI column when nothing is due (closed/fully paid)", () => {
    const text = card({ nextAmount: null, nextDate: null, muted: true }).textContent!;
    expect(text).not.toMatch(/Next EMI|Next payment/);
    expect(text).toMatch(/Loan amount ₹5,00,000/);
  });

  it("opens on click and on Enter/Space", () => {
    const onClick = vi.fn();
    card({ onClick });
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});

describe("interestRateLabel", () => {
  it("formats stored terms and returns null when there are none", () => {
    expect(interestRateLabel({ ratePercent: 10.5, period: "yearly" })).toBe("10.5% p.a.");
    expect(interestRateLabel({ ratePercent: 1.25, period: "monthly" })).toBe("1.25% p.m.");
    expect(interestRateLabel(null)).toBeNull();
  });
});

describe("DebtCard — ownership indicator", () => {
  it("shows the label and My share only for a confirmed allocation", () => {
    const text = card({ ownership: { kind: "shared", myShare: 3333.34 } }).textContent!;
    expect(text).toContain("Shared");
    expect(text).toMatch(/My share ₹3,333\.34|My share ₹3,333/);
  });
  it("Unconfirmed owner carries no My share and keeps every existing figure", () => {
    const text = card({ ownership: { kind: "review", myShare: null } }).textContent!;
    expect(text).toContain("Confirm who owes this EMI");
    expect(text).not.toContain("My share");
    expect(text).toMatch(/Outstanding₹3,00,000/);
    expect(text).toMatch(/Next EMI₹12,000/);
  });
  it("renders no indicator when none is passed", () => {
    expect(card().textContent).not.toMatch(/Mine|Shared|Others|Confirm who owes/);
  });
});

describe("DebtCard — ownership action", () => {
  it("shows the action beside the badge; clicking or pressing keys on it never opens the record", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    card({ onClick, ownership: { kind: "review", myShare: null, action: { label: "This EMI is mine", onClick: onAction } } });
    const button = screen.getByRole("button", { name: "This EMI is mine" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
  it("renders no action when none is offered, and keeps every figure", () => {
    const text = card({ ownership: { kind: "review", myShare: null } }).textContent!;
    expect(text).not.toContain("This EMI is mine");
    expect(text).toMatch(/Outstanding₹3,00,000/);
  });
});
