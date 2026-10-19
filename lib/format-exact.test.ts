// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";

/** D-03: the payment confirmation shows the amount that is actually debited. */
describe("formatCurrencyExact", () => {
  it("shows paise when the amount has them, whole rupees otherwise", () => {
    expect(formatCurrencyExact(5330.93)).toBe("₹5,330.93");
    expect(formatCurrencyExact(5331)).toBe("₹5,331");
    expect(formatCurrencyExact(0.07)).toBe("₹0.07");
    expect(formatCurrencyExact(120000.5)).toBe("₹1,20,000.50");
  });
  it("is display-only: the same value still rounds to the headline in formatCurrency", () => {
    expect(formatCurrency(5330.93)).toBe("₹5,331");
    const amount = 5330.93;
    formatCurrencyExact(amount);
    expect(amount).toBe(5330.93);
  });
});

describe("Money exact", () => {
  it("default keeps whole rupees (other Loan/EMI views unchanged); exact shows paise", () => {
    const plain = render(createElement(Money, { amount: 5330.93 }));
    expect(plain.container.textContent).toBe("₹5,331");
    const exact = render(createElement(Money, { amount: 5330.93, exact: true }));
    expect(exact.container.textContent).toBe("₹5,330.93");
    const whole = render(createElement(Money, { amount: 5331, exact: true }));
    expect(whole.container.textContent).toBe("₹5,331");
  });
});
