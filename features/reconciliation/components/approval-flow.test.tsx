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

const openApproval = () => fireEvent.click(screen.getByTestId("open-approval"));
const dialog = () => screen.getByTestId("approval-dialog");

describe("Final approval — nothing happens until the user confirms", () => {
  it("opening Reconciliation (and opening the approval) writes nothing; the button is disabled until every row has a decision", async () => {
    seed({ e1: { kind: "import_new", category: "Food" } });
    const { fake } = mount();
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
    expect(fake.creates).toBe(0);
  });

  it("shows the whole summary: totals, exact receiving account, charges/credits, effects — and needs the explicit confirmation", async () => {
    seed();
    const { fake } = mount();
    const open = screen.getByTestId("open-approval") as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    openApproval();
    const d = within(dialog());
    expect(d.getByTestId("count-captured").textContent).toMatch(/^5/);
    expect(d.getByTestId("count-new").textContent).toMatch(/^3/);
    expect(d.getByTestId("count-linked").textContent).toMatch(/^1/);
    expect(d.getByTestId("count-ignored").textContent).toMatch(/^1/);
    expect(d.getByTestId("count-inbox").textContent).toMatch(/^0/);
    expect(d.getByTestId("count-unresolved").textContent).toMatch(/^0/);
    expect(d.getByTestId("approval-account").textContent).toMatch(/HDFC Millennia •••• 4821/);
    expect(d.getByTestId("approval-account").textContent).toMatch(/credit card/);
    expect(d.getByTestId("approval-charges").textContent).toMatch(/340\.00/);
    expect(d.getByTestId("approval-credits").textContent).toMatch(/300\.00/);
    expect(d.getByTestId("approval-effect-text").textContent).toMatch(/owed on this card rises by ₹40\.00/);
    expect(d.getAllByTestId("approval-import-row")).toHaveLength(3);
    const submit = d.getByTestId("approval-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // not until the confirmation is ticked
    expect(fake.creates).toBe(0);
    fireEvent.click(d.getByTestId("approval-confirm"));
    await waitFor(() => expect((d.getByTestId("approval-submit") as HTMLButtonElement).disabled).toBe(false));
    expect(fake.creates).toBe(0); // still nothing written
  });

  it("confirming imports the three rows once and lists every row's outcome; full success only when nothing failed", async () => {
    seed();
    const { fake } = mount();
    openApproval();
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    fireEvent.click(within(dialog()).getByTestId("approval-submit"));
    await waitFor(() => expect(screen.getByTestId("approval-result").dataset.status).toBe("complete"));
    expect(fake.creates).toBe(3);
    expect(fake.balanceEffect()).toBe(-90 - 250 + 300);
    const outcomes = screen.getAllByTestId("approval-outcome").map((o) => [o.dataset.rowId, o.dataset.outcome]);
    expect(outcomes).toEqual([["e1", "imported"], ["e2", "imported"], ["rf", "imported"], ["lk", "linked"], ["ig", "ignored"]]);
    expect(screen.getByTestId("approval-result").textContent).toMatch(/All 5 rows are resolved/);
  });

  it("a failed row is never shown as success: precise outcome, 'retry the failed' offered, only the failed row is retried", async () => {
    seed();
    const { fake, rerender } = mount();
    fake.failFor.add("BOOKSTORE");
    openApproval();
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    fireEvent.click(within(dialog()).getByTestId("approval-submit"));
    await waitFor(() => expect(screen.getByTestId("approval-result").dataset.status).toBe("partial"));
    expect(screen.getByTestId("approval-result").textContent).toMatch(/4 of 5 rows done — 1 needs a retry/);
    expect(screen.getByTestId("approval-result").textContent).not.toMatch(/All 5 rows/);
    const kinds = Object.fromEntries(screen.getAllByTestId("approval-outcome").map((o) => [o.dataset.rowId, o.dataset.outcome]));
    expect(kinds).toMatchObject({ e1: "imported", e2: "failed", rf: "imported", lk: "linked", ig: "ignored" });
    expect(screen.queryByTestId("approval-clear")).toBeNull(); // "Clear this review" only appears after a complete run
    expect(fake.store.size).toBe(2);

    fake.failFor.clear();
    rerender(); // the live data catches up: the two imported rows are now seen as already imported
    fireEvent.click(screen.getByTestId("approval-retry"));
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    expect(within(dialog()).getByTestId("count-new").textContent).toMatch(/^1/);
    fireEvent.click(within(dialog()).getByTestId("approval-submit"));
    await waitFor(() => expect(screen.getByTestId("approval-result").dataset.status).toBe("complete"));
    expect(fake.store.size).toBe(3);
    expect(fake.creates).toBe(4); // 3 first run (one failed) + exactly one retry
  });

  it("an out-of-date review stops with an explanation and writes nothing", async () => {
    seed();
    const { fake, data } = mount();
    openApproval();
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    // Between the review and the click, a look-alike of row 1 appears in FlowFi (the server read sees it first).
    data.transactions.push(txn({ id: "t-late", amount: 90, description: "Cafe One", dateTime: new Date(2026, 9, 24, 13), source: "sms" }));
    fireEvent.click(within(dialog()).getByTestId("approval-submit"));
    await waitFor(() => expect(dialog().dataset.stage).toBe("stale"));
    expect(screen.getByTestId("approval-stale-note").textContent).toMatch(/Nothing was imported/);
    expect(screen.getByTestId("approval-stale").textContent).toMatch(/Row 1/);
    expect(fake.creates).toBe(0);
  });

  it("a server read that fails stops with 'nothing was imported' and offers Try again", async () => {
    seed();
    const { fake, deps } = mount();
    deps.readData = async () => Promise.reject(new Error("offline"));
    openApproval();
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    fireEvent.click(within(dialog()).getByTestId("approval-submit"));
    await waitFor(() => expect(dialog().dataset.stage).toBe("unavailable"));
    expect(screen.getByTestId("approval-unavailable").textContent).toMatch(/Nothing was imported/);
    expect(fake.creates).toBe(0);
  });

  it("a double click on Approve runs one approval", async () => {
    seed();
    const { fake } = mount();
    openApproval();
    fireEvent.click(within(dialog()).getByTestId("approval-confirm"));
    const submit = within(dialog()).getByTestId("approval-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId("approval-result").dataset.status).toBe("complete"));
    expect(fake.creates).toBe(3);
  });

  it("a review with no Import has nothing to approve: the dialog says FlowFi stays exactly as it is", async () => {
    seed({ lk: { kind: "link", linkedRecordId: "t-sw" }, ig: { kind: "ignore" } }, [ROWS[3]!, ROWS[4]!]);
    const { fake } = mount();
    openApproval();
    expect(screen.getByTestId("approval-nothing").textContent).toMatch(/Nothing will be imported/);
    expect(screen.queryByTestId("approval-submit")).toBeNull();
    expect(fake.creates).toBe(0);
  });
});
