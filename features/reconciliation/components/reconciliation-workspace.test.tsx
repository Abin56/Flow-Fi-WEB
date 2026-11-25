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
import { menuItem, openInlineReview, rowStatusOf, setRowCategory } from "./menu-test-utils";
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
  localStorage.setItem("flowfi.recon.autoNext", "0"); // these tests decide a row and then keep inspecting it
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
const existingIds = () => screen.queryAllByTestId("inline-candidate").map((r) => r.dataset.recordId);
/** The match chip opens the row's inline review under it. */
const compare = (n: number) => fireEvent.click(screen.getByRole("button", { name: `Compare row ${n}` }));
const grid = () => screen.getByRole("grid", { name: "Statement rows" });
const select = (id: string) => fireEvent.click(rowEl(id));
const resolve = (id: string) => menuItem(id);

describe("Reconciliation workspace — desktop", () => {
  it("restores the draft, shows each row's advisory state and never says 'duplicate'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    expect(screen.getByText(/Restored your review/)).toBeTruthy();
    const states = Object.fromEntries(ROWS.map((r) => [r.id, rowEl(r.id).dataset.state]));
    expect(states).toEqual({ r1: "exact_candidate", r2: "near_amount", r3: "multiple", r4: "multiple", r5: "in_inbox", r6: "no_match", r7: "no_match" });
    // A possible match is never labelled a duplicate — the statement sheet and the dock never use the word; the comparison
    // band says "Possible duplicate" (a suggestion) and never "confirmed / exact duplicate".
    select("r1");
    expect(grid().textContent).not.toMatch(/(confirmed|exact|definite|is a) duplicate/i); // "Possible duplicate" is the status; a match is never called a confirmed duplicate
    compare(1);
    expect(screen.getByTestId("inline-review").textContent).not.toMatch(/(confirmed|exact|definite|is a) duplicate/i);
    expect(screen.getByTestId("privacy-notice").textContent).toMatch(/never saved/);
  });

  it("other-account look-alike is a note in the full comparison, never a candidate in the inline review", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r7");
    compare(7);
    expect(existingIds()).toEqual([]);
    expect(screen.getByTestId("inline-no-candidate")).toBeTruthy();
    fireEvent.click(screen.getByTestId("inline-full-details")); // the full comparison lists the notes
    expect(document.body.textContent).toMatch(/SBI Savings •••• 9981 — a different account/);
  });

  it("keyboard: J/K move, I ignores, ? investigates, L keeps the suggestion", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    const g = grid();
    g.focus();
    expect(rowEl("r1").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(g, { key: "l" });
    expect(within(rowEl("r1")).getByTestId("decision-chip").textContent).toBe("Already recorded");
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
    compare(4);
    expect(screen.getByTestId("inline-view-only").textContent).toMatch(/Already kept by row 3/);
    expect((screen.getByTestId("inline-keep-existing") as HTMLButtonElement).disabled).toBe(true);
    expect(resolve("keep_existing").disabled).toBe(true);
    expect(resolve("keep_existing").title).toMatch(/Already kept by row 3/);
  });

  it("Keep both on a row with a possible match is one explicit click in the comparison; the category is picked on the row", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    openInlineReview("r2");
    fireEvent.click(screen.getByTestId("inline-keep-both"));
    setRowCategory("r2", "Food");
    expect(rowStatusOf("r2")).toBe("ready");
    expect(JSON.parse(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!).decisions.r2).toMatchObject({ kind: "import_new", notSameAck: true, category: "Food" });
  });

  it("N on a row with possible matches opens the row's editor instead of deciding", () => {
    setViewport(1280);
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "n" });
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect(screen.getByTestId("import-as-transaction")).toBeTruthy();
  });

  it("D10: a row in a closed card bill can't be imported; one in the open cycle can", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    expect(within(rowEl("r6")).getByTestId("row-blocked").getAttribute("title")).toMatch(/already closed/);
    expect(rowStatusOf("r6")).toBe("fix");
    expect(within(rowEl("r7")).queryByTestId("row-blocked")).toBeNull();
  });

  it("D11: an SMS waiting in the Inbox can be marked 'Handle in Inbox'", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    select("r5");
    compare(5);
    expect(screen.getByTestId("inline-compare").textContent).toMatch(/SMS · waiting in Inbox/);
    fireEvent.click(resolve("inbox"));
    expect(within(rowEl("r5")).getByTestId("decision-chip").textContent).toBe("In Inbox");
  });

  it("D5: bulk Keep existing covers only unique exact candidates, asks first, and can be undone", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: /Keep existing for exact matches \(1\)/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep existing" }));
    expect(within(rowEl("r1")).getByTestId("decision-chip").textContent).toBe("Already recorded");
    expect(within(rowEl("r3")).getByTestId("decision-chip").dataset.pending).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Undo bulk keep \(1\)/ }));
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
  });

  it("editing an amount withdraws the decision made against the old value — and asks for NO confirmation of the number just typed", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.keyDown(grid(), { key: "l" });
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "452.50" } });
    fireEvent.blur(amount);
    // The Keep existing was made against ₹452 — withdrawn, so the row is a Possible duplicate again…
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    // …but the typed amount is accepted on the spot: no "Edited — confirm values", no "Values are correct" step.
    expect(within(rowEl("r1")).queryByText("Edited — confirm values")).toBeNull();
    expect(screen.queryByTestId("row-fix")).toBeNull();
    // It is a possible match again, so its details point to the comparison instead of importing blind.
    expect((screen.getByTestId("import-as-transaction") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("editor-review-match")).toBeTruthy();
    // Undo can't bring back the Keep existing the edit withdrew — it was made against the old amount.
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect(screen.getByTestId("undo-notice").textContent).toMatch(/changed since/);
    // Saved draft follows along — and never contains the raw statement text field.
    const saved = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(saved).toContain('"amount":452.5');
    expect(saved).not.toContain("sourceText");
  });

  it("filters and search narrow the statement sheet", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    // One summary strip is the quick filter; the toolbar's Filter menu offers the same statuses.
    fireEvent.click(screen.getByTestId("filter-menu"));
    fireEvent.click(screen.getByRole("radio", { name: /^Possible match/ }));
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    fireEvent.click(screen.getByRole("button", { name: "Show all rows" }));
    fireEvent.click(screen.getByTestId("rf-duplicate"));
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    fireEvent.click(screen.getByTestId("rf-duplicate"));
    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "1,299" } });
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(["r2"]);
  });

  it("paste → rows appear and nothing is compared until the account is chosen", () => {
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.change(screen.getByLabelText("Statement rows"), { target: { value: "24/10/2026  SWIGGY BANGALORE  452.00\n24/10/2026  NETFLIX COM  649.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare rows" }));
    expect(screen.getByTestId("choose-account")).toBeTruthy();
    // Nothing is compared: every row is "Account missing", with cross-account evidence only.
    expect(screen.getAllByTestId("recon-row").every((r) => r.dataset.state === "pending" && r.dataset.accountMissing === "true")).toBe(true);
    expect(screen.getAllByTestId("match-account-missing").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("inline-review")).toBeNull();
    expect(screen.queryByTestId("resolution-dock")).toBeNull();
    // Cross-account evidence is only a hint in the Match cell — and the toolbar offers the likely account.
    expect(screen.getAllByTestId("match-account-missing")[0]!.textContent).toMatch(/similar on|Nothing similar/);
    const saved = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;
    expect(saved).toContain("SWIGGY BANGALORE");
    expect(saved).not.toContain("24/10/2026  SWIGGY"); // the raw pasted line itself is never kept
    // "Use" is the user's explicit choice — then the real (single-account) matcher runs.
    fireEvent.click(screen.getByRole("button", { name: "Choose statement account" }));
    fireEvent.click(screen.getAllByTestId("account-option").find((o) => o.textContent?.includes("HDFC Millennia"))!);
    expect(screen.getByTestId("selected-account").textContent).toMatch(/HDFC Millennia/);
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.state)).toEqual(["exact_candidate", "no_match"]);
    // A similar transaction on ANOTHER account is never a candidate in the inline review.
    fireEvent.click(screen.getAllByTestId("recon-row")[1]);
    compare(2);
    expect(existingIds()).toEqual([]);
    expect(screen.getByTestId("inline-no-candidate")).toBeTruthy();
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

  it("opens over the viewport (never inside the sheet), follows the selection, and opening/moving/closing changes no decision", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    const savedBefore = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 2" }));
    const panel = sheet()!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(screen.getByTestId("statement-sheet").contains(panel)).toBe(false);
    expect(screen.getByTestId("review-sheet").contains(panel)).toBe(false);
    expect(within(panel).getByRole("heading", { name: /Amazon/ })).toBeTruthy(); // FlowFi's clean wording of "AMAZON PAY INDIA"
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");

    // Its arrows and J/K move the selection; the sheet follows.
    fireEvent.click(within(panel).getByRole("button", { name: "Next row" }));
    expect(rowEl("r3").getAttribute("aria-selected")).toBe("true");
    expect(within(sheet()!).getByText("Statement row 3")).toBeTruthy();
    fireEvent.keyDown(sheet()!, { key: "j" });
    expect(within(sheet()!).getByText("Statement row 4")).toBeTruthy();

    // Escape, Close and the ✕ all close it; nothing was decided along the way.
    fireEvent.keyDown(sheet()!, { key: "Escape" });
    expect(sheet()).toBeNull();
    fireEvent.keyDown(grid(), { key: "Enter" });
    fireEvent.click(within(sheet()!).getByTestId("editor-close"));
    expect(sheet()).toBeNull();
    fireEvent.doubleClick(rowEl("r2"));
    fireEvent.click(within(sheet()!).getByRole("button", { name: "Close row details" }));
    expect(sheet()).toBeNull();
    for (const id of ["r2", "r3", "r4"]) expect(within(rowEl(id)).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toBe(savedBefore);
  });

  it("a typed value is kept when the sheet closes before the field is left; Escape in a field reverts it and keeps the sheet open", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    const shown = (screen.getByLabelText("Description") as HTMLInputElement).value; // FlowFi's wording (here: the user's own "Swiggy" history)
    (screen.getByLabelText("Description") as HTMLInputElement).focus();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "SWIGGY BLR" } });
    fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Escape" });
    expect(sheet()).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe(shown);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "SWIGGY BLR" } });
    fireEvent.click(screen.getByRole("button", { name: "Next row" }));
    expect(rowEl("r1").textContent).toContain("SWIGGY BLR");
    expect(rowEl("r1").dataset.description).toBe("SWIGGY BANGALORE"); // the bank narration itself is never changed
  });

  it("offers Mine / Someone else's / Split on a charge — Mine by default, nothing written by choosing", () => {
    seedDraft();
    render(<ReconciliationWorkspace uid="u1" data={DATA} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand row 1" }));
    const own = within(screen.getByTestId("editor-ownership"));
    expect(own.getByRole("radio", { name: "My own expense" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(own.getByRole("radio", { name: "Split expense" }));
    expect(own.getByRole("radio", { name: "Split expense" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("ownership-split")).toBeTruthy();
    expect(screen.getAllByTestId("split-share")).toHaveLength(2);
  });
});
