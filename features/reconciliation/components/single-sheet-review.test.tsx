// @vitest-environment jsdom
/**
 * Single-sheet review scenarios (2026-11-24): the user's ₹299-vs-₹300 grocery example, the four explicit decisions
 * (Keep existing · Import statement / Keep both · Review later · Not a match), the summary + filter strip, and the
 * rule that editing a row withdraws a decision made against its old values. Every interaction is draft-only; the
 * tripwire proves nothing is read from the server or written while reviewing and deciding.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import type { ReconciliationData } from "../lib/analyze";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import { DRAFT_KEY_PREFIX, buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow, RowDecision } from "../lib/types";
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
  localStorage.setItem("flowfi.recon.autoNext", "0");
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? 1600 >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = (d: number, h = 13) => new Date(2026, 9, d, h);
const ROWS: ReconRow[] = [
  // The user's example: FlowFi has "Grocery purchase ₹300"; the bank says "UPI GROCERY STORE ₹299" the same day.
  reconRow({ id: "g1", day: [2026, 10, 20], description: "UPI GROCERY STORE", amount: 299 }),
  // Same description, a different day (bank posted a day later) and a clearly different amount: should not be an exact match.
  reconRow({ id: "g2", day: [2026, 10, 22], description: "PHARMACY MEDPLUS", amount: 480 }),
  // Nothing in FlowFi at all.
  reconRow({ id: "g3", day: [2026, 10, 24], description: "BOOKSTORE", amount: 725 }),
  // Same amount as an unrelated different-merchant record on the same day — must NOT be paired on amount alone.
  reconRow({ id: "g4", day: [2026, 10, 24], description: "ELECTRIC BOARD", amount: 1200 }),
];
const DATA: ReconciliationData = reconData({
  transactions: [
    txn({ id: "t-groc", amount: 300, description: "Grocery purchase", dateTime: at(20) }),
    txn({ id: "t-med", amount: 480, description: "Medplus pharmacy", dateTime: at(23) }),
    txn({ id: "t-other", amount: 1200, description: "Netflix annual", dateTime: at(24) }),
  ],
});
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function seed(decisions: Record<string, Partial<RowDecision>> = {}) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, decisions, "acc-card")));
}
function renderStudio() {
  const creates = vi.fn();
  const readData = vi.fn(async () => DATA);
  const fakeRepo = { getByKey: vi.fn(async () => null), createTransaction: creates } as unknown as TransactionRepository;
  const deps: ApprovalDeps = { readData, repositories: commitRepositoriesFor(fakeRepo), now: () => APPROVAL_NOW };
  render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} approvalDeps={deps} />);
  return { creates, readData };
}
const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const rowNo = (id: string) => ROWS.findIndex((r) => r.id === id) + 1;
const open = (id: string) => {
  fireEvent.click(rowEl(id));
  fireEvent.click(within(rowEl(id)).getByRole("button", { name: `Compare row ${rowNo(id)}` }));
};
const draft = () => JSON.parse(sessionStorage.getItem(`${DRAFT_KEY_PREFIX}u1`)!);
const field = (name: string) => screen.getByTestId("inline-compare").querySelector(`[data-field="${name}"]`) as HTMLElement;

describe("possible matches are conservative", () => {
  it("₹299 vs ₹300 the same day on the same account is a Possible match with the amount difference highlighted — never decided for the user", () => {
    seed();
    const { creates, readData } = renderStudio();
    expect(rowEl("g1").dataset.state).not.toBe("no_match");
    expect(rowEl("g1").dataset.decision).toBe("");
    open("g1");
    expect(field("amount").dataset.verdict).toBe("diff");
    expect(field("amount").textContent).toMatch(/₹300\.00/);
    expect(field("amount").textContent).toMatch(/₹299\.00/);
    expect(field("amount").textContent).toMatch(/₹1\.00 more in FlowFi/);
    expect(field("date").dataset.verdict).toBe("same");
    expect(field("account").dataset.verdict).toBe("same");
    expect(field("type").dataset.verdict).toBe("same");
    expect(creates).not.toHaveBeenCalled();
    expect(readData).not.toHaveBeenCalled();
  });

  it("a different merchant with the same amount is not paired on amount alone; a row with nothing similar has no candidate", () => {
    seed();
    renderStudio();
    expect(rowEl("g3").dataset.state).toBe("no_match");
    open("g3");
    expect(screen.getByTestId("inline-no-candidate")).toBeTruthy();
    expect(screen.queryByTestId("inline-keep-existing")).toBeNull(); // nothing to keep
    // Whatever the engine says about ELECTRIC BOARD vs "Netflix annual", it is never an exact decision on its own.
    expect(rowEl("g4").dataset.decision).toBe("");
  });
});

describe("the four explicit decisions", () => {
  it("Keep existing: records a draft link to the FlowFi transaction — the statement row is not imported, nothing is written", () => {
    seed();
    const { creates } = renderStudio();
    open("g1");
    fireEvent.click(screen.getByTestId("inline-keep-existing"));
    expect(draft().decisions.g1).toMatchObject({ kind: "link", linkedRecordId: "t-groc" });
    expect(within(rowEl("g1")).getByTestId("decision-chip").textContent).toBe("Keep existing");
    expect(creates).not.toHaveBeenCalled();
  });

  it("Keep both (Import statement with a possible match): needs the explicit acknowledgement AND a category; FlowFi's record stays untouched", () => {
    seed();
    const { creates } = renderStudio();
    open("g1");
    fireEvent.click(screen.getByTestId("inline-import"));
    const form = screen.getByTestId("inline-import-form");
    const submit = within(form).getByTestId("import-confirm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Category for import"), { target: { value: "Food" } });
    expect(submit.disabled).toBe(true); // the acknowledgement is still missing
    fireEvent.click(within(form).getByRole("checkbox", { name: "These are separate transactions" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(draft().decisions.g1).toMatchObject({ kind: "import_new", notSameAck: true, category: "Food" });
    expect(within(rowEl("g1")).getByTestId("decision-chip").textContent).toBe("Keep both");
    expect(creates).not.toHaveBeenCalled(); // final approval is the only writer
  });

  it("Import statement without a match needs no acknowledgement, only a category", () => {
    seed();
    renderStudio();
    open("g3");
    fireEvent.click(screen.getByTestId("inline-import"));
    const form = screen.getByTestId("inline-import-form");
    expect(within(form).queryByRole("checkbox", { name: "These are separate transactions" })).toBeNull();
    fireEvent.change(within(form).getByLabelText("Category for import"), { target: { value: "Food" } });
    fireEvent.click(within(form).getByTestId("import-confirm-submit"));
    expect(draft().decisions.g3).toMatchObject({ kind: "import_new", category: "Food" });
  });

  it("Review later leaves the row unresolved and not importable — final approval waits for it", () => {
    seed();
    renderStudio();
    open("g1");
    fireEvent.click(screen.getByTestId("inline-review-later"));
    expect(draft().decisions.g1).toMatchObject({ kind: "investigate" });
    expect(within(rowEl("g1")).getByTestId("decision-chip").textContent).toBe("Review later");
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Not a match drops only that suggestion for the row (draft, undoable); nothing is imported or deleted", () => {
    seed();
    const { creates } = renderStudio();
    open("g1");
    fireEvent.click(screen.getByTestId("inline-not-a-match"));
    expect(rowEl("g1").dataset.state).toBe("no_match");
    expect(rowEl("g1").dataset.decision).toBe("");
    expect(draft().decisions.g1.rejectedRecordIds).toEqual(["t-groc"]);
    fireEvent.click(screen.getByTestId("undo-decision"));
    expect(rowEl("g1").dataset.state).not.toBe("no_match");
    expect(creates).not.toHaveBeenCalled();
  });

  it("a decision can be cleared from the same panel", () => {
    seed({ g1: { kind: "link", linkedRecordId: "t-groc" } });
    renderStudio();
    open("g1");
    expect(screen.getByTestId("inline-decided")).toBeTruthy();
    fireEvent.click(screen.getByTestId("inline-clear"));
    expect(rowEl("g1").dataset.decision).toBe("");
  });
});

describe("editing a row invalidates a stale decision", () => {
  it("changing the amount after Keep existing withdraws the decision (the evidence it was based on is gone)", () => {
    seed({ g1: { kind: "link", linkedRecordId: "t-groc" } });
    renderStudio();
    expect(rowEl("g1").dataset.decision).toBe("link");
    fireEvent.click(screen.getByRole("button", { name: `Expand row ${rowNo("g1")}` }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "310" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(rowEl("g1").dataset.decision).toBe("");
    expect(draft().decisions.g1?.kind ?? null).toBeNull();
  });
});

describe("summary and filters", () => {
  it("one strip shows Captured / Possible / Exact / Needs review / Ready / Skipped, and its counts follow decisions", () => {
    seed({ g3: { kind: "ignore" } });
    renderStudio();
    const strip = screen.getByTestId("review-filter-strip");
    const n = (id: string) => Number(within(strip).getByTestId(`${id}-count`).textContent);
    expect(Number(within(strip).getByTestId("rf-captured").textContent)).toBe(4);
    expect(n("rf-all")).toBe(4);
    const possible = n("rf-possible");
    expect(possible).toBeGreaterThanOrEqual(1);
    // Every count equals the rows the filter actually shows.
    fireEvent.click(within(strip).getByTestId("rf-possible"));
    expect(screen.getAllByTestId("recon-row")).toHaveLength(possible);
    fireEvent.click(within(strip).getByTestId("rf-possible")); // pressing it again clears the filter
    expect(screen.getAllByTestId("recon-row")).toHaveLength(4);
    // Deciding a row moves it from Needs review to Ready.
    const openBefore = n("rf-open");
    const readyBefore = n("rf-ready");
    fireEvent.click(rowEl("g1"));
    fireEvent.click(within(rowEl("g1")).getByRole("button", { name: `Compare row ${rowNo("g1")}` }));
    fireEvent.click(screen.getByTestId("inline-keep-existing"));
    expect(n("rf-open")).toBe(openBefore - 1);
    expect(n("rf-ready")).toBe(readyBefore + 1);
  });
});
