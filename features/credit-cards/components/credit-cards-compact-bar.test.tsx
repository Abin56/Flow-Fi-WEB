// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCurrency } from "@/lib/format";
import { CreditCardsCompactBar } from "./credit-cards-compact-bar";

/**
 * The Credit Cards compact bar is presentational: every figure and handler comes from the page. These tests pin that it
 * shows exactly what it is given, calls the page's handlers, keeps Export statements disabled, and stays out of the
 * accessibility tree while hidden.
 */

const handlers = () => ({ onAdd: vi.fn(), onViewStatements: vi.fn(), onManageCards: vi.fn() });

function renderBar(over: Partial<React.ComponentProps<typeof CreditCardsCompactBar>> = {}) {
  const h = handlers();
  const utils = render(
    <div className="flex flex-col">
      <CreditCardsCompactBar progress={1} reduceMotion={false} top={8} creditUsed={123456} utilizationPercent={42} available={176544} {...h} {...over} />
    </div>,
  );
  return { ...utils, ...h };
}
const bar = () => screen.getByRole("region", { name: "Credit Cards quick bar" });
const barEl = () => document.querySelector<HTMLElement>("[data-compact-bar]")!;

afterEach(cleanup);

describe("Credit Cards compact bar — content", () => {
  it("shows the page's own Credit used, utilization % and Available, formatted by the page's formatter", () => {
    renderBar();
    const b = within(bar());
    expect(b.getByText("Credit Cards")).toBeTruthy();
    expect(b.getByText(formatCurrency(123456))).toBeTruthy();
    expect(b.getByText("42% used")).toBeTruthy();
    expect(b.getByText(formatCurrency(176544))).toBeTruthy();
    expect(b.getByText("Credit used")).toBeTruthy();
  });

  it("flags high utilization (≥80%) with the expense tone", () => {
    renderBar({ utilizationPercent: 91 });
    expect(within(bar()).getByText("91% used").className).toContain("text-expense");
  });

  it("narrow screens carry the % in the Credit used label so it is never dropped", () => {
    renderBar();
    expect(within(bar()).getByText(/· 42%/).className).toContain("sm:hidden");
  });
});

describe("Credit Cards compact bar — handlers", () => {
  it("Add Card calls the page's openAdd once", () => {
    const { onAdd } = renderBar();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add Card" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("More: View statements and Manage cards call the page's scroll handlers; Export statements stays disabled and Soon", async () => {
    const { onViewStatements, onManageCards } = renderBar();
    const trigger = within(bar()).getByRole("button", { name: "More actions" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /View statements/ }));
    expect(onViewStatements).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage cards/ }));
    expect(onManageCards).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(trigger, { key: "Enter" });
    const exportItem = await screen.findByRole("menuitem", { name: /Export statements/ });
    expect(exportItem.getAttribute("aria-disabled")).toBe("true");
    expect(exportItem.textContent).toContain("Soon");
    fireEvent.click(exportItem);
    expect(onViewStatements).toHaveBeenCalledTimes(1);
    expect(onManageCards).toHaveBeenCalledTimes(1);
  });
});

describe("Credit Cards compact bar — accessibility", () => {
  it("is inert, aria-hidden and out of the accessibility tree while hidden", () => {
    renderBar({ progress: 0 });
    expect(screen.queryByRole("region", { name: "Credit Cards quick bar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Card" })).toBeNull();
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().getAttribute("aria-hidden")).toBe("true");
  });

  it("is not interactive while still sliding in (progress < 0.5)", () => {
    renderBar({ progress: 0.3 });
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().style.visibility).toBe("visible");
  });

  it("slides (translate, opaque) and never fades", () => {
    renderBar({ progress: 0.6 });
    expect(barEl().style.opacity).toBe("");
    expect(barEl().style.transform).toContain("translateY(");
  });

  it("reduced motion: no slide, appears at once", () => {
    renderBar({ progress: 0.6, reduceMotion: true });
    expect(barEl().style.transform).toBe("");
    expect(barEl().style.visibility).toBe("visible");
    cleanup();
    renderBar({ progress: 0.3, reduceMotion: true });
    expect(barEl().style.visibility).toBe("hidden");
  });

  it("stays shown while its menu is open, even when progress says hide", async () => {
    const { rerender, ...h } = renderBar();
    fireEvent.keyDown(within(bar()).getByRole("button", { name: "More actions" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: /View statements/ });
    rerender(
      <div className="flex flex-col">
        <CreditCardsCompactBar progress={0} reduceMotion={false} top={8} creditUsed={123456} utilizationPercent={42} available={176544} {...h} />
      </div>,
    );
    await waitFor(() => expect(barEl().hasAttribute("inert")).toBe(false));
  });

  it("keeps the measured top it is given", () => {
    renderBar({ top: -16 });
    expect(barEl().parentElement!.style.top).toBe("-16px");
  });
});
