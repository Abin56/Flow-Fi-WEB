// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AccountLabel, AccountMark, AccountSelect, accountKind, creditCardOption, groupAccountsByKind, isCreditCardAccount } from "./account-label";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const bank = { id: "sbi", name: "SBI Savings", type: "bank", cardSubtype: null, accountNumberLast4: "1111" };
const debit = { id: "dc", name: "SBI Debit", type: "card", cardSubtype: "debit", accountNumberLast4: "2222" };
const credit = { id: "cc", name: "Octane", type: "card", cardSubtype: "credit", accountNumberLast4: "3456" };

describe("account kinds", () => {
  it("only a card with cardSubtype credit is a credit card", () => {
    expect(accountKind(bank)).toBe("account");
    expect(accountKind(debit)).toBe("card");
    expect(accountKind({ type: "card", cardSubtype: null })).toBe("card");
    expect(accountKind(credit)).toBe("credit");
    expect(isCreditCardAccount({ type: "bank", cardSubtype: "credit" })).toBe(false);
  });

  it("groups bank/cash, then debit & other cards, then credit cards — keeping order inside each group", () => {
    const groups = groupAccountsByKind([credit, bank, debit, { ...bank, id: "cash", name: "Cash", type: "cash" }]);
    expect(groups.map((g) => g.kind)).toEqual(["account", "card", "credit"]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(["sbi", "cash"]);
  });

  it("drops empty groups", () => {
    expect(groupAccountsByKind([bank]).map((g) => g.kind)).toEqual(["account"]);
  });
});

describe("credit card presentation", () => {
  it("tags a credit card with a Credit label and a card mark; a bank account and a debit card get neither", () => {
    const { container, rerender } = render(<AccountLabel account={credit} />);
    expect(screen.getByText("Credit")).toBeTruthy();
    expect(container.querySelector("[data-credit-card-mark]")).not.toBeNull();
    rerender(<AccountLabel account={bank} />);
    expect(screen.queryByText("Credit")).toBeNull();
    expect(container.querySelector("[data-credit-card-mark]")).toBeNull();
    rerender(<AccountLabel account={debit} />);
    expect(screen.queryByText("Credit")).toBeNull();
  });

  it("a credit card with a bank logo gets the card badge on top of the logo", () => {
    const { container } = render(<AccountMark account={{ ...credit, bankId: "hdfc" }} size={20} />);
    expect(container.querySelector("[data-credit-card-mark] svg")).not.toBeNull();
  });
});

describe("AccountSelect sections", () => {
  it("lists credit cards under their own Credit cards heading, apart from bank accounts and debit cards, and still selects by id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AccountSelect accounts={[bank, debit, credit]} value="" onChange={onChange} ariaLabel="Account" />);
    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Bank & cash accounts")).toBeTruthy();
    expect(within(listbox).getByText("Debit & other cards")).toBeTruthy();
    expect(within(listbox).getByText("Credit cards")).toBeTruthy();
    expect(within(listbox).getAllByRole("option").map((o) => o.getAttribute("data-account-kind"))).toEqual(["account", "card", "credit"]);
    await user.click(within(listbox).getByRole("option", { name: /Octane/ }));
    expect(onChange).toHaveBeenCalledWith("cc");
  });

  it("shows no headings when every account is the same plain kind", async () => {
    const user = userEvent.setup();
    render(<AccountSelect accounts={[bank, { ...bank, id: "b2", name: "HDFC" }]} value="" onChange={() => {}} />);
    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).queryByText("Bank & cash accounts")).toBeNull();
  });

  it("uses the stored ARGB and legacy card colors in the list and keeps the swatch when a card is selected", async () => {
    const user = userEvent.setup();
    const octane = { ...credit, bankId: "sbi", colorValue: 0xffc62828 };
    const legacy = { ...debit, colorValue: 3 };
    function Harness() {
      const [value, setValue] = useState("");
      return <AccountSelect accounts={[bank, legacy, octane, { ...credit, id: "virtual", name: "Virtual card" }]} value={value} onChange={setValue} />;
    }

    render(<Harness />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    const list = within(await screen.findByRole("listbox"));
    const option = list.getByRole("option", { name: /Octane/ });
    expect(option.style.getPropertyValue("--account-card-color")).toBe("#c62828");
    expect(option.querySelector("img")?.getAttribute("src")).toMatch(/\/banks\/logos\/sbi\./);
    expect(list.getByRole("option", { name: /SBI Debit/ }).style.getPropertyValue("--account-card-color")).toBe("#0f766e");
    expect(list.getByRole("option", { name: /Virtual card/ }).style.getPropertyValue("--account-card-color")).toBe("");

    await user.keyboard("o{Enter}");
    expect(within(trigger).getByText("Octane")).toBeTruthy();
    expect(within(trigger).getByText("•••• 3456")).toBeTruthy();
    expect(trigger.querySelector<HTMLElement>("[data-account-kind=credit]")?.style.getPropertyValue("--account-card-color")).toBe("#c62828");
  });

  it("selects a card profile by its own ID and keeps the original empty choice available", async () => {
    const user = userEvent.setup();
    const option = creditCardOption({ id: "profile", issuer: "sbi", lastFourDigits: "9876" }, { ...credit, colorValue: 6 });
    const onChange = vi.fn();
    const { rerender } = render(<AccountSelect accounts={[option]} value="" onChange={onChange} placeholder="Choose card" clearable />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /Octane.*9876/ }));
    expect(onChange).toHaveBeenCalledWith("profile");

    rerender(<AccountSelect accounts={[option]} value="profile" onChange={onChange} placeholder="Choose card" clearable />);
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Choose card" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
