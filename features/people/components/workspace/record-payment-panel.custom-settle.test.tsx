// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record Payment — "pay only ₹X now" (the list total), Skip, amounts the user takes over, and the reminder.
 * AMMA owes ₹5,400 across three items and sends ₹29,800 into SBI; ₹4,000 settles (oldest first),
 * ₹1,400 stays owed, ₹25,800 is kept as advance.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "sbi", name: "SBI", isDefault: true, deletedAt: null }] }) }));
vi.mock("@/hooks/use-categories", () => ({ useCategories: () => ({ data: [{ id: "gift", name: "Gift", type: "income", deletedAt: null }] }) }));
vi.mock("@/features/people/components/workspace/purpose-money", () => ({ usePurposeLinkOptions: () => [] }));

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

function obligation(key: string, title: string, outstanding: number, day: number): PayableObligation {
  const date = new Date(2026, 8, day);
  return {
    key,
    title,
    date,
    createdAt: date,
    amount: outstanding,
    outstanding,
    side: "theyOwe",
    typeLabel: "Shared expense",
    category: "gave",
    target: { kind: "entry", entry: { id: key.replace("ledger:", ""), sourceKind: "manual" }, max: outstanding } as never,
    isEmi: false,
    timing: "cycle",
  };
}

beforeEach(() => {
  payable = [obligation("ledger:exam", "Exam", 1000, 18), obligation("ledger:loan", "Loan installment", 2000, 19), obligation("ledger:share", "Expense share", 2400, 20)];
});

function setup() {
  const onSubmit = vi.fn(async (_i: RecordPaymentInput, _id: string | null) => {});
  const onSetReminder = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <RecordPaymentPanel
      personName="AMMA"
      rows={[]}
      cycle={{ start: new Date(2026, 8, 17), end: new Date(2026, 9, 16) }}
      cycleLabel="17 Sep – 16 Oct 2026"
      cycleStartDay={17}
      onCancel={() => {}}
      onSubmit={onSubmit}
      onSetReminder={onSetReminder}
    />,
  );
  return { user, onSubmit, onSetReminder };
}

const amountInput = () => screen.getByLabelText(/^Amount received$/);
// The list's total: typing it pays that much in total, oldest first, across the chosen items.
const applyInput = () => screen.getByLabelText("Total paying now") as HTMLInputElement;
const cta = () => screen.getByRole("button", { name: /^Record|Saving/ });
const useFor = () => screen.getAllByLabelText(/^Use for —/)[0] as HTMLSelectElement;

describe("Record Payment — custom amount paying now", () => {
  it("₹29,800 received, ₹4,000 paying now: ₹1,400 still owed and ₹25,800 kept as advance — two separate numbers", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    // Default unchanged: pays everything due (₹5,400).
    expect(applyInput().value).toBe("5400");
    await user.clear(applyInput());
    await user.type(applyInput(), "4000");
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/1,400/);
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/25,800/);
    // Canonical oldest-first order — the share stays partial, nothing new is invented.
    expect(screen.getByText("₹1,400 left")).toBeTruthy();
    expect(screen.getAllByText("Paid in full")).toHaveLength(2);
    // On the same screen: the money left reads as kept as advance (the default, unchanged).
    expect(useFor().value).toBe("advance");
    expect((screen.getByLabelText("Advance amount") as HTMLInputElement).value).toBe("25800");
    await user.click(cta());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.amount).toBe(29800);
    expect(input.lines.map((l) => [l.key, l.amount])).toEqual([
      ["ledger:exam", 1000],
      ["ledger:loan", 2000],
      ["ledger:share", 1000],
    ]);
    expect(input.extra).toEqual({ kind: "advance", amount: 25800 });
  });

  it("validation explains instead of silently capping", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "3000");
    await user.clear(applyInput());
    await user.type(applyInput(), "4000");
    expect(screen.getByRole("alert").textContent).toMatch(/Only 3000\.00 was received/);
    expect(applyInput().value).toBe("4000");
    await user.clear(amountInput());
    await user.type(amountInput(), "29800");
    await user.clear(applyInput());
    await user.type(applyInput(), "6000");
    expect(screen.getByRole("alert").textContent).toMatch(/Only 5400\.00 is due/);
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    await user.click(cta());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Skip all settles nothing: the whole receipt goes through the money-left choice", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    await user.click(screen.getByRole("button", { name: "Skip all" }));
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/5,400/);
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/29,800/);
    expect(screen.getAllByText(/unpaid$/)).toHaveLength(3);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines).toEqual([]);
    expect(input.extra).toEqual({ kind: "advance", amount: 29800 });
  });

  it("Skip one item: the rest stay oldest first; the skipped one stays unpaid; its money joins the money left", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    await user.click(screen.getByRole("button", { name: "Skip Loan installment" }));
    expect(screen.getByRole("button", { name: "Skip Loan installment" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("₹2,000 unpaid")).toBeTruthy();
    expect(applyInput().value).toBe("3400");
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/2,000/);
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/26,400/);
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].lines.map((l) => l.key)).toEqual(["ledger:exam", "ledger:share"]);
  });

  it("reminder for what is still owed is saved only after the payment, once, on the still-open item", async () => {
    const { user, onSubmit, onSetReminder } = setup();
    await user.type(amountInput(), "29800");
    await user.clear(applyInput());
    await user.type(applyInput(), "4000");
    const picker = within(screen.getByRole("radiogroup", { name: "Reminder" }));
    await user.click(picker.getByRole("radio", { name: /Next cycle/ }));
    // Double click → one payment, one reminder write.
    await user.dblClick(cta());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSetReminder).toHaveBeenCalledTimes(1);
    const [targets, when] = onSetReminder.mock.calls[0] as unknown as [{ key: string }[], { kind: string; remindOn: Date }];
    expect(targets.map((t) => t.key)).toEqual(["ledger:share"]);
    expect(when.kind).toBe("nextCycle");
    expect(when.remindOn.getDate()).toBe(17);
  });

  it("per-item amounts take over from the custom total", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    await user.clear(applyInput());
    await user.type(applyInput(), "4000");
    const share = screen.getByLabelText("Paying now for Expense share");
    await user.clear(share);
    await user.type(share, "2400");
    expect(applyInput().value).toBe("5400");
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].extra).toEqual({ kind: "advance", amount: 24400 });
  });

  it("amounts the user took over stay when the received amount changes — an overflow is reported, never re-spread", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    await user.click(screen.getByRole("button", { name: "Pay part of Expense share" }));
    await user.keyboard("1000");
    expect(screen.getByRole("button", { name: "Oldest first" })).toBeTruthy();
    await user.clear(amountInput());
    await user.type(amountInput(), "3000");
    // Exam 1,000 + Loan 2,000 + Share 1,000 = 4,000 chosen against 3,000 received: blocked, values untouched.
    expect((screen.getByLabelText("Paying now for Expense share") as HTMLInputElement).value).toBe("1000");
    expect(screen.getByTestId("rp-blocker").textContent).toMatch(/more than the payment/);
    expect((cta() as HTMLButtonElement).disabled).toBe(true);
    // One tap back to the automatic order.
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(applyInput().value).toBe("3000");
    await user.click(cta());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("Record Payment — scope is what's due through the selected cycle", () => {
  beforeEach(() => {
    payable = [
      { ...obligation("ledger:prev", "August share", 1000, 10), date: new Date(2026, 7, 10), timing: "carried" },
      { ...obligation("emi-inst:oct", "EMI · October", 2000, 30), isEmi: true, timing: "cycle" },
      { ...obligation("emi-inst:nov", "EMI · November", 4000, 30), date: new Date(2026, 10, 30), isEmi: true, timing: "later" },
    ];
  });

  it("previous ₹1,000 + this cycle ₹2,000 = ₹3,000 due; the future ₹4,000 EMI is not selected", async () => {
    const { user, onSubmit } = setup();
    expect(screen.getByTestId("rp-due-total").textContent).toMatch(/3,000/);
    expect(screen.queryByLabelText("Paying now for EMI · November")).toBeNull(); // hidden behind "Show upcoming"
    await user.type(amountInput(), "5000");
    expect(screen.queryByLabelText("Paying now for EMI · November")).toBeNull();
    expect(screen.getByRole("button", { name: "Pay all due" }).getAttribute("aria-pressed")).toBe("true");
    expect(applyInput().value).toBe("3000");
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/2,000/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.map((l) => l.key)).toEqual(["ledger:prev", "emi-inst:oct"]);
    expect(input.extra).toEqual({ kind: "advance", amount: 2000 });
  });

  it("pay only ₹2,000: oldest first, ₹1,000 still owed on this cycle's EMI; reminder targets it", async () => {
    const { user, onSubmit, onSetReminder } = setup();
    await user.type(amountInput(), "2000");
    await user.clear(applyInput());
    await user.type(applyInput(), "2000");
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/1,000/);
    await user.click(within(screen.getByRole("radiogroup", { name: "Reminder" })).getByRole("radio", { name: "Tomorrow" }));
    await user.click(cta());
    expect(onSubmit.mock.calls[0][0].lines.map((l) => [l.key, l.amount])).toEqual([
      ["ledger:prev", 1000],
      ["emi-inst:oct", 1000],
    ]);
    expect((onSetReminder.mock.calls[0] as unknown as [{ key: string }[]])[0].map((t) => t.key)).toEqual(["emi-inst:oct"]);
  });
});
