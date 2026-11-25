// @vitest-environment jsdom
/**
 * Loading is a real state, never an indefinite spinner (2026-11-24): the captured rows are on screen at once; matching
 * says what it is waiting for, says so when it is slow (with Retry), reports a failure as a dismissible error, and never
 * claims a status before matching and card bills have really loaded. Edits and decisions survive every transition.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { Category } from "@/lib/models/category";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import type { ReconciliationData } from "../lib/analyze";
import { buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow } from "../lib/types";
import { ReconciliationWorkspace } from "./reconciliation-workspace";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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

const ROWS: ReconRow[] = [
  reconRow({ id: "a", day: [2026, 10, 24], description: "SWIGGY BANGALORE", amount: 120 }), // Swiggy → the user's Food & Dining: Ready by default
  reconRow({ id: "b", day: [2026, 10, 24], description: "ZOMATO", amount: 300 }),
];
const DATA: ReconciliationData = reconData({
  categories: [{ id: "c-other", name: "Other", type: "both", isActive: true, deletedAt: null } as unknown as Category, { id: "c-food", name: "Food & Dining", type: "expense", isActive: true, deletedAt: null } as unknown as Category],
  transactions: [txn({ id: "t-z", amount: 300, description: "Zomato", dateTime: new Date(2026, 9, 24, 13) })],
});
const sync = (over: Partial<RecordsSync> = {}): RecordsSync => ({ loading: [], failed: [], retry: vi.fn(), ...over });
const seed = () => saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, {}, "acc-card")));
const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const status = (id: string) => within(rowEl(id)).getByTestId("decision-chip");

describe("progressive loading", () => {
  it("the captured rows are shown immediately; no match and no status is claimed until matching has really loaded", () => {
    seed();
    render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={sync({ loading: ["transactions"] })} />);
    expect(screen.getAllByTestId("recon-row")).toHaveLength(2); // the list is there at once
    expect(rowEl("a").dataset.state).toBe("pending");
    expect(status("a").dataset.status).toBe("checking"); // never "Ready" before matching ran
    expect(document.body.textContent).not.toMatch(/No match/);
    expect(screen.getByTestId("records-loading").dataset.phase).toBe("loading");
  });

  it("after 8 seconds the loading line says it is slow and offers Retry (which reloads the stuck sources)", () => {
    seed();
    const s = sync({ loading: ["transactions", "deleted"] });
    render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={s} />);
    expect(screen.queryByTestId("records-retry")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(8100);
    });
    const line = screen.getByTestId("records-loading");
    expect(line.dataset.phase).toBe("slow");
    expect(line.textContent).toMatch(/taking longer than usual/);
    fireEvent.click(screen.getByTestId("records-retry"));
    expect(s.retry).toHaveBeenCalled();
  });

  it("the slow state clears by itself once the records arrive", () => {
    seed();
    const view = render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={sync({ loading: ["transactions"] })} />);
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.getByTestId("records-loading").dataset.phase).toBe("slow");
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync()} />);
    expect(screen.queryByTestId("records-loading")).toBeNull();
    expect(rowEl("b").dataset.state).not.toBe("pending");
  });
});

describe("failure", () => {
  it("a failed required source is a compact error with Retry and a dismiss button — and still never 'No match'", () => {
    seed();
    const s = sync({ failed: ["transactions"] });
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={s} />);
    const alert = screen.getByTestId("records-error");
    expect(alert.textContent).toMatch(/Couldn't load your FlowFi transactions/);
    expect(rowEl("a").dataset.state).toBe("pending");
    fireEvent.click(within(alert).getByTestId("records-retry"));
    expect(s.retry).toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("records-error")).toBeNull(); // dismissed…
    expect(rowEl("a").dataset.state).toBe("pending"); // …but rows are still honest: nothing is compared
    expect(document.body.textContent).not.toMatch(/No match/);
  });
});

describe("card bills load apart from matching", () => {
  it("matches appear as soon as the matching sources load; statuses and Import wait for the card bills", () => {
    seed();
    const view = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync({ bills: "loading" })} />);
    expect(rowEl("b").dataset.state).toBe("exact_candidate"); // matching did not wait for the bills
    expect(status("a").dataset.status).toBe("checking"); // but a status (closed-bill rule) isn't guessed
    expect(screen.getByTestId("records-loading").textContent).toMatch(/Checking card bills/);
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync({ bills: "ready" })} />);
    expect(status("a").dataset.status).toBe("ready");
    expect(status("b").dataset.status).toBe("duplicate");
    expect(screen.getByTestId("open-approval").textContent).toBe("Import 1 transaction");
  });

  it("a card-bills failure pauses statuses and import with a clear, dismissible message — matches stay visible", () => {
    seed();
    const s = sync({ bills: "failed" });
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={s} />);
    expect(rowEl("b").dataset.state).toBe("exact_candidate");
    expect(screen.getByTestId("records-error").textContent).toMatch(/card bills/);
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
    expect(status("a").dataset.status).toBe("checking");
  });
});

describe("edits and decisions survive loading", () => {
  it("a value typed while records are still loading is kept when matching completes, and is matched against what it now says", () => {
    seed();
    const view = render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={sync({ loading: ["transactions"] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "300" } }); // row a becomes ₹300 — same as the Zomato in FlowFi
    fireEvent.blur(screen.getByLabelText("Amount"));
    fireEvent.click(screen.getByTestId("editor-close"));
    expect(rowEl("a").textContent).toMatch(/300\.00/);
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync()} />);
    expect(rowEl("a").textContent).toMatch(/300\.00/); // the edit was not discarded by the arrival of the records
    expect(rowEl("a").dataset.state).not.toBe("pending");
    expect(rowEl("a").dataset.state).not.toBe("no_match"); // matched against the NEW value (₹300), not the old ₹120
  });

  it("a decision made before a source reloads is kept (Skip stays Skipped)", () => {
    seed();
    const view = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync()} />);
    fireEvent.click(rowEl("b"));
    fireEvent.keyDown(screen.getByRole("grid", { name: "Statement rows" }), { key: "i" });
    expect(status("b").dataset.status).toBe("skipped");
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync({ loading: ["transactions"] })} />);
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync()} />);
    expect(status("b").dataset.status).toBe("skipped");
  });
});

describe("a bank account never waits for card bills", () => {
  it("bills stuck loading (or failed) do not hold back a BANK statement: no loading line, statuses and Import are available", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, {}, "acc-bank")));
    for (const bills of ["loading", "failed"] as const) {
      const view = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync({ bills })} />);
      expect(screen.queryByTestId("records-loading")).toBeNull();
      expect(screen.queryByTestId("records-error")).toBeNull();
      expect(status("a").dataset.status).toBe("ready");
      view.unmount();
    }
  });

  it("rows that cannot depend on card bills (already imported / skipped) show their status even while bills load on a card", () => {
    saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, { b: { kind: "ignore" } }, "acc-card")));
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={sync({ bills: "loading" })} />);
    expect(status("b").dataset.status).toBe("skipped"); // a skip is final
    expect(status("a").dataset.status).toBe("checking"); // Ready could still change with the bills
  });
});
