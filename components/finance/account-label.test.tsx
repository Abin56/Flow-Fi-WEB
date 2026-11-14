// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountLabel, AccountMark, AccountSelect, accountKind, groupAccountsByKind, isCreditCardAccount } from "./account-label";

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
});
