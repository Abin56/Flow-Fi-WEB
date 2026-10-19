// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallmentPeoplePanel } from "@/features/loans/components/installment-people-panel";
import type { InstallmentBreakdown } from "@/lib/engines/installment-participants";

vi.mock("next/link", () => ({
  default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={String(href)} {...rest}>
        {children}
      </a>
    );
  }),
}));
vi.mock("@/features/people/hooks/use-payment-deferrals", () => ({ usePersonPaymentDeferrals: () => ({ deferrals: [], isLoading: false }) }));
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => 1 }));

const line = (remaining: number) => ({
  key: "emi-inst:i1", installmentId: "i1", sequenceNumber: 1, dueDate: new Date(2026, 9, 5), share: 3000, received: 3000 - remaining, remaining, state: remaining > 0 ? ("pending" as const) : ("received" as const),
});
const breakdown = (advanceHeld: number, remaining = 3000): InstallmentBreakdown => ({
  installmentAmount: 9000, lenderPaid: 0, lenderRemaining: 9000, yourShare: 3000, othersOwe: remaining,
  participants: [{ personId: "shan", personName: "Shan", current: line(remaining), carried: [], outstanding: remaining, advanceHeld }],
});

afterEach(cleanup);

describe("InstallmentPeoplePanel — held advance", () => {
  it("names the held advance, says it is not applied, and links to People's Apply advance for this obligation", () => {
    render(<InstallmentPeoplePanel breakdown={breakdown(3000)} loading={false} />);
    expect(screen.getByTestId("advance-shan").textContent).toMatch(/Holding ₹3,000 advance from Shan — not applied to this share yet/);
    const link = screen.getByRole("link", { name: /Apply Shan's .*advance in People/ });
    const href = new URL(link.getAttribute("href")!, "http://x");
    expect(href.pathname).toBe("/people");
    expect(href.searchParams.get("person")).toBe("shan");
    expect(href.searchParams.get("applyAdvance")).toBe("1");
    expect(href.searchParams.get("obligation")).toBe("emi-inst:i1");
  });

  it("shows nothing when no advance is held, or when the share is already received", () => {
    const { rerender } = render(<InstallmentPeoplePanel breakdown={breakdown(0)} loading={false} />);
    expect(screen.queryByTestId("advance-shan")).toBeNull();
    rerender(<InstallmentPeoplePanel breakdown={breakdown(3000, 0)} loading={false} />);
    expect(screen.queryByTestId("advance-shan")).toBeNull();
  });
});
