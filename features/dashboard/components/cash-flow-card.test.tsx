// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CashFlowCard } from "./cash-flow-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCashFlow(income: number, expenses: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  const net = income - expenses;
  render(<CashFlowCard cashFlow={{ income, expenses, net, weeks: [{ label: "1-7", value: net, moneyIn: income, moneyOut: expenses }] }} />);
  return screen.getByRole("img", { name: /^Weekly cash flow/ });
}

it("shows the same paise-precise net in the monthly headline and weekly tooltip", () => {
  const chart = renderCashFlow(250, 250.25);
  expect(screen.getByText("-₹0.25")).toBeTruthy();
  expect(chart.getAttribute("aria-label")).toContain("out ₹250.25");

  fireEvent.mouseEnter(chart.querySelector("rect[fill=transparent]")!);
  expect(within(chart).getByText("−₹250.25")).toBeTruthy();
  expect(within(chart).getAllByText("-₹0.25")).toHaveLength(2);
});

it("draws equal inflow and outflow amounts at the same height", () => {
  const chart = renderCashFlow(1000, 1000);
  const height = (fill: string) => {
    const path = chart.querySelector(`path[fill="url(#cf-${fill})"]`)!;
    const [, base, end] = path.getAttribute("d")!.match(/^M [\d.]+ ([\d.]+) V [\d.]+ Q [\d.]+ ([\d.]+)/)!;
    return Math.abs(Number(base) - Number(end));
  };
  expect(height("in")).toBeCloseTo(height("out"));
});
