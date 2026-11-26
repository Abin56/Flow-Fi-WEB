// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeferralContext, type DeferralContextValue } from "@/features/people/components/workspace/payment-deferral";
import type { PersonLinkedEmi } from "@/lib/engines/person-linked-emis";
import type { DeferralView } from "@/lib/engines/person-payment-deferral";
import { EmiAgreementList, EmiHeaderColumn, LinkedEmisPanel } from "./linked-emis-panel";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows installment balances and the EMI amount already included in the People Ledger", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 27));
  const installments: PersonLinkedEmi["installments"] = [2000, 0, 0].map((paid, index) => ({
    key: `emi-inst:smart-${index + 1}`,
    installmentId: String(index + 1),
    number: index + 1,
    dueDate: new Date(2026, 8 + index, 5),
    amount: 2500,
    paid,
    remaining: 2500 - paid,
    status: index === 0 ? "partial" : "overdue",
    lenderStatus: "paid",
  }));
  const summaries: PersonLinkedEmi[] = [{
    key: "emi:smart", sourceKind: "emi", sourceId: "smart", name: "Smart loan",
    shared: false, monthlyShare: 2500, installmentAmount: 2500, nextDue: null,
    dueToDate: 7500, paid: 2000, remaining: 5500, upcoming: 0,
    installmentCount: 3, paidCount: 0, overdueCount: 3, status: "overdue", installments,
  }];
  const movedTo = new Date(2026, 11, 5);
  const postponed = {
    status: "postponed", date: movedTo,
    cycle: { start: new Date(2026, 11, 1), end: new Date(2026, 11, 31) },
  } as DeferralView;
  const deferrals: DeferralContextValue = {
    byKey: new Map([[installments[1].key, postponed]]),
    revisionByKey: new Map(),
    cycleStartDay: 1,
    personName: "Dad",
    onApply: async () => "noop",
  };

  render(
    <DeferralContext.Provider value={deferrals}>
      <EmiHeaderColumn summaries={summaries} includedInReceivable={5500} totalReceivable={7000} />
      <EmiAgreementList summaries={summaries} onOpen={vi.fn()} />
      <LinkedEmisPanel personName="Dad" summaries={summaries} sources={[]} savingId={null} onToggle={vi.fn()} />
    </DeferralContext.Provider>,
  );

  expect(screen.getByText("Included in To receive").nextElementSibling?.textContent).toBe("₹5,500");
  expect(screen.getByText("People Ledger · To receive").nextElementSibling?.textContent).toBe("₹7,000");
  const overview = within(screen.getByTestId("linked-emi-snapshot"));
  expect(overview.getByText("₹7,500")).toBeTruthy();
  expect(overview.getByText("+₹2,000")).toBeTruthy();
  expect(overview.getByText("−₹5,500")).toBeTruthy();
  expect(overview.getByText("Due now").textContent).toBe("Due now ₹3,000");
  expect(overview.getByText("Postponed").textContent).toBe("Postponed ₹2,500");

  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  const schedule = within(screen.getByRole("table", { name: "Smart loan monthly schedule" }));
  expect(schedule.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Due date", "EMI", "Paid", "Pending", "Status"]);
  const [, first, second, third] = schedule.getAllByRole("row");
  expect(within(first).getByText("₹2,000").classList.contains("text-success")).toBe(true);
  expect(within(first).getByText("₹500")).toBeTruthy();
  expect(within(first).getByTestId("linked-emi-schedule-status").textContent).toBe("Partially paid");
  expect(within(second).getByTestId("linked-emi-schedule-status").textContent).toContain("Postponed");
  expect(within(second).getByText("5 Dec 2026")).toBeTruthy();
  expect(within(second).getAllByRole("cell")[3].textContent).toBe("Pending₹2,500");
  expect(within(third).getByTestId("linked-emi-schedule-status").textContent).toBe("Overdue");
});
