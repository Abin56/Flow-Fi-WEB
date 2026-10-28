// @vitest-environment jsdom
/**
 * Balance Control's credit-limit correction surfaces: the "Correct" button only appears where a correction is
 * actually meaningful (a real, fixable limit gap on a product that has a write target), the sheet validates
 * before enabling Apply, and it calls the repository action with exactly what the user entered. Pure render
 * tests — the write path itself is covered end-to-end against a real emulator in
 * `tests/integration/credit-limit-correction.test.ts`.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordCorrection = vi.fn();
const historyFor = vi.fn();
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(() => ({})), query: vi.fn(() => ({})), limit: vi.fn(() => ({})), getDocsFromServer: vi.fn() }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/layout/scroll-nav", () => ({ ScrollNav: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../hooks/use-limit-correction", () => ({
  useLimitCorrection: () => ({ recordCorrection, reverseCorrection: vi.fn(), historyFor }),
}));

import type { VarianceProduct } from "../lib/build-balance-control";
import { BalanceControlView } from "./balance-control-workspace";

const q = (id: string) => screen.queryByTestId(id);

function cardProduct(overrides: Partial<VarianceProduct> = {}): VarianceProduct {
  return {
    id: "card:c1",
    kind: "card",
    name: "QA Card",
    subtitle: "Credit card",
    metrics: ["creditLimit"],
    flowfi: { creditLimit: 50000 },
    notes: {},
    context: { lockedEmiPrincipal: 0 },
    crossEffect: null,
    limitCorrectionTarget: { kind: "card", cardId: "c1" },
    reconciliation: null,
    ...overrides,
  };
}

beforeEach(() => {
  recordCorrection.mockReset();
  historyFor.mockReset();
  historyFor.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("Correct button visibility", () => {
  it("does not show while nothing is typed (classification notEntered)", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    expect(q("correct-limit-button")).toBeNull();
  });

  it("does not show when the typed figure matches FlowFi's", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(screen.getByTestId("bank-input"), { target: { value: "50000" } });
    expect(q("correct-limit-button")).toBeNull();
  });

  it("shows once a different bank limit is typed", () => {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(screen.getByTestId("bank-input"), { target: { value: "60000" } });
    expect(q("correct-limit-button")).not.toBeNull();
  });

  it("never shows for a product with no correction target (loan/EMI)", () => {
    const loan = cardProduct({ id: "loan:l1", kind: "loan", metrics: ["creditLimit"], limitCorrectionTarget: null });
    render(<BalanceControlView products={[loan]} isLoading={false} isError={false} reachability="reachable" />);
    fireEvent.change(screen.getByTestId("bank-input"), { target: { value: "60000" } });
    expect(q("correct-limit-button")).toBeNull();
  });
});

describe("correction sheet", () => {
  async function openSheet() {
    render(<BalanceControlView products={[cardProduct()]} isLoading={false} isError={false} reachability="reachable" />);
    await act(async () => {
      fireEvent.change(screen.getByTestId("bank-input"), { target: { value: "60000" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("correct-limit-button"));
    });
  }

  it("pre-fills the bank figure already typed in the variance row", async () => {
    await openSheet();
    expect((screen.getByTestId("correction-new-value") as HTMLInputElement).value).toBe("60000");
  });

  it("disables Apply until a reason is chosen", async () => {
    await openSheet();
    fireEvent.change(screen.getByTestId("correction-effective-date"), { target: { value: "2026-10-01" } });
    expect((screen.getByTestId("correction-apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("correction-reason-bankIncreased"));
    expect((screen.getByTestId("correction-apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Apply for a zero or blank new limit", async () => {
    await openSheet();
    fireEvent.change(screen.getByTestId("correction-new-value"), { target: { value: "0" } });
    fireEvent.change(screen.getByTestId("correction-effective-date"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByTestId("correction-reason-bankIncreased"));
    expect((screen.getByTestId("correction-apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies with exactly the entered target, previous and new limit, reason and date", async () => {
    recordCorrection.mockResolvedValue({ status: "applied", correction: {} });
    await openSheet();
    fireEvent.change(screen.getByTestId("correction-effective-date"), { target: { value: "2026-10-05" } });
    fireEvent.click(screen.getByTestId("correction-reason-bankIncreased"));
    fireEvent.change(screen.getByTestId("correction-note"), { target: { value: "SMS from bank" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("correction-apply"));
    });
    expect(recordCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "card", cardId: "c1" },
        previousLimit: 50000,
        newLimit: 60000,
        reason: "bankIncreased",
        note: "SMS from bank",
      }),
    );
  });

  it("shows the server's error and keeps the sheet open on failure", async () => {
    recordCorrection.mockRejectedValue(new Error("The limit changed to ₹55,000 elsewhere"));
    await openSheet();
    fireEvent.change(screen.getByTestId("correction-effective-date"), { target: { value: "2026-10-05" } });
    fireEvent.click(screen.getByTestId("correction-reason-bankIncreased"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("correction-apply"));
    });
    expect(screen.getByTestId("correction-error").textContent).toMatch(/changed to ₹55,000 elsewhere/);
    expect(q("limit-correction-sheet")).not.toBeNull();
  });
});
