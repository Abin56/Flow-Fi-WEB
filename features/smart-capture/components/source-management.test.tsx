// @vitest-environment jsdom
/**
 * Smart Capture source management and selection: Replace screenshot / Paste new statement / Retry OCR / Clear capture
 * / Back to capture never silently drop review work, never keep stale rows behind a new source, and release
 * screenshot URLs; include/exclude is its own idea with live counts, preserved across Back.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe as vitestDescribe, expect, it, vi } from "vitest";

// 2026-10-29: Smart Capture now hands rows straight to Review & Import (/reconciliation); the standalone review step
// these tests drive is no longer routed. The components are kept untouched until the two-step flow is verified in the
// browser (user decision), so this suite is skipped rather than deleted. The new flow: two-step-flow.test.tsx.
const describe = vitestDescribe.skip;
import { ocrLine } from "../lib/ocr-test-helpers";
import type { OcrResult } from "../lib/tesseract-ocr";
import { SmartCaptureStudio } from "./smart-capture-studio";
import { _resetHandoffForTests, getHandoffState } from "@/features/reconciliation/lib/capture-handoff";

vi.mock("./capture-approval", () => ({ CaptureApproval: () => <div data-testid="approval" /> }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "acc-card", deletedAt: null }] }) }));
const recognize = vi.fn<(...args: unknown[]) => Promise<OcrResult>>();
vi.mock("../lib/tesseract-ocr", async (orig) => ({ ...(await orig<typeof import("../lib/tesseract-ocr")>()), recognizeScreenshot: (...a: unknown[]) => recognize(...a) }));
vi.mock("../lib/image-crop", async (orig) => ({ ...(await orig<typeof import("../lib/image-crop")>()), prepareForOcr: () => ({}) }));

let urlSeq = 0;
beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => (cb(0), 0);
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 600 });
});
beforeEach(() => {
  sessionStorage.clear();
  urlSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:img-${++urlSeq}`);
  URL.revokeObjectURL = vi.fn();
  recognize.mockReset();
  push.mockReset();
  _resetHandoffForTests();
});
afterEach(cleanup);

const TEXT = "05/09/2026 AMAZON 1,299.00 Dr\n06/09/2026 SWIGGY 452.00 Dr\n07/09/2026 UBER 250.00 Dr";
const OTHER = "08/09/2026 NETFLIX 649.00 Dr";

function extract(text: string) {
  fireEvent.change(screen.getByLabelText("Pasted statement text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ }));
}
const rowsEls = () => screen.getAllByTestId("review-row");
const descriptions = () => rowsEls().map((r) => r.dataset.description);
const include = (desc: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Include ${desc}` }));
const dialog = () => screen.getByRole("dialog");
const draft = () => sessionStorage.getItem("flowfi.smartCapture.draft.v1");

const OCR_LINES = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"])];
async function readScreenshot() {
  recognize.mockResolvedValue({ text: OCR_LINES.map((l) => l.text).join("\n"), lines: OCR_LINES, confidence: 92, durationMs: 900 });
  render(<SmartCaptureStudio />);
  fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
  fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "stmt.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
  await screen.findByTestId("progress-ready");
}

describe("source management", () => {
  it("Paste new statement with review work asks first, says what is lost, and Keep my review changes nothing", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    include("UBER"); // a review decision
    fireEvent.click(screen.getByTestId("paste-new"));
    expect(dialog().textContent).toMatch(/Paste a new statement\?/);
    expect(dialog().textContent).toMatch(/3 extracted rows/);
    expect(dialog().textContent).toMatch(/include\/exclude choices/);
    expect(dialog().textContent).toMatch(/Nothing has been imported/);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Keep my review" }));
    expect(descriptions()).toEqual(["AMAZON", "SWIGGY", "UBER"]);
    expect(rowsEls().find((r) => r.dataset.description === "UBER")!.dataset.status).toBe("excluded");
  });

  it("confirming Paste new statement clears every row and the draft — the next extract shows only the new rows", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    include("UBER");
    expect(draft()).not.toBeNull();
    fireEvent.click(screen.getByTestId("paste-new"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Start new paste" }));
    expect(screen.queryAllByTestId("review-row")).toHaveLength(0);
    expect((screen.getByLabelText("Pasted statement text") as HTMLTextAreaElement).value).toBe("");
    expect(draft()).toBeNull();
    extract(OTHER);
    expect(descriptions()).toEqual(["NETFLIX"]);
  });

  it("with no review work yet, replacing doesn't ask", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    fireEvent.click(screen.getByTestId("paste-new"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Pasted statement text")).toBeTruthy();
  });

  it("Back to capture keeps the review; the same text returns to it, a different one asks before replacing it", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    include("UBER");
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    expect(screen.getByTestId("review-in-progress").textContent).toMatch(/3 rows is still open/);
    fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ })); // same text still in the box
    expect(screen.getByText(/Same statement as your open review/)).toBeTruthy();
    expect(rowsEls().find((r) => r.dataset.description === "UBER")!.dataset.status).toBe("excluded"); // kept

    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    extract(OTHER);
    expect(dialog().textContent).toMatch(/Replace the current capture\?/);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Replace capture" }));
    expect(descriptions()).toEqual(["NETFLIX"]); // no stale rows behind the new source
  });

  it("Clear capture after handing over asks, and leaves a duplicate check already open in Reconciliation alone", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00 Dr");
    fireEvent.click(screen.getByRole("button", { name: /Next: Check duplicates/ }));
    expect(getHandoffState().snapshot).not.toBeNull();
    fireEvent.click(screen.getByTestId("clear-capture"));
    expect(dialog().textContent).toMatch(/stays there until you replace or discard it/);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Clear capture" }));
    expect(getHandoffState().snapshot).toBeNull();
    expect(screen.queryAllByTestId("review-row")).toHaveLength(0);
  });

  it("Retry OCR keeps the screenshot (its URL isn't revoked) but drops the rows read from it", async () => {
    await readScreenshot();
    expect(descriptions()).toEqual(["SWIGGY", "ZOMATO"]);
    fireEvent.click(screen.getByTestId("retry-ocr"));
    expect(screen.queryAllByTestId("review-row")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Read text|Read selected area/ })).toBeTruthy();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:img-1");
  });

  it("Replace screenshot releases the old screenshot's URL and opens a fresh drop zone", async () => {
    await readScreenshot();
    fireEvent.click(screen.getByTestId("replace-screenshot"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:img-1");
    expect(screen.getByText(/Drop a screenshot/)).toBeTruthy();
    expect(screen.queryAllByTestId("review-row")).toHaveLength(0);
  });

  it("changing the screenshot under an open, worked-on review asks; cancelling releases the new image and keeps the review", async () => {
    await readScreenshot();
    include("ZOMATO");
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["y"], "other.png", { type: "image/png" })] } });
    expect(dialog().textContent).toMatch(/Replace the screenshot\?/);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Keep my review" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:img-2"); // the unused new image
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:img-1"); // the review's image stays
    fireEvent.click(screen.getByRole("button", { name: "Return to review" }));
    expect(descriptions()).toEqual(["SWIGGY", "ZOMATO"]);
  });
});

describe("selection", () => {
  it("Select all / Deselect all and the counts update immediately; excluded rows can be hidden but are never lost", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    const countText = () => screen.getByTestId("selection-count").textContent;
    expect(countText()).toBe("3 included · 0 excluded");
    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(countText()).toBe("0 included · 3 excluded");
    expect(screen.getByTestId("progress-included").textContent).toMatch(/0\s*\/ 3/);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    include("UBER");
    expect(countText()).toBe("2 included · 1 excluded");

    const toggle = screen.getByRole("button", { name: "Show excluded rows" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(descriptions()).toEqual(["AMAZON", "SWIGGY"]);
    fireEvent.click(screen.getByRole("button", { name: /^Excluded/ })); // the Excluded filter still shows them
    expect(descriptions()).toEqual(["UBER"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.click(toggle);
    expect(descriptions()).toEqual(["AMAZON", "SWIGGY", "UBER"]);
  });

  it("included ≠ verified ≠ ready: three separate figures", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00\n06/09/2026 SWIGGY 452.00 Dr"); // AMAZON's Charge/Credit is unclear
    const fig = (id: string) => screen.getByTestId(id).querySelectorAll("p")[1]!.textContent;
    expect(fig("progress-included")).toBe("2 / 2");
    expect(fig("progress-ready")).toBe("1 / 2");
    expect(fig("progress-fix")).toBe("1");
  });

  it("selection is preserved when going back to capture and returning", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    include("SWIGGY");
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    fireEvent.click(screen.getByRole("button", { name: "Return to review" }));
    expect(screen.getByTestId("selection-count").textContent).toBe("2 included · 1 excluded");
  });

  it("only included rows count as handed over for import; excluded ones travel along marked excluded", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    include("SWIGGY");
    include("UBER");
    fireEvent.click(screen.getByRole("button", { name: /Next: Check duplicates/ }));
    const pending = getHandoffState().pending!;
    expect(pending.rows.filter((r) => r.include).map((r) => r.description)).toEqual(["AMAZON"]);
    expect(pending.rows.filter((r) => r.captureExcluded).map((r) => r.description)).toEqual(["SWIGGY", "UBER"]);
    expect(pending.accountId).toBeNull(); // the account is chosen explicitly in Reconciliation
  });
});

describe("workflow language and grid", () => {
  it("says what Next does and that nothing is imported yet", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    expect(screen.getByRole("button", { name: "Next: Check duplicates & details" })).toBeTruthy();
    expect(screen.getAllByText("No transactions are imported yet.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("workspace-header").textContent).toMatch(/Smart Capture/);
  });

  it("amounts and dates never wrap or truncate in the grid, and grid rows have a fixed height", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026\tAMAZON\t12,34,567.89 Dr");
    const row = rowsEls()[0]!;
    expect(row.querySelector('[data-testid="review-row-summary"]')!.className).toMatch(/\bh-11\b/);
    const amount = row.querySelector('[data-col="amount"] span')!;
    expect(amount.className).toMatch(/whitespace-nowrap/);
    expect(amount.className).not.toMatch(/truncate/);
    expect(amount.textContent).toBe("−₹12,34,567.89");
    expect(row.querySelector('[data-col="date"]')!.className).toMatch(/whitespace-nowrap/);
  });
});
