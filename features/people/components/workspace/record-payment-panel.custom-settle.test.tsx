// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { RecordPaymentPanel } from "./record-payment-panel";

/**
 * Record Payment — "use only ₹X to settle", the decision-first order, and the follow-up reminder.
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
const applyInput = () => screen.getByLabelText("Apply to balance") as HTMLInputElement;
const cta = () => screen.getByRole("button", { name: /^Record|Saving/ });

describe("Record Payment — custom settlement amount", () => {
  it("₹29,800 received, ₹4,000 applied: ₹1,400 still owed and ₹25,800 kept as advance — two separate numbers", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    // Default unchanged: settles everything selected (₹5,400).
    expect(applyInput().value).toBe("5400");
    await user.clear(applyInput());
    await user.type(applyInput(), "4000");
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/1,400/);
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/25,800/);
    // Canonical oldest-first order — the share stays partial, nothing new is invented.
    expect(screen.getByText("Partially paid")).toBeTruthy();
    expect(screen.getAllByText("Paid in full")).toHaveLength(2);
    expect((screen.getByRole("radio", { name: /Keep as advance/ }) as HTMLInputElement).checked).toBe(true);
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

  it("₹0 settles nothing: the whole receipt goes through the remaining-money choice", async () => {
    const { user, onSubmit } = setup();
    await user.type(amountInput(), "29800");
    await user.click(screen.getByRole("button", { name: "Settle nothing now" }));
    expect(screen.getByTestId("rp-still-owed").textContent).toMatch(/5,400/);
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/29,800/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines).toEqual([]);
    expect(input.extra).toEqual({ kind: "advance", amount: 29800 });
  });

  it("decision comes before the long allocation list", () => {
    setup();
    const decide = screen.getByRole("heading", { name: "Settle what AMMA owes you" });
    const list = screen.getByRole("heading", { name: "Payment allocation" });
    expect(decide.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("per-item amounts take over from the custom amount", async () => {
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
    expect(screen.getByText(/^Due from AMMA$/).closest("div")!.textContent).toMatch(/3,000/);
    expect(screen.queryByLabelText("Apply to EMI · November")).toBeNull(); // hidden behind "Show upcoming"
    await user.type(amountInput(), "5000");
    expect(screen.getByRole("button", { name: /Settle full ₹3,000/ })).toBeTruthy();
    expect(applyInput().value).toBe("3000");
    expect(screen.getByTestId("rp-left-over").textContent).toMatch(/2,000/);
    await user.click(cta());
    const input = onSubmit.mock.calls[0][0];
    expect(input.lines.map((l) => l.key)).toEqual(["ledger:prev", "emi-inst:oct"]);
    expect(input.extra).toEqual({ kind: "advance", amount: 2000 });
  });

  it("settle only ₹2,000: oldest first, ₹1,000 still owed on this cycle's EMI; reminder targets it", async () => {
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
