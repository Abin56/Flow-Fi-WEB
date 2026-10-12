// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record Payment — UI regression for the one-screen workspace (money → what to pay now → the money left).
 * The figures are the engine's (`allocatePayment` / `planExtraAllocation` / `reconcilePayment`); these tests
 * only pin that the screen shows them, keeps every option reachable, and saves exactly what it did before.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [{ id: "gift", name: "Gift", type: "income", deletedAt: null }] }) }));
vi.mock("@/features/people/components/workspace/purpose-money", () => ({
  usePurposeLinkOptions: () => [
    { kind: "bill", id: "kseb", label: "KSEB" },
    { kind: "loan", id: "hdfc", label: "HDFC loan" },
  ],
}));

let payable: PayableObligation[] = [];
vi.mock("@/features/people/lib/person-payment-obligations", async (orig) => {
  const actual = await orig<typeof import("@/features/people/lib/person-payment-obligations")>();
  return { ...actual, settlementProjection: () => ({ payable, elsewhere: [] }) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);
beforeEach(() => {
  payable = [];
});

const D = new Date(2026, 8, 20);
function obligation(key: string, title: string, outstanding: number, amount = outstanding, side: "theyOwe" | "iOwe" = "theyOwe", day = 20): PayableObligation {
  const date = new Date(2026, 8, day);
  return {
    key,
    title,
    date,
    createdAt: date,
    amount,
    outstanding,
    side,
    typeLabel: "Shared expense",
    category: "gave",
    target: { kind: "entry", entry: { id: key.replace("ledger:", ""), sourceKind: "manual" }, max: outstanding } as never,
    isEmi: false,
    timing: "cycle",
  };
}

function setup(props: Partial<React.ComponentProps<typeof RecordPaymentPanel>> = {}) {
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <RecordPaymentPanel
      personName="AMMA"
      rows={[]}
      cycle={{ start: new Date(2026, 8, 18), end: new Date(2026, 9, 17) }}
      cycleLabel="18 Sep – 17 Oct 2026"
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { user, onSubmit, onCancel };
}

const amountInput = () => screen.getByLabelText(/^Amount (received|paid)$/);
const fig = (id: string) => screen.getByTestId(id).textContent;
const cta = () => screen.getByRole("button", { name: /^Record|Save changes|Saving/ });
const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const useFor = (i = 0) => screen.getAllByLabelText(/^Use for —/)[i] as HTMLSelectElement;

describe("Record Payment — one-screen workspace", () => {
  it("1/11/14. nothing owed: calm empty state, whole amount left to use, unassigned when no destination", async () => {
    const { user } = setup();
    expect(screen.getByText("Nothing to receive from AMMA right now")).toBeTruthy();
    await user.type(amountInput(), "5000");
    expect(fig("rp-hero-amount")).toMatch(/5,000/);
    // The default is visible right away, on the same screen: the whole amount kept as advance.
    expect(screen.getByRole("heading", { name: "What to do with the money left" })).toBeTruthy();
    expect(fig("rp-left-over")).toMatch(/5,000/);
    expect(useFor().value).toBe("advance");
    expect(valueOf("Advance amount")).toBe("5000");
    expect(fig("rp-advance")).toMatch(/5,000/);
    expect(fig("rp-unassigned")).toBe("₹0");
    // Removing the only destination leaves it unassigned and the save gate closes.
    await user.click(screen.getByRole("button", { name: /Remove Advance from AMMA/ }));
    expect(fig("rp-unassigned")).toMatch(/5,000/);
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    // One tap puts it back.
    await user.click(screen.getByRole("button", { name: "Keep as advance" }));
    expect(fig("rp-unassigned")).toBe("₹0");
  });

  it("2/3/12. obligations are rows with Full / Part / Skip; oldest first by default; partial settlement", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000, 1500, "theyOwe", 19), obligation("ledger:emi", "EMI · October", 1667, 1667, "theyOwe", 21)];
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "1500");
    expect(screen.getByRole("heading", { name: "Choose what to pay now" })).toBeTruthy();
    // No disclosure: every row is on screen.
    expect(screen.getByLabelText("Paying now for KSEB")).toBeTruthy();
    expect(fig("rp-applied")).toMatch(/1,500/);
    expect(fig("rp-still-owed")).toMatch(/1,167/);
    expect(screen.getByRole("button", { name: "Pay KSEB in full" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Pay part of EMI · October" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Paid in full")).toBeTruthy();
    expect(screen.getByText("₹1,167 left")).toBeTruthy();
    expect(screen.queryByText("What to do with the money left")).toBeNull();
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.map((l) => [l.key, l.amount])).toEqual([
      ["ledger:kseb", 1000],
      ["ledger:emi", 500],
    ]);
    expect(input.extra).toBeNull();
  });

  it("4. keep as advance saves an advance extra — no extra step", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "2000");
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toEqual({ kind: "advance", amount: 2000 });
  });

  it("4b. overpayment: ₹1,000 received on ₹200 owed → ₹200 applied, ₹800 left kept as advance", async () => {
    payable = [obligation("ledger:tea", "Tea", 200)];
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "1000");
    expect(fig("rp-applied")).toMatch(/200/);
    expect(fig("rp-left-over")).toMatch(/800/);
    expect(valueOf("Advance amount")).toBe("800");
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toEqual({ kind: "advance", amount: 800 });
  });

  it("5. add as income: switching the row's kind focuses the category; then saves income", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000)];
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "3000");
    await user.selectOptions(useFor(), "income");
    const category = screen.getByLabelText("Income category");
    expect(document.activeElement).toBe(category);
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(category, "gift");
    expect(fig("rp-income")).toMatch(/2,000/);
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toMatchObject({ kind: "income", amount: 2000, categoryId: "gift" });
    expect(onSubmit.mock.calls[0][0].lines).toHaveLength(1);
  });

  it("13. existing gate: income alone, with nothing settled, still can't be saved", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "2000");
    await user.selectOptions(useFor(), "income");
    await user.selectOptions(screen.getByLabelText("Income category"), "gift");
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("6/7/8/9/10. purposes: compact rows, details on request, link, multiple purposes and totals", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "5000");
    await user.selectOptions(useFor(), "purpose");
    expect(document.activeElement).toBe(screen.getByLabelText("What is this money for?"));
    await user.type(screen.getByLabelText("What is this money for?"), "KSEB bill");
    const purposeAmount = screen.getByLabelText("Purpose amount");
    await user.clear(purposeAmount);
    await user.type(purposeAmount, "3000");
    expect(screen.getByTestId("rp-left-status").textContent).toMatch(/2,000 not yet assigned/);
    // Optional details are behind the row's details toggle.
    expect(screen.queryByLabelText("Date to use it by")).toBeNull();
    await user.click(screen.getByRole("button", { name: /More details — KSEB bill/ }));
    await user.type(screen.getByLabelText("Date to use it by"), "10102026");
    expect(screen.getByRole("option", { name: "Not linked — standalone purpose" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Connect to FlowFi item"), "bill");
    await user.selectOptions(screen.getByLabelText("Bill"), "bill:kseb");
    expect(fig("rp-unassigned")).toMatch(/2,000/);
    // A second purpose takes what's still unassigned and gets focus — no panel, no Back.
    await user.click(screen.getByRole("button", { name: "Add another purpose" }));
    const titles = screen.getAllByLabelText("What is this money for?");
    expect(titles).toHaveLength(2);
    expect(document.activeElement).toBe(titles[1]);
    expect((screen.getAllByLabelText("Purpose amount")[1] as HTMLInputElement).value).toBe("2000");
    await user.type(titles[1], "Bank loan");
    expect(screen.getByTestId("rp-left-status").textContent).toBe("All assigned");
    expect(fig("rp-set-aside")).toMatch(/5,000/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.purposes?.map((p) => [p.title, p.amount, p.dueDate?.getDate() ?? null, p.link?.id ?? null])).toEqual([
      ["KSEB bill", 3000, 10, "kseb"],
      ["Bank loan", 2000, null, null],
    ]);
    expect(input.extra).toBeNull();
  }, 15_000); // the longest typing flow — headroom when the whole suite runs in parallel

  it("H. split remainder: purpose + income, both saved", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "5000");
    await user.selectOptions(useFor(), "purpose");
    await user.type(screen.getByLabelText("What is this money for?"), "KSEB bill");
    await user.clear(screen.getByLabelText("Purpose amount"));
    await user.type(screen.getByLabelText("Purpose amount"), "3000");
    await user.click(screen.getByRole("button", { name: "Add income" }));
    expect(valueOf("Income amount")).toBe("2000");
    await user.selectOptions(screen.getByLabelText("Income category"), "gift");
    // Only one income per payment: the kind can't be picked twice.
    expect(screen.queryByRole("button", { name: "Add income" })).toBeNull();
    expect(fig("rp-income")).toMatch(/2,000/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.extra).toMatchObject({ kind: "income", amount: 2000 });
    expect(input.purposes?.[0]).toMatchObject({ title: "KSEB bill", amount: 3000 });
  });

  it("H2. a single destination follows the money left when the amount changes; its choice is kept", async () => {
    const { user } = setup();
    await user.type(amountInput(), "1000");
    await user.selectOptions(useFor(), "income");
    await user.selectOptions(screen.getByLabelText("Income category"), "gift");
    await user.clear(amountInput());
    await user.type(amountInput(), "1500");
    expect(valueOf("Income amount")).toBe("1500");
    expect(valueOf("Income category")).toBe("gift");
    expect(fig("rp-unassigned")).toBe("₹0");
  });

  it("13/17. validation: Enter with no amount does not save; Enter with a valid form saves once", async () => {
    const { user, onSubmit } = setup();
    amountInput().focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("750{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("15. money paid: only advance is offered, CTA says paid", async () => {
    payable = [obligation("ledger:b", "Borrowed", 400, 400, "iOwe")];
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: /Money paid to AMMA/ }));
    await user.type(amountInput(), "1000");
    expect(screen.getByRole("heading", { name: "Choose what to pay now" })).toBeTruthy();
    expect(useFor().value).toBe("advance");
    expect(within(useFor()).queryByRole("option", { name: "Income" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add income|Add purpose/ })).toBeNull();
    expect(screen.getByText("Still owed to AMMA")).toBeTruthy();
    expect(cta().textContent).toMatch(/Record ₹1,000 paid/);
  });

  it("16. keyboard: row choices are buttons with pressed state; a destination's kind is a native select", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000)];
    const { user } = setup();
    await user.type(amountInput(), "500");
    const part = screen.getByRole("button", { name: "Pay part of KSEB" });
    part.focus();
    await user.keyboard("{Enter}");
    // Part focuses the row's amount, ready to type.
    expect(document.activeElement).toBe(screen.getByLabelText("Paying now for KSEB"));
    await user.keyboard("300");
    expect(fig("rp-applied")).toMatch(/300/);
    expect(fig("rp-left-over")).toMatch(/200/);
    // Native control: the platform's own keyboard and screen-reader behaviour.
    expect(useFor().tagName).toBe("SELECT");
  });

  it("18. Cancel / Close call onCancel and never save", async () => {
    const { user, onCancel, onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("19. layout: one screen — money, what to pay, the money left, then the pinned summary + action; no inner navigation", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000)];
    const { user } = setup();
    const form = screen.getByRole("form");
    const aside = screen.getByRole("complementary", { name: "Payment summary" });
    expect(aside.parentElement).toBe(form);
    expect(form.lastElementChild).toBe(aside);
    expect(document.querySelector("table")).toBeNull();
    await user.type(amountInput(), "1500");
    const settle = screen.getByRole("heading", { name: "Choose what to pay now" });
    const extra = screen.getByRole("heading", { name: "What to do with the money left" });
    expect(settle.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Done$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Payment allocation/ })).toBeNull();
  });

  it("20. render and interactions don't save; edit opens with the existing advance/income split", async () => {
    const { user, onSubmit } = setup({
      initial: { paymentId: "p1", direction: "theyPaid", amount: 3000, accountId: "sbi", date: D, lines: {}, advance: 1000, income: { amount: 2000, categoryId: "gift", description: "Gift" } },
    });
    expect(valueOf("Advance amount")).toBe("1000");
    expect(valueOf("Income amount")).toBe("2000");
    expect(fig("rp-advance")).toMatch(/1,000/);
    expect(fig("rp-income")).toMatch(/2,000/);
    // Nothing in the money-left section steals focus from the amount on open.
    expect(document.activeElement).toBe(amountInput());
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit.mock.calls[0][1]).toBe("p1");
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 3000, extra: { kind: "advance", amount: 1000 }, extras: [{ kind: "income", amount: 2000 }] });
  });
});
