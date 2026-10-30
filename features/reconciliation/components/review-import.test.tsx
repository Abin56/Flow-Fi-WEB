// @vitest-environment jsdom
/**
 * Review & Import (step 2): OCR checks, possible duplicates, the money summary, the bulk "Import new rows" and the
 * final Import button — on one screen. Synthetic data only; nothing here writes (the final approval is covered by
 * approval-flow / dual-sheet tests).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import { toReviewRows } from "@/features/smart-capture/lib/capture-review";
import { annotateOcrRows } from "@/features/smart-capture/lib/ocr-review";
import { ocrLine, ocrText } from "@/features/smart-capture/lib/ocr-test-helpers";
import { parsePastedStatement } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import { _resetHandoffForTests, handOffCapture } from "../lib/capture-handoff";
import { txn } from "../lib/test-fixtures";
import { ReconciliationWorkspace, type ReconciliationData } from "./reconciliation-workspace";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  sessionStorage.clear();
  URL.createObjectURL = vi.fn(() => "blob:handoff");
  URL.revokeObjectURL = vi.fn();
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
const CATEGORIES = [{ id: "food", name: "Food", type: "expense", isActive: true, deletedAt: null } as unknown as Category, { id: "shop", name: "Shopping", type: "expense", isActive: true, deletedAt: null } as unknown as Category];

const DATA: ReconciliationData = {
  accounts: ACCOUNTS,
  creditCards: [],
  statements: [],
  categories: CATEGORIES,
  transactions: [
    // Same day as the statement's CAFE ₹100.00, but ₹100.70 — a possible match, never a confirmed duplicate.
    txn({ id: "txn_cafe", description: "CAFE", amount: 100.7, dateTime: new Date(2026, 8, 7, 13), categoryId: "food" }),
    // Earlier Swiggy orders, all "Food" — far enough back not to be match candidates; they only feed the suggestion.
    txn({ id: "txn_h1", description: "SWIGGY", amount: 300, dateTime: new Date(2026, 6, 1, 13), categoryId: "food" }),
    txn({ id: "txn_h2", description: "Swiggy", amount: 310, dateTime: new Date(2026, 6, 20, 13), categoryId: "food" }),
  ],
  trashedTransactions: [],
  smsCandidates: [],
  expenses: [],
};
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function handOff() {
  const lines = [
    ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]),
    ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"], { "810.00": 40 }),
    ocrLine(80, ["07/09/2026", "CAFE", "100.00 Dr"]),
    ocrLine(120, ["08/09/2026", "NEW SHOP", "250.00 Dr"]),
    ocrLine(160, ["09/09/2026", "REFUND MYNTRA", "999.00 Cr"]),
  ];
  const text = ocrText(lines);
  const parse = parsePastedStatement(text);
  const rows = toReviewRows(annotateOcrRows(parse.rows, lines, { hasCreditMarkers: parse.hasCreditMarkers }), "ocr");
  const ocr: OcrCapture = { text, lines, imageUrl: "blob:own", natural: { width: 1200, height: 600 }, area: { x: 0, y: 0, width: 1200, height: 600 }, prepared: { width: 2400, height: 1200 }, crop: null, confidence: 90, durationMs: 800, warnings: [] };
  expect(handOffCapture({ sourceText: text, parse, rows, ocr, image: { file: new Blob(["png"]), name: "s.png" }, crop: null, mode: "image", accountId: null, accounts: ACCOUNTS }).ok).toBe(true);
  return rows;
}

function open() {
  const rows = handOff();
  render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose statement account" }));
  fireEvent.click(screen.getAllByTestId("account-option").find((o) => o.textContent?.includes("QA Card"))!);
  return rows;
}

const value = (id: string) => screen.getByTestId(id).dataset.value;
const count = (id: string) => screen.getByTestId(id).querySelector("dd")!.textContent;
const rowEl = (desc: string) => screen.getAllByTestId("recon-row").find((r) => r.textContent?.includes(desc))!;

describe("Review & Import", () => {
  it("is titled Review & Import and summarises the included rows' money and what's left", () => {
    open();
    expect(screen.getByRole("heading", { name: "Review & Import" })).toBeTruthy();
    expect(value("total-debits")).toBe("1612.00"); // 452 + 810 + 100 + 250
    expect(value("total-credits")).toBe("999.00");
    expect(value("total-net")).toBe("-613.00");
    expect(count("summary-included")).toBe("5");
    expect(count("summary-duplicates")).toBe("1"); // CAFE ₹100.00 vs ₹100.70
    expect(count("summary-to-check")).toBe("1"); // ZOMATO's unclear amount
    expect(count("summary-will-import")).toBe("0");
    expect(within(rowEl("ZOMATO")).getByTestId("row-check-label").textContent).toBe("Check amount");
    expect(within(rowEl("SWIGGY")).queryByTestId("row-check-label")).toBeNull();
  });

  it("the unclear OCR amount is settled with ONE confirmation that names the value, beside the image strip", () => {
    open();
    fireEvent.click(screen.getByTestId("next-check"));
    const editor = screen.getByTestId("row-editor");
    expect(within(editor).getByTestId("editor-evidence")).toBeTruthy();
    expect(within(editor).getAllByRole("button", { name: /^Confirm/ })).toHaveLength(1);
    expect(within(editor).getByTestId("confirm-row").textContent).toMatch(/Confirm ₹810\.00$/);
    fireEvent.click(within(editor).getByTestId("confirm-row"));
    expect(within(screen.getByTestId("row-editor")).queryByTestId("confirm-row")).toBeNull();
    expect(count("summary-to-check")).toBe("0");
  });

  it("bulk Import new rows takes only clean unmatched charges: history fills SWIGGY, one pick fills the rest", () => {
    open();
    fireEvent.click(screen.getByTestId("bulk-import-open"));
    const dialog = screen.getByTestId("bulk-import-dialog");
    const listed = within(dialog).getAllByTestId("bulk-import-row").map((r) => r.textContent);
    // Not ZOMATO (unclear), not CAFE (possible duplicate), not the refund (a credit needs Refund/Income).
    expect(listed.some((t) => /SWIGGY/.test(t ?? ""))).toBe(true);
    expect(listed.some((t) => /NEW SHOP/.test(t ?? ""))).toBe(true);
    expect(listed).toHaveLength(2);
    expect((within(dialog).getByLabelText("Category for SWIGGY") as HTMLSelectElement).value).toBe("Food");
    expect((within(dialog).getByLabelText("Category for NEW SHOP") as HTMLSelectElement).value).toBe("");
    fireEvent.change(within(dialog).getByTestId("bulk-fill-all"), { target: { value: "Shopping" } });
    expect((within(dialog).getByLabelText("Category for NEW SHOP") as HTMLSelectElement).value).toBe("Shopping");
    fireEvent.click(within(dialog).getByTestId("bulk-import-apply"));
    expect(count("summary-will-import")).toBe("2");
    expect(screen.getByTestId("open-approval").textContent).toMatch(/Finish review|Import/);
  });

  it("the final button says how many will be imported once every row is decided", () => {
    open();
    fireEvent.click(screen.getByTestId("bulk-import-open"));
    const dialog = screen.getByTestId("bulk-import-dialog");
    fireEvent.change(within(dialog).getByTestId("bulk-fill-all"), { target: { value: "Shopping" } });
    fireEvent.click(within(dialog).getByTestId("bulk-import-apply"));
    // Remaining rows still need their own decision — the final import waits for them.
    expect((screen.getByTestId("open-approval") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("open-approval").textContent).toBe("Import 2 transactions…");
  });

  it("excluding a row updates the totals at once; including it again restores them", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /Expand row 4/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Include this row" }));
    expect(value("total-debits")).toBe("1362.00");
    fireEvent.click(screen.getByRole("switch", { name: "Include this row" }));
    expect(value("total-debits")).toBe("1612.00");
  });
});
