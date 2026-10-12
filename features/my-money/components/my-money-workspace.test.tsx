// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";
import { obligationStatus, summarizeToPay, type ObligationItem } from "@/features/my-money/lib/my-money";

/**
 * My Money presentation lock: the four headlines stay separate, a shared installment shows my share apart
 * from the lender amount, informational (card-funded) rows never enter To pay, and Completed starts collapsed.
 * The money itself comes from the canonical engines (see `my-money.test.ts` for the presentation rules).
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const NOW = new Date(2026, 9, 12, 10);
const base = (over: Partial<ObligationItem> & Pick<ObligationItem, "key" | "title" | "dueDate" | "remaining">): ObligationItem => ({
  kind: "loan",
  sourceId: over.key,
  detail: "",
  amountDue: over.remaining,
  amountPaid: 0,
  status: obligationStatus(over.dueDate, over.remaining, NOW),
  carriedForward: false,
  countsTowardTotal: true,
  note: null,
  billStillOpen: false,
  shared: null,
  href: `/loans?agreement=${over.key}`,
  actionLabel: "Pay",
  ...over,
});

const obligations: ObligationItem[] = [
  base({
    key: "loan",
    title: "Personal Loan",
    dueDate: new Date(2026, 9, 14),
    remaining: 30000,
    shared: {
      myShare: 10000,
      othersShare: 20000,
      collected: 10000,
      toCollect: 10000,
      people: [
        { personId: "a", name: "ANU", share: 10000, received: 10000, remaining: 0, state: "received" },
        { personId: "b", name: "BIJU", share: 10000, received: 0, remaining: 10000, state: "pending" },
      ],
    },
  }),
  base({ key: "card", kind: "card", title: "HDFC Freedom ••1234", dueDate: new Date(2026, 9, 17), remaining: 8500, actionLabel: "Pay bill" }),
  base({ key: "phone", kind: "emi", title: "Phone EMI", dueDate: new Date(2026, 9, 25), remaining: 1400, amountDue: 2400, amountPaid: 1000, actionLabel: "Continue payment" }),
  base({ key: "tv", kind: "emi", title: "TV EMI", dueDate: new Date(2026, 9, 25), remaining: 999, countsTowardTotal: false, note: "Included in HDFC Freedom ••1234 bill" }),
];

const data = {
  isLoading: false,
  now: NOW,
  cycleRange: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59, 999) },
  periodLabel: "October 2026",
  rangeLabel: "1 Oct – 31 Oct",
  isCustomCycle: false,
  startDay: 1,
  isCurrent: true,
  isPast: false,
  nav: { previous: vi.fn(), next: vi.fn(), current: vi.fn(), pickMonth: vi.fn() },
  obligations,
  toPay: summarizeToPay(obligations),
  collect: {
    items: [
      { personId: "s", name: "SHAMBU", amount: 1200, partlyReceived: 300, reasons: ["Shared expense"], expected: null, alsoOwe: 0, href: "/people?person=s" },
    ],
    total: 1200,
    totalToGive: 0,
    giveCount: 0,
    advanceHeld: 500,
    collectedInPeriod: 0,
  },
  spending: {
    mySpend: 4200,
    sharedMine: 800,
    othersShare: 1600,
    purchaseCount: 9,
    topCategories: [{ categoryId: "food", name: "Food", iconKey: "food", amount: 4200, percent: 100 }],
    comparison: { kind: "inProgress", previous: 9000 },
  },
  completed: {
    groups: [
      { key: "card:c0", kind: "card", sourceId: "c0", title: "SBI Card", amount: 5000, payments: 1, lastDate: new Date(2026, 9, 5), undatedAmount: 0, undatedDueDate: null, href: "/credit-cards?card=c0" },
      { key: "bill:b1", kind: "bill", sourceId: "b1", title: "Rent", amount: 12000, payments: 0, lastDate: null, undatedAmount: 12000, undatedDueDate: new Date(2026, 9, 10), href: "/bills" },
    ],
    total: 17000,
  },
};
vi.mock("@/features/my-money/hooks/use-my-money-data", () => ({ useMyMoneyData: () => data }));

const { MyMoneyWorkspace } = await import("./my-money-workspace");
afterEach(cleanup);

function renderPage() {
  return render(
    <TooltipProvider>
      <MyMoneyWorkspace />
    </TooltipProvider>,
  );
}

describe("MyMoneyWorkspace", () => {
  it("shows the four headlines separately; To pay excludes a card-funded EMI", () => {
    renderPage();
    const summary = within(screen.getByRole("region", { name: "Period summary" }));
    // 30,000 + 8,500 + 1,400 — the ₹999 TV EMI is already inside the card bill.
    expect(summary.getByText(formatCurrency(39900))).toBeTruthy();
    expect(summary.getByText(formatCurrency(1200))).toBeTruthy();
    expect(summary.getByText(formatCurrency(4200))).toBeTruthy();
    expect(summary.getByText(formatCurrency(17000))).toBeTruthy();
    expect(summary.getByText("Outstanding today · 1 person")).toBeTruthy();
    // A running period compares amounts, never a %.
    expect(summary.getByText(`Previous period: ${formatCurrency(9000)}`)).toBeTruthy();
    expect(screen.getByText("Not in total")).toBeTruthy();
  });

  it("names the next action and links to the existing payment flow", () => {
    renderPage();
    const summary = within(screen.getByRole("region", { name: "Period summary" }));
    expect(summary.getByText("Personal Loan")).toBeTruthy();
    expect(summary.getByRole("link", { name: /Pay/ }).getAttribute("href")).toBe("/loans?agreement=loan");
  });

  it("keeps my share apart from what the lender is owed, with each person's state on demand", () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: /Your share/ });
    expect(toggle.textContent).toContain(formatCurrency(10000));
    expect(screen.queryByText("BIJU")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("BIJU")).toBeTruthy();
    expect(screen.getByText("Received")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
  });

  it("shows a partial EMI at its remainder with what is already paid", () => {
    renderPage();
    expect(screen.getByText("Partially paid")).toBeTruthy();
    expect(screen.getByText(`${formatCurrency(1000)} paid`)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Continue payment/ })).toBeTruthy();
  });

  it("groups payments by urgency and keeps items outside the total collapsed", () => {
    renderPage();
    // Loan (in 2 days) needs attention; the card (in 5 days) and the partial Phone EMI are later this period.
    expect(screen.getByRole("heading", { name: /^Needs attention/ }).textContent).toContain("· 1");
    expect(screen.getByRole("heading", { name: /^Later this period/ }).textContent).toContain("· 2");
    expect(screen.queryByText("TV EMI")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Covered elsewhere/ }));
    expect(screen.getByText("TV EMI")).toBeTruthy();
    expect(screen.getByText("Included in HDFC Freedom ••1234 bill")).toBeTruthy();
  });

  it("collapses Completed by default", () => {
    renderPage();
    expect(screen.queryByText("SBI Card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));
    expect(screen.getByText("SBI Card")).toBeTruthy();
    expect(screen.getByText("Card bill · Paid 5 Oct")).toBeTruthy();
    // No recorded payment date → said so; the due date is never presented as when it was paid.
    expect(screen.getByText("Bill · Bill due 10 Oct · payment date not recorded")).toBeTruthy();
  });

  it("shows held advances apart from money to collect", () => {
    renderPage();
    expect(screen.getByText(/in advances that haven.t been applied yet/)).toBeTruthy();
    expect(screen.getByText(`${formatCurrency(300)} already received`)).toBeTruthy();
  });
});
