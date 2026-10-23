// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCurrency } from "@/lib/format";
import { MyMoneyCompactBar } from "./my-money-compact-bar";
import type { MyMoneyData } from "@/features/my-money/hooks/use-my-money-data";
import type { ObligationItem } from "@/features/my-money/lib/my-money";

/**
 * The My Money compact bar is presentational: every figure, label and handler comes from the page's own `data`. These
 * tests pin that it shows the same To pay figure and period label as the expanded header/summary, drives the same
 * `data.nav` handlers, surfaces `next` as a CTA, and stays out of the accessibility tree while hidden.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

function makeData(over: Partial<MyMoneyData> = {}): MyMoneyData {
  return {
    periodLabel: "Oct 2026",
    isCurrent: true,
    nav: { previous: vi.fn(), next: vi.fn(), current: vi.fn(), pickMonth: vi.fn() },
    toPay: { total: 5000, count: 2, overdue: 0, overdueCount: 0, dueSoon: 0, othersStillOwe: 0, next: null },
    ...over,
  } as unknown as MyMoneyData;
}

const NEXT_ITEM = { key: "k1", title: "Card bill", href: "/credit-cards", remaining: 2000, status: "upcoming" } as unknown as ObligationItem;

function renderBar(over: Partial<React.ComponentProps<typeof MyMoneyCompactBar>> = {}) {
  const data = over.data ?? makeData();
  const utils = render(
    <div className="flex flex-col">
      <MyMoneyCompactBar progress={1} reduceMotion={false} top={8} data={data} next={null} {...over} />
    </div>,
  );
  return { ...utils, data };
}
const bar = () => screen.getByRole("region", { name: "My Money quick bar" });
const barEl = () => document.querySelector<HTMLElement>("[data-compact-bar]")!;

afterEach(cleanup);

describe("My Money compact bar — content", () => {
  it("shows the page's own To pay total and period label", () => {
    renderBar();
    const b = within(bar());
    expect(b.getByText("My Money")).toBeTruthy();
    expect(b.getByText("Oct 2026")).toBeTruthy();
    expect(b.getByText(formatCurrency(5000))).toBeTruthy();
    expect(b.getByText("To pay")).toBeTruthy();
  });

  it("flags overdue To pay with the expense tone", () => {
    renderBar({ data: makeData({ toPay: { total: 5000, count: 2, overdue: 1200, overdueCount: 1, dueSoon: 0, othersStillOwe: 0, next: null } }) });
    expect(within(bar()).getByText(formatCurrency(5000)).className).toContain("text-expense");
  });

  it("shows nothing-due in success tone when count is 0", () => {
    renderBar({ data: makeData({ toPay: { total: 0, count: 0, overdue: 0, overdueCount: 0, dueSoon: 0, othersStillOwe: 0, next: null } }) });
    expect(within(bar()).getByText(formatCurrency(0)).className).toContain("text-success");
  });

  it("renders the next obligation as a CTA when present, and omits it when there is none", () => {
    renderBar({ next: NEXT_ITEM });
    expect(within(bar()).getByRole("link", { name: /Card bill/ })).toBeTruthy();
    cleanup();
    renderBar({ next: null });
    expect(within(bar()).queryByRole("link")).toBeNull();
  });

  it("only shows the jump-to-current control when not already on the current period", () => {
    renderBar({ data: makeData({ isCurrent: false }) });
    expect(within(bar()).getByRole("button", { name: "Jump to this month" })).toBeTruthy();
    cleanup();
    renderBar({ data: makeData({ isCurrent: true }) });
    expect(within(bar()).queryByRole("button", { name: "Jump to this month" })).toBeNull();
  });
});

describe("My Money compact bar — handlers", () => {
  it("period nav buttons call the page's own nav handlers", () => {
    const data = makeData();
    renderBar({ data });
    fireEvent.click(within(bar()).getByRole("button", { name: "Previous period" }));
    expect(data.nav.previous).toHaveBeenCalledTimes(1);
    fireEvent.click(within(bar()).getByRole("button", { name: "Next period" }));
    expect(data.nav.next).toHaveBeenCalledTimes(1);
  });

  it("jump-to-current calls data.nav.current", () => {
    const data = makeData({ isCurrent: false });
    renderBar({ data });
    fireEvent.click(within(bar()).getByRole("button", { name: "Jump to this month" }));
    expect(data.nav.current).toHaveBeenCalledTimes(1);
  });
});

describe("My Money compact bar — accessibility", () => {
  it("is inert, aria-hidden and out of the accessibility tree while hidden", () => {
    renderBar({ progress: 0 } as Partial<React.ComponentProps<typeof MyMoneyCompactBar>>);
    expect(screen.queryByRole("region", { name: "My Money quick bar" })).toBeNull();
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the measured top it is given", () => {
    render(
      <div className="flex flex-col">
        <MyMoneyCompactBar progress={1} reduceMotion={false} top={-16} data={makeData()} next={null} />
      </div>,
    );
    expect(barEl().parentElement!.style.top).toBe("-16px");
  });
});
