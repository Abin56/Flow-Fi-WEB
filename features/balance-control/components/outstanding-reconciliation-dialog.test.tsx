// @vitest-environment jsdom
/**
 * The compact outstanding / available-credit reconciliation dialog: a one-sentence summary with the right direction,
 * plain-language reasons that are still the engine's cause codes under its eligibility rules, exactly one next step
 * per reason (always an existing workflow, never a write), optional details, keyboard selection, and a fresh state
 * on reopen. Pure render + navigation — the component has no write path.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => <a {...rest}>{children}</a> }));

import type { ReconciliationCardContext } from "../lib/build-balance-control";
import { OutstandingReconciliationSheet, type OutstandingReconciliationSheetProps } from "./outstanding-reconciliation-sheet";

const CTX: ReconciliationCardContext = { cardAccountId: "acct-1", lockedEmiPrincipal: 0, onSharedLimit: false, hasOpeningBalance: false };

function show(overrides: Partial<OutstandingReconciliationSheetProps> = {}) {
  const props: OutstandingReconciliationSheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    productName: "Octane •••• 0282",
    metric: "totalOutstanding",
    flowfiValue: 47816.52,
    bankValue: 40000,
    asOfDate: new Date("2026-10-29T12:00:00"),
    context: CTX,
    transactions: [],
    ...overrides,
  };
  render(<OutstandingReconciliationSheet {...props} />);
  return props;
}
const sheet = () => screen.getByTestId("outstanding-reconciliation-sheet");
const causeIds = () => within(screen.getByTestId("cause-list")).getAllByRole("radio").map((b) => b.getAttribute("data-testid"));
const pick = (cause: string) => fireEvent.click(screen.getByTestId(`cause-${cause}`));

afterEach(() => cleanup());

describe("summary", () => {
  it("bank lower than FlowFi: exact gap, 'less', payment-side reasons only", () => {
    show();
    expect(screen.getByTestId("reconcile-difference").textContent).toBe("₹7,816.52");
    expect(screen.getByTestId("reconcile-summary").textContent).toBe("Your bank shows ₹7,816.52 less outstanding than FlowFi.");
    expect(causeIds()).toEqual(["cause-missingPayment", "cause-refundOrCredit", "cause-cardEmiOrSharedLimit", "cause-statementTiming", "cause-unknown"]);
    expect(screen.getByTestId("cause-missingPayment").textContent).toMatch(/I made a payment/);
    expect(screen.getByTestId("cause-unknown").textContent).toMatch(/I'm not sure/);
  });

  it("bank higher than FlowFi: 'more', charge-side reasons, never payment/refund", () => {
    show({ bankValue: 48516.52 });
    expect(screen.getByTestId("reconcile-summary").textContent).toBe("Your bank shows ₹700.00 more outstanding than FlowFi.");
    const ids = causeIds();
    expect(ids).toContain("cause-missingPurchase");
    expect(ids).toContain("cause-interestCharge");
    expect(ids).not.toContain("cause-missingPayment");
    expect(ids).not.toContain("cause-refundOrCredit");
  });

  it("available credit keeps the bank's literal direction in words, and the mirrored reason list", () => {
    show({ metric: "availableCredit", flowfiValue: 25500, bankValue: 27000 });
    expect(screen.getByTestId("reconcile-summary").textContent).toBe("Your bank shows ₹1,500.00 more available credit than FlowFi.");
    // More available at the bank = less owed there → payment-side reasons.
    expect(causeIds()).toContain("cause-missingPayment");
  });

  it("equal figures: says they match and offers no reasons", () => {
    show({ bankValue: 47816.52 });
    expect(screen.getByTestId("reconcile-summary").textContent).toMatch(/same outstanding\. Nothing to reconcile/);
    expect(screen.queryByTestId("cause-list")).toBeNull();
  });
});

describe("one next step per reason", () => {
  it("nothing is shown until a reason is chosen", () => {
    show();
    expect(screen.queryByTestId("resolution-panel")).toBeNull();
  });

  it("missing payment → Record missing payment via Pay bill, never Add Expense", () => {
    show();
    pick("missingPayment");
    const link = within(screen.getByTestId("resolution-panel")).getByTestId("resolution-link-pay-bill");
    expect(link.textContent).toMatch(/Record missing payment/);
    expect(link.getAttribute("href")).toBe("/credit-cards?card=acct-1&pay=1");
    expect(screen.queryByTestId("resolution-link-add-expense")).toBeNull();
    expect(screen.getAllByTestId("resolution-panel")).toHaveLength(1);
  });

  it("refund → Add missing refund on this card's transactions", () => {
    show();
    pick("refundOrCredit");
    const link = screen.getByTestId("resolution-link-add-expense");
    expect(link.textContent).toMatch(/Add missing refund/);
    expect(link.getAttribute("href")).toBe("/transactions?account=acct-1");
  });

  it("missing purchase (bank higher) → Add missing purchase, with the change preview available", () => {
    show({ bankValue: 48516.52 });
    pick("missingPurchase");
    expect(screen.getByTestId("resolution-link-add-expense").textContent).toMatch(/Add missing purchase/);
    expect(screen.getByTestId("reconcile-impact-preview").textContent).toMatch(/Total outstanding/);
    expect(screen.getByTestId("reconcile-impact-preview").textContent).toMatch(/Stays unchanged: Transaction history/);
  });

  it("shared limit → plain label, explained, Review shared credit limit, no write link", () => {
    show({ context: { ...CTX, onSharedLimit: true } });
    expect(screen.getByTestId("cause-cardEmiOrSharedLimit").textContent).toMatch(/This card shares a credit limit/);
    pick("cardEmiOrSharedLimit");
    const panel = screen.getByTestId("resolution-panel");
    expect(panel.textContent).toMatch(/Nothing is changed/);
    expect(within(panel).getByTestId("resolution-link-shared-limit").getAttribute("href")).toBe("/credit-cards?card=acct-1");
    expect(screen.queryByTestId("resolution-link-add-expense")).toBeNull();
    expect(screen.queryByTestId("resolution-link-pay-bill")).toBeNull();
    expect(screen.queryByTestId("recon-more-impact")).toBeNull();
  });

  it("locked card-EMI → its own label and the locked amount in the hint", () => {
    show({ context: { ...CTX, lockedEmiPrincipal: 22816.52 } });
    pick("cardEmiOrSharedLimit");
    expect(screen.getByTestId("cause-cardEmiOrSharedLimit").textContent).toMatch(/An EMI is locked on this card.*₹22,816\.52/);
  });

  it("statement timing → 'The bank hasn't updated yet', no action", () => {
    show();
    expect(screen.getByTestId("cause-statementTiming").textContent).toMatch(/The bank hasn't updated yet/);
    pick("statementTiming");
    const panel = screen.getByTestId("resolution-panel");
    expect(panel.textContent).toMatch(/Nothing is changed/);
    expect(panel.querySelector("a")).toBeNull();
  });

  it("unknown → manual review notice and a View card transactions link", () => {
    show();
    pick("unknown");
    expect(screen.getByTestId("reconcile-review-notice")).toBeTruthy();
    expect(screen.getByTestId("resolution-link-view-transactions").getAttribute("href")).toBe("/transactions?account=acct-1");
  });
});

describe("interaction", () => {
  it("arrow keys move and select within the reasons", () => {
    show();
    const group = screen.getByTestId("cause-list");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(screen.getByTestId("cause-missingPayment").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(screen.getByTestId("cause-refundOrCredit").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByTestId("cause-refundOrCredit"));
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(screen.getByTestId("cause-missingPayment").getAttribute("aria-checked")).toBe("true");
  });

  it("recent transactions sit in a collapsed section", () => {
    show();
    const details = screen.getByTestId("recon-more-transactions");
    expect(details.tagName).toBe("DETAILS");
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toMatch(/None nearby/);
  });

  it("closing clears the chosen reason, so a reopen starts fresh", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <OutstandingReconciliationSheet open={open} onOpenChange={setOpen} productName="Card" metric="totalOutstanding" flowfiValue={100} bankValue={50} asOfDate={new Date()} context={CTX} transactions={[]} />
        </>
      );
    }
    render(<Harness />);
    pick("missingPayment");
    expect(screen.getByTestId("resolution-panel")).toBeTruthy();
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(screen.queryByTestId("outstanding-reconciliation-sheet")).toBeNull();
    fireEvent.click(screen.getByText("reopen"));
    expect(screen.queryByTestId("resolution-panel")).toBeNull();
  });
});
