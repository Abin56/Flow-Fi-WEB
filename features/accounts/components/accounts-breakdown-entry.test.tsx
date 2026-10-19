// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsStats } from "./accounts-stats";
import { AccountTile } from "./account-tile";
import type { AccountOverviewItem } from "@/features/accounts/hooks/use-accounts-data";

/** Every balance on the Accounts screen has a visible, labelled way into the breakdown — and it is not the tile's own select. */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/features/accounts/hooks/use-accounts-data", () => ({
  useAccountsStats: () => ({ stats: { totalBalance: 42237, totalInBanks: 42237, cashOnHand: 0 }, isLoading: false }),
}));

afterEach(cleanup);

const item = { id: "sbi", name: "SBI", typeLabel: "Savings Account", bankId: null, mask: "5568", balance: 42237, balanceLabel: "Current balance", cardStyle: "compact", color: "blue" } as AccountOverviewItem;

describe("Accounts → breakdown entry points", () => {
  it("Total balance: the 'View breakdown' button and the amount both open the total scope", () => {
    const onExplain = vi.fn();
    render(<AccountsStats accountCount={2} onExplain={onExplain} />);
    fireEvent.click(screen.getByRole("button", { name: "View breakdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Explain total balance" }));
    expect(onExplain).toHaveBeenNthCalledWith(1, { kind: "total" });
    expect(onExplain).toHaveBeenNthCalledWith(2, { kind: "total" });
  });

  it("In banks / Cash on hand open their own scopes", () => {
    const onExplain = vi.fn();
    render(<AccountsStats onExplain={onExplain} />);
    fireEvent.click(screen.getByRole("button", { name: "Explain in banks" }));
    fireEvent.click(screen.getByRole("button", { name: "Explain cash on hand" }));
    expect(onExplain).toHaveBeenNthCalledWith(1, { kind: "banks" });
    expect(onExplain).toHaveBeenNthCalledWith(2, { kind: "cash" });
  });

  it.each(["grid", "list"] as const)("%s tile: Breakdown opens the breakdown without selecting the account", (variant) => {
    const onExplain = vi.fn();
    const onSelect = vi.fn();
    render(<AccountTile variant={variant} account={item} active={false} onSelect={onSelect} onExplain={onExplain} />);
    fireEvent.click(screen.getByRole("button", { name: "View SBI balance breakdown" }));
    expect(onExplain).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
