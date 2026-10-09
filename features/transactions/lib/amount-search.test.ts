import { describe, expect, it } from "vitest";
import { amountMatches, parseAmountQuery } from "./amount-search";

function matches(query: string, amount: number): boolean {
  const parsed = parseAmountQuery(query);
  if (!parsed) throw new Error(`"${query}" did not parse as an amount query`);
  return amountMatches(parsed, amount);
}

describe("parseAmountQuery", () => {
  it("returns null for plain text and empty input", () => {
    expect(parseAmountQuery("")).toBeNull();
    expect(parseAmountQuery("   ")).toBeNull();
    expect(parseAmountQuery("swiggy")).toBeNull();
    expect(parseAmountQuery("7-Eleven")).toBeNull();
    expect(parseAmountQuery(">")).toBeNull();
  });

  it("treats a bare number as a number query (text search still applies)", () => {
    expect(parseAmountQuery("500")?.kind).toBe("number");
    expect(parseAmountQuery(">500")?.kind).toBe("expression");
    expect(parseAmountQuery("100-200")?.kind).toBe("expression");
  });
});

describe("amountMatches", () => {
  it("matches a whole number against any paise of that rupee amount", () => {
    expect(matches("500", 500)).toBe(true);
    expect(matches("500", 500.75)).toBe(true);
    expect(matches("500", 501)).toBe(false);
    expect(matches("500", 50)).toBe(false);
  });

  it("matches a decimal exactly", () => {
    expect(matches("500.5", 500.5)).toBe(true);
    expect(matches("500.50", 500.5)).toBe(true);
    expect(matches("500.5", 500.75)).toBe(false);
  });

  it("ignores ₹, rs, commas and spaces", () => {
    expect(matches("₹1,250", 1250)).toBe(true);
    expect(matches("Rs. 1,25,000", 125000)).toBe(true);
    expect(matches("rs 99", 99)).toBe(true);
    expect(matches("> ₹1,000", 1500)).toBe(true);
  });

  it("supports comparison operators", () => {
    expect(matches(">500", 500.01)).toBe(true);
    expect(matches(">500", 500)).toBe(false);
    expect(matches(">=500", 500)).toBe(true);
    expect(matches("<500", 499.99)).toBe(true);
    expect(matches("<500", 500)).toBe(false);
    expect(matches("<=500", 500)).toBe(true);
    expect(matches("=500", 500)).toBe(true);
    expect(matches("=500", 500.5)).toBe(false);
  });

  it("supports inclusive ranges in any order and separator", () => {
    expect(matches("100-200", 100)).toBe(true);
    expect(matches("100-200", 200)).toBe(true);
    expect(matches("100-200", 200.01)).toBe(false);
    expect(matches("200-100", 150)).toBe(true);
    expect(matches("100..200", 150)).toBe(true);
    expect(matches("100 to 200", 150)).toBe(true);
    expect(matches("1,000 - 5,000", 2500)).toBe(true);
  });

  it("is immune to float noise", () => {
    expect(matches("=0.3", 0.1 + 0.2)).toBe(true);
  });
});
