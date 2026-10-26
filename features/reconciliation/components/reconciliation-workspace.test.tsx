// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { DRAFT_KEY_PREFIX, buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { reconRow } from "../lib/test-fixtures";
import type { ReconRow } from "../lib/types";
import { ReconciliationWorkspace, type ReconciliationData } from "./reconciliation-workspace";

const NOW = new Date(2026, 9, 26, 12, 0, 0);

function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sessionStorage.clear();
  setViewport(1600);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const day = (d: number, m = 10) => new Date(2026, m - 1, d, 13);

function txn(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    type: "expense",
    amount: 500,
    dateTime: day(25),
    accountId: "acc-card",
    categoryId: "c1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: day(25),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: "manual",
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...over,
  };
}

const DATA: ReconciliationData = {
  accounts: [
    { id: "acc-card", name: "HDFC Millennia", type: "card", deletedAt: null, accountNumberLast4: null } as unknown as Account,
    { id: "acc-bank", name: "SBI Savings", type: "bank", deletedAt: null, accountNumberLast4: "9981" } as unknown as Account,
  ],
  // Statement day 17 → the open cycle is 18 Oct – 17 Nov; 1 Aug is in a closed cycle.
  creditCards: [{ id: "card1", accountId: "acc-card", lastFourDigits: "4821", statementDay: 17, paymentDueDay: 5, minimumDuePercent: null, sharedLimitId: null, deletedAt: null } as unknown as CreditCardProfile],
  statements: [],
  categories: [{ id: "c1", name: "Food", type: "expense", isActive: true, deletedAt: null } as unknown as Category],
  transactions: [
    txn({ id: "t-swiggy", amount: 452, description: "Swiggy", dateTime: day(24) }),
    txn({ id: "t-amazon", amount: 1299.02, description: "Amazon", dateTime: day(23) }),
    txn({ id: "t-zomato", amount: 300, description: "Zomato", dateTime: day(24) }),
    txn({ id: "t-bank", amount: 649, description: "Netflix", dateTime: day(24), accountId: "acc-bank" }),
  ],
  trashedTransactions: [],
  smsCandidates: [
    { id: "s1", amount: 250, direction: "debit", transactionDate: day(24), merchant: "UBER", bankName: null, cardId: "card1", accountId: null, rawLastFour: "4821" } as unknown as SmsTransactionCandidate,
  ],
  expenses: [],
};

const ROWS: ReconRow[] = [
  reconRow({ id: "r1", day: [2026, 10, 24], description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r2", day: [2026, 10, 22], description: "AMAZON PAY INDIA", amount: 1299 }),
  reconRow({ id: "r3", day: [2026, 10, 24], description: "ZOMATO", amount: 300 }),
  reconRow({ id: "r4", day: [2026, 10, 24], description: "ZOMATO", amount: 300 }),
  reconRow({ id: "r5", day: [2026, 10, 24], description: "UBER TRIP", amount: 250 }),
  reconRow({ id: "r6", day: [2026, 8, 1], description: "OLD STORE", amount: 999 }),
  reconRow({ id: "r7", day: [2026, 10, 24], description: "NETFLIX COM", amount: 649 }),
];

function seedDraft(rows = ROWS, accountId: string | null = "acc-card") {
  saveReconciliationDraft(buildReconciliationDraft("u1", { fingerprint: "fp:1", source: "text", accountId, priorSessionIds: {}, rows, decisions: {}, createdAt: Date.now() }));
}

const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const panel = () => screen.getByTestId("match-panel");
const grid = () => screen.getByRole("grid", { name: "Statement rows" });
const select = (id: string) => fireEvent.click(rowEl(id));

describe("Reconciliation workspace — desktop", () => {
  it("restores the draft, shows each row's advisory state and never says 'duplicate'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    expect(screen.getByText(/Restored your review/)).toBeTruthy();
    const states = Object.fromEntries(ROWS.map((r) => [r.id, rowEl(r.id).dataset.state]));
    expect(states).toEqual({ r1: "exact_candidate", r2: "near_amount", r3: "multiple", r4: "multiple", r5: "in_inbox", r6: "no_match", r7: "no_match" });
    // A possible match is never labelled a duplicate — in the grid or on a match card. (The step itself is named
    // "Check duplicates", and the panel calls matches "only suggestions".)
    expect(grid().textContent).not.toMatch(/duplicate/i);
    select("r1");
    for (const card of within(panel()).getAllByTestId("match-candidate")) expect(card.textContent).not.toMatch(/duplicate/i);
    expect(screen.getByTestId("privacy-notice").textContent).toMatch(/never saved/);
  });

  it("other-account look-alike is a note in the comparison, never a candidate", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r7");
    expect(within(panel()).queryAllByTestId("match-candidate")).toHaveLength(0);
    expect(panel().textContent).toMatch(/SBI Savings •••• 9981 — a different account/);
  });

  it("keyboard: J/K move, I ignores, ? investigates, L links the suggestion", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    const g = grid();
    g.focus();
    expect(rowEl("r1").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(g, { key: "l" });
    expect(within(rowEl("r1")).getByText("Already recorded")).toBeTruthy();
    fireEvent.keyDown(g, { key: "j" });
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(g, { key: "i" });
    expect(within(rowEl("r2")).getByText("Skipped")).toBeTruthy();
    fireEvent.keyDown(g, { key: "j" });
    fireEvent.keyDown(g, { key: "?" });
    expect(within(rowEl("r3")).getByText("Review later")).toBeTruthy();
    fireEvent.keyDown(g, { key: "k" });
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("progress-count").textContent).toBe("2/7");
  });

  it("one-to-one: once r3 links the only Zomato, r4 can't take it too", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r3");
    fireEvent.click(within(panel()).getByRole("button", { name: /Already recorded — skip import/ }));
    expect(rowEl("r4").dataset.state).toBe("conflict");
    select("r4");
    expect(panel().textContent).toMatch(/Linked to row 3/);
  });

  it("Import as new on a row with a possible match needs the explicit 'different transaction' confirmation and a category", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r2");
    fireEvent.click(within(panel()).getByRole("button", { name: "Add as a separate transaction" }));
    const errors = () => within(panel()).getByTestId("decision-errors").textContent;
    expect(errors()).toMatch(/Confirm this is a different transaction/);
    fireEvent.click(within(panel()).getByRole("checkbox", { name: "This is a different transaction" }));
    expect(errors()).not.toMatch(/Confirm this is a different transaction/);
    expect(errors()).toMatch(/Choose a category/);
  });

  it("N on a row with possible matches opens the comparison instead of deciding", () => {
    setViewport(1280); // desktop, below the docked-panel breakpoint → drawer
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "n" });
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toMatch(/Compare row 1/);
  });

  it("D10: a row in a closed card bill can't be imported as new; one in the open cycle can", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r6");
    expect(within(panel()).getByTestId("import-blocked").textContent).toMatch(/already closed/);
    expect((within(panel()).getByRole("button", { name: "Add as new transaction" }) as HTMLButtonElement).disabled).toBe(true);
    select("r7");
    expect(within(panel()).queryByTestId("import-blocked")).toBeNull();
  });

  it("D11: an SMS waiting in the Inbox can be marked 'Handle in Inbox'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r5");
    expect(panel().textContent).toMatch(/Waiting in the Transaction Inbox \(1\)/);
    fireEvent.click(within(panel()).getByRole("button", { name: "Handle in Inbox" }));
    expect(within(rowEl("r5")).getByText("Handle in Inbox")).toBeTruthy();
  });

  it("D5: bulk Link covers only unique exact candidates, asks first, and can be undone", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: /Mark exact matches already recorded \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark already recorded" }));
    expect(within(rowEl("r1")).getByText("Already recorded")).toBeTruthy();
    expect(within(rowEl("r3")).getByText("Undecided")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Undo bulk “already recorded” \(1\)/ }));
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
  });

  it("D6: editing an amount withdraws the decision and requires re-confirmation", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.keyDown(grid(), { key: "l" });
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "452.50" } });
    fireEvent.blur(amount);
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
    expect(within(rowEl("r1")).getByText("Edited — confirm values")).toBeTruthy();
    select("r1");
    expect(within(panel()).getByTestId("import-blocked").textContent).toMatch(/confirm the values/);
    fireEvent.click(screen.getByRole("button", { name: /Values are correct/ }));
    expect(within(rowEl("r1")).queryByText("Edited — confirm values")).toBeNull();
    // Saved draft follows along — and never contains the raw statement text field.
    const saved = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(saved).toContain('"amount":452.5');
    expect(saved).not.toContain("sourceText");
  });

  it("filters and search narrow the grid", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: /^Multiple/ }));
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(["r3", "r4"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "1,299" } });
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(["r2"]);
  });

  it("paste → rows appear and nothing is compared until the account is chosen", () => {
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.change(screen.getByLabelText("Statement rows"), { target: { value: "24/10/2026  SWIGGY BANGALORE  452.00\n24/10/2026  NETFLIX COM  649.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare rows" }));
    expect(screen.getByTestId("choose-account")).toBeTruthy();
    expect(screen.getAllByTestId("recon-row").every((r) => r.dataset.state === "pending")).toBe(true);
    const saved = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(saved).toContain("SWIGGY BANGALORE");
    expect(saved).not.toContain("24/10/2026  SWIGGY"); // the raw pasted line itself is never kept
  });

  it("Discard removes the draft from this tab", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard this review" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBeNull();
    expect(screen.getByLabelText("Statement rows")).toBeTruthy();
  });
});

describe("Reconciliation workspace — mobile", () => {
  it("compact cards, no grid; tapping opens the match sheet", async () => {
    setViewport(390);
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    expect(screen.queryByRole("grid")).toBeNull();
    const cards = screen.getAllByTestId("recon-card");
    expect(cards).toHaveLength(7);
    await act(async () => {
      fireEvent.click(cards[0]!);
    });
    const sheet = screen.getByTestId("mobile-sheet");
    expect(within(sheet).getByTestId("match-panel").dataset.rowId).toBe("r1");
    fireEvent.click(within(sheet).getByRole("button", { name: /Already recorded — skip import/ }));
    expect(within(screen.getAllByTestId("recon-card")[0]!).getByText("Already recorded")).toBeTruthy();
  });
});
