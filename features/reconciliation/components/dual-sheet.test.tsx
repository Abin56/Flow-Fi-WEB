// @vitest-environment jsdom
/**
 * The single-sheet review (2026-11-24): ONE statement table; a row's match chip opens an inline review directly under
 * it (candidates · one side-by-side comparison · the four decisions). The old second "Existing FlowFi" sheet and its
 * divider are gone from the desktop view (their components remain, unrouted). Synthetic data only. Every interaction here is draft-only — the tripwire deps prove nothing is read from
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
import type { Category } from "@/lib/models/category";
import type { ReconRow, RowDecision } from "../lib/types";
import { activeRowId, menuItem, openInlineReview, pickedRecordId, rowStatusOf, setRowCategory } from "./menu-test-utils";
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
const OTHER_CATEGORY = { id: "c-other", name: "Other", type: "both", isActive: true, deletedAt: null } as unknown as Category;
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
/** A candidate in the open inline review. */
const candidateEl = (id: string) => screen.getAllByTestId("inline-candidate").find((r) => r.dataset.recordId === id)!;
/** The FlowFi transactions the open inline review shows (the candidate list, or the single compared one). */
const existingIds = () => {
  const list = screen.queryAllByTestId("inline-candidate").map((r) => r.dataset.recordId);
  if (list.length > 0) return list;
  const one = screen.queryByTestId("inline-compare")?.dataset.recordId;
  return one ? [one] : [];
};
/** The match chip opens the row's inline review under it. */
const compare = (n: number) => fireEvent.click(screen.getByRole("button", { name: `Compare row ${n}` }));
const field = (name: string) => screen.getByTestId("inline-compare").querySelector(`[data-field="${name}"]`) as HTMLElement;
const resolve = (id: string) => menuItem(id);
const statementRowIds = () => screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId);
const comparingRow = () => activeRowId();
const select = (id: string) => fireEvent.click(rowEl(id));
const draft = () => sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!;

/** `withOther`: the user has the system "Other" category, so clean unmatched rows are Ready by default. */
function renderStudio(withOther = false) {
  const t = tripwire();
  const data = withOther ? { ...DATA, categories: [...DATA.categories, OTHER_CATEGORY] } : DATA;
  render(<ReconciliationWorkspace uid="u1" data={data} sync={LOADED} approvalDeps={t.deps} />);
  return t;
}

describe("single-sheet selection and the inline review", () => {
  it("shows ONE statement sheet; a match chip opens the row's review directly under it, with no second table", () => {
    seed();
    renderStudio();
    expect(screen.getByTestId("statement-sheet")).toBeTruthy();
    expect(screen.queryByTestId("existing-sheet")).toBeNull();
    expect(screen.queryByRole("grid", { name: "Existing FlowFi transactions" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize the sheets" })).toBeNull();
    expect(screen.queryByTestId("inline-review")).toBeNull(); // nothing is expanded until a chip is clicked

    select("r1");
    compare(1);
    expect(existingIds()).toEqual(["t-sw"]);
    expect(pickedRecordId()).toBe("t-sw");
    expect(comparingRow()).toBe("r1");
    expect(rowEl("r1").nextElementSibling).toBe(screen.getByTestId("inline-review")); // directly under its row, same scroll body
    expect(screen.getByTestId("recon-grid-body").contains(screen.getByTestId("inline-review"))).toBe(true);
    expect(screen.queryByTestId("resolution-dock")).toBeNull(); // no bottom action bar — actions live in the row and the panel

    select("r6"); // nothing similar on the card — the panel closes with the selection
    expect(screen.queryByTestId("inline-review")).toBeNull();
    compare(6);
    expect(existingIds()).toEqual([]);
    expect(screen.getByTestId("inline-no-candidate").textContent).toMatch(/Nothing on this account looks like this row/);
  });

  it("clicking the chip again, the close button or Escape collapses it; only one review is ever open", () => {
    seed();
    renderStudio();
    compare(1);
    expect(screen.getAllByTestId("inline-review")).toHaveLength(1);
    compare(1);
    expect(screen.queryByTestId("inline-review")).toBeNull();
    compare(2);
    compare(3);
    expect(screen.getAllByTestId("inline-review")).toHaveLength(1);
    expect(screen.getByTestId("inline-review").dataset.rowId).toBe("r3");
    fireEvent.click(screen.getByTestId("inline-review-close"));
    expect(screen.queryByTestId("inline-review")).toBeNull();
    compare(1);
    fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "Escape" });
    expect(screen.queryByTestId("inline-review")).toBeNull();
  });

  it("the inline review lists only the matcher's candidates — never another account's record or one outside the window", () => {
    seed();
    renderStudio();
    select("r6"); // Bookstore ₹250 exists only on the BANK
    compare(6);
    expect(existingIds()).not.toContain("t-bank");
    select("r1"); // Swiggy: the ₹380 one from 22 days earlier is not a candidate
    compare(1);
    expect(existingIds()).toEqual(["t-sw"]);
  });

  it("two same-day statement rows can each open the same FlowFi transaction as a candidate (genuine repeats stay separate decisions)", () => {
    seed();
    renderStudio();
    select("r4");
    compare(4);
    expect(existingIds()).toEqual(["t-cafe"]);
    select("r5");
    compare(5);
    expect(existingIds()).toEqual(["t-cafe"]);
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
    compare(1);
    expect(field("amount").dataset.verdict).toBe("same");
    expect(field("date").dataset.verdict).toBe("same");
    expect(field("account").dataset.verdict).toBe("same");
    expect(screen.getByTestId("inline-review").textContent).not.toMatch(/(confirmed|exact|definite|is a) duplicate/i);
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
  });

  it("a near amount is a possible match whose differences are highlighted (₹1,299 vs ₹1,299.50, a day apart)", () => {
    seed();
    renderStudio();
    select("r3");
    compare(3);
    expect(rowEl("r3").dataset.state).toBe("near_amount");
    expect(field("amount").dataset.verdict).toBe("diff");
    expect(field("amount").textContent).toMatch(/₹0\.50 more/);
    expect(field("date").dataset.verdict).toBe("diff");
    expect(field("date").textContent).toMatch(/1 day later/);
    expect(within(rowEl("r3")).getByTestId("decision-chip").dataset.pending).toBe("true");
  });

  it("multiple possible matches: both listed, nothing pre-decided; picking one compares and keeps exactly that one", () => {
    seed();
    renderStudio();
    select("r2");
    compare(2);
    expect(rowEl("r2").dataset.state).toBe("multiple");
    expect(existingIds()).toEqual(["t-z1", "t-z2"]);
    expect(rowEl("r2").dataset.decision).toBe("");
    fireEvent.click(candidateEl("t-z2"));
    expect(pickedRecordId()).toBe("t-z2");
    expect(screen.getAllByTestId("inline-compare")).toHaveLength(1); // one detailed comparison at a time
    fireEvent.click(screen.getByTestId("inline-keep-existing"));
    expect(within(rowEl("r2")).getByTestId("decision-chip").textContent).toBe("Already recorded");
    expect(JSON.parse(draft()).decisions.r2.linkedRecordId).toBe("t-z2");
    expect(screen.queryByTestId("inline-review")).toBeNull(); // deciding collapses the panel
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

  it("Keep both: one explicit click in the comparison; same-day repeat rows can each be resolved", () => {
    seed();
    renderStudio();
    select("r4");
    fireEvent.click(resolve("keep_existing")); // the first CAFE ONE is the recorded one
    select("r5");
    expect(rowEl("r5").dataset.state).toBe("conflict");
    expect(resolve("keep_existing").disabled).toBe(true); // one-to-one
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    openInlineReview("r5");
    fireEvent.click(screen.getByTestId("inline-keep-both"));
    expect(JSON.parse(draft()).decisions.r5).toMatchObject({ kind: "import_new", notSameAck: true });
    // One earlier "Cafe One" is too thin a history to choose for the user — Food is only ranked first; the user picks it.
    expect(rowStatusOf("r5")).toBe("fix");
    setRowCategory("r5", "Food");
    expect(rowStatusOf("r5")).toBe("ready");
    expect(JSON.parse(draft()).decisions.r5).toMatchObject({ kind: "import_new", notSameAck: true, category: "Food" });
  });

  it("a credit is never assumed: its type is chosen on the row (or in the editor), then a category — no acknowledgement without a match", () => {
    seed();
    renderStudio();
    select("r7");
    expect(rowStatusOf("r7")).toBe("fix");
    fireEvent.click(resolve("import")); // "Edit details" opens the row's editor
    expect(screen.getByTestId("row-editor-panel")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "These are separate transactions" })).toBeNull();
    fireEvent.change(screen.getByTestId("credit-type-select"), { target: { value: "refund" } });
    expect(JSON.parse(draft()).decisions.r7).toMatchObject({ creditAs: "refund" });
    fireEvent.click(screen.getByTestId("editor-close"));
    setRowCategory("r7", "Salary");
    expect(rowStatusOf("r7")).toBe("ready");
    expect(within(rowEl("r7")).getByTestId("decision-chip").textContent).toBe("Ready");
    expect(JSON.parse(draft()).decisions.r7).toMatchObject({ category: "Salary", creditAs: "refund" });
  });

  it("row choices work one after another with real pointer events (category on one row, credit type on the next)", async () => {
    seed();
    renderStudio();
    const user = userEvent.setup();
    await user.selectOptions(within(rowEl("r6")).getByTestId("row-category"), "Food");
    expect(rowStatusOf("r6")).toBe("ready");
    await user.click(within(rowEl("r7")).getByTestId("row-credit-type"));
    await user.click(screen.getByTestId("row-credit-type-refund"));
    expect(JSON.parse(draft()).decisions.r7).toMatchObject({ creditAs: "refund" });
    expect(rowStatusOf("r7")).toBe("fix"); // still needs its category
    expect(within(rowEl("r7")).getByTestId("row-choose-category")).toBeTruthy();
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
  it("O opens the inline review; J/K move the selection and close it; L keeps the picked transaction", () => {
    seed();
    renderStudio();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    grid.focus();
    fireEvent.keyDown(grid, { key: "o" });
    expect(screen.getByTestId("inline-review").dataset.rowId).toBe("r1");
    fireEvent.keyDown(grid, { key: "j" }); // r2 — two Zomatos
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("inline-review")).toBeNull();
    fireEvent.keyDown(grid, { key: "o" });
    expect(existingIds()).toEqual(["t-z1", "t-z2"]);
    fireEvent.click(candidateEl("t-z2"));
    fireEvent.keyDown(grid, { key: "l" });
    expect(JSON.parse(draft()).decisions.r2.linkedRecordId).toBe("t-z2");
  });

  it("N opens the row's editor to import (nothing is decided by the key)", () => {
    seed();
    renderStudio();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    fireEvent.keyDown(grid, { key: "n" });
    expect(screen.getByTestId("import-as-transaction")).toBeTruthy();
    expect(within(rowEl("r1")).getByTestId("decision-chip").dataset.pending).toBe("true");
    fireEvent.click(screen.getByTestId("editor-close"));
  });
});

describe("layout and scrolling", () => {
  it("desktop: the one sheet scrolls on its own under a sticky header; the inline review lives INSIDE that scroll body (no nested scroller)", () => {
    seed();
    renderStudio();
    expect(screen.getByTestId("recon-grid-body").className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("statement-sheet").className).toMatch(/@container/);
    expect(screen.getByTestId("review-sheet").className).toMatch(/flex-1/);
    compare(2);
    const panel = screen.getByTestId("inline-review");
    expect(screen.getByTestId("recon-grid-body").contains(panel)).toBe(true);
    // The panel is in normal flow: no own overflow / max-height that would create a second scroller, and it is not sticky.
    expect(panel.className).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-|sticky|fixed|absolute/);
    // The column header is outside the scroll body, so nothing can overlap an expanded panel.
    expect(screen.getByTestId("recon-grid-body").contains(screen.getByRole("columnheader", { name: "Description" }))).toBe(false);
    // Expanding and collapsing never changes the scroll position of the body.
    const body = screen.getByTestId("recon-grid-body");
    body.scrollTop = 0;
    fireEvent.click(screen.getByTestId("inline-review-close"));
    expect(body.scrollTop).toBe(0);
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
    const { creates, readData } = renderStudio(true);
    select("r1");
    fireEvent.click(resolve("keep_existing"));
    select("r2");
    compare(2);
    fireEvent.click(candidateEl("t-z1"));
    fireEvent.click(screen.getByTestId("inline-keep-existing"));
    select("r3");
    fireEvent.click(resolve("keep_existing"));
    select("r4");
    fireEvent.click(resolve("keep_existing"));
    for (const id of ["r5", "r7"]) {
      select(id);
      fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "i" });
    }
    // r6 (Bookstore, nothing similar on the card) needs only its category — then it is simply Ready.
    expect(within(rowEl("r6")).getByTestId("decision-chip").dataset.status).toBe("fix");
    setRowCategory("r6", "Food");
    expect(within(rowEl("r6")).getByTestId("decision-chip").dataset.status).toBe("ready");
    expect(readData).not.toHaveBeenCalled();
    expect(creates).not.toHaveBeenCalled();

    // The button says what it will do, and nothing has been written until it is pressed.
    const approve = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(approve.textContent).toBe("Import 1 transaction");
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
    for (const id of ["r1", "r2", "r3", "r4"]) {
      select(id);
      fireEvent.click(resolve("keep_existing"));
    }
    openInlineReview("r5");
    fireEvent.click(screen.getByTestId("inline-keep-both"));
    setRowCategory("r5", "Food");
    setRowCategory("r6", "Food");
    fireEvent.click(within(rowEl("r7")).getByTestId("row-credit-type"));
    fireEvent.click(screen.getByTestId("row-credit-type-refund"));
    setRowCategory("r7", "Salary");
    expect(["r5", "r6", "r7"].map(rowStatusOf)).toEqual(["ready", "ready", "ready"]);
    fireEvent.click(screen.getByTestId("open-approval"));
    await waitFor(() => expect(screen.queryAllByTestId("recon-row")).toHaveLength(0)); // all handled → the finished review is cleared
    expect(fakeRepo.createTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("select → find possible matches → compare → decide (2026-11-18)", () => {
  const comparing = () => activeRowId();

  it("the open review always describes the selected row; a row hidden by a filter hands focus to the next shown row", () => {
    seed();
    renderStudio();
    select("r3");
    expect(comparing()).toBe("r3");
    select("r1");
    compare(1);
    expect(comparing()).toBe("r1");
    expect(existingIds()).toEqual(["t-sw"]);
    // Decide r1, then show only Pending rows: r1 is hidden, so the selection moves on to the next shown row.
    fireEvent.click(resolve("keep_existing"));
    fireEvent.click(screen.getByTestId("rf-duplicate")); // only rows that still need a duplicate decision
    expect(screen.getAllByTestId("recon-row").some((r) => r.dataset.rowId === "r1")).toBe(false);
    expect(comparing()).toBe("r2");
    expect(screen.queryByTestId("inline-review")).toBeNull();
  });

  it("Keep existing · Import as transaction · Not a match — ignoring only drops that suggestion, writes nothing, and Undo brings it back", () => {
    seed();
    const { creates, readData } = renderStudio();
    select("r3"); // ₹1,299.00 vs FlowFi ₹1,299.50 — a possible match
    expect(rowEl("r3").dataset.state).toBe("near_amount");
    expect(resolve("import").textContent).toMatch(/Edit details/);
    expect(resolve("keep_existing").textContent).toMatch(/Already recorded/);
    fireEvent.click(resolve("ignore_match"));
    expect(rowEl("r3").dataset.state).toBe("no_match");
    expect(rowEl("r3").dataset.decision).toBe(""); // nothing decided or dismissed — still under review
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(rowEl("r3").dataset.state).toBe("near_amount");
    expect(creates).not.toHaveBeenCalled();
    expect(readData).not.toHaveBeenCalled();
  });
});
