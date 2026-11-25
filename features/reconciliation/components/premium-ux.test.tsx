// @vitest-environment jsdom
/**
 * Premium Reconciliation UX: the statement account bar (explicit, never pre-selected, loading/error), account changes
 * invalidating decisions and recomputing candidates, the side-by-side duplicate comparison, the readiness summary,
 * the draft-only editor, layout/scrolling contracts — and that none of it writes anything.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import type { ReconciliationData } from "../lib/analyze";
import { DRAFT_KEY_PREFIX, buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow, RowDecision } from "../lib/types";
import { menuItem, setRowCategory } from "./menu-test-utils";
import { ReconciliationWorkspace } from "./reconciliation-workspace";

function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? width >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
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
  vi.setSystemTime(APPROVAL_NOW);
  sessionStorage.clear();
  localStorage.setItem("flowfi.recon.autoNext", "0"); // these tests decide a row and then keep inspecting it
  setViewport(1600);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OCT_24: [number, number, number] = [2026, 10, 24];
const ROWS: ReconRow[] = [
  reconRow({ id: "r1", day: OCT_24, description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r2", day: OCT_24, description: "NETFLIX COM", amount: 649 }),
  reconRow({ id: "r3", day: OCT_24, description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "r4", day: OCT_24, description: "LEFT OUT", amount: 10, include: false, captureExcluded: true }),
  reconRow({ id: "r5", day: [2026, 8, 1], description: "OLD STORE", amount: 999 }),
];

// The card has an SMS-imported Swiggy ₹0.50 higher, a day later; the bank has the Netflix.
const DATA: ReconciliationData = reconData({
  transactions: [
    txn({ id: "t-sw", amount: 452.5, description: "Swiggy", notes: "Team lunch", source: "sms", dateTime: new Date(2026, 9, 25, 13) }),
    txn({ id: "t-nf", amount: 649, description: "Netflix", accountId: "acc-bank", dateTime: new Date(2026, 9, 24, 13) }),
  ],
});
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function seed(accountId: string | null = "acc-card", decisions: Record<string, Partial<RowDecision>> = {}) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, decisions, accountId)));
}

/** Tripwire deps: any server read or transaction write during review would show up here. */
function tripwire() {
  const creates = vi.fn();
  const readData = vi.fn(async () => DATA);
  const fakeRepo = { getByKey: vi.fn(async () => null), createTransaction: creates } as unknown as TransactionRepository;
  const deps: ApprovalDeps = { readData, repositories: commitRepositoriesFor(fakeRepo), now: () => APPROVAL_NOW };
  return { deps, creates, readData };
}

const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const states = () => Object.fromEntries(screen.getAllByTestId("recon-row").map((r) => [r.dataset.rowId, r.dataset.state]));
/** Desktop: the full comparison (MatchPanel) opens in a drawer (key O); phones show it in the row's sheet. */
const panel = () => screen.queryByTestId("match-panel") ?? (fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "o" }), fireEvent.click(screen.getByTestId("inline-full-details")), screen.getByTestId("match-panel"));
const select = (id: string) => fireEvent.click(rowEl(id));

function pick(name: string) {
  fireEvent.click(screen.getByTestId("account-picker"));
  fireEvent.click(screen.getAllByTestId("account-option").find((o) => o.textContent?.includes(name))!);
}

describe("statement account bar", () => {
  it("nothing is pre-selected: it says so, hides matches and the approval, and lists name, kind and last four", () => {
    seed(null);
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    const bar = screen.getByTestId("account-bar");
    expect(bar.dataset.selected).toBe("false");
    expect(within(bar).getByTestId("choose-account").textContent).toMatch(/No account selected/);
    expect(Object.values(states()).every((s) => s === "pending")).toBe(true);
    expect(screen.queryByTestId("open-approval")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose statement account" }));
    const options = screen.getAllByTestId("account-option").map((o) => o.textContent);
    expect(options[0]).toMatch(/HDFC Millennia.*Credit card · •••• 4821/); // cards first
    expect(options[1]).toMatch(/SBI Savings.*Bank account · •••• 9981/);
  });

  it("shows loading and error states for the account list — Retry asks the data layer again", () => {
    seed(null);
    const retry = vi.fn();
    const view = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={{ loading: ["accounts"], failed: [], retry }} />);
    expect(screen.getByTestId("accounts-loading").textContent).toMatch(/Loading your accounts/);
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={{ loading: [], failed: ["accounts"], retry }} />);
    expect(screen.getByTestId("accounts-error").textContent).toMatch(/Couldn't load your accounts/);
    fireEvent.click(within(screen.getByTestId("account-bar")).getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
  });

  it("changing the account asks first, clears decisions made against the old one, and recomputes on the new account only", () => {
    seed("acc-card");
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(states()).toMatchObject({ r1: "near_amount", r2: "no_match" }); // the bank's Netflix is never a card candidate
    select("r1");
    fireEvent.click(menuItem("keep_existing"));
    select("r2");
    fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "i" });
    expect(within(rowEl("r1")).getByTestId("decision-chip").textContent).toBe("Already recorded");

    pick("SBI Savings");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/recalculated for SBI Savings •••• 9981/);
    expect(dialog.textContent).toMatch(/against HDFC Millennia •••• 4821's transactions/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Change account" }));

    expect(screen.getByTestId("selected-account").textContent).toMatch(/SBI Savings/);
    // The stale "already recorded" is withdrawn; with nothing similar on the bank and Swiggy → Food, the row is simply Ready.
    expect(rowEl("r1").dataset.decision).not.toBe("link");
    expect(within(rowEl("r1")).getByTestId("decision-chip").textContent).toBe("Ready");
    expect(within(rowEl("r2")).getByText("Skipped")).toBeTruthy(); // skip doesn't depend on the account
    expect(states()).toMatchObject({ r1: "no_match", r2: "exact_candidate" }); // the card's Swiggy no longer counts
  });
});

describe("duplicate comparison", () => {
  it("puts the statement row beside the FlowFi transaction: source, merchant, amount and date differences, account, flags and context", () => {
    seed("acc-card");
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    select("r1");
    const card = within(panel()).getByTestId("match-candidate");
    const field = (label: string) => card.querySelector(`[data-compare="${label}"]`)!.textContent;
    expect(card.textContent).toMatch(/Suggestion — you decide/);
    expect(field("Source")).toMatch(/Pasted statement.*From SMS/);
    expect(field("Merchant")).toMatch(/SWIGGY BANGALORE.*Swiggy/);
    expect(field("Amount")).toMatch(/Difference ₹0\.50 more in FlowFi/);
    expect(field("Date")).toMatch(/1 day later in FlowFi/);
    expect(field("Account")).toMatch(/HDFC Millennia •••• 4821.*HDFC Millennia •••• 4821.*Same account/);
    expect(field("Flags")).toMatch(/no split\/EMI/);
    expect(field("Context")).toMatch(/Team lunch/);
    // Near match: a suggestion — nothing decided yet, and choices never edit the FlowFi record.
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect(panel().textContent).toMatch(/only suggestions until you decide/);
  });

  it("offers the four plain-language actions; 'Not this match' drops the candidate", () => {
    seed("acc-card");
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    select("r1");
    for (const name of ["Keep existing", "Keep both", "Not this match", "Review later"]) {
      expect(within(panel()).getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(within(panel()).getByRole("button", { name: "Not this match" }));
    expect(within(panel()).queryAllByTestId("match-candidate")).toHaveLength(0);
    expect(rowEl("r1").dataset.state).toBe("no_match");
    // With nothing to compare, the add action reads simply "Import new".
    expect(within(panel()).getByRole("button", { name: "Import new" })).toBeTruthy();
  });
});

describe("readiness summary", () => {
  it("counts each status separately, imports only the Ready rows, and never claims everything will be imported", () => {
    seed("acc-card", { r1: { kind: "link", linkedRecordId: "t-sw" }, r2: { kind: "ignore" }, r3: { kind: "import_new", category: "Food" } });
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    const n = (key: string) => screen.getByTestId(`status-count-${key}`).querySelector("dd")!.textContent;
    expect([n("ready"), n("fix"), n("skipped")]).toEqual(["1", "1", "3"]); // r3 · r5 (closed bill) · r1 kept, r2 skipped, r4 excluded
    const button = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(button.textContent).toBe("Import 1 transaction");
    expect(button.disabled).toBe(false); // the blocked row no longer holds the Ready one back
    expect(screen.getByTestId("approval-hint").textContent).toMatch(/the 1 row still to resolve stay/);

    select("r5"); // in a closed card bill → can't be added; skipping it resolves the review
    expect(within(panel()).getByTestId("import-blocked").textContent).toMatch(/Can't import/);
    fireEvent.click(within(panel()).getByRole("button", { name: "Skip this transaction" }));
    const hint = screen.getByTestId("approval-hint").textContent!;
    expect(hint).toMatch(/Import adds the 1 Ready row as new transactions\./);
    expect(hint).not.toMatch(/\ball\b/i);
    expect(n("skipped")).toBe("4");
  });
});

describe("draft-only editor and zero writes", () => {
  it("shows the statement account read-only, offers Person and Split as draft choices, and edits stay in the tab draft — nothing is read from the server or written", () => {
    seed("acc-card");
    const { deps, creates, readData } = tripwire();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} approvalDeps={deps} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 3" }));
    expect(screen.getByTestId("editor-account").textContent).toMatch(/HDFC Millennia •••• 4821/);
    expect((screen.getByRole("radio", { name: "Split expense" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("radio", { name: "Someone else's expense" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "checked with receipt" } });
    expect(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)).toContain("checked with receipt");
    // The row sheet is modal: close it before going back to the dock.
    fireEvent.click(screen.getByTestId("editor-close"));

    // A full review pass — decisions, comparison, account change — still writes nothing.
    select("r1");
    fireEvent.click(menuItem("keep_existing"));
    setRowCategory("r3", "Food");
    expect(within(rowEl("r3")).getByTestId("decision-chip").textContent).toBe("Ready");
    pick("SBI Savings");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Change account" }));
    expect(readData).not.toHaveBeenCalled();
    expect(creates).not.toHaveBeenCalled();
  });
});

describe("layout contracts", () => {
  it("desktop: the single sheet's body is its own scroll region; the progress bar is a fixed part of the workspace (not floating over rows)", () => {
    seed("acc-card");
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(screen.getByTestId("recon-grid-body").className).toMatch(/overflow-y-auto/);
    expect(screen.queryByTestId("existing-grid-body")).toBeNull(); // one sheet — no second scroll region
    const bar = screen.getByTestId("status-bar");
    expect(bar.className).toMatch(/shrink-0/);
    expect(bar.className).not.toMatch(/sticky/);
    expect(screen.getByTestId("workspace-header")).toBeTruthy();
  });

  it("mobile: no grid, one page scroll, a sticky action bar and the account bar", () => {
    setViewport(390);
    seed("acc-card");
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getAllByTestId("recon-card")).toHaveLength(5);
    expect(screen.getByTestId("status-bar").className).toMatch(/sticky bottom-0/);
    expect(screen.getByTestId("account-bar").dataset.selected).toBe("true");
  });
});
