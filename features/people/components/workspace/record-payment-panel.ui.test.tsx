// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record Payment — UI regression for the redesigned presentation. The figures are the engine's
 * (`allocatePayment` / `planExtraAllocation` / `reconcilePayment`); these tests only pin that the new
 * layout shows them, keeps every option reachable by keyboard, and saves exactly what it did before.
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
const summary = () => within(screen.getByRole("complementary", { name: "Payment summary" }));
const summaryValue = (label: string) => summary().getByText(label).closest("div")!.querySelector("dd")!.textContent;
const cta = () => screen.getByRole("button", { name: /^Record|Save changes|Saving/ });

describe("Record Payment — redesigned UI", () => {
  it("1/11/14. nothing owed: calm empty state, full amount remaining, unassigned when no destination", async () => {
    const { user } = setup();
    expect(screen.getByText("Nothing to receive from AMMA right now")).toBeTruthy();
    await user.type(amountInput(), "5000");
    expect(screen.getByTestId("rp-hero-amount").textContent).toMatch(/5,000/);
    expect(screen.getAllByText(/received from AMMA/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "What should happen to this money?" })).toBeTruthy();
    // Default (unchanged): the whole remainder is kept as advance.
    expect((screen.getByRole("radio", { name: /Keep as advance/ }) as HTMLInputElement).checked).toBe(true);
    expect(summaryValue("Advance")).toMatch(/5,000/);
    expect(summaryValue("Unassigned")).toMatch(/0/);
    // Removing the only destination leaves it unassigned and the save gate closes.
    await user.click(screen.getByRole("button", { name: /Remove Advance from AMMA/ }));
    expect(summaryValue("Unassigned")).toMatch(/5,000/);
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
  });

  it("2/3/12. obligations: selected rows, partial settlement, fully allocated", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000, 1500, "theyOwe", 19), obligation("ledger:emi", "EMI · October", 1667, 1667, "theyOwe", 21)];
    const { user, onSubmit } = setup();
    expect(screen.getByText("Settle what AMMA owes you")).toBeTruthy();
    expect(screen.getByText(/of ₹1,500/)).toBeTruthy();
    await user.type(amountInput(), "1500");
    expect(screen.getByText("Partially paid")).toBeTruthy();
    expect(screen.getByText("Paid in full")).toBeTruthy();
    expect(screen.queryByText("What should happen to this money?")).toBeNull();
    expect(summaryValue("Settled obligations")).toMatch(/1,500/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.map((l) => [l.key, l.amount])).toEqual([
      ["ledger:kseb", 1000],
      ["ledger:emi", 500],
    ]);
    expect(input.extra).toBeNull();
  });

  it("4. keep as advance saves an advance extra", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "2000");
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toEqual({ kind: "advance", amount: 2000 });
  });

  it("5. record as income needs a category, then saves income (alongside a settled item, per the existing gate)", async () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000)];
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "3000");
    await user.click(screen.getByRole("radio", { name: /Record as income/ }));
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Category *"), "gift");
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toMatchObject({ kind: "income", amount: 2000, categoryId: "gift" });
    expect(onSubmit.mock.calls[0][0].lines).toHaveLength(1);
  });

  it("13. existing gate: income alone, with nothing settled, still can't be saved", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "2000");
    await user.click(screen.getByRole("radio", { name: /Record as income/ }));
    await user.selectOptions(screen.getByLabelText("Category *"), "gift");
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("6/7/8/9/10. purposes: primary fields, more details, link, multiple purposes and totals", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "5000");
    await user.click(screen.getByRole("radio", { name: /Set aside for something/ }));
    await user.type(screen.getByLabelText("What is this money for? *"), "KSEB bill");
    const purposeAmount = screen.getByLabelText("Purpose amount");
    await user.clear(purposeAmount);
    await user.type(purposeAmount, "3000");
    // Optional details are behind "More details".
    expect(screen.queryByLabelText("Date to use it by")).toBeNull();
    await user.click(screen.getByRole("button", { name: /More details/ }));
    await user.type(screen.getByLabelText("Date to use it by"), "10102026");
    expect(screen.getByRole("option", { name: "Not linked — standalone purpose" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Connect to FlowFi item"), "bill");
    await user.selectOptions(screen.getByLabelText("Bill"), "bill:kseb");
    expect(summaryValue("Unassigned")).toMatch(/2,000/);
    // Second purpose takes what's still available.
    await user.click(screen.getByRole("button", { name: /Edit KSEB bill/ }));
    await user.click(screen.getByRole("button", { name: "Add another purpose" }));
    await user.type(screen.getByLabelText("What is this money for? *"), "Bank loan");
    expect(screen.getByText("Fully assigned")).toBeTruthy();
    expect(summaryValue("Set aside")).toMatch(/5,000/);
    expect(summary().getByText("KSEB bill")).toBeTruthy();
    expect(summary().getByText("Bank loan")).toBeTruthy();
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.purposes?.map((p) => [p.title, p.amount, p.dueDate?.getDate() ?? null, p.link?.id ?? null])).toEqual([
      ["KSEB bill", 3000, 10, "kseb"],
      ["Bank loan", 2000, null, null],
    ]);
    expect(input.extra).toBeNull();
  });

  it("H. split remainder: purpose + income, both saved", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "5000");
    await user.click(screen.getByRole("radio", { name: /Set aside for something/ }));
    await user.type(screen.getByLabelText("What is this money for? *"), "KSEB bill");
    await user.clear(screen.getByLabelText("Purpose amount"));
    await user.type(screen.getByLabelText("Purpose amount"), "3000");
    await user.click(screen.getByRole("button", { name: "Add income" }));
    await user.selectOptions(screen.getByLabelText("Category *"), "gift");
    expect(screen.getByText(/Split across 2 destinations/)).toBeTruthy();
    expect(summaryValue("Income")).toMatch(/2,000/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.extra).toMatchObject({ kind: "income", amount: 2000 });
    expect(input.purposes?.[0]).toMatchObject({ title: "KSEB bill", amount: 3000 });
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
    expect(screen.getByText("Settle what you owe AMMA")).toBeTruthy();
    await user.type(amountInput(), "1000");
    expect(screen.queryByRole("radio", { name: /Record as income/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Set aside/ })).toBeNull();
    expect(cta().textContent).toMatch(/Record ₹1,000 paid/);
  });

  it("16. keyboard: decision cards are a native radio group reachable by Tab and arrows", async () => {
    const { user } = setup();
    await user.type(amountInput(), "500");
    const advance = screen.getByRole("radio", { name: /Keep as advance/ });
    advance.focus();
    await user.keyboard("{ArrowRight}");
    expect((screen.getByRole("radio", { name: /Record as income/ }) as HTMLInputElement).checked).toBe(true);
    await user.keyboard("{ArrowRight}");
    expect((screen.getByRole("radio", { name: /Set aside for something/ }) as HTMLInputElement).checked).toBe(true);
    // Arrowing back restores, it doesn't lose, the earlier choice's draft.
    await user.type(screen.getByLabelText("What is this money for? *"), "Gift");
    screen.getByRole("radio", { name: /Set aside for something/ }).focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect((screen.getByLabelText("What is this money for? *") as HTMLInputElement).value).toBe("Gift");
  });

  it("18. Cancel / Close call onCancel and never save", async () => {
    const { user, onCancel, onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("19. layout: single column first, summary after the form, rows stack figures on phones", () => {
    payable = [obligation("ledger:kseb", "KSEB", 1000)];
    setup();
    const form = screen.getByRole("form");
    const aside = screen.getByRole("complementary", { name: "Payment summary" });
    expect(form.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(aside.previousElementSibling?.contains(screen.getByText("Settle what AMMA owes you"))).toBe(true);
    expect(aside.parentElement!.className).toMatch(/lg:grid-cols/);
    expect(document.querySelector("table")).toBeNull();
  });

  it("20. render and interactions don't save; edit opens with the existing advance/income split", async () => {
    const { user, onSubmit } = setup({
      initial: { paymentId: "p1", direction: "theyPaid", amount: 3000, accountId: "sbi", date: D, lines: {}, advance: 1000, income: { amount: 2000, categoryId: "gift", description: "Gift" } },
    });
    expect(screen.getByText(/Split across 2 destinations/)).toBeTruthy();
    expect(summaryValue("Advance")).toMatch(/1,000/);
    expect(summaryValue("Income")).toMatch(/2,000/);
    await user.click(screen.getByRole("button", { name: /Edit Gift/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit.mock.calls[0][1]).toBe("p1");
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 3000, extra: { kind: "advance", amount: 1000 }, extras: [{ kind: "income", amount: 2000 }] });
  });
});
