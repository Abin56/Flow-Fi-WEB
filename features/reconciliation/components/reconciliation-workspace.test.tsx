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
const existingIds = () => screen.queryAllByTestId("existing-row").map((r) => r.dataset.recordId);
const dock = () => screen.getByTestId("resolution-dock");
const grid = () => screen.getByRole("grid", { name: "Statement rows" });
const select = (id: string) => fireEvent.click(rowEl(id));
const resolve = (id: string) => screen.getByTestId(`resolve-${id}`) as HTMLButtonElement;

describe("Reconciliation workspace — desktop", () => {
  it("restores the draft, shows each row's advisory state and never says 'duplicate'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    expect(screen.getByText(/Restored your review/)).toBeTruthy();
    const states = Object.fromEntries(ROWS.map((r) => [r.id, rowEl(r.id).dataset.state]));
    expect(states).toEqual({ r1: "exact_candidate", r2: "near_amount", r3: "multiple", r4: "multiple", r5: "in_inbox", r6: "no_match", r7: "no_match" });
    // A possible match is never labelled a duplicate — in either sheet or in the dock.
    select("r1");
    expect(grid().textContent).not.toMatch(/duplicate/i);
    expect(screen.getByTestId("existing-sheet").textContent).not.toMatch(/duplicate/i);
    expect(dock().textContent).not.toMatch(/duplicate/i);
    expect(screen.getByTestId("privacy-notice").textContent).toMatch(/never saved/);
  });

  it("other-account look-alike is a note in the dock, never a row in the Existing FlowFi sheet", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r7");
    expect(existingIds()).toEqual([]);
    fireEvent.click(screen.getByTestId("existing-mode-ledger"));
    expect(existingIds()).not.toContain("t-bank");
    fireEvent.click(screen.getByTestId("dock-notes"));
    expect(document.body.textContent).toMatch(/SBI Savings •••• 9981 — a different account/);
  });

  it("keyboard: J/K move, I ignores, ? investigates, L keeps the suggestion", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    const g = grid();
    g.focus();
    expect(rowEl("r1").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(g, { key: "l" });
    expect(within(rowEl("r1")).getByText("Keep existing")).toBeTruthy();
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

  it("one-to-one: once r3 keeps the only Zomato, r4 can't keep it too", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r3");
    fireEvent.click(resolve("keep_existing"));
    expect(rowEl("r4").dataset.state).toBe("conflict");
    select("r4");
    const zomato = screen.getAllByTestId("existing-row").find((r) => r.dataset.recordId === "t-zomato")!;
    expect(zomato.dataset.viewOnly).toBe("claimed");
    expect(zomato.textContent).toMatch(/Kept by row 3/);
    expect(resolve("keep_existing").disabled).toBe(true);
    expect(resolve("keep_existing").title).toMatch(/Already kept by row 3/);
  });

  it("Keep both on a row with a possible match needs the explicit acknowledgement and a category", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r2");
    expect(resolve("import_new").disabled).toBe(true); // a possible match exists → Keep both, never a silent Import new
    fireEvent.click(resolve("keep_both"));
    const submit = screen.getByTestId("import-confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId("import-confirm").textContent).toMatch(/Needs the acknowledgement, a category/);
    fireEvent.click(screen.getByRole("checkbox", { name: "These are separate transactions" }));
    fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: "Food" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(within(rowEl("r2")).getByText("Keep both")).toBeTruthy();
    expect(screen.getByTestId("financial-effect").textContent).toMatch(/adds 1 charge of ₹1,299\.00.*Existing FlowFi transactions stay unchanged/);
  });

  it("N on a row with possible matches opens the Keep both confirmation instead of deciding", () => {
    setViewport(1280);
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "n" });
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
    expect(screen.getByTestId("import-confirm").textContent).toMatch(/Keep both/);
  });

  it("D10: a row in a closed card bill can't be imported; one in the open cycle can", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r6");
    expect(screen.getByTestId("dock-import-blocked").textContent).toMatch(/already closed/);
    expect(resolve("import_new").disabled).toBe(true);
    select("r7");
    expect(screen.queryByTestId("dock-import-blocked")).toBeNull();
    expect(resolve("import_new").disabled).toBe(false);
  });

  it("D11: an SMS waiting in the Inbox can be marked 'Handle in Inbox'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r5");
    expect(screen.getAllByTestId("existing-row").map((r) => r.dataset.role)).toEqual(["sms"]);
    fireEvent.click(screen.getByTestId("resolve-inbox"));
    expect(within(rowEl("r5")).getByText("Handle in Inbox")).toBeTruthy();
  });

  it("D5: bulk Keep existing covers only unique exact candidates, asks first, and can be undone", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: /Keep existing for exact matches \(1\)/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep existing" }));
    expect(within(rowEl("r1")).getByText("Keep existing")).toBeTruthy();
    expect(within(rowEl("r3")).getByText("Undecided")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Undo bulk keep \(1\)/ }));
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
    expect(screen.getByTestId("dock-import-blocked").textContent).toMatch(/confirm the values/);
    fireEvent.click(screen.getByRole("button", { name: /Values are correct/ }));
    expect(within(rowEl("r1")).queryByText("Edited — confirm values")).toBeNull();
    // Undo can't bring back the Keep existing the edit withdrew — it was made against the old amount.
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
    expect(screen.getByTestId("undo-notice").textContent).toMatch(/changed since/);
    // Saved draft follows along — and never contains the raw statement text field.
    const saved = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(saved).toContain('"amount":452.5');
    expect(saved).not.toContain("sourceText");
  });

  it("filters and search narrow the statement sheet", () => {
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
    expect(screen.getByTestId("existing-empty").textContent).toMatch(/Choose the statement account/);
    expect(screen.queryByTestId("resolution-dock")).toBeNull();
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
    fireEvent.click(within(sheet).getByRole("button", { name: /^Keep existing$/ }));
    expect(within(screen.getAllByTestId("recon-card")[0]!).getByText("Keep existing")).toBeTruthy();
  });
});

describe("Reconciliation workspace — row bottom sheet", () => {
  const sheet = () => screen.queryByTestId("row-editor-panel");

  it("opens over the viewport (never inside either sheet), follows the selection, and opening/moving/closing changes no decision", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    const savedBefore = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 2" }));
    const panel = sheet()!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("statement-sheet").contains(panel)).toBe(false);
    expect(screen.getByTestId("existing-sheet").contains(panel)).toBe(false);
    expect(within(panel).getByRole("heading", { name: "AMAZON PAY INDIA" })).toBeTruthy();
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");

    // Its arrows and J/K move the selection; the sheet follows.
    fireEvent.click(within(panel).getByRole("button", { name: "Next row" }));
    expect(rowEl("r3").getAttribute("aria-selected")).toBe("true");
    expect(within(sheet()!).getByText("Statement row 3 · draft")).toBeTruthy();
    fireEvent.keyDown(sheet()!, { key: "j" });
    expect(within(sheet()!).getByText("Statement row 4 · draft")).toBeTruthy();

    // Escape, Done and the close button all close it; nothing was decided along the way.
    fireEvent.keyDown(sheet()!, { key: "Escape" });
    expect(sheet()).toBeNull();
    fireEvent.keyDown(grid(), { key: "Enter" });
    fireEvent.click(within(sheet()!).getByRole("button", { name: "Done" }));
    expect(sheet()).toBeNull();
    fireEvent.doubleClick(rowEl("r2"));
    fireEvent.click(within(sheet()!).getByRole("button", { name: "Close row details" }));
    expect(sheet()).toBeNull();
    for (const id of ["r2", "r3", "r4"]) expect(within(rowEl(id)).getByText("Undecided")).toBeTruthy();
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBe(savedBefore);
  });

  it("a typed value is kept when the sheet closes before the field is left; Escape in a field reverts it and keeps the sheet open", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    (screen.getByLabelText("Description") as HTMLInputElement).focus();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "SWIGGY BLR" } });
    fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Escape" });
    expect(sheet()).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("SWIGGY BANGALORE");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "SWIGGY BLR" } });
    fireEvent.click(screen.getByRole("button", { name: "Next row" }));
    expect(rowEl("r1").textContent).toContain("SWIGGY BLR");
  });

  it("keeps Person and Split disabled", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    expect(screen.getByTestId("editor-person").getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("switch", { name: "Split expense (not available yet)" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
