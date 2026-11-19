// @vitest-environment jsdom
/**
 * The dual-sheet merge studio: New Statement (left) ⇄ Existing FlowFi (right), the comparison dock and its Git-style
 * resolutions. Synthetic data only. Every interaction here is draft-only — the tripwire deps prove nothing is read from
 * the server or written while comparing and deciding.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 }); // each decision now goes through a row menu and, for imports, the row editor
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import type { ReconciliationData } from "../lib/analyze";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import { DRAFT_KEY_PREFIX, buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow, RowDecision } from "../lib/types";
import { menuItem, openImportConfirm, pickedRecordId } from "./menu-test-utils";
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
  localStorage.clear();
  localStorage.setItem("flowfi.recon.autoNext", "0"); // these tests decide a row and then keep inspecting it
  setViewport(1600);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OCT = (d: number): [number, number, number] => [2026, 10, d];
const at = (d: number, h = 13) => new Date(2026, 9, d, h);
const ROWS: ReconRow[] = [
  reconRow({ id: "r1", day: OCT(24), description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r2", day: OCT(24), description: "ZOMATO", amount: 300 }),
  reconRow({ id: "r3", day: OCT(22), description: "AMAZON PAY INDIA", amount: 1299 }),
  reconRow({ id: "r4", day: OCT(24), description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "r5", day: OCT(24), description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "r6", day: OCT(24), description: "BOOKSTORE", amount: 250 }),
  reconRow({ id: "r7", day: OCT(24), description: "REFUND AMAZON", amount: 300, direction: "credit", kind: "refund" }),
];
const DATA: ReconciliationData = reconData({
  transactions: [
    txn({ id: "t-sw", amount: 452, description: "Swiggy", source: "sms", notes: "Team lunch", dateTime: at(24) }),
    txn({ id: "t-sw-old", amount: 380, description: "Swiggy", dateTime: at(2) }),
    txn({ id: "t-z1", amount: 300, description: "Zomato", dateTime: at(24, 12) }),
    txn({ id: "t-z2", amount: 300, description: "Zomato", dateTime: at(24, 20) }),
    txn({ id: "t-am", amount: 1299.5, description: "Amazon Mktp", dateTime: at(23) }),
    txn({ id: "t-cafe", amount: 90, description: "Cafe One", dateTime: at(24) }),
    txn({ id: "t-rent", amount: 5000, description: "Rent", dateTime: at(20) }),
    txn({ id: "t-bank", amount: 250, description: "Bookstore", accountId: "acc-bank", dateTime: at(24) }),
  ],
});
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function seed(decisions: Record<string, Partial<RowDecision>> = {}) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, decisions, "acc-card")));
}

/** Tripwire deps: any server read or transaction write during the review shows up here. */
function tripwire() {
  const creates = vi.fn();
  const readData = vi.fn(async () => DATA);
  const fakeRepo = { getByKey: vi.fn(async () => null), createTransaction: creates } as unknown as TransactionRepository;
  const deps: ApprovalDeps = { readData, repositories: commitRepositoriesFor(fakeRepo), now: () => APPROVAL_NOW };
  return { deps, creates, readData };
}

const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const existingEl = (id: string) => screen.getAllByTestId("existing-row").find((r) => r.dataset.recordId === id)!;
const existingIds = () => screen.queryAllByTestId("existing-row").map((r) => r.dataset.recordId);
const resolve = (id: string) => menuItem(id);
const statementRowIds = () => screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId);
const comparingRow = () => screen.getByTestId("existing-comparing").dataset.rowId;
const select = (id: string) => fireEvent.click(rowEl(id));
const draft = () => sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;

function renderStudio() {
  const t = tripwire();
  render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} approvalDeps={t.deps} />);
  return t;
}

describe("dual-sheet selection and candidate highlighting", () => {
  it("shows both sheets side by side; selecting a statement row drives the Existing FlowFi sheet and the dock", () => {
    seed();
    renderStudio();
    expect(screen.getByTestId("statement-sheet")).toBeTruthy();
    expect(screen.getByTestId("existing-sheet")).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Existing FlowFi transactions" })).toBeTruthy();

    select("r1");
    expect(existingIds()).toEqual(["t-sw"]);
    expect(existingEl("t-sw").dataset.role).toBe("suggested");
    expect(existingEl("t-sw").getAttribute("aria-selected")).toBe("true");
    expect(comparingRow()).toBe("r1");
    expect(pickedRecordId()).toBe("t-sw");
    expect(screen.queryByTestId("resolution-dock")).toBeNull(); // no bottom action bar — actions live in each row's ⋯ menu
    expect(screen.getByTestId("sheet-link-count").textContent).toBe("1");

    select("r6"); // nothing similar on the card
    expect(existingIds()).toEqual([]);
    expect(screen.getByTestId("existing-empty").textContent).toMatch(/No match for Row 6/);
  });

  it("selecting an existing transaction highlights every statement row it could be (same-day genuine repeats)", () => {
    seed();
    renderStudio();
    select("r4");
    expect(existingIds()).toEqual(["t-cafe"]);
    expect(rowEl("r5").dataset.related).toBe("true"); // the twin row could be the same FlowFi transaction
    expect(rowEl("r1").dataset.related).toBeUndefined();
  });

  it("account ledger: everything on the account in the statement period, with the reason a record can't be this row", () => {
    seed();
    renderStudio();
    select("r1");
    fireEvent.click(screen.getByTestId("existing-mode-ledger"));
    expect(screen.getByTestId("existing-sheet").dataset.mode).toBe("ledger");
    expect(existingIds()).toEqual(expect.arrayContaining(["t-rent", "t-z1", "t-z2", "t-am", "t-cafe", "t-sw"]));
    expect(existingIds()).not.toContain("t-bank"); // another account — never shown
    expect(existingIds()).not.toContain("t-sw-old"); // outside the statement period
    fireEvent.click(existingEl("t-rent"));
    expect(existingEl("t-rent").dataset.viewOnly).toBe("amount");
    expect(resolve("keep_existing").disabled).toBe(true);
    expect(resolve("keep_existing").title).toMatch(/too far apart/);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // Search the account.
    fireEvent.change(screen.getByLabelText("Search existing transactions"), { target: { value: "zomato" } });
    expect(existingIds()).toEqual(["t-z1", "t-z2"]);
  });
});

describe("live match comparison", () => {
  // These read the field-by-field table, which is folded by default — open it, as a viewer would (remembered per viewer).
  beforeEach(() => localStorage.setItem("flowfi.recon.dockCollapsed", "0"));
  afterEach(() => localStorage.removeItem("flowfi.recon.dockCollapsed"));
  it("exact match: same amount and day, a suggestion — never decided by itself", () => {
    seed();
    renderStudio();
    select("r1");
    expect(existingEl("t-sw").textContent).toMatch(/Possible match/);
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
  });

  it("a near amount is a possible match whose difference is named beside the description", () => {
    seed();
    renderStudio();
    select("r3");
    expect(existingEl("t-am").textContent).toMatch(/Possible match/);
    expect(existingEl("t-am").textContent).toMatch(/₹0\.50 more/);
    expect(within(existingEl("t-am")).getByTestId("existing-difference").textContent).toMatch(/1 day later/);
  });

  it("multiple possible matches: both listed, nothing pre-decided; picking one compares and keeps exactly that one", () => {
    seed();
    renderStudio();
    select("r2");
    expect(rowEl("r2").dataset.state).toBe("multiple");
    expect(existingIds()).toEqual(["t-z1", "t-z2"]);
    expect(screen.getAllByTestId("existing-row").every((r) => r.dataset.role === "candidate")).toBe(true);
    fireEvent.click(existingEl("t-z2"));
    expect(pickedRecordId()).toBe("t-z2");
    fireEvent.click(resolve("keep_existing"));
    expect(within(rowEl("r2")).getByTestId("decision-chip").textContent).toBe("Keep existing");
    expect(existingEl("t-z2").textContent).toMatch(/Kept by row 2/);
    expect(JSON.parse(draft()).decisions.r2.linkedRecordId).toBe("t-z2");
  });
});

describe("Git-style resolution", () => {
  it("Keep existing: a draft link only — no edit, no deletion, no write", () => {
    seed();
    const { creates, readData } = renderStudio();
    select("r1");
    fireEvent.click(resolve("keep_existing"));
    expect(rowEl("r1").dataset.decision).toBe("link");
    expect(JSON.parse(draft()).decisions.r1.linkedRecordId).toBe("t-sw");
    expect(creates).not.toHaveBeenCalled();
    expect(readData).not.toHaveBeenCalled();
  });

  it("Keep both: needs the explicit acknowledgement; same-day repeat rows can each be resolved", () => {
    seed();
    renderStudio();
    select("r4");
    fireEvent.click(resolve("keep_existing")); // the first CAFE ONE is the recorded one
    select("r5");
    expect(rowEl("r5").dataset.state).toBe("conflict");
    expect(resolve("keep_existing").disabled).toBe(true); // one-to-one
    openImportConfirm();
    const submit = screen.getByTestId("import-confirm-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: "Food" } });
    expect(submit.disabled).toBe(true); // category alone is not enough — the acknowledgement is required
    fireEvent.click(screen.getByRole("checkbox", { name: "These are separate transactions" }));
    fireEvent.click(submit);
    expect(within(rowEl("r5")).getByTestId("decision-chip").textContent).toBe("Keep both");
    expect(JSON.parse(draft()).decisions.r5).toMatchObject({ kind: "import_new", notSameAck: true, category: "Food" });
  });

  it("Import as transaction: opens the row's editor; a credit must be named refund or income; the acknowledgement is only asked when FlowFi has something similar", () => {
    seed();
    renderStudio();
    select("r7");
    openImportConfirm();
    expect(screen.getByTestId("row-editor-panel")).toBeTruthy(); // the editor (date · description · amount · category · notes · owner) is what opened
    expect(screen.queryByRole("checkbox", { name: "These are separate transactions" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: "Salary" } });
    const submit = screen.getByTestId("import-confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Refund" }));
    fireEvent.click(submit);
    expect(within(rowEl("r7")).getByTestId("decision-chip").textContent).toBe("Import new");
    expect(JSON.parse(draft()).decisions.r7).toMatchObject({ kind: "import_new", category: "Salary", creditAs: "refund" });
  });

  it("the import confirmation works again on the next row after one was submitted (real pointer events)", async () => {
    seed();
    renderStudio();
    const user = userEvent.setup();
    await user.click(rowEl("r6"));
    await user.click(within(rowEl("r6")).getByTestId("quick-decide"));
    await user.click(screen.getByTestId("resolve-import"));
    await user.click(screen.getByTestId("import-as-transaction"));
    await user.selectOptions(screen.getByLabelText("Category for import"), "Food");
    await user.click(screen.getByTestId("import-confirm-submit"));
    expect(screen.queryByTestId("import-confirm")).toBeNull();
    expect(rowEl("r6").dataset.decision).toBe("import_new");
    await waitFor(() => expect(screen.queryByTestId("row-editor-panel")).toBeNull()); // the editor closed after importing
    await user.click(rowEl("r7"));
    await user.click(within(rowEl("r7")).getByTestId("quick-decide"));
    await user.click(screen.getByTestId("resolve-import"));
    await user.click(screen.getByTestId("import-as-transaction"));
    expect(screen.getByTestId("import-confirm")).toBeTruthy();
  });

  it("Remove from review: the row leaves the list, counts follow, nothing is imported or deleted, and Undo restores it", () => {
    seed();
    const { creates, readData } = renderStudio();
    const before = screen.getAllByTestId("recon-row").length;
    select("r6");
    fireEvent.click(resolve("remove"));
    expect(screen.getAllByTestId("recon-row")).toHaveLength(before - 1);
    expect(screen.getAllByTestId("recon-row").some((r) => r.dataset.rowId === "r6")).toBe(false);
    expect(comparingRow()).not.toBe("r6"); // the next row is selected
    expect(JSON.parse(draft()).rows.find((r: { id: string }) => r.id === "r6").include).toBe(false);
    expect(creates).not.toHaveBeenCalled();
    expect(readData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("undo-decision")); // the bottom bar's Undo puts it back
    expect(screen.getAllByTestId("recon-row")).toHaveLength(before);
    expect(comparingRow()).toBe("r6");
    expect(JSON.parse(draft()).rows.find((r: { id: string }) => r.id === "r6").include).toBe(true);
  });

  it("a removed row can also be restored from the Excluded filter", () => {
    seed();
    renderStudio();
    select("r6");
    fireEvent.click(resolve("remove"));
    fireEvent.click(screen.getByTestId("filter-menu"));
    fireEvent.click(screen.getByRole("radio", { name: /Excluded/ }));
    expect(statementRowIds()).toEqual(["r6"]);
    fireEvent.click(menuItem("restore", "r6"));
    expect(screen.getAllByTestId("recon-row").some((r) => r.dataset.rowId === "r6")).toBe(true);
  });

  it("Review later keeps the row open", () => {
    seed();
    renderStudio();
    select("r6");
    fireEvent.click(resolve("review_later"));
    expect(within(rowEl("r6")).getByTestId("decision-chip").textContent).toBe("Review later");
  });
});

describe("undo draft decisions", () => {
  it("Undo button, Z and Ctrl+Z step back through draft decisions", () => {
    seed();
    renderStudio();
    select("r1");
    fireEvent.click(resolve("keep_existing"));
    select("r6");
    fireEvent.click(resolve("review_later"));
    expect(screen.getByTestId("undo-decision").getAttribute("aria-label")).toBe("Undo Review later · row 6");

    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(within(rowEl("r6")).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect(screen.getByTestId("undo-notice").textContent).toMatch(/Undid “Review later · row 6”/);

    const grid = screen.getByRole("grid", { name: "Statement rows" });
    fireEvent.keyDown(grid, { key: "i" }); // skip r6
    expect(within(rowEl("r6")).getByText("Skipped")).toBeTruthy();
    fireEvent.keyDown(grid, { key: "z", ctrlKey: true });
    expect(within(rowEl("r6")).getByTestId("decision-chip").dataset.pending).toBe("true");
    fireEvent.keyDown(grid, { key: "z" });
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    expect((screen.getByTestId("undo-decision") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("keyboard navigation", () => {
  it("→ crosses into FlowFi, J/K pick a transaction, Enter keeps it, ← comes back", () => {
    seed();
    renderStudio();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    grid.focus();
    fireEvent.keyDown(grid, { key: "j" }); // r2 — two Zomatos
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    const existing = screen.getByRole("grid", { name: "Existing FlowFi transactions" });
    expect(document.activeElement).toBe(existing);
    fireEvent.keyDown(existing, { key: "j" });
    expect(existingEl("t-z2").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(existing, { key: "Enter" });
    expect(JSON.parse(draft()).decisions.r2.linkedRecordId).toBe("t-z2");
    fireEvent.keyDown(existing, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(grid);
  });

  it("N opens the row's editor to import (nothing is decided by the key); the divider resizes with the arrow keys and is remembered", () => {
    seed();
    renderStudio();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    fireEvent.keyDown(grid, { key: "n" });
    expect(screen.getByTestId("import-as-transaction")).toBeTruthy();
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    const divider = screen.getByRole("separator", { name: "Resize the sheets" });
    const start = Number(divider.getAttribute("aria-valuenow"));
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(start - 4);
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider.getAttribute("aria-valuenow")).toBe("40");
    expect(localStorage.getItem("flowfi.recon.split")).toBe("40");
  });
});

describe("layout and scrolling", () => {
  it("desktop: each sheet scrolls on its own under a sticky header; selection is synchronised, scrolling is not", () => {
    seed();
    renderStudio();
    expect(screen.getByTestId("recon-grid-body").className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("existing-grid-body").className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("statement-sheet").className).toMatch(/@container/);
    expect(screen.getByTestId("existing-sheet").className).toMatch(/@container/);
    expect(screen.getByTestId("dual-sheet").className).toMatch(/flex-1/);
  });

  it("phone: the sheets become tabs; the selected row stays pinned and can be kept from the FlowFi tab", async () => {
    setViewport(390);
    seed();
    renderStudio();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByTestId("mobile-tab-statement").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("recon-card")[1]!); // r2 opens its sheet
    });
    fireEvent.keyDown(screen.getByTestId("mobile-sheet"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("mobile-tab-existing"));
    expect(screen.getByTestId("mobile-context").textContent).toMatch(/Row 2.*ZOMATO/);
    expect(screen.getAllByTestId("mobile-existing-card").map((c) => c.dataset.recordId)).toEqual(["t-z1", "t-z2"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Keep existing Zomato" })[1]!);
    expect(screen.getByTestId("mobile-context").textContent).toMatch(/Keep existing/);
    expect(JSON.parse(draft()).decisions.r2.linkedRecordId).toBe("t-z2");
    fireEvent.click(screen.getByTestId("mobile-tab-statement"));
    expect(within(screen.getAllByTestId("recon-card")[1]!).getByText("Keep existing")).toBeTruthy();
  });
});

describe("approval regression and zero writes", () => {
  it("a full comparison pass writes nothing; decisions made here feed the unchanged Phase 4 approval", () => {
    seed();
    const { creates, readData } = renderStudio();
    select("r1");
    fireEvent.click(resolve("keep_existing"));
    select("r2");
    fireEvent.click(existingEl("t-z1"));
    fireEvent.click(resolve("keep_existing"));
    select("r3");
    fireEvent.click(screen.getByTestId("existing-mode-ledger"));
    fireEvent.click(resolve("keep_existing"));
    select("r4");
    fireEvent.click(resolve("keep_existing"));
    for (const id of ["r5", "r6", "r7"]) {
      select(id);
      fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "i" });
    }
    expect(readData).not.toHaveBeenCalled();
    expect(creates).not.toHaveBeenCalled();

    const approve = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    const dialog = screen.getByTestId("approval-dialog");
    expect(dialog.textContent).toMatch(/HDFC Millennia •••• 4821/);
    // Opening the summary is still not a write; only its explicit confirmation is.
    expect(readData).not.toHaveBeenCalled();
    expect(creates).not.toHaveBeenCalled();
  });

  it("a menu-made Import as transaction (new and keep-both) passes the Phase 4 approval end to end (fake repositories)", async () => {
    seed();
    const store = new Map<string, ReturnType<typeof txn>>();
    const fakeRepo = {
      getByKey: vi.fn(async (id: string) => store.get(id) ?? null),
      createTransaction: vi.fn(async (p: { idempotencyKey?: string; type: "income" | "expense"; amount: number; dateTime: Date; accountId: string; description: string }) => {
        const t = txn({ id: `txn_${p.idempotencyKey}`, type: p.type, amount: p.amount, dateTime: p.dateTime, accountId: p.accountId, description: p.description });
        store.set(t.id, t);
        return t;
      }),
    } as unknown as TransactionRepository;
    const deps: ApprovalDeps = { readData: vi.fn(async () => DATA), repositories: commitRepositoriesFor(fakeRepo), now: () => APPROVAL_NOW };
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} approvalDeps={deps} />);
    const importVia = (rowId: string, button: "import_new" | "keep_both", credit?: "Refund") => {
      select(rowId);
      openImportConfirm();
      if (button === "keep_both") fireEvent.click(screen.getByRole("checkbox", { name: "These are separate transactions" }));
      fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: credit ? "Salary" : "Food" } });
      if (credit) fireEvent.click(screen.getByRole("radio", { name: credit }));
      fireEvent.click(screen.getByTestId("import-confirm-submit"));
    };
    for (const id of ["r1", "r2", "r3", "r4"]) {
      select(id);
      fireEvent.click(resolve("keep_existing"));
    }
    importVia("r5", "keep_both");
    importVia("r6", "import_new");
    importVia("r7", "import_new", "Refund");
    fireEvent.click(screen.getByTestId("open-approval"));
    const dialog = screen.getByTestId("approval-dialog");
    fireEvent.click(within(dialog).getByTestId("approval-confirm"));
    fireEvent.click(within(dialog).getByTestId("approval-submit"));
    await waitFor(() => expect(within(dialog).getByTestId("approval-result")).toBeTruthy());
    const outcomes = within(dialog).getAllByTestId("approval-outcome").map((e) => `${e.dataset.rowId}:${e.dataset.outcome}`);
    expect(outcomes).toEqual(expect.arrayContaining(["r5:imported", "r6:imported", "r7:imported", "r1:linked"]));
    expect(fakeRepo.createTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("select → find possible matches → compare → decide (2026-11-18)", () => {
  const comparing = () => screen.getByTestId("existing-comparing").dataset.rowId;

  it("the FlowFi side always describes the selected row; a row hidden by a filter hands focus to the next shown row", () => {
    seed();
    renderStudio();
    select("r3");
    expect(comparing()).toBe("r3");
    select("r1");
    expect(comparing()).toBe("r1");
    expect(existingIds()).toEqual(["t-sw"]);
    // Decide r1, then show only Pending rows: r1 is hidden, so neither side may keep describing it.
    fireEvent.click(resolve("keep_existing"));
    fireEvent.click(screen.getByTestId("status-pending"));
    expect(screen.getAllByTestId("recon-row").some((r) => r.dataset.rowId === "r1")).toBe(false);
    expect(comparing()).toBe("r2");
  });

  it("a row with no match says so and lists the rows that do have one — one click compares them", () => {
    seed();
    renderStudio();
    select("r6"); // Bookstore: only the BANK has one, so nothing on the card
    expect(rowEl("r6").dataset.state).toBe("no_match");
    const others = within(screen.getByTestId("existing-other-rows")).getAllByTestId("existing-other-row").map((b) => b.getAttribute("aria-label"));
    expect(others).toEqual(expect.arrayContaining(["Compare row 1", "Compare row 2", "Compare row 3"]));
    expect(others).not.toContain("Compare row 6");
    fireEvent.click(within(screen.getByTestId("existing-other-rows")).getByRole("button", { name: "Compare row 1" }));
    expect(comparing()).toBe("r1");
    expect(existingIds()).toEqual(["t-sw"]);
    expect(rowEl("r1").getAttribute("aria-selected")).toBe("true");
  });

  it("Keep existing · Import as transaction · Not a match — ignoring only drops that suggestion, writes nothing, and Undo brings it back", () => {
    seed();
    const { creates, readData } = renderStudio();
    select("r3"); // ₹1,299.00 vs FlowFi ₹1,299.50 — a possible match
    expect(rowEl("r3").dataset.state).toBe("near_amount");
    expect(resolve("import").textContent).toMatch(/Import as transaction/);
    expect(resolve("keep_existing").textContent).toMatch(/Keep existing/);
    fireEvent.click(resolve("ignore_match"));
    expect(rowEl("r3").dataset.state).toBe("no_match");
    expect(rowEl("r3").dataset.decision).toBe(""); // nothing decided or dismissed — still under review
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(rowEl("r3").dataset.state).toBe("near_amount");
    expect(creates).not.toHaveBeenCalled();
    expect(readData).not.toHaveBeenCalled();
  });
});
