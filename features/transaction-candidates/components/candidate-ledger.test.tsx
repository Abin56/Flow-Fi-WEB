// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { deriveCandidateStatus } from "../lib/candidate-status";
import { CandidateLedger, merchantInitials, type LedgerGroup } from "./candidate-ledger";
import type { CandidateRowModel } from "./candidate-row-parts";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(cleanup);

function candidate(o: Partial<SmsTransactionCandidate> & { id: string }): SmsTransactionCandidate {
  return {
    amount: 321,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date(2026, 9, 21, 12),
    merchant: "Swiggy",
    bankName: "QA Bank",
    rawLastFour: null,
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date(2026, 9, 21),
    deletedAt: null,
    ...o,
  };
}

function row(c: SmsTransactionCandidate, over: Partial<CandidateRowModel> = {}, destination: CandidateRowModel["destinationState"] = "matched", dup = false): CandidateRowModel {
  const duplicate = dup ? ({ duplicateOfTransactionId: "t1", reason: "Same amount, date and merchant as an existing transaction (txn_abcdef123456).", confidence: 0.9 } as never) : null;
  return {
    candidate: c,
    number: 1,
    status: deriveCandidateStatus(c, duplicate, destination),
    duplicate,
    destinationState: destination,
    accountLabel: destination === "matched" ? "QA Bank •••• 4821" : null,
    identity: destination === "matched" ? { kind: "card", bankId: "hdfc", name: "HDFC Freedom", last4: "4821", accountType: "card" } : null,
    accountHint: "Not matched • •••• 7743",
    selected: false,
    selectBlockedReason: null,
    ...over,
  };
}

function renderLedger(groups: LedgerGroup[], extra: { onReview?: (id: string) => void; onToggle?: (id: string, c: boolean) => void } = {}) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return render(
    <CandidateLedger
      groups={groups}
      shownCount={total}
      queueCount={total}
      allSelected={false}
      someSelected={false}
      selectAllDisabled={false}
      onToggleAll={() => {}}
      onToggle={extra.onToggle ?? (() => {})}
      onReview={extra.onReview ?? (() => {})}
      candidateRepository={null}
      onHide={() => {}}
      onUnhide={() => {}}
    />,
  );
}

describe("merchantInitials", () => {
  it("uses up to two initials from a real name", () => {
    expect(merchantInitials("Swiggy")).toBe("SW");
    expect(merchantInitials("Big Basket")).toBe("BB");
    expect(merchantInitials("acme corp ltd")).toBe("AC");
  });
  it("never invents initials for an unknown merchant or a raw reference", () => {
    expect(merchantInitials(null)).toBeNull();
    expect(merchantInitials("")).toBeNull();
    expect(merchantInitials("IGST-VPS2717151193919-RATE 18.0 -32")).toBeNull();
    expect(merchantInitials("***")).toBeNull();
  });
});

describe("CandidateLedger", () => {
  const clean = row(candidate({ id: "clean" }));
  const credit = row(candidate({ id: "credit", merchant: "Acme Corp", amount: 62000, direction: "credit", eventType: "salaryCredit" }));
  const unnamed = row(candidate({ id: "unnamed", merchant: null, amount: 1250.5 }));
  const unmatched = row(candidate({ id: "unmatched", merchant: "Uber", accountId: null, needsReview: true, confidenceLevel: "low" }), {}, "unmatched");
  const dup = row(candidate({ id: "dup", merchant: "QA groceries", amount: 850 }), {}, "matched", true);
  const review = row(candidate({ id: "review", merchant: "BigBasket", needsReview: true, confidenceLevel: "medium" }));
  const groups: LedgerGroup[] = [
    { key: "2026-10-21", label: "Yesterday", dateText: "21 October 2026", flat: false, rows: [clean, credit, unnamed, unmatched, dup, review] },
    { key: "2026-09-30", label: "30 September 2026", dateText: null, flat: false, rows: [row(candidate({ id: "sep", merchant: "Zomato", transactionDate: new Date(2026, 8, 30, 12) }))] },
  ];

  it("groups rows under day headings (Yesterday + its real date) that show a COUNT, never a money total", () => {
    renderLedger(groups);
    const oct = screen.getByRole("heading", { name: /Yesterday/ }).closest("section")!;
    expect(within(oct).getByText("21 October 2026")).toBeTruthy();
    expect(within(oct).getByText("6 transactions")).toBeTruthy();
    expect(screen.getByText("1 transaction")).toBeTruthy(); // singular
    expect(screen.getByRole("heading", { name: "30 September 2026" })).toBeTruthy();
    // Nothing in a month header is a currency amount.
    expect(oct.querySelector("h2")!.parentElement!.textContent).not.toMatch(/₹/);
  });

  it("a clean row shows no status badge, no 'No issues flagged', and no notice", () => {
    renderLedger(groups);
    const li = screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === "clean")!;
    expect(li.getAttribute("data-lane")).toBe("noIssues");
    expect(li.textContent).not.toMatch(/No issues flagged|Needs account|Possible duplicate|Needs review|Review suggested/);
  });

  it("shows the right notice only where action is needed", () => {
    renderLedger(groups);
    const rowOf = (id: string) => screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === id)!;
    expect(rowOf("unmatched").textContent).toMatch(/Needs account/);
    expect(rowOf("dup").textContent).toMatch(/Possible duplicate/);
    expect(rowOf("review").textContent).toMatch(/Review suggested/);
    // …and a possible duplicate is never called a certain one.
    expect(rowOf("dup").textContent).not.toMatch(/duplicate of|is a duplicate/i);
  });

  it("signs the amount by direction and keeps the exact value (paise survive, whole rupees stay clean)", () => {
    renderLedger(groups);
    const rowOf = (id: string) => screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === id)!;
    expect(rowOf("credit").textContent).toContain("+₹62,000");
    expect(rowOf("clean").textContent).toContain("−₹321");
    expect(rowOf("clean").textContent).not.toContain("₹321.00");
    expect(rowOf("unnamed").textContent).toContain("−₹1,250.50");
    // Direction is also a screen-reader label, not just a sign or a colour.
    expect(within(rowOf("credit")).getAllByLabelText(/^Credit/).length).toBeGreaterThan(0);
    expect(within(rowOf("clean")).getAllByLabelText(/^Debit/).length).toBeGreaterThan(0);
  });

  it("shows an unknown merchant transparently instead of inventing one", () => {
    renderLedger(groups);
    const li = screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === "unnamed")!;
    expect(li.textContent).toContain("Unknown merchant");
  });

  it("shows a verified match as the card name with its masked last four, or the transparent hint when unmatched", () => {
    renderLedger(groups);
    const rowOf = (id: string) => screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === id)!;
    expect(rowOf("clean").textContent).toContain("HDFC Freedom");
    expect(rowOf("clean").textContent).toContain("•••• 4821");
    expect(within(rowOf("clean")).getAllByTitle(/Credit card: HDFC Freedom •••• 4821/).length).toBe(1);
    expect(within(rowOf("unmatched")).queryByTitle(/Credit card|Account:/)).toBeNull();
    expect(rowOf("unmatched").textContent).toContain("Not matched • •••• 7743");
  });

  it("notes medium / low confidence as quiet text and says nothing for high", () => {
    renderLedger(groups);
    const rowOf = (id: string) => screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === id)!;
    expect(rowOf("review").textContent).toContain("Medium confidence");
    expect(rowOf("unmatched").textContent).toContain("Low confidence");
    expect(rowOf("clean").textContent).not.toMatch(/confidence/i);
  });

  it("opens the review from the Review button and from empty row space, but not when a control is clicked", () => {
    const onReview = vi.fn();
    const onToggle = vi.fn();
    renderLedger(groups, { onReview, onToggle });
    const li = screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === "clean")!;
    fireEvent.click(within(li).getByRole("button", { name: /^Review/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenLastCalledWith("clean");
    fireEvent.click(li);
    expect(onReview).toHaveBeenCalledTimes(2);
    fireEvent.click(within(li).getByRole("checkbox"));
    expect(onReview).toHaveBeenCalledTimes(2); // a checkbox click never opens the drawer
    expect(onToggle).toHaveBeenCalledWith("clean", true);
  });

  it("a 'Needs account' notice is the direct way into resolving the account", () => {
    const onReview = vi.fn();
    renderLedger(groups, { onReview });
    const li = screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === "unmatched")!;
    fireEvent.click(within(li).getAllByRole("button", { name: /Needs account/ })[0]);
    expect(onReview).toHaveBeenCalledWith("unmatched");
  });

  it("labels the amount with its direction in text as well as the sign", () => {
    renderLedger(groups);
    const rowOf = (id: string) => screen.getAllByTestId("candidate-row").find((r) => r.getAttribute("data-candidate-id") === id)!;
    expect(rowOf("credit").textContent).toMatch(/\+₹62,000\s*Credit/);
    expect(rowOf("clean").textContent).toMatch(/−₹321\s*Debit/);
  });

  it("says how many of the inbox are shown", () => {
    const { rerender } = renderLedger(groups);
    expect(screen.getByTestId("candidates-shown").textContent).toMatch(/7\s*in your inbox/);
    rerender(
      <CandidateLedger
        groups={groups}
        shownCount={3}
        queueCount={7}
        allSelected={false}
        someSelected={false}
        selectAllDisabled
        onToggleAll={() => {}}
        onToggle={() => {}}
        onReview={() => {}}
        candidateRepository={null}
        onHide={() => {}}
        onUnhide={() => {}}
      />,
    );
    expect(screen.getByTestId("candidates-shown").textContent).toMatch(/Showing\s*3\s*of\s*7/);
  });
});

describe("CandidateLedger account suggestion", () => {
  it("shows a live last-4 suggestion on an unmatched row without changing its status", () => {
    const r = row(candidate({ id: "u1", merchant: "Uber", accountId: null, rawLastFour: "9585" }), { accountSuggestion: "Bank of India •••• 9585" }, "unmatched");
    renderLedger([{ key: "k", label: "Today", dateText: null, flat: false, rows: [r] }]);
    expect(screen.getByTestId("account-suggestion").textContent).toBe("Suggested: Bank of India •••• 9585");
    expect(r.status.lane).toBe("needsAccount");
    expect(screen.getAllByText(/Needs account/).length).toBeGreaterThan(0);
  });
  it("shows nothing extra when there is no suggestion", () => {
    const r = row(candidate({ id: "u2", merchant: "Uber", accountId: null }), {}, "unmatched");
    renderLedger([{ key: "k", label: "Today", dateText: null, flat: false, rows: [r] }]);
    expect(screen.queryByTestId("account-suggestion")).toBeNull();
  });
});
