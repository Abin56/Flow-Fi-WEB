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

function extract(text: string) {
  fireEvent.change(screen.getByLabelText("Pasted statement text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ }));
}
function loadScreenshot() {
  fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
  fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "stmt.png", { type: "image/png" })] } });
}

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
    extract("hello world");
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
