// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import type { ReconciliationData } from "../lib/analyze";
import { buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { EMPTY_DECISION } from "../lib/decisions";
import { APPROVAL_NOW, reconData, reconRow, txn } from "../lib/test-fixtures";
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

class FakeTransactions {
  store = new Map<string, Transaction>();
  creates = 0;
  failFor = new Set<string>();
  async getByKey(id: string) {
    return this.store.get(id) ?? null;
  }
  async createTransaction(p: { description: string; idempotencyKey?: string; type: "income" | "expense"; amount: number; dateTime: Date; accountId: string }) {
    this.creates++;
    if (this.failFor.has(p.description)) throw new Error("network interrupted");
    const id = `txn_${p.idempotencyKey}`;
    const prior = this.store.get(id);
    if (prior) return prior;
    const t = txn({ id, type: p.type, amount: p.amount, dateTime: p.dateTime, accountId: p.accountId, description: p.description, source: null });
    this.store.set(id, t);
    return t;
  }
  balanceEffect() {
    return [...this.store.values()].reduce((s, t) => s + balanceEffect(t), 0);
  }
}

const OCT_24: [number, number, number] = [2026, 10, 24];
const ROWS: ReconRow[] = [
  reconRow({ id: "e1", day: OCT_24, description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "e2", day: OCT_24, description: "BOOKSTORE", amount: 250 }),
  reconRow({ id: "rf", day: OCT_24, description: "REFUND AMAZON", direction: "credit", amount: 300, kind: "refund" }),
  reconRow({ id: "lk", day: OCT_24, description: "SWIGGY", amount: 452 }),
  reconRow({ id: "ig", day: OCT_24, description: "NOISE", amount: 3 }),
];
const DECISIONS: Record<string, Partial<RowDecision>> = {
  e1: { kind: "import_new", category: "Food" },
  e2: { kind: "import_new", category: "Food" },
  rf: { kind: "import_new", category: "Salary", creditAs: "refund" },
  lk: { kind: "link", linkedRecordId: "t-sw" },
  ig: { kind: "ignore" },
};
const baseData = (): ReconciliationData => reconData({ transactions: [txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: new Date(2026, 9, 24, 13) })] });

function seed(decisions = DECISIONS, rows = ROWS) {
  const full = Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, { ...EMPTY_DECISION, ...d }]));
  saveReconciliationDraft(buildReconciliationDraft("u1", { fingerprint: "fp:ui", source: "text", accountId: "acc-card", priorSessionIds: {}, rows, decisions: full, createdAt: Date.now() }));
}

function mount(data = baseData()) {
  const fake = new FakeTransactions();
  const live = (): ReconciliationData => ({ ...data, transactions: [...data.transactions, ...fake.store.values()] });
  const deps: ApprovalDeps = { readData: async () => live(), repositories: commitRepositoriesFor(fake as unknown as TransactionRepository), now: () => APPROVAL_NOW };
  const view = render(<ReconciliationWorkspace uid="u1" data={data} approvalDeps={deps} />);
  return { fake, deps, data, view, rerender: () => view.rerender(<ReconciliationWorkspace uid="u1" data={live()} approvalDeps={deps} />) };
}

// "Import N transactions" is the one confirmation: there is no summary screen or tick-box in between (2026-11-24). Since
// 2026-11-25 it imports the rows that are Ready — the rest stay in the review — and a finished import shows Imported on
// its rows (plus a one-line summary) instead of a result dialog.
const importNow = () => fireEvent.click(screen.getByTestId("open-approval"));
const dialog = () => screen.getByTestId("approval-dialog");
const rowEl = (rowId: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === rowId)!;
const statusOf = (rowId: string) => rowEl(rowId)?.dataset.status;

/** An imported row reads Imported — or, once EVERY row is handled, the finished review has been cleared. */
async function importedOrCleared(rowId: string) {
  await waitFor(() => expect(screen.queryAllByTestId("recon-row").length === 0 || statusOf(rowId) === "imported").toBe(true));
}

describe("Import — one click, nothing written before it", () => {
  it("opening Reconciliation writes nothing; Import covers the Ready rows only, and the rest stay for later", async () => {
    seed({ e1: { kind: "import_new", category: "Food" } });
    const { fake } = mount();
    const button = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(fake.creates).toBe(0);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Import 1 transaction"); // e1 only — the others are not Ready
    importNow();
    await importedOrCleared("e1");
    expect(fake.creates).toBe(1);
    expect([...fake.store.values()].map((t) => t.description)).toEqual(["CAFE ONE"]);
    expect(statusOf("rf")).toBe("fix"); // the credit still needs its type — untouched
    expect(screen.queryByTestId("approval-dialog")).toBeNull();
  });

  it("the button names the count; clicking it imports directly (no summary screen, no confirmation tick); rows read Imported", async () => {
    seed();
    const { fake } = mount();
    const button = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Import 3 transactions");
    expect(fake.creates).toBe(0);
    importNow();
    await importedOrCleared("e1");
    expect(screen.queryByTestId("approval-confirm")).toBeNull(); // no confirmation step existed
    expect(screen.queryByTestId("approval-dialog")).toBeNull();
    expect(fake.creates).toBe(3);
    expect(fake.balanceEffect()).toBe(-90 - 250 + 300);
    // Every row is imported or skipped, so the finished review is cleared (a clean Smart Capture follows).
    expect(screen.queryAllByTestId("recon-row")).toHaveLength(0);
  });

  it("a row's own Import imports exactly that row", async () => {
    seed();
    const { fake } = mount();
    fireEvent.click(within(rowEl("e2")).getByTestId("row-import"));
    await importedOrCleared("e2");
    expect(fake.creates).toBe(1);
    expect([...fake.store.values()].map((t) => t.description)).toEqual(["BOOKSTORE"]);
    expect(statusOf("e1")).toBe("ready");
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).textContent).toBe("Import 2 transactions");
  });

  it("a failed row is never shown as success: precise outcome, retry imports only the failed row", async () => {
    seed();
    const { fake, rerender } = mount();
    fake.failFor.add("BOOKSTORE");
    importNow();
    await waitFor(() => expect(screen.getByTestId("approval-result").dataset.status).toBe("partial"));
    expect(screen.getByTestId("approval-result").textContent).toMatch(/2 of 3 rows done — 1 needs a retry/);
    const kinds = Object.fromEntries(screen.getAllByTestId("approval-outcome").map((o) => [o.dataset.rowId, o.dataset.outcome]));
    expect(kinds).toEqual({ e1: "imported", e2: "failed", rf: "imported" }); // only the rows this import covered
    expect(screen.queryByTestId("approval-clear")).toBeNull(); // "Clear this review" only appears after a complete run
    expect(fake.store.size).toBe(2);

    fake.failFor.clear();
    rerender(); // the live data catches up: the two imported rows are now seen as already imported
    fireEvent.click(screen.getByTestId("approval-retry"));
    await importedOrCleared("e2");
    expect(fake.store.size).toBe(3);
    expect(fake.creates).toBe(4); // 3 first run (one failed) + exactly one retry
  });

  it("an out-of-date review stops with an explanation and writes nothing", async () => {
    seed();
    const { fake, data } = mount();
    // Between the review and the click, a look-alike of row 1 appears in FlowFi (the server read sees it first).
    data.transactions.push(txn({ id: "t-late", amount: 90, description: "Cafe One", dateTime: new Date(2026, 9, 24, 13), source: "sms" }));
    importNow();
    await waitFor(() => expect(dialog().dataset.stage).toBe("stale"));
    expect(screen.getByTestId("approval-stale-note").textContent).toMatch(/Nothing was imported/);
    expect(screen.getByTestId("approval-stale").textContent).toMatch(/Row 1/);
    expect(fake.creates).toBe(0);
  });

  it("a server read that fails stops with 'nothing was imported' and offers Try again", async () => {
    seed();
    const { fake, deps } = mount();
    deps.readData = async () => Promise.reject(new Error("offline"));
    importNow();
    await waitFor(() => expect(dialog().dataset.stage).toBe("unavailable"));
    expect(screen.getByTestId("approval-unavailable").textContent).toMatch(/Nothing was imported/);
    expect(fake.creates).toBe(0);
  });

  it("a double click on Import runs one import", async () => {
    seed();
    const { fake } = mount();
    const button = screen.getByTestId("open-approval");
    fireEvent.click(button);
    fireEvent.click(button);
    await importedOrCleared("e1");
    expect(fake.creates).toBe(3);
  });

  it("a double click on a row's Import imports it once", async () => {
    seed();
    const { fake } = mount();
    const button = within(rowEl("e1")).getByTestId("row-import");
    fireEvent.click(button);
    fireEvent.click(button);
    await importedOrCleared("e1");
    expect(fake.creates).toBe(1);
  });

  it("identical rows in one import still need the user's own 'these are separate purchases' before anything is written", async () => {
    const rows = [reconRow({ id: "a1", day: OCT_24, description: "TEA STALL", amount: 20 }), reconRow({ id: "a2", day: OCT_24, description: "TEA STALL", amount: 20 })];
    seed({ a1: { kind: "import_new", category: "Food" }, a2: { kind: "import_new", category: "Food" } }, rows);
    const { fake } = mount();
    importNow();
    await waitFor(() => expect(dialog().dataset.stage).toBe("review"));
    expect(fake.creates).toBe(0);
    const submit = within(dialog()).getByTestId("approval-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(within(dialog()).getByTestId("approval-repeats")).getByRole("checkbox"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await importedOrCleared("a2");
    expect(fake.creates).toBe(2);
  });

  it("two same-day, same-amount UPI credits with DIFFERENT references import one by one, without a repeat question, each exactly once", async () => {
    const rows = [
      reconRow({ id: "m1", day: OCT_24, description: "UPI/627481159639/CR/MOHAN/BKID/mohankoda/UPI", amount: 2000, direction: "credit", referenceNumber: "627481159639" }),
      reconRow({ id: "m2", day: OCT_24, description: "UPI/664081439342/CR/MOHAN/BKID/mohankoda/UPI", amount: 2000, direction: "credit", referenceNumber: "664081439342" }),
    ];
    const credit = { kind: "import_new" as const, category: "Salary", creditAs: "income" as const, notOwnTransferAck: true };
    seed({ m1: credit, m2: credit }, rows);
    const { fake, rerender } = mount();
    expect(statusOf("m1")).toBe("ready");
    expect(statusOf("m2")).toBe("ready");
    fireEvent.click(within(rowEl("m1")).getByTestId("row-import"));
    await importedOrCleared("m1");
    rerender(); // row 1 is now a live FlowFi transaction — it must not hold row 2 back
    fireEvent.click(within(rowEl("m2")).getByTestId("row-import"));
    await importedOrCleared("m2");
    expect(screen.queryByTestId("approval-dialog")).toBeNull();
    expect(fake.creates).toBe(2);
    const saved = [...fake.store.values()];
    expect(saved.map((t) => t.description)).toEqual(["Received from Mohan · UPI", "Received from Mohan · UPI"]);
    expect(fake.balanceEffect()).toBe(4000);
  });

  it("a review with nothing to import has no Import to press — FlowFi stays exactly as it is", async () => {
    seed({ lk: { kind: "link", linkedRecordId: "t-sw" }, ig: { kind: "ignore" } }, [ROWS[3]!, ROWS[4]!]);
    const { fake } = mount();
    const button = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(button.textContent).toBe("Import 0 transactions");
    expect(button.disabled).toBe(true);
    expect(screen.queryByTestId("approval-dialog")).toBeNull();
    expect(fake.creates).toBe(0);
  });
});
