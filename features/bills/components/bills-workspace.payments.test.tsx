// @vitest-environment jsdom
/**
 * Bills dashboard (Payments tab): the four headlines come from the engine's overview untouched, every row names its
 * source module, "Pay now" on a bill targets that row's EXACT cycle through the existing Pay dialog, and loan / EMI /
 * card rows hand off to the owning module's own payment flow (Bills never records those itself).
 * The numbers are produced by `buildBillsOverview` / `buildCycleObligations` (see their own tests); here the overview is
 * built from fixed obligations so the assertions are about what the page does with them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillsWorkspace } from "./bills-workspace";
import { buildBillsOverview } from "@/features/bills/lib/bills-overview";
import { obligationStatus, type CompletedGroup, type ObligationItem, type ObligationKind } from "@/features/my-money/lib/my-money";
import { formatCurrency } from "@/lib/format";
import type { Bill, BillOccurrence } from "@/lib/models/bill";

const NOW = new Date(2026, 9, 25, 10);
const day = (m: number, d: number) => new Date(2026, m - 1, d, 12);
const base = { deletedAt: null, lastEditedAt: null, editHistory: [], createdAt: new Date(2026, 0, 1) };

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({
  default: ({ children, href, className, ...rest }: { children: React.ReactNode; href: string; className?: string } & Record<string, unknown>) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

function item(key: string, kind: ObligationKind, title: string, due: Date, remaining: number, patch: Partial<ObligationItem> = {}): ObligationItem {
  const amountPaid = patch.amountPaid ?? 0;
  return {
    key,
    kind,
    sourceId: key.split(":")[1]!,
    title,
    detail: "",
    dueDate: due,
    amountDue: remaining + amountPaid,
    amountPaid,
    remaining,
    status: obligationStatus(due, remaining, NOW),
    carriedForward: false,
    countsTowardTotal: true,
    note: null,
    billStillOpen: false,
    shared: null,
    href: `/${kind}s?agreement=${key}`,
    actionLabel: "Pay",
    payHref: null,
    related: null,
    ...patch,
  };
}

const bill = (id: string, name: string): Bill => ({ ...base, id, name, amount: 1000, nextDueDate: day(10, 20), recurrence: "monthly", accountId: null, categoryId: null, customIntervalDays: null, reminderOffsets: [], notes: "" });
const occ = (id: string, billId: string, due: Date, amountPaid = 0): BillOccurrence => ({ ...base, id, billId, dueDate: due, amount: 1000, amountPaid, isSkipped: false });

const elecNow = occ("e1", "elec", day(10, 20));
const elecOld = occ("e0", "elec", day(9, 10)); // an older, reopened cycle — NOT the bill's latest
const elecLatest = occ("e2", "elec", day(11, 20));

let paymentCalls: { open: boolean; occurrenceId: string }[] = [];
vi.mock("@/features/bills/components/bill-payment-dialog", () => ({
  BillPaymentDialog: ({ open, occurrence }: { open: boolean; occurrence: BillOccurrence }) => {
    paymentCalls.push({ open, occurrenceId: occurrence.id });
    return open ? <div role="dialog" aria-label="Pay dialog">paying {occurrence.id}</div> : null;
  },
}));

const completed: { groups: CompletedGroup[]; total: number } = {
  groups: [{ key: "bill:water", kind: "bill", sourceId: "water", title: "Water", amount: 700, payments: 1, lastDate: day(10, 21), undatedAmount: 0, undatedDueDate: null, href: "/bills" }],
  total: 700,
};

const cycleItems = [
  item("bill:elec:e1", "bill", "Electricity", day(10, 20), 1000, { occurrenceId: "e1" }), // overdue
  item("bill:elec:e0", "bill", "Electricity", day(9, 10), 1000, { occurrenceId: "e0", carriedForward: true }), // older cycle, carried
  item("loan:home:h1", "loan", "Home Loan", day(11, 3), 4000, { payHref: "/loans?agreement=home&installment=h1&pay=1", href: "/loans?agreement=home", installmentId: "h1", amountPaid: 1000 }),
  item("card:card-1:st", "card", "HDFC ••1234", day(11, 5), 17000, { payHref: "/credit-cards?card=card-1&pay=1", href: "/credit-cards?card=card-1&pay=1", actionLabel: "Pay bill", related: "HDFC ••1234" }),
  item("emi:phone:p1", "emi", "Phone EMI", day(11, 8), 2000, { countsTowardTotal: false, note: "Included in HDFC ••1234 bill", href: "/loans?agreement=phone" }),
];
const nextItems = [item("bill:net:n1", "bill", "Internet", day(11, 20), 600, { occurrenceId: "n1" })];

let rowsState: { bill: Bill; occurrence: BillOccurrence; account: undefined; category: undefined }[] = [];
let cyclesState: { billId: string; occurrence: BillOccurrence }[] = [];

vi.mock("@/features/bills/hooks/use-bills-data", () => ({
  useBillRows: () => ({ rows: rowsState, cycles: cyclesState, isLoading: false, refreshOccurrences: vi.fn(async () => {}) }),
  useBillActions: () => ({
    createBill: vi.fn(),
    editBill: vi.fn(),
    deleteBill: vi.fn(),
    payFromAccount: vi.fn(),
    recordPaidEarlier: vi.fn(),
    editBillPayment: vi.fn(),
    cancelBillPayment: vi.fn(),
    listPayments: vi.fn(async () => []),
    listOccurrences: vi.fn(async () => []),
    skipOccurrence: vi.fn(),
    unskipOccurrence: vi.fn(),
    recordPayment: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [] }) }));

vi.mock("@/features/bills/hooks/use-bills-overview", () => ({
  useBillsOverview: () => {
    const range = { start: new Date(2026, 9, 18), end: new Date(2026, 10, 17, 23, 59, 59) };
    return {
      isLoading: false,
      now: NOW,
      startDay: 18,
      isCustomCycle: true,
      cycleRange: range,
      nextRange: { start: new Date(2026, 10, 18), end: new Date(2026, 11, 17, 23, 59, 59) },
      isCurrent: true,
      periodLabel: "18 Oct – 17 Nov",
      nextPeriodLabel: "18 Nov – 17 Dec",
      rangeLabel: "18 Oct – 17 Nov",
      nav: { previous: vi.fn(), next: vi.fn(), current: vi.fn(), pickMonth: vi.fn() },
      ...buildBillsOverview({ cycleObligations: cycleItems, nextCycleObligations: nextItems, completed }),
    };
  },
}));

function renderWorkspace() {
  rowsState = [{ bill: bill("elec", "Electricity"), occurrence: elecLatest, account: undefined, category: undefined }];
  cyclesState = [elecNow, elecOld, elecLatest].map((occurrence) => ({ billId: "elec", occurrence }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<BillsWorkspace />, { wrapper: Wrapper });
}

afterEach(() => {
  cleanup();
  paymentCalls = [];
  window.localStorage.clear();
});

describe("Bills dashboard — Payments tab", () => {
  it("shows the four headlines exactly as the overview computed them", () => {
    renderWorkspace();
    // counted: 1,000 + 1,000 + 4,000 + 17,000 = 23,000 (the covered ₹2,000 EMI is not added); overdue 2,000; upcoming 600; paid 700
    expect(within(screen.getByTestId("bills-summary-due")).getByText(formatCurrency(23000))).toBeTruthy();
    expect(within(screen.getByTestId("bills-summary-overdue")).getByText(formatCurrency(2000))).toBeTruthy();
    expect(within(screen.getByTestId("bills-summary-upcoming")).getByText(formatCurrency(600))).toBeTruthy();
    expect(within(screen.getByTestId("bills-summary-paid")).getByText(formatCurrency(700))).toBeTruthy();
  });

  it("names the Month Cycle it is showing, not a calendar month", () => {
    renderWorkspace();
    expect(screen.getAllByText("18 Oct – 17 Nov").length).toBeGreaterThan(0);
  });

  it("every row names its source module and status", () => {
    renderWorkspace();
    const rows = screen.getAllByTestId("bills-row");
    const kinds = rows.map((r) => r.getAttribute("data-kind"));
    expect(new Set(kinds)).toEqual(new Set(["bill", "loan", "card"])); // the card-funded EMI is covered → collapsed, not a row yet
    const home = rows.find((r) => within(r).queryByText("Home Loan"))!;
    expect(within(home).getByText("Loan")).toBeTruthy();
    expect(within(home).getByText("Partially paid")).toBeTruthy();
    expect(within(home).getByText(/1,000 paid/)).toBeTruthy();
    const overdue = rows.filter((r) => within(r).queryByText("Overdue"));
    expect(overdue.length).toBe(2); // the in-cycle one and the carried one
  });

  it("an earlier cycle that is still unpaid is flagged, not hidden", () => {
    renderWorkspace();
    expect(screen.getAllByText("From an earlier cycle")).toHaveLength(1);
  });

  it("'Pay now' on a bill opens the existing Pay dialog for THAT row's cycle — not the bill's latest one", async () => {
    renderWorkspace();
    const oldRow = screen.getAllByTestId("bills-row").find((r) => within(r).queryByText("From an earlier cycle"))!;
    fireEvent.click(within(oldRow).getByRole("button", { name: "Pay now: Electricity" }));
    const dialog = await screen.findByRole("dialog", { name: "Pay dialog" });
    expect(dialog.textContent).toContain("paying e0"); // the old cycle, not e2 (latest) or e1
    expect(paymentCalls.some((c) => c.open && c.occurrenceId === "e2")).toBe(false);
  });

  it("loan and card rows hand off to the owning module's own pay flow instead of recording anything here", () => {
    renderWorkspace();
    const rows = screen.getAllByTestId("bills-row");
    const home = rows.find((r) => within(r).queryByText("Home Loan"))!;
    expect(within(home).getByRole("link", { name: "Pay: Home Loan" }).getAttribute("href")).toBe("/loans?agreement=home&installment=h1&pay=1");
    const card = rows.find((r) => r.getAttribute("data-kind") === "card")!;
    expect(within(card).getByRole("link", { name: "Pay bill: HDFC ••1234" }).getAttribute("href")).toBe("/credit-cards?card=card-1&pay=1");
  });

  it("a card-funded EMI installment is listed only under 'not added to totals' and offers no Pay", () => {
    renderWorkspace();
    expect(screen.queryByText("Phone EMI")).toBeNull(); // collapsed
    fireEvent.click(screen.getByRole("button", { name: /Included in a card bill or paid by someone else/ }));
    const row = screen.getAllByTestId("bills-row").find((r) => within(r).queryByText("Phone EMI"))!;
    expect(within(row).getByText("Not added to totals")).toBeTruthy();
    expect(within(row).queryByRole("link", { name: /Pay/ })).toBeNull();
    expect(within(row).getByRole("link", { name: "View Phone EMI" })).toBeTruthy();
  });

  it("filters narrow the list by type and status without changing the headline", () => {
    renderWorkspace();
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by type" })).getByRole("button", { name: /^Loans/ }));
    expect(screen.getAllByTestId("bills-row").map((r) => r.getAttribute("data-kind"))).toEqual(["loan"]);
    expect(within(screen.getByTestId("bills-summary-due")).getByText(formatCurrency(23000))).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Filter by type" })).getByRole("button", { name: /^All/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by status" })).getByRole("button", { name: "Overdue" }));
    expect(screen.getAllByTestId("bills-row")).toHaveLength(2);

    fireEvent.click(within(screen.getByRole("group", { name: "Filter by status" })).getByRole("button", { name: "Paid" }));
    expect(screen.queryAllByTestId("bills-row")).toHaveLength(0);
    expect(screen.getAllByTestId("bills-paid-row")).toHaveLength(1);
  });

  it("lists what was paid this cycle", () => {
    renderWorkspace();
    const paid = screen.getByTestId("bills-paid-row");
    expect(within(paid).getByText("Water")).toBeTruthy();
    expect(within(paid).getByText(formatCurrency(700))).toBeTruthy();
  });

  it("Grid view shows the same payments as cards with the same actions, and is remembered", async () => {
    renderWorkspace();
    const listKinds = screen.getAllByTestId("bills-row").map((r) => r.getAttribute("data-kind"));
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    const cards = screen.getAllByTestId("bills-row");
    expect(cards.map((r) => r.getAttribute("data-kind"))).toEqual(listKinds);
    const home = cards.find((r) => within(r).queryByText("Home Loan"))!;
    expect(within(home).getByRole("link", { name: "Pay: Home Loan" }).getAttribute("href")).toBe("/loans?agreement=home&installment=h1&pay=1");
    expect(screen.getAllByTestId("bills-paid-row")).toHaveLength(1);
    // the same exact-cycle Pay dialog opens from a card
    const oldCard = cards.find((r) => within(r).queryByText("From an earlier cycle"))!;
    fireEvent.click(within(oldCard).getByRole("button", { name: "Pay now: Electricity" }));
    expect((await screen.findByRole("dialog", { name: "Pay dialog" })).textContent).toContain("paying e0");
    expect(window.localStorage.getItem("flowfi.bills.view")).toBe("grid");
  });

  it("the 'My bills' tab still holds every bill for editing", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: /My bills/ }));
    await waitFor(() => expect(screen.getByRole("tabpanel")).toBeTruthy());
    expect(within(screen.getByRole("tabpanel")).getByText("Electricity")).toBeTruthy();
  });
});
