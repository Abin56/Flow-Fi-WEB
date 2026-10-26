// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ocrLine } from "../lib/ocr-test-helpers";
import { OcrCancelledError, type OcrResult } from "../lib/tesseract-ocr";
import { SmartCaptureStudio } from "./smart-capture-studio";
import { _resetHandoffForTests, getHandoffState } from "@/features/reconciliation/lib/capture-handoff";

// The retired approval step talks to Firestore; it must never render (asserted below) — mocked so a regression shows.
vi.mock("./capture-approval", () => ({ CaptureApproval: () => <div data-testid="approval" /> }));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [{ id: "acc-card", deletedAt: null }] }) }));

const recognize = vi.fn<(...args: unknown[]) => Promise<OcrResult>>();
vi.mock("../lib/tesseract-ocr", async (orig) => ({ ...(await orig<typeof import("../lib/tesseract-ocr")>()), recognizeScreenshot: (...a: unknown[]) => recognize(...a) }));
// jsdom has no canvas — cropping geometry is unit-tested separately.
vi.mock("../lib/image-crop", async (orig) => ({ ...(await orig<typeof import("../lib/image-crop")>()), prepareForOcr: () => ({}) }));

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => (cb(0), 0);
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

const PASTE = `05/09/2026  AMAZON PAY INDIA        1,299.00
07/09/2026  REFUND MYNTRA             999.00
Total Amount Due                    2,298.00`;

function extract(text: string) {
  fireEvent.change(screen.getByLabelText("Pasted statement text"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ }));
}

const rowsEls = () => screen.getAllByTestId("review-row");
const row = (desc: string) => rowsEls().find((r) => r.dataset.description === desc)!;
const cont = () => screen.getByRole("button", { name: /Next: Check duplicates/ }) as HTMLButtonElement;
const figure = (id: string) => screen.getByTestId(id).querySelectorAll("p")[1]!.textContent;
const expand = (desc: string) => fireEvent.click(screen.getByRole("button", { name: `Expand ${desc}` }));

const OCR_LINES = [ocrLine(0, ["05/09/2026", "SWIGGY", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "ZOMATO", "810.00 Dr"], { "810.00": 40 })];
const OCR_RESULT: OcrResult = { text: OCR_LINES.map((l) => l.text).join("\n"), lines: OCR_LINES, confidence: 88, durationMs: 1234 };

function loadScreenshot() {
  fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
  fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "stmt.png", { type: "image/png" })] } });
}

async function readOcr() {
  recognize.mockResolvedValue(OCR_RESULT);
  render(<SmartCaptureStudio />);
  loadScreenshot();
  fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
  await screen.findByTestId("progress-ready");
}

describe("paste text", () => {
  it("shows a clear error when nothing looks like a transaction", () => {
    render(<SmartCaptureStudio />);
    extract("hello world");
    expect(screen.getByRole("alert").textContent).toMatch(/No transaction rows found/);
  });

  it("'Fix …' on a collapsed row expands it; resolving the field unblocks continuing", () => {
    render(<SmartCaptureStudio />);
    extract(PASTE);
    expect(rowsEls()).toHaveLength(2);
    expect(cont().disabled).toBe(true);
    const refund = row("REFUND MYNTRA");
    expect(refund.dataset.status).toBe("fix");
    fireEvent.click(within(refund).getByTestId("row-status"));
    fireEvent.click(within(row("REFUND MYNTRA")).getByRole("button", { name: "Credit" }));
    expect(cont().disabled).toBe(false);
    fireEvent.click(cont());
    expect(push).toHaveBeenCalledWith("/reconciliation");
    expect(screen.queryByTestId("approval")).toBeNull();
    expect(getHandoffState().pending!.rows.map((r) => r.description)).toEqual(["AMAZON PAY INDIA", "REFUND MYNTRA"]);
  });

  it("deselect all disables continuing", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00 Dr");
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(cont().disabled).toBe(true);
  });

  it("collapsed rows show ₹ amounts with two decimals, Indian grouping and a sign", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 124999 Dr\n06/09/2026 REFUND SHOP 452.00 Cr");
    expect(row("AMAZON").textContent).toContain("−₹1,24,999.00");
    expect(row("REFUND SHOP").textContent).toContain("+₹452.00");
  });
});

describe("dropped decimal point — candidates, never auto-selected", () => {
  it("shows the candidates, requires a pick, then an explicit confirmation", () => {
    render(<SmartCaptureStudio />);
    extract("06/10/2026\tTELECOM\t43461 D\n07/10/2026\tSHOP\t50.00 D");
    const telecom = row("TELECOM");
    expect(telecom.dataset.amount).toBe("");
    expect(telecom.textContent).toContain("Fix amount");
    expand("TELECOM");
    const candidates = within(row("TELECOM")).getByRole("group", { name: "Amount candidates" });
    expect(within(candidates).getAllByRole("button").map((b) => b.textContent)).toEqual(["₹434.61", "₹43,461.00"]);
    expect(within(candidates).getAllByRole("button").every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect((within(row("TELECOM")).getByRole("button", { name: /Confirm amount/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(candidates).getByRole("button", { name: "₹434.61" }));
    expect(row("TELECOM").dataset.amount).toBe("434.61");
    expect(cont().disabled).toBe(true); // picked, not yet confirmed
    fireEvent.click(within(row("TELECOM")).getByRole("button", { name: "Confirm ₹434.61" }));
    expect(cont().disabled).toBe(false);
  });

  it("a typed amount also needs the explicit confirmation", () => {
    render(<SmartCaptureStudio />);
    extract("06/10/2026\tTELECOM\t43461 D");
    expand("TELECOM");
    fireEvent.change(within(row("TELECOM")).getByLabelText("Amount"), { target: { value: "434.61" } });
    expect(cont().disabled).toBe(true);
    fireEvent.click(within(row("TELECOM")).getByRole("button", { name: "Confirm ₹434.61" }));
    expect(cont().disabled).toBe(false);
  });
});

describe("screenshot OCR + progress + bulk confirmation", () => {
  it("separates checked, needs-correction and ready counts", async () => {
    await readOcr();
    expect(figure("progress-ready")).toBe("0 / 2");
    expect(figure("progress-verified")).toBe("0 / 2");
    expect(figure("progress-fix")).toBe("1");
    expect(screen.getByTestId("ocr-source")).toBeTruthy();
  });

  it("bulk confirm asks once, lists the eligible rows only, and can be undone", async () => {
    await readOcr();
    fireEvent.click(screen.getByRole("button", { name: "Confirm all reviewed rows (1)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("bulk-list").textContent).toContain("SWIGGY");
    expect(within(dialog).getByTestId("bulk-list").textContent).not.toContain("ZOMATO"); // low-confidence amount
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm 1 row" }));
    expect(figure("progress-ready")).toBe("1 / 2");
    expect(row("ZOMATO").dataset.status).toBe("fix");
    fireEvent.click(screen.getByRole("button", { name: /Undo bulk confirmation \(1\)/ }));
    expect(figure("progress-ready")).toBe("0 / 2");
  });

  it("the low-confidence row needs its own row check AND field confirmation", async () => {
    await readOcr();
    expand("ZOMATO");
    fireEvent.click(within(row("ZOMATO")).getByRole("button", { name: "Row matches the image" }));
    expect(row("ZOMATO").dataset.status).toBe("fix");
    fireEvent.click(within(row("ZOMATO")).getByRole("button", { name: "Confirm ₹810.00" }));
    expand("SWIGGY");
    fireEvent.click(within(row("SWIGGY")).getByRole("button", { name: "Row matches the image" }));
    expect(cont().disabled).toBe(false);
    // Undoing a row's verification re-blocks approval.
    fireEvent.click(within(row("SWIGGY")).getByRole("button", { name: "Undo verification" }));
    expect(cont().disabled).toBe(true);
  });

  it("moves the source-image highlight to the focused row (1200×600 image read at 2× → 2400×1200 canvas)", async () => {
    await readOcr();
    expect(screen.getByTestId("ocr-highlight").style.top).toBe("0%");
    expand("ZOMATO");
    expect(screen.getByTestId("ocr-highlight").style.top).toMatch(/^3\.33/);
    expect(within(row("ZOMATO")).getByTestId("row-zoom")).toBeTruthy();
  });

  it("shows progress, can be cancelled, and nothing is extracted", async () => {
    let fail: (e: Error) => void = () => undefined;
    recognize.mockImplementation((_img, opts) => {
      (opts as { onProgress: (p: unknown) => void }).onProgress({ stage: "recognizing", progress: 0.5, label: "Reading text" });
      return new Promise((_, reject) => (fail = reject));
    });
    render(<SmartCaptureStudio />);
    loadScreenshot();
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    await screen.findByText("50%");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => fail(new OcrCancelledError()));
    expect(screen.getByRole("alert").textContent).toMatch(/cancelled/);
    expect(screen.queryByTestId("progress-ready")).toBeNull();
  });

  it("reports an OCR failure and retries successfully", async () => {
    recognize.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(OCR_RESULT);
    render(<SmartCaptureStudio />);
    loadScreenshot();
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't read this screenshot/));
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByTestId("progress-ready");
  });
});

describe("expand / collapse", () => {
  const TEXT = "05/09/2026 SHOP A 100.00 Dr\n06/09/2026 SHOP B 200.00 Dr\n07/09/2026 REFUND C 50.00";

  it("defaults to a compact list; one row expands and collapses with an accessible toggle", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    expect(screen.queryAllByLabelText("Amount")).toHaveLength(0);
    expand("SHOP A");
    expect(screen.getByRole("button", { name: "Collapse SHOP A" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(row("SHOP A")).getByLabelText("Amount")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse SHOP A" }));
    expect(screen.queryAllByLabelText("Amount")).toHaveLength(0);
  });

  it("expand all / collapse all", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    expect(screen.getAllByLabelText("Amount")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Collapse all/ }));
    expect(screen.queryAllByLabelText("Amount")).toHaveLength(0);
  });

  it("keeps expanded rows expanded across filtering, sorting and editing", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    expand("SHOP B");
    fireEvent.click(screen.getByRole("button", { name: /^To fix/ }));
    expect(screen.queryByText("SHOP B")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(within(row("SHOP B")).getByLabelText("Amount")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    expect(within(row("SHOP B")).getByLabelText("Amount")).toBeTruthy();
    fireEvent.change(within(row("SHOP B")).getByLabelText("Description"), { target: { value: "SHOP B2" } });
    expect(within(row("SHOP B2")).getByLabelText("Amount")).toBeTruthy();
  });
});

describe("layout", () => {
  it("the action bar sits after the list (never inside it or the screenshot panel)", async () => {
    await readOcr();
    const footer = screen.getByTestId("review-footer");
    const list = screen.getByTestId("review-list");
    expect(footer.closest("aside")).toBeNull();
    expect(list.contains(footer)).toBe(false);
    expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the source text never wraps (amounts stay on one line)", () => {
    render(<SmartCaptureStudio />);
    extract("06/10/2026\tBSNL SELFCARE\tIN\t434.61\tD");
    expect(screen.getByTestId("source-text").querySelector("[data-line]")!.className).toMatch(/whitespace-pre(\s|$)/);
  });
});

describe("draft recovery", () => {
  it("restores decisions from the same paste after a refresh, and can discard", async () => {
    const first = render(<SmartCaptureStudio />);
    extract(PASTE);
    fireEvent.click(within(row("REFUND MYNTRA")).getByTestId("row-status"));
    fireEvent.click(within(row("REFUND MYNTRA")).getByRole("button", { name: "Credit" }));
    fireEvent.click(within(row("AMAZON PAY INDIA")).getAllByRole("checkbox")[0]);
    first.unmount();

    render(<SmartCaptureStudio />);
    expect(await screen.findByText(/Unfinished capture/)).toBeTruthy();
    expect(sessionStorage.getItem("flowfi.smartCapture.draft.v1")).not.toMatch(/AMAZON|MYNTRA|1,299/);
    extract(PASTE);
    expect(screen.getByText(/Restored your decisions on 2 rows/)).toBeTruthy();
    expect(row("AMAZON PAY INDIA").dataset.status).toBe("excluded");

    fireEvent.click(screen.getByTestId("clear-capture"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear capture" }));
    expect(sessionStorage.getItem("flowfi.smartCapture.draft.v1")).toBeNull();
  });

  it("an intentional new capture replaces the old draft without a confusing mismatch message", async () => {
    const first = render(<SmartCaptureStudio />);
    extract(PASTE);
    first.unmount();
    render(<SmartCaptureStudio />);
    await screen.findByText(/Unfinished capture/);
    extract("01/10/2026 SOMETHING ELSE 10.00 Dr");
    expect(screen.queryByText(/doesn't match|started fresh|replaced/)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("flowfi.smartCapture.draft.v1") ?? "{}").rowCount).toBe(1);
  });
});

describe("Continue → Reconciliation (Phase 3 handoff)", () => {
  it("is refused while any included row needs attention — nothing is handed over", () => {
    render(<SmartCaptureStudio />);
    extract(PASTE); // REFUND MYNTRA's Charge/Credit is unresolved
    expect(cont().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Check duplicates" }) as HTMLButtonElement).disabled).toBe(true);
    expect(getHandoffState().pending).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("an excluded row travels along, still excluded; ids and values are untouched", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00 Dr\n06/09/2026 SWIGGY 452.00 Dr");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include SWIGGY" }));
    fireEvent.click(cont());
    const pending = getHandoffState().pending!;
    expect(pending.rows.map((r) => [r.id, r.description, r.amount, r.direction, r.include, r.captureExcluded])).toEqual([
      ["r1", "AMAZON", 1299, "debit", true, false],
      ["r2", "SWIGGY", 452, "debit", false, true],
    ]);
    expect(pending.priorSessionIds["acc-card"]).toMatch(/^smartcapture_/);
  });

  it("an OCR capture hands over the verified rows with their positions and its own copy of the screenshot", async () => {
    await readOcr();
    fireEvent.click(screen.getByRole("button", { name: "Confirm all reviewed rows (1)" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm 1 row" }));
    expand("ZOMATO");
    fireEvent.click(within(row("ZOMATO")).getByRole("button", { name: "Row matches the image" }));
    fireEvent.click(within(row("ZOMATO")).getByRole("button", { name: "Confirm ₹810.00" }));
    const createdBefore = vi.mocked(URL.createObjectURL).mock.calls.length;
    fireEvent.click(cont());
    const pending = getHandoffState().pending!;
    expect(pending.source).toBe("ocr");
    expect(pending.rows.every((r) => r.ocr?.box)).toBe(true);
    expect(pending.rows.find((r) => r.description === "ZOMATO")!.confirmedFields).toContain("amount");
    expect(pending.screenshot).not.toBeNull();
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(createdBefore + 1); // the handoff's own URL
    expect(push).toHaveBeenCalledWith("/reconciliation");
  });

  it("Back from Reconciliation reopens the capture at review, exactly as handed over", () => {
    const first = render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00 Dr");
    fireEvent.click(cont());
    first.unmount();
    render(<SmartCaptureStudio />);
    expect(screen.getByText(/Back from Check duplicates/)).toBeTruthy();
    expect(rowsEls().map((r) => r.dataset.description)).toEqual(["AMAZON"]);
    expect(cont().disabled).toBe(false);
  });

  it("Discard forgets the restore point but never a review's screenshot", () => {
    render(<SmartCaptureStudio />);
    extract("05/09/2026 AMAZON 1,299.00 Dr");
    fireEvent.click(cont());
    fireEvent.click(screen.getByTestId("clear-capture"));
    // Already handed over → asks first, and says a duplicate check open there is kept.
    expect(within(screen.getByRole("dialog")).getByText(/stays there until you replace or discard it/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear capture" }));
    expect(getHandoffState().snapshot).toBeNull();
    expect(getHandoffState().pending).toBeNull(); // not yet taken by Reconciliation → released
  });
});
