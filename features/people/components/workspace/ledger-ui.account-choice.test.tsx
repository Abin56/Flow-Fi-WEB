// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountField, useAccountChoice } from "./ledger-ui";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    data: [
      { id: "sbi", name: "SBI", type: "bank", isDefault: true, deletedAt: null, currentBalance: 100000 },
      { id: "cash", name: "Cash", type: "cash", isDefault: false, deletedAt: null, currentBalance: 0 },
    ],
  }),
}));

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

function Harness({ outflow }: { outflow?: number | null }) {
  const choice = useAccountChoice();
  return (
    <>
      <AccountField choice={choice} label="Pay from account" outflow={outflow} />
      <output data-testid="chosen">{choice.accountId}</output>
    </>
  );
}

const choose = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name }));
};

describe("People paying-account choice", () => {
  it("never defaults to the default / first account — nothing is chosen until the user picks", () => {
    render(<Harness outflow={5000} />);
    expect(screen.getByTestId("chosen").textContent).toBe("");
    expect(screen.queryByTestId("payment-source-summary")).toBeNull();
  });

  it("shows balance → payment → after once chosen; a payment equal to the balance is fine", async () => {
    const user = userEvent.setup();
    render(<Harness outflow={100000} />);
    await choose(user, /SBI/);
    expect(screen.getByTestId("chosen").textContent).toBe("sbi");
    expect(screen.getByTestId("payment-source-summary").textContent).toContain("₹1,00,000");
    expect(screen.getByTestId("payment-source-after").textContent).toBe("₹0");
    expect(screen.queryByTestId("payment-source-insufficient")).toBeNull();
  });

  it("zero-balance account: insufficient is called out with the shortfall", async () => {
    const user = userEvent.setup();
    render(<Harness outflow={2500} />);
    await choose(user, /Cash/);
    expect(screen.getByTestId("payment-source-insufficient").textContent).toContain("short by ₹2,500");
  });

  it("money received shows no funds preview at all", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await choose(user, /SBI/);
    expect(screen.queryByTestId("payment-source-summary")).toBeNull();
  });
});
