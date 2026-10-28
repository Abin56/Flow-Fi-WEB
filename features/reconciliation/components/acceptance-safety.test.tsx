// @vitest-environment jsdom
/**
 * Acceptance: decisions made in the dual-sheet studio can never get past Phase 4's final checks. Every scenario decides
 * through the dock, then FlowFi changes between review and approval (a second tab, an SMS sync, an edit) and the
 * approval's fresh SERVER read must stop it with nothing written. A harmless change is the control: it still imports,
 * so the checks react to evidence, not to "anything changed". Synthetic data and fake repositories only.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { ReconciliationData } from "../lib/analyze";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import { buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
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
  reconRow({ id: "r1", day: [2026, 10, 24], description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r2", day: [2026, 10, 24], description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "r3", day: [2026, 10, 24], description: "CAFE ONE", amount: 90 }),
  reconRow({ id: "r4", day: [2026, 10, 24], description: "BOOKSTORE", amount: 250 }),
];
const SWIGGY = txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: at(24) });
const CAFE = txn({ id: "t-cafe", amount: 90, description: "Cafe One", dateTime: at(24) });
const BANK = txn({ id: "t-bank", amount: 250, description: "Bookstore", accountId: "acc-bank", dateTime: at(24) });
const DATA: ReconciliationData = reconData({ transactions: [SWIGGY, CAFE, BANK] });

function fakeRepository() {
  const store = new Map<string, ReturnType<typeof txn>>();
  const repo = {
    getByKey: vi.fn(async (id: string) => store.get(id) ?? null),
    createTransaction: vi.fn(async (p: { idempotencyKey?: string; type: "income" | "expense"; amount: number; dateTime: Date; accountId: string; description: string }) => {
      const t = txn({ id: `txn_${p.idempotencyKey}`, type: p.type, amount: p.amount, dateTime: p.dateTime, accountId: p.accountId, description: p.description });
      store.set(t.id, t);
      return t;
    }),
  };
  return { repo, store };
}

/** Decides every row through the dock: keep, keep, keep both (acknowledged), import new. */
function decideThroughDock() {
  const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
  fireEvent.click(rowEl("r1"));
  fireEvent.click(screen.getByTestId("resolve-keep_existing"));
  fireEvent.click(rowEl("r2"));
  fireEvent.click(screen.getByTestId("resolve-keep_existing"));
  fireEvent.click(rowEl("r3"));
  fireEvent.click(screen.getByTestId("resolve-keep_both"));
  fireEvent.click(screen.getByRole("checkbox", { name: "These are separate transactions" }));
  fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: "Food" } });
  fireEvent.click(screen.getByTestId("import-confirm-submit"));
  fireEvent.click(rowEl("r4"));
  fireEvent.click(screen.getByTestId("resolve-import_new"));
  fireEvent.change(screen.getByLabelText("Category for import"), { target: { value: "Food" } });
  fireEvent.click(screen.getByTestId("import-confirm-submit"));
}

async function approveAgainst(serverData: ReconciliationData) {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, {}, "acc-card")));
  const { repo } = fakeRepository();
  const readData = vi.fn(async () => serverData);
  const deps: ApprovalDeps = { readData, repositories: commitRepositoriesFor(repo as unknown as TransactionRepository), now: () => APPROVAL_NOW };
  render(<ReconciliationWorkspace uid="u1" data={DATA} sync={{ loading: [], failed: [], retry: vi.fn() }} approvalDeps={deps} />);
  decideThroughDock();
  fireEvent.click(screen.getByTestId("open-approval"));
  const dialog = screen.getByTestId("approval-dialog");
  fireEvent.click(within(dialog).getByTestId("approval-confirm"));
  const repeats = within(dialog).queryByTestId("approval-repeats");
  if (repeats) fireEvent.click(within(repeats).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByTestId("approval-submit"));
  await waitFor(() => expect(readData).toHaveBeenCalled());
  return { repo, readData };
}

const withTransactions = (transactions: ReconciliationData["transactions"], extra: Partial<ReconciliationData> = {}) => reconData({ transactions, ...extra });

describe("final approval rechecks fresh data for dock-made decisions", () => {
  it("control: unchanged (or unrelated) server data imports exactly the Keep both + Import new rows; Keep existing changes nothing", async () => {
    const unrelated = txn({ id: "t-other", amount: 999, description: "Rent", accountId: "acc-bank", dateTime: at(20) });
    const before = JSON.stringify([SWIGGY, CAFE]);
    const { repo } = await approveAgainst(withTransactions([SWIGGY, CAFE, BANK, unrelated]));
    const dialog = screen.getByTestId("approval-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("approval-result")).toBeTruthy());
    const outcomes = within(dialog).getAllByTestId("approval-outcome").map((e) => `${e.dataset.rowId}:${e.dataset.outcome}`);
    expect(outcomes.sort()).toEqual(["r1:linked", "r2:linked", "r3:imported", "r4:imported"]);
    expect(repo.createTransaction).toHaveBeenCalledTimes(2);
    // The kept transactions were never touched: the fake repository has no update/delete at all, and the data is unchanged.
    expect(JSON.stringify([SWIGGY, CAFE])).toBe(before);
  });

  const STALE: [string, ReconciliationData][] = [
    ["stale candidate — the kept Swiggy was deleted in another tab", withTransactions([CAFE, BANK], { trashedTransactions: [{ ...SWIGGY, deletedAt: at(25) }] })],
    ["changed amount — the kept Swiggy was edited to ₹600", withTransactions([{ ...SWIGGY, amount: 600 }, CAFE, BANK])],
    ["changed account — the kept Swiggy was moved to the bank account", withTransactions([{ ...SWIGGY, accountId: "acc-bank" }, CAFE, BANK])],
    ["concurrent transaction — a Bookstore ₹250 arrived on the card (SMS sync) after Import new was chosen", withTransactions([SWIGGY, CAFE, BANK, txn({ id: "t-new", amount: 250, description: "Bookstore", source: "sms", dateTime: at(24, 18) })])],
    ["concurrent transaction — a second Cafe One arrived, so Keep both's acknowledgement no longer covers the evidence", withTransactions([SWIGGY, CAFE, BANK, txn({ id: "t-cafe2", amount: 90, description: "Cafe One", dateTime: at(24, 19) })])],
  ];
  for (const [name, server] of STALE) {
    it(`${name}: stopped, nothing written`, async () => {
      const { repo } = await approveAgainst(server);
      const dialog = screen.getByTestId("approval-dialog");
      await waitFor(() => expect(within(dialog).getByTestId("approval-stale-note")).toBeTruthy());
      expect(within(dialog).getByTestId("approval-stale-note").textContent).toMatch(/Nothing was imported/);
      expect(repo.createTransaction).not.toHaveBeenCalled();
    });
  }
});

describe("draft tampering can't cross accounts", () => {
  it("a draft that links a row to another account's transaction is not a valid decision and blocks approval", () => {
    const tampered: Record<string, Partial<RowDecision>> = {
      r1: { kind: "link", linkedRecordId: "t-sw" },
      r2: { kind: "link", linkedRecordId: "t-cafe" },
      r3: { kind: "ignore" },
      r4: { kind: "link", linkedRecordId: "t-bank" }, // the bank's Bookstore — not this card's
    };
    saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, tampered, "acc-card")));
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={{ loading: [], failed: [], retry: vi.fn() }} />);
    expect(screen.getByTestId("progress-count").textContent).toBe("3/4");
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === "r4")!);
    expect(screen.queryAllByTestId("existing-row").map((r) => r.dataset.recordId)).not.toContain("t-bank");
    expect(screen.getByTestId("financial-effect").dataset.tone).toBe("blocked");
  });
});
