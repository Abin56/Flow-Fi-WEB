// @vitest-environment jsdom
/**
 * Detected matches are visible when a review opens: the first row with an undecided possible match is selected (never
 * decided), a "possible matches found" strip jumps to each, the choice is remembered for the tab, and undecided rows read
 * "Needs review" / "Possible match". Synthetic data only; nothing here is written.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { RecordsSync } from "../hooks/use-reconciliation-data";
import type { ReconciliationData } from "../lib/analyze";
import { DRAFT_KEY_PREFIX, buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow, RowDecision } from "../lib/types";
import { activeRowId, menuItem } from "./menu-test-utils";
import { ReconciliationWorkspace } from "./reconciliation-workspace";

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
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? 1600 >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OCT = (d: number): [number, number, number] => [2026, 10, d];
const at = (d: number, h = 13) => new Date(2026, 9, d, h);
// Row 1 has nothing on the account; rows 2 and 3 each have one possible match.
const ROWS: ReconRow[] = [
  reconRow({ id: "r1", day: OCT(24), description: "BOOKSTORE", amount: 250 }),
  reconRow({ id: "r2", day: OCT(24), description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r3", day: OCT(22), description: "AMAZON PAY INDIA", amount: 1299 }),
  reconRow({ id: "r4", day: OCT(21), description: "GYM", amount: 700 }),
];
const DATA: ReconciliationData = reconData({
  transactions: [txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: at(24) }), txn({ id: "t-am", amount: 1299.5, description: "Amazon Mktp", dateTime: at(23) })],
});
const NO_MATCH_DATA: ReconciliationData = reconData({ transactions: [] });
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function seed(decisions: Record<string, Partial<RowDecision>> = {}) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, decisions, "acc-card")));
}
const open = (data = DATA) => render(<ReconciliationWorkspace uid="u1" data={data} sync={LOADED} />);
const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const comparing = () => activeRowId();
/** The match chip opens the row's inline review. */
const compare = (n: number) => fireEvent.click(screen.getByRole("button", { name: `Compare row ${n}` }));
/** The FlowFi transactions the open inline review shows (the candidate list, or the single compared one). */
const existingIds = () => {
  const list = screen.queryAllByTestId("inline-candidate").map((r) => r.dataset.recordId);
  if (list.length > 0) return list;
  const one = screen.queryByTestId("inline-compare")?.dataset.recordId;
  return one ? [one] : [];
};
const draftText = () => sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`);

describe("detected matches are visible on open", () => {
  it("opens on the first row that has a possible match, shows its FlowFi transaction, and decides nothing", () => {
    seed();
    const before = (seed(), draftText());
    open();
    expect(comparing()).toBe("r2");
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");
    expect(existingIds()).toEqual([]); // nothing is expanded until the match chip is clicked
    compare(2);
    expect(existingIds()).toEqual(["t-sw"]);
    expect(rowEl("r2").dataset.decision).toBe("");
    expect(draftText()).toBe(before); // viewing a match never edits the draft
  });

  it("one sheet, no second table: a row with a match expands in place under it; a row with no match says so", () => {
    seed();
    open();
    expect(screen.queryByTestId("existing-sheet")).toBeNull();
    expect(screen.queryByRole("grid", { name: "Existing FlowFi transactions" })).toBeNull();
    fireEvent.click(rowEl("r1")); // no match for this one
    compare(1);
    expect(screen.getByTestId("inline-no-candidate").textContent).toMatch(/Nothing on this account looks like this row/);
    // Opening another row's review replaces it — only one panel is ever open, directly under its row.
    compare(3);
    expect(screen.getAllByTestId("inline-review")).toHaveLength(1);
    expect(rowEl("r3").nextElementSibling).toBe(screen.getByTestId("inline-review"));
    expect(existingIds()).toEqual(["t-am"]);
    expect(screen.getByTestId("inline-compare").textContent).toMatch(/0\.50/); // the difference is named, not hidden
  });

  it("deciding the match removes it from the stepper; with no matches anywhere there is no match heading", () => {
    seed({ r2: { kind: "link", linkedRecordId: "t-sw" } });
    open();
    expect(comparing()).toBe("r3"); // r2 is already handled
    cleanup();
    sessionStorage.removeItem("flowfi.recon.selectedRow"); // a fresh visit, not a return to r3
    seed();
    open(NO_MATCH_DATA);
    expect(comparing()).toBe("r1");
  });

  it("returning to an unfinished review keeps the row the user was on", () => {
    seed();
    const first = open();
    fireEvent.click(rowEl("r4"));
    expect(comparing()).toBe("r4");
    first.unmount();
    open();
    expect(comparing()).toBe("r4");
  });

  it("Match column says Possible match / No match; Decision says Needs review — never 'Undecided'", () => {
    seed();
    open();
    expect(within(rowEl("r2")).getByRole("button", { name: "Compare row 2" }).textContent).toBe("Possible match");
    expect(within(rowEl("r1")).getByRole("button", { name: "Compare row 1" }).textContent).toBe("No match");
    expect(within(rowEl("r2")).getByTestId("decision-chip").textContent).toBe("Needs review");
    expect(within(rowEl("r1")).getByTestId("decision-chip").textContent).toBe("Needs review");
    expect(screen.queryByText("Undecided")).toBeNull();
  });
});

describe("review flow: decide → feedback → next row waiting", () => {
  it("after a decision on the row in focus, the next undecided row is selected; Undo brings the decided row back", () => {
    seed();
    open();
    expect(comparing()).toBe("r2");
    fireEvent.click(menuItem("keep_existing"));
    expect(rowEl("r2").dataset.decision).toBe("link");
    expect(comparing()).toBe("r3"); // the next row still waiting
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(rowEl("r2").dataset.decision).toBe("");
    expect(comparing()).toBe("r2"); // revisited
  });

  it("Auto-next can be switched off — the row stays selected after a decision", () => {
    seed();
    open();
    fireEvent.click(screen.getByTestId("auto-next"));
    expect(localStorage.getItem("flowfi.recon.autoNext")).toBe("0");
    fireEvent.click(menuItem("keep_existing"));
    expect(comparing()).toBe("r2");
  });
});

describe("row menu", () => {
  it("Enter on a row's ⋯ button belongs to the button — it never opens the editor through the grid's own Enter", () => {
    seed();
    open();
    const trigger = within(rowEl("r2")).getByTestId("quick-decide");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByTestId("row-editor-panel")).toBeNull();
  });

  it("N never opens the editor for a row a financial rule blocks, but does for one that just needs its values fixed", () => {
    seed();
    open();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    fireEvent.click(rowEl("r1"));
    fireEvent.keyDown(grid, { key: "n" });
    expect(screen.getByTestId("import-as-transaction")).toBeTruthy();
  });
});
