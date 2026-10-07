// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { ApplyAdvancePanel } from "./payment-extras";

/**
 * Apply advance — money from the person I already hold. Applying it early to a FUTURE item is allowed,
 * but only as an explicit choice: upcoming items are marked and never pre-selected.
 * Cycle 18 Sep – 17 Oct: August share ₹1,000 (carried), EMI Oct ₹2,000, EMI Nov ₹4,000 (upcoming).
 * Advance held ₹5,000.
 */
afterEach(cleanup);

const CYCLE = { start: new Date(2026, 8, 18), end: new Date(2026, 9, 17) };
function ob(key: string, title: string, outstanding: number, date: Date): PayableObligation {
  return {
    key, title, date, createdAt: date, amount: outstanding, outstanding, side: "theyOwe", typeLabel: "Share", category: "gave",
    target: { kind: "entry", entry: { id: key }, max: outstanding } as never, isEmi: key.startsWith("emi"),
  };
}
const obligations = [
  ob("ledger:aug", "August share", 1000, new Date(2026, 7, 20)),
  ob("emi-inst:oct", "EMI · October", 2000, new Date(2026, 9, 5)),
  ob("emi-inst:nov", "EMI · November", 4000, new Date(2026, 10, 5)),
];
const available = [{ entryId: "adv1", date: new Date(2026, 8, 1), side: "theyOwe" as const, amount: 5000, remaining: 5000 }];

function setup() {
  const onConfirm = vi.fn(async () => {});
  render(
    <ApplyAdvancePanel personName="AMMA" side="theyOwe" available={available as never} obligations={obligations} cycle={CYCLE} open onOpenChange={() => {}} onConfirm={onConfirm} />,
  );
  return { onConfirm, user: userEvent.setup() };
}

describe("Apply advance — future items are explicit only", () => {
  it("upcoming item is marked, not pre-selected; ₹5,000 applies only ₹3,000 (what's due now)", async () => {
    const { onConfirm, user } = setup();
    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect((screen.getByLabelText("Apply advance to EMI · November") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Apply advance to EMI · October") as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: /Apply ₹3,000 of advance/ }));
    const targets = (onConfirm.mock.calls[0] as unknown as [{ obligationKey: string; uses: { amount: number }[] }[]])[0];
    expect(targets.map((t) => [t.obligationKey, t.uses.reduce((s, u) => s + u.amount, 0)])).toEqual([
      ["ledger:aug", 1000],
      ["emi-inst:oct", 2000],
    ]);
  });

  it("ticking the future EMI is an explicit early application of the rest (₹2,000)", async () => {
    const { onConfirm, user } = setup();
    await user.click(screen.getByLabelText("Apply advance to EMI · November"));
    await user.click(screen.getByRole("button", { name: /Apply ₹5,000 of advance/ }));
    const targets = (onConfirm.mock.calls[0] as unknown as [{ obligationKey: string; uses: { amount: number }[] }[]])[0];
    expect(targets.find((t) => t.obligationKey === "emi-inst:nov")!.uses[0].amount).toBe(2000);
  });
});
