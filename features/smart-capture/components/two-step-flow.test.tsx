// @vitest-environment jsdom
/**
 * Capture → Review & Import: extracting hands every row straight to /reconciliation (no review step here), exactly
 * as read — flags included, so Review & Import's own gates settle them. Nothing is written from Smart Capture.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ocrLine } from "../lib/ocr-test-helpers";
import { openIssues } from "../lib/capture-review";
import { OcrCancelledError, type OcrResult } from "../lib/tesseract-ocr";
import { SmartCaptureStudio } from "./smart-capture-studio";
import { _resetHandoffForTests, consumePendingHandoff, getHandoffState } from "@/features/reconciliation/lib/capture-handoff";

vi.mock("./capture-approval", () => ({ CaptureApproval: () => <div data-testid="approval" /> }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "acc-card", deletedAt: null }] }) }));
const recognize = vi.fn<(...args: unknown[]) => Promise<OcrResult>>();
vi.mock("../lib/tesseract-ocr", async (orig) => ({ ...(await orig<typeof import("../lib/tesseract-ocr")>()), recognizeScreenshot: (...a: unknown[]) => recognize(...a) }));
vi.mock("../lib/image-crop", async (orig) => ({ ...(await orig<typeof import("../lib/image-crop")>()), prepareForOcr: () => ({}) }));

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 600 });
});
beforeEach(() => {
  sessionStorage.clear();
  recognize.mockReset();
  push.mockReset();
  _resetHandoffForTests();
});
afterEach(cleanup);

/** Pastes and presses Extract — a statement that reads as a table stops at the column-mapping step. */
function startExtract(text: string) {
  fireEvent.change(screen.getByLabelText("Pasted statement text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ }));
}
/** …and confirms the detected columns. */
function extract(text: string) {
  startExtract(text);
  fireEvent.click(screen.getByTestId("mapping-confirm"));
}
async function confirmMapping() {
  fireEvent.click(await screen.findByTestId("mapping-confirm"));
}
function loadScreenshot() {
  fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
  fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "stmt.png", { type: "image/png" })] } });
}

describe("column mapping step", () => {
  const BANK = [
    "Date\tNarration\tWithdrawal\tDeposit\tBalance",
    "01/10/2026\tUPI SWIGGY\t450.00\t\t49,550.00",
    "02/10/2026\tSALARY ACME\t\t1,00,000.00\t1,49,550.00",
    "03/10/2026\tATM WITHDRAWAL\t10,000.00\t\t1,39,550.00",
  ].join("\n");

  it("a table stops at Match your columns first — nothing is handed over until the user confirms", () => {
    render(<SmartCaptureStudio />);
    startExtract(BANK);
    expect(screen.getByTestId("column-mapping")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    expect(getHandoffState().pending).toBeNull();
    // Detected from the headers: nothing for the user to do but confirm.
    expect((screen.getByTestId("column-role-4") as HTMLSelectElement).value).toBe("balance");
    expect((screen.getByTestId("column-role-2") as HTMLSelectElement).value).toBe("debit");
    expect(screen.getByTestId("mapping-summary").textContent).toMatch(/Debit.*Withdrawal/);
    expect(screen.getAllByTestId("mapping-preview-row")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("mapping-confirm"));
    expect(push).toHaveBeenCalledWith("/reconciliation");
    const rows = getHandoffState().pending!.rows;
    expect(rows.map((r) => [r.amount, r.direction])).toEqual([[450, "debit"], [100000, "credit"], [10000, "debit"]]);
  });

  it("the user can correct a column, the preview follows, and a mapping with no Date can't be confirmed", () => {
    render(<SmartCaptureStudio />);
    startExtract(BANK);
    fireEvent.change(screen.getByTestId("column-role-2"), { target: { value: "credit" } });
    fireEvent.change(screen.getByTestId("column-role-3"), { target: { value: "debit" } });
    // The balance now moves the opposite way — the preview says so and offers the swap back.
    expect(screen.getByTestId("mapping-swap")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mapping-swap"));
    expect((screen.getByTestId("column-role-2") as HTMLSelectElement).value).toBe("debit");

    fireEvent.change(screen.getByTestId("column-role-0"), { target: { value: "ignore" } });
    expect((screen.getByTestId("mapping-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("mapping-error").textContent).toMatch(/Date/);
    expect(screen.queryByTestId("mapping-result")).toBeNull();
    fireEvent.click(screen.getByTestId("mapping-confirm"));
    expect(push).not.toHaveBeenCalled();
  });

  it("optional columns can all be ignored", () => {
    render(<SmartCaptureStudio />);
    startExtract(BANK);
    fireEvent.change(screen.getByTestId("column-role-4"), { target: { value: "ignore" } });
    expect((screen.getByTestId("mapping-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("mapping-confirm"));
    expect(getHandoffState().pending!.rows).toHaveLength(3);
  });

  it("'Edit source' goes back to the pasted text, untouched", () => {
    render(<SmartCaptureStudio />);
    startExtract(BANK);
    fireEvent.click(screen.getByTestId("mapping-back"));
    expect(screen.queryByTestId("column-mapping")).toBeNull();
    expect((screen.getByLabelText("Pasted statement text") as HTMLTextAreaElement).value).toBe(BANK);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Capture → Review & Import", () => {
  it("shows two steps, and extracting goes straight to Review & Import with every row — no review step in between", () => {
    render(<SmartCaptureStudio />);
    const steps = screen.getByRole("list", { name: "Progress" }).textContent;
    expect(steps).toMatch(/Capture/);
    expect(steps).toMatch(/Review & Import/);
    expect(steps).not.toMatch(/Check duplicates/);

    extract("05/09/2026\tSWIGGY\t452.00 Dr\n07/09/2026\tREFUND MYNTRA\t999.00\n08/09/2026\tSWIGGY\t452.00 Dr\n08/09/2026\tSWIGGY\t452.00 Dr");
    expect(push).toHaveBeenCalledWith("/reconciliation");
    expect(screen.queryByTestId("review-row")).toBeNull();
    const pending = getHandoffState().pending!;
    expect(pending.rows.map((r) => r.description)).toEqual(["SWIGGY", "REFUND MYNTRA", "SWIGGY", "SWIGGY"]);
    // The refund with no Cr marker and the look-alike pair arrive flagged — never silently resolved.
    expect(openIssues(pending.rows[1]).map((i) => i.code)).toContain("direction_unclear");
    expect(openIssues(pending.rows[2]).map((i) => i.code)).toContain("possible_repeat");
    expect(pending.accountId).toBeNull(); // the statement account is chosen there, explicitly
    expect(screen.queryByTestId("approval")).toBeNull();
  });

  it("explains when nothing looks like a transaction, and hands nothing over", () => {
    render(<SmartCaptureStudio />);
    startExtract("hello world"); // no table in it → no mapping step, read as before
    expect(screen.getByRole("alert").textContent).toMatch(/No transaction rows found/);
    expect(push).not.toHaveBeenCalled();
    expect(getHandoffState().pending).toBeNull();
  });

  it("a screenshot is read, annotated and handed over with its own copy of the image", async () => {
    const lines = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"], { "810.00": 40 })];
    recognize.mockResolvedValue({ text: lines.map((l) => l.text).join("\n"), lines, confidence: 88, durationMs: 900 });
    render(<SmartCaptureStudio />);
    loadScreenshot();
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    await confirmMapping();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/reconciliation"));
    const pending = getHandoffState().pending!;
    expect(pending.source).toBe("ocr");
    expect(pending.screenshot).not.toBeNull();
    const [swiggy, zomato] = pending.rows;
    expect(openIssues(swiggy)).toEqual([]); // read clearly — no click needed anywhere
    expect(openIssues(zomato).map((i) => i.code)).toEqual(["low_confidence_amount"]); // one check, done in Review & Import
  });

  it("an OCR failure hands nothing over; retrying works", async () => {
    recognize.mockRejectedValueOnce(new Error("the OCR engine couldn't start"));
    render(<SmartCaptureStudio />);
    loadScreenshot();
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't read this screenshot/);
    expect(getHandoffState().pending).toBeNull();
    const lines = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"])];
    recognize.mockResolvedValueOnce({ text: lines[0].text, lines, confidence: 95, durationMs: 500 });
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await confirmMapping();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/reconciliation"));
  });

  it("a cancelled read hands nothing over", async () => {
    recognize.mockRejectedValueOnce(new OcrCancelledError());
    render(<SmartCaptureStudio />);
    loadScreenshot();
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Reading cancelled/);
    expect(push).not.toHaveBeenCalled();
  });

  it("coming back from Review & Import shows the capture with a way back — never a second review", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026\tSWIGGY\t452.00 Dr");
    consumePendingHandoff(); // Review & Import took it
    cleanup();
    push.mockReset();
    render(<SmartCaptureStudio />);
    expect(screen.getByTestId("review-in-progress").textContent).toMatch(/open in Review & Import/);
    expect((screen.getByLabelText("Pasted statement text") as HTMLTextAreaElement).value).toMatch(/SWIGGY/);
    fireEvent.click(screen.getByRole("button", { name: "Return to Review & Import" }));
    expect(push).toHaveBeenCalledWith("/reconciliation");
    expect(screen.queryByTestId("review-row")).toBeNull();
  });
});

describe("extract error", () => {
  it("belongs to the source it came from — switching tabs does not carry it over", () => {
    render(<SmartCaptureStudio />);
    startExtract("hello world\nthis is not a statement");
    expect(screen.getByRole("alert").textContent).toMatch(/No transaction rows found/);
    fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Paste text/ }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
