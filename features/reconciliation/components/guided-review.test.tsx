// @vitest-environment jsdom
/**
 * Guided review: the grid's quick-decide menu, "Next undecided", the comparison panel's row navigation and its
 * plain-language decision list. All of it only changes the tab's draft — the same rules as the buttons in the panel.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { RecordsSync } from "../hooks/use-reconciliation-data";
import type { ReconciliationData } from "../lib/analyze";
import { buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow, RowDecision } from "../lib/types";
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
const DATA: ReconciliationData = reconData({
  transactions: [
    txn({ id: "t-sw", amount: 452.5, description: "Swiggy", notes: "Team lunch", source: "sms", dateTime: new Date(2026, 9, 25, 13) }),
    txn({ id: "t-nf", amount: 649, description: "Netflix", accountId: "acc-bank", dateTime: new Date(2026, 9, 24, 13) }),
  ],
});
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function seed(decisions: Record<string, Partial<RowDecision>> = {}) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, decisions, "acc-card")));
}

const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
/** Desktop: the full comparison (MatchPanel) opens in a drawer from the dock's "Full details"; phones show it in the row's sheet. */
const panel = () => screen.queryByTestId("match-panel") ?? (fireEvent.click(screen.getByTestId("dock-details")), screen.getByTestId("match-panel"));
const menuOf = (id: string) => within(rowEl(id)).getByTestId("quick-decide");

describe("quick-decide menu", () => {
  it("decides a row from the grid, shows what each choice does, and clears it again", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(within(rowEl("r3")).getByText("Undecided")).toBeTruthy();

    fireEvent.click(menuOf("r3"));
    expect(screen.getByRole("menuitem", { name: /^Import new/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Clear my decision/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Skip this transaction/ }));
    expect(within(rowEl("r3")).getByText("Skipped")).toBeTruthy();
    expect(rowEl("r3").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(menuOf("r3"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear my decision/ }));
    expect(within(rowEl("r3")).getByText("Undecided")).toBeTruthy();
  });

  it("keeps a rule-blocked choice visible but disabled, with the reason", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    fireEvent.click(menuOf("r5")); // dated inside a closed card bill
    const add = screen.getByRole("menuitem", { name: /^Import new/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.textContent).toMatch(/already closed/);
  });

  it("'Keep both' on a row with possible matches opens the explicit confirmation instead of deciding", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    fireEvent.click(menuOf("r1"));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Keep both/ }));
    expect(within(rowEl("r1")).getByText("Undecided")).toBeTruthy();
    expect(screen.getByTestId("resolution-dock").dataset.rowId).toBe("r1");
    expect(screen.getByTestId("import-confirm").textContent).toMatch(/these are separate transactions/);
  });

  it("excluded rows have no menu", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(within(rowEl("r4")).queryByTestId("quick-decide")).toBeNull();
    expect(within(rowEl("r4")).getByText("Not imported")).toBeTruthy();
  });
});

describe("next undecided", () => {
  it("jumps to the next row that still needs a decision and disappears when none are left", () => {
    seed({ r1: { kind: "ignore" } });
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    select("r1");
    fireEvent.click(screen.getByTestId("next-open"));
    expect(rowEl("r2").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(menuOf("r2"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Skip this transaction/ }));
    fireEvent.click(screen.getByTestId("next-open"));
    expect(rowEl("r3").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(menuOf("r3"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Skip this transaction/ }));

    // r5 is the last one; once it's decided the review is complete.
    fireEvent.click(screen.getByTestId("next-open"));
    expect(rowEl("r5").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(menuOf("r5"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Skip this transaction/ }));
    expect(screen.queryByTestId("next-open")).toBeNull();
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("progressbar", { name: "Review progress" }).getAttribute("aria-valuenow")).toBe("100");
  });

  function select(id: string) {
    fireEvent.click(rowEl(id));
  }
});

describe("comparison panel", () => {
  it("steps through the rows with Previous / Next", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    fireEvent.click(rowEl("r1"));
    expect(within(within(panel()).getByTestId("panel-nav")).getByText("1 of 5")).toBeTruthy();
    expect((within(panel()).getByRole("button", { name: "Previous row" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(panel()).getByRole("button", { name: "Next row" }));
    expect(panel().dataset.rowId).toBe("r2");
    fireEvent.click(within(panel()).getByRole("button", { name: "Previous row" }));
    expect(panel().dataset.rowId).toBe("r1");
  });

  it("puts the decision list right under a row with nothing to compare, and puts the block reason on 'Add as new'", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    fireEvent.click(rowEl("r5")); // no match, in a closed bill
    const sections = within(panel()).getAllByRole("region").map((s) => s.getAttribute("aria-label"));
    expect(sections.indexOf("Decision")).toBeLessThan(sections.indexOf("Possible matches"));
    const addOption = panel().querySelector('[data-decision="import_new"]') as HTMLElement;
    expect(within(addOption).getByTestId("import-blocked").textContent).toMatch(/Can't import/);
    expect((within(addOption).getByRole("button", { name: "Import new" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("each choice says what it does, and the selected one is marked", () => {
    seed({ r3: { kind: "ignore" } });
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    fireEvent.click(rowEl("r3"));
    const skip = within(panel()).getByRole("button", { name: "Skip this transaction" });
    expect(skip.getAttribute("aria-pressed")).toBe("true");
    expect(skip.getAttribute("aria-describedby")).toBeTruthy();
    expect(panel().textContent).toMatch(/Nothing is written for this row/);
  });
});
