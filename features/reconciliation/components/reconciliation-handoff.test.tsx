// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import { confirmField, toReviewRows, type ReviewRow } from "@/features/smart-capture/lib/capture-review";
import { annotateOcrRows } from "@/features/smart-capture/lib/ocr-review";
import { ocrLine, ocrText } from "@/features/smart-capture/lib/ocr-test-helpers";
import { parsePastedStatement } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import { _resetHandoffForTests, getHandoffState, handOffCapture } from "../lib/capture-handoff";
import { ReconciliationWorkspace, type ReconciliationData } from "./reconciliation-workspace";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
let urlSeq = 0;
beforeEach(() => {
  sessionStorage.clear();
  urlSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:handoff-${++urlSeq}`);
  URL.revokeObjectURL = vi.fn();
  // Wide desktop: the comparison is docked beside the grid.
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? 1600 >= Number(min[1]) : false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  _resetHandoffForTests();
});

const ACCOUNTS = [{ id: "acc-card", name: "QA Card", type: "card", deletedAt: null, accountNumberLast4: "4242" } as unknown as Account];

function txn(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    type: "expense", amount: 452, dateTime: new Date(2026, 8, 5, 13), accountId: "acc-card", categoryId: "c1", description: "Swiggy", notes: "", receiptPurpose: null, transferId: null,
    excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false, createdAt: new Date(2026, 8, 5, 13), transferMatchedAt: null, status: "posted",
    isBusiness: false, source: "sms", loanId: null, emiId: null, installmentId: null, installmentPaymentId: null, paymentAllocationType: null, isPersonLedgerMovement: false,
    deletedAt: null, lastEditedAt: null, editHistory: [], ...over,
  };
}

const DATA: ReconciliationData = {
  accounts: ACCOUNTS,
  creditCards: [],
  statements: [],
  categories: [],
  // An SMS-imported Swiggy ₹452 on the same card and day — the existing record a statement row may match.
  transactions: [txn({ id: "txn_sms_abc12345" })],
  trashedTransactions: [],
  smsCandidates: [],
  expenses: [],
};
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function capture(lines = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"]), ocrLine(80, ["07/09/2026", "UBER", "250.00 Dr"])]) {
  const text = ocrText(lines);
  const parse = parsePastedStatement(text);
  const rows: ReviewRow[] = toReviewRows(annotateOcrRows(parse.rows, lines), "ocr").map((r) => (r.description === "UBER" ? { ...r, include: false } : confirmField({ ...r, confirmed: true }, "amount")));
  const ocr: OcrCapture = { text, lines, imageUrl: "blob:smart-capture-own", natural: { width: 1200, height: 600 }, area: { x: 0, y: 0, width: 1200, height: 600 }, prepared: { width: 2400, height: 1200 }, crop: null, confidence: 90, durationMs: 800, warnings: [] };
  return { text, parse, rows, ocr };
}

function handOff(cap = capture()) {
  const result = handOffCapture({ sourceText: cap.text, parse: cap.parse, rows: cap.rows, ocr: cap.ocr, image: { file: new Blob(["png"]), name: "s.png" }, crop: null, mode: "image", accountId: "acc-card", accounts: ACCOUNTS });
  expect(result.ok).toBe(true);
  return cap;
}

/** A handoff never picks the statement account — the user does, explicitly. */
function pickAccount(name = "QA Card") {
  const picker = screen.queryByRole("button", { name: "Choose statement account" });
  if (!picker) return;
  fireEvent.click(picker);
  fireEvent.click(screen.getAllByTestId("account-option").find((o) => o.textContent?.includes(name))!);
}

const rowEl = (id: string) => screen.getAllByTestId("recon-row").find((r) => r.dataset.rowId === id)!;
const states = () => Object.fromEntries(screen.getAllByTestId("recon-row").map((r) => [r.dataset.rowId, r.dataset.state]));

/** Desktop: the full comparison (with the screenshot strip) opens from the dock's "Full details". */
const openDetails = () => fireEvent.click(screen.getByTestId("dock-details"));

describe("Smart Capture → Reconciliation handoff", () => {
  it("takes the rows with their own ids, keeps the excluded row excluded (re-includable here), and shows the existing SMS transaction as a candidate", () => {
    const cap = handOff();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    expect(getHandoffState().pending).toBeNull(); // consumed
    expect(screen.getByTestId("handoff-notice").textContent).toMatch(/2 rows arrived from Smart Capture/);
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(cap.rows.map((r) => r.id));
    const uber = cap.rows.find((r) => r.description === "UBER")!.id;
    const swiggy = cap.rows.find((r) => r.description === "SWIGGY")!.id;
    expect(states()[uber]).toBe("excluded");
    expect(states()[swiggy]).toBe("exact_candidate");
    // Rows verified in Smart Capture are not re-flagged here (confirmed issues are resolved, as there).
    expect(screen.queryAllByTestId("row-check-label")).toEqual([]);
    openDetails();
    const panel = screen.getByTestId("match-panel");
    expect(within(panel).getByTestId("match-candidate").textContent).toMatch(/From SMS/);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // Arrives excluded, but OCR checks now live here, so it can be included here (two-step flow).
    fireEvent.click(screen.getByRole("button", { name: "Expand row 3" }));
    expect(screen.queryByTestId("capture-excluded")).toBeNull();
    expect(screen.getByRole("switch", { name: "Include this row" })).toBeTruthy();
  });

  it("shows the row's strip of the handed-over screenshot, from the handoff's own URL", () => {
    handOff();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    openDetails();
    const zoom = within(screen.getByTestId("row-screenshot")).getByTestId("row-zoom");
    expect(zoom.querySelector("img")!.getAttribute("src")).toBe("blob:handoff-1");
  });

  it("after a refresh the review comes back from the draft — and says the screenshot isn't available", () => {
    const cap = handOff();
    const first = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    first.unmount();
    _resetHandoffForTests(); // a refresh wipes in-memory state
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    expect(screen.getByText(/Restored your review/)).toBeTruthy();
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(cap.rows.map((r) => r.id));
    openDetails();
    expect(screen.getByTestId("screenshot-unavailable")).toBeTruthy();
  });

  it("Back to Smart Capture is always offered", () => {
    handOff();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    expect(screen.getByTestId("back-to-capture").getAttribute("href")).toBe("/smart-capture");
  });
});

describe("live matching states", () => {
  it("while records load: no match states, no 'No match' — then results appear once loaded", () => {
    handOff();
    const view = render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={{ loading: ["transactions"], failed: [], retry: vi.fn() }} />);
    pickAccount();
    expect(screen.getByTestId("records-loading").textContent).toMatch(/Loading your FlowFi transactions/);
    expect(Object.values(states()).every((s) => s === "pending")).toBe(true);
    expect(screen.getAllByTestId("match-pending")[0]!.textContent).toBe("Loading FlowFi records…");
    expect(document.body.textContent).not.toMatch(/No match/);
    // The snapshot arrives: the existing SMS transaction is found — it was never "no match".
    view.rerender(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    expect(screen.queryByTestId("records-loading")).toBeNull();
    expect(Object.values(states())).toContain("exact_candidate");
  });

  it("a failed required query is an error with Retry — never 'No match'", () => {
    handOff();
    const retry = vi.fn();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={{ loading: [], failed: ["transactions"], retry }} />);
    pickAccount();
    const alert = screen.getByTestId("records-error");
    expect(alert.textContent).toMatch(/Couldn't load your FlowFi transactions/);
    expect(Object.values(states()).every((s) => s === "pending")).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
  });

  it("'No match' only after a successful load with nothing similar", () => {
    handOff();
    render(<ReconciliationWorkspace uid="u1" data={{ ...DATA, transactions: [] }} sync={LOADED} />);
    pickAccount();
    expect(Object.values(states()).filter((s) => s === "no_match")).toHaveLength(2);
  });
});

describe("never silently replacing a review", () => {
  it("a different capture waits for an explicit keep/replace", () => {
    const original = handOff();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    const originalIds = original.rows.map((r) => r.id);

    act(() => void handOff(capture([ocrLine(0, ["08/09/2026", "NETFLIX", "649.00 Dr"])])));
    expect(screen.getByTestId("handoff-conflict")).toBeTruthy();
    expect(screen.getAllByTestId("recon-row").map((r) => r.dataset.rowId)).toEqual(originalIds); // untouched

    fireEvent.click(screen.getByRole("button", { name: "Keep my current review" }));
    expect(screen.queryByTestId("handoff-conflict")).toBeNull();
    expect(getHandoffState().pending).toBeNull();
    expect(screen.getAllByTestId("recon-row")).toHaveLength(3);

    act(() => void handOff(capture([ocrLine(0, ["08/09/2026", "NETFLIX", "649.00 Dr"])])));
    fireEvent.click(screen.getByRole("button", { name: "Review the new capture instead" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace review" }));
    expect(screen.getAllByTestId("recon-row")).toHaveLength(1);
    expect(rowEl("r1").textContent).toMatch(/NETFLIX/);
  });

  it("the same capture again merges and says what changed", () => {
    handOff();
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    pickAccount();
    act(() => void handOff());
    expect(screen.getByTestId("handoff-notice").textContent).toMatch(/nothing changed, your decisions are kept/);
  });
});

describe("statement account is always an explicit choice", () => {
  it("a handoff that carries an account never pre-selects it — nothing is compared until the user chooses", () => {
    handOff(); // passes accountId "acc-card"
    render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
    const bar = screen.getByTestId("account-bar");
    expect(bar.dataset.selected).toBe("false");
    expect(within(bar).getByTestId("choose-account").textContent).toMatch(/No account selected/);
    expect(Object.values(states()).every((s) => s === "pending")).toBe(true);
    expect(screen.queryByTestId("match-candidate")).toBeNull();
    expect(screen.queryByTestId("open-approval")).toBeNull();

    pickAccount();
    expect(screen.getByTestId("account-bar").dataset.selected).toBe("true");
    expect(screen.getByTestId("selected-account").textContent).toMatch(/QA Card.*Credit card.*•••• 4242/);
    expect(Object.values(states())).toContain("exact_candidate");
  });
});
