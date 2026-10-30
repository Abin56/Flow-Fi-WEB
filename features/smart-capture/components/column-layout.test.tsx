// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => (cb(0), 0);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

const rowsEls = () => screen.getAllByTestId("review-row");
const row = (desc: string) => rowsEls().find((r) => r.dataset.description === desc)!;
const cols = (el: Element) => Array.from(el.querySelectorAll("[data-col]")).map((c) => (c as HTMLElement).dataset.col);
const headerLabels = () => Array.from(screen.getByTestId("review-columns-header").querySelectorAll("[data-col-header]")).map((c) => c.textContent);
const trigger = () => screen.getByTestId("column-layout-trigger");
const cont = () => screen.getByRole("button", { name: /Next: Check duplicates/ }) as HTMLButtonElement;
const expand = (desc: string) => fireEvent.click(screen.getByRole("button", { name: `Expand ${desc}` }));
const snapshot = () => rowsEls().map((r) => [r.dataset.rowId, r.dataset.date, r.dataset.description, r.dataset.amount, r.dataset.direction, r.dataset.status]);

const DMA = "05/09/2026\tAMAZON\t1,299.00 Dr\n07/09/2026\tREFUND MYNTRA\t999.00 Cr\n10/09/2026\tSWIGGY\t452.00 Dr";
const ADM = "1,299.00 Dr\t05/09/2026\tAMAZON\n999.00 Cr\t07/09/2026\tREFUND MYNTRA\n452.00 Dr\t10/09/2026\tSWIGGY";
const MAD = "AMAZON\t1,299.00 Dr\t05/09/2026\nREFUND MYNTRA\t999.00 Cr\t07/09/2026\nSWIGGY\t452.00 Dr\t10/09/2026";
const MDCA = "AMAZON\t05/09/2026\tDebit\t1,299.00\nREFUND MYNTRA\t07/09/2026\tCredit\t999.00\nSWIGGY\t10/09/2026\tDebit\t452.00";
const SPLIT = "Date\tNarration\tDebit\tCredit\n05/09/2026\tAMAZON\t1,299.00\n07/09/2026\tREFUND MYNTRA\t\t999.00\n10/09/2026\tSWIGGY\t452.00";

const EXPECTED = [
  ["r1", "2026-09-05", "AMAZON", "1299", "debit"],
  ["r2", "2026-09-07", "REFUND MYNTRA", "999", "credit"],
  ["r3", "2026-09-10", "SWIGGY", "452", "debit"],
];
const core = () => snapshot().map((r) => r.slice(0, 5));

describe("Auto layout follows the source's column order", () => {
  it.each([
    ["Date / Merchant / Amount", DMA, ["date", "merchant", "amount"], ["Date", "Merchant", "Amount"]],
    ["Amount / Date / Merchant", ADM, ["amount", "date", "merchant"], ["Amount", "Date", "Merchant"]],
    ["Merchant / Amount / Date", MAD, ["merchant", "amount", "date"], ["Merchant", "Amount", "Date"]],
    ["Merchant / Date / Charge/Credit / Amount", MDCA, ["merchant", "date", "direction", "amount"], ["Merchant", "Date", "Charge/Credit", "Amount"]],
  ])("%s", (_name, text, order, labels) => {
    render(<SmartCaptureStudio />);
    extract(text);
    for (const r of rowsEls()) expect(cols(r)).toEqual(order);
    expect(headerLabels()).toEqual(labels);
    expect(core()).toEqual(EXPECTED); // same ids, dates, merchants, amounts and directions whatever the order
    expect(trigger().getAttribute("aria-label")).toBe("Column layout: Auto (Source order)");
  });

  it("the header strip uses the very grid template the rows use (one alignment source)", () => {
    render(<SmartCaptureStudio />);
    extract(ADM);
    const headerGrid = screen.getByTestId("review-columns-header").querySelector<HTMLElement>("[data-col-header]")!.parentElement!;
    const rowGrid = within(row("AMAZON")).getByRole("button", { name: "Expand AMAZON" });
    expect(headerGrid.style.getPropertyValue("--review-cols")).toBe("8rem 6.5rem minmax(0,1fr)");
    expect(rowGrid.style.getPropertyValue("--review-cols")).toBe(headerGrid.style.getPropertyValue("--review-cols"));
  });

  it("values are drawn exactly as before: sign, rupee amount and Charge/Credit", () => {
    render(<SmartCaptureStudio />);
    extract(ADM);
    expect(row("AMAZON").textContent).toContain("−₹1,299.00");
    expect(row("REFUND MYNTRA").textContent).toContain("+₹999.00");
    expect(row("SWIGGY").textContent).toContain("Charge");
    expect(row("REFUND MYNTRA").textContent).toContain("Credit");
  });
});

describe("separate Debit and Credit columns", () => {
  it("each amount is drawn under the column its direction names, the other cell is empty", () => {
    render(<SmartCaptureStudio />);
    extract(SPLIT);
    for (const r of rowsEls()) expect(cols(r)).toEqual(["date", "merchant", "debit", "credit"]);
    expect(headerLabels()).toEqual(["Date", "Merchant", "Debit", "Credit"]);
    const cell = (desc: string, col: string) => row(desc).querySelector(`[data-col="${col}"]`)!.textContent;
    // (a filled cell also carries a phones-only "Debit"/"Credit" label before the amount)
    expect(cell("AMAZON", "debit")).toMatch(/₹1,299\.00$/);
    expect(cell("AMAZON", "credit")).toBe("—");
    expect(cell("REFUND MYNTRA", "debit")).toBe("—");
    expect(cell("REFUND MYNTRA", "credit")).toMatch(/₹999\.00$/);
    expect(core()).toEqual(EXPECTED);
  });

  it("a row whose direction is unknown is not placed under either column as fact — it's flagged 'C/D ?'", () => {
    render(<SmartCaptureStudio />);
    extract("Date\tNarration\tDebit\tCredit\n05/09/2026\tODD ROW\t100.00\t200.00\n06/09/2026\tSWIGGY\t452.00");
    const odd = row("ODD ROW");
    expect(odd.dataset.direction).toBe("");
    expect(odd.textContent).toContain("C/D ?");
    expect(odd.dataset.status).toBe("fix");
    expect(cont().disabled).toBe(true);
  });
});

describe("ambiguous sources keep the standard layout", () => {
  const AMBIGUOUS = "AMAZON PAY 05/09/2026 1,299.00 Dr\nSWIGGY 07/09/2026 452.00 Dr";

  it("no guess: standard rows, no header strip, the date is still asked for", () => {
    render(<SmartCaptureStudio />);
    extract(AMBIGUOUS);
    expect(screen.queryByTestId("review-columns-header")).toBeNull();
    expect(rowsEls().every((r) => within(r).getByRole("button", { name: /^Expand/ }).dataset.layout === "standard")).toBe(true);
    expect(rowsEls().every((r) => r.dataset.status === "fix")).toBe(true);
    expect(trigger().getAttribute("aria-label")).toBe("Column layout: Auto (Standard)");
  });

  it("the panel says why, and Customize still works from date / merchant / amount", () => {
    render(<SmartCaptureStudio />);
    extract(AMBIGUOUS);
    fireEvent.click(trigger());
    expect(screen.getByTestId("column-layout-panel").textContent).toMatch(/Source order couldn't be confirmed/);
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    expect(headerLabels()).toEqual(["Date", "Merchant", "Amount"]);
  });
});

describe("Customize columns / Reset to source", () => {
  const openPanel = () => fireEvent.click(trigger());

  it("reorders only the display: ids, values, statuses and expanded rows are unchanged", () => {
    render(<SmartCaptureStudio />);
    extract(DMA);
    expand("SWIGGY");
    const before = snapshot();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Amount left" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Amount left" }));
    for (const r of rowsEls()) expect(cols(r)).toEqual(["amount", "date", "merchant"]);
    expect(headerLabels()).toEqual(["Amount", "Date", "Merchant"]);
    expect(snapshot()).toEqual(before);
    expect(within(row("SWIGGY")).getByLabelText("Amount")).toBeTruthy(); // still expanded
    expect(trigger().getAttribute("aria-label")).toBe("Column layout: Custom");
  });

  it("end columns can't move past the edge", () => {
    render(<SmartCaptureStudio />);
    extract(DMA);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    expect((screen.getByRole("button", { name: "Move Date left" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Amount right" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Reset to source returns to the detected order", () => {
    render(<SmartCaptureStudio />);
    extract(ADM);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Merchant left" }));
    expect(headerLabels()).toEqual(["Amount", "Merchant", "Date"]);
    fireEvent.click(screen.getByRole("button", { name: /Reset to source/ }));
    expect(headerLabels()).toEqual(["Amount", "Date", "Merchant"]);
    expect(trigger().getAttribute("aria-label")).toBe("Column layout: Auto (Source order)");
    expect((screen.getByRole("button", { name: /Reset to source/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Auto' in the panel is the same as reset", () => {
    render(<SmartCaptureStudio />);
    extract(MAD);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Date left" }));
    fireEvent.click(screen.getByRole("button", { name: /Auto \(Source order\)/ }));
    expect(headerLabels()).toEqual(["Merchant", "Amount", "Date"]);
  });

  it("the preference survives this review session (Review → Capture → Review) and holds only column names", () => {
    render(<SmartCaptureStudio />);
    extract(DMA);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Amount left" }));
    const saved = sessionStorage.getItem("flowfi.smartCapture.columns.v1")!;
    expect(JSON.parse(saved)).toEqual(["date", "amount", "merchant"]);
    expect(saved).not.toMatch(/AMAZON|1,299|2026/);
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    fireEvent.click(screen.getByRole("button", { name: /Extract transactions/ }));
    expect(headerLabels()).toEqual(["Date", "Amount", "Merchant"]);
  });

  it("a saved order for different columns is ignored (Debit/Credit statement after an Amount one)", () => {
    sessionStorage.setItem("flowfi.smartCapture.columns.v1", JSON.stringify(["amount", "date", "merchant"]));
    render(<SmartCaptureStudio />);
    extract(SPLIT);
    expect(headerLabels()).toEqual(["Date", "Merchant", "Debit", "Credit"]);
  });

  it("a corrupt saved order is ignored", () => {
    sessionStorage.setItem("flowfi.smartCapture.columns.v1", "{not json");
    render(<SmartCaptureStudio />);
    extract(DMA);
    expect(headerLabels()).toEqual(["Date", "Merchant", "Amount"]);
  });
});

describe("desktop and mobile layout contract", () => {
  // jsdom has no layout engine, so the list's measured width is stubbed; real geometry is covered by the browser suite
  // (tests/e2e-qa/suites/smart-capture-columns.mjs). Rule under test: grid + header only where the columns fit.
  /** Makes the review list report `px` as its width to the component's ResizeObserver; returns the restore function. */
  function listWidth(initial: number) {
    const original = globalThis.ResizeObserver;
    let px = initial;
    const observers = new Set<(entries: unknown[], observer: unknown) => void>();
    globalThis.ResizeObserver = class {
      constructor(private cb: (entries: unknown[], observer: unknown) => void) {}
      observe() {
        observers.add(this.cb);
        this.cb([], this);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.cb);
      }
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.dataset?.testid === "review-list" ? px : 0; } });
    const restore = () => {
      globalThis.ResizeObserver = original;
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    };
    /** Resizes the list and notifies the component, as the browser would. */
    restore.resize = (next: number) => {
      px = next;
      act(() => observers.forEach((cb) => cb([], null)));
    };
    return restore;
  }
  const layoutOf = (desc: string) => within(row(desc)).getByRole("button", { name: `Expand ${desc}` }).dataset.layout;

  it("minimum list widths: 570 / 666 / 698px for 3 / 4 columns (readable merchant ≥ 9rem)", async () => {
    const { gridMinWidth } = await import("./review-row");
    expect(gridMinWidth(["date", "merchant", "amount"])).toBe(570);
    expect(gridMinWidth(["merchant", "date", "direction", "amount"])).toBe(666);
    expect(gridMinWidth(["date", "merchant", "debit", "credit"])).toBe(698);
  });

  it("width unknown or wide enough: an aligned grid with a header", () => {
    for (const px of [0, 600, 900]) {
      const restore = listWidth(px);
      try {
        render(<SmartCaptureStudio />);
        extract(ADM);
        const button = within(row("AMAZON")).getByRole("button", { name: "Expand AMAZON" });
        expect(button.dataset.layout).toBe("grid");
        expect(button.className.split(" ")).toEqual(expect.arrayContaining(["grid", "min-w-0", "flex-1"]));
        expect(button.className).toContain("[grid-template-columns:var(--review-cols)]");
        expect(screen.getByTestId("review-columns-header").getAttribute("aria-hidden")).toBe("true");
        const merchant = row("AMAZON").querySelector('[data-col="merchant"]')!;
        expect(merchant.className).toContain("min-w-0");
        expect(merchant.firstElementChild!.className).toContain("truncate");
        expect(merchant.firstElementChild!.getAttribute("title")).toBe("AMAZON");
        expect(screen.getByTestId("review-list").className).not.toMatch(/overflow-x/);
      } finally {
        restore();
        cleanup();
      }
    }
  });

  it("too narrow for the columns (phones; a list squeezed beside the screenshot): the same order flows and wraps — no header, no grid", () => {
    for (const [text, order, px] of [
      [ADM, ["amount", "date", "merchant"], 500],
      [MDCA, ["merchant", "date", "direction", "amount"], 600], // 4 columns need 666
      [SPLIT, ["date", "merchant", "debit", "credit"], 640], // …and 698
    ] as const) {
      const restore = listWidth(px);
      try {
        render(<SmartCaptureStudio />);
        extract(text);
        const button = rowsEls()[0].querySelector("button[aria-expanded]") as HTMLElement;
        expect(button.dataset.layout).toBe("flow");
        expect(button.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0", "flex-1"]));
        expect(button.className).not.toMatch(/(^|\s)grid(\s|$)/);
        expect(screen.queryByTestId("review-columns-header")).toBeNull();
        for (const r of rowsEls()) expect(cols(r)).toEqual(order);
        expect(core()).toEqual(EXPECTED);
        // Customize still works, and still reorders the flow.
        fireEvent.click(trigger());
        fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
        fireEvent.click(screen.getByRole("button", { name: `Move ${{ date: "Date", merchant: "Merchant", amount: "Amount", direction: "Charge/Credit", debit: "Debit", credit: "Credit" }[order[1]]} left` }));
        expect(cols(rowsEls()[0])[0]).toBe(order[1]);
        expect(core()).toEqual(EXPECTED);
      } finally {
        restore();
        cleanup();
      }
    }
  });

  it("flow mode: the empty Debit/Credit cell is hidden and the filled one carries its own label", () => {
    const restore = listWidth(400);
    try {
      render(<SmartCaptureStudio />);
      extract(SPLIT);
      expect(layoutOf("AMAZON")).toBe("flow");
      expect(row("AMAZON").querySelector('[data-col="credit"]')!.className.split(" ")).toContain("hidden");
      expect(row("AMAZON").querySelector('[data-col="debit"]')!.textContent).toMatch(/^Debit₹1,299\.00$/);
    } finally {
      restore();
    }
  });

  it("grid mode: no phone-only label inside the aligned Debit/Credit cells", () => {
    render(<SmartCaptureStudio />);
    extract(SPLIT);
    expect(layoutOf("AMAZON")).toBe("grid");
    expect(row("AMAZON").querySelector('[data-col="debit"]')!.textContent).toBe("₹1,299.00");
    expect(row("AMAZON").querySelector('[data-col="credit"]')!.className.split(" ")).not.toContain("hidden");
  });

  it("crossing the threshold only swaps presentation: ids, values and expanded rows are unchanged", () => {
    const restore = listWidth(900);
    try {
      render(<SmartCaptureStudio />);
      extract(MDCA);
      fireEvent.click(within(rowsEls()[1]).getByRole("button", { name: /^Expand/ }));
      const before = snapshot();
      expect(layoutOf("AMAZON")).toBe("grid");
      expect(screen.queryByTestId("review-columns-header")).not.toBeNull();
      restore.resize(500);
      expect(layoutOf("AMAZON")).toBe("flow");
      expect(screen.queryByTestId("review-columns-header")).toBeNull();
      expect(snapshot()).toEqual(before);
      expect(within(rowsEls()[1]).getByLabelText("Amount")).toBeTruthy(); // still expanded
      for (const r of rowsEls()) expect(cols(r)).toEqual(["merchant", "date", "direction", "amount"]);
      restore.resize(900);
      expect(layoutOf("AMAZON")).toBe("grid");
      expect(snapshot()).toEqual(before);
    } finally {
      restore();
    }
  });
});

describe("expand / collapse, corrections and confirmation still work in every layout", () => {
  it("expands and collapses a row; the details editor and Technical details are intact", () => {
    render(<SmartCaptureStudio />);
    extract(MAD);
    expect(screen.queryAllByLabelText("Amount")).toHaveLength(0);
    expand("AMAZON");
    expect(screen.getByRole("button", { name: "Collapse AMAZON" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(row("AMAZON")).getByLabelText("Amount")).toBeTruthy();
    expect(within(row("AMAZON")).getByText("Technical details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse AMAZON" }));
    expect(screen.queryAllByLabelText("Amount")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    expect(screen.getAllByLabelText("Amount")).toHaveLength(3);
  });

  it("editing a value in an amount-first layout updates that cell and the row id stays", () => {
    render(<SmartCaptureStudio />);
    extract(ADM);
    expand("AMAZON");
    fireEvent.change(within(row("AMAZON")).getByLabelText("Amount"), { target: { value: "1400" } });
    expect(row("AMAZON").dataset.rowId).toBe("r1");
    expect(row("AMAZON").dataset.amount).toBe("1400");
    expect(row("AMAZON").querySelector('[data-col="amount"]')!.textContent).toContain("₹1,400.00");
  });

  it("a missing Cr/Dr is fixed in the details, then Continue unlocks and hands over the same values", () => {
    render(<SmartCaptureStudio />);
    extract("999.00\t07/09/2026\tREFUND MYNTRA\n452.00 Dr\t10/09/2026\tSWIGGY");
    const refund = row("REFUND MYNTRA");
    expect(refund.dataset.status).toBe("fix");
    expect(cont().disabled).toBe(true);
    fireEvent.click(within(refund).getByTestId("row-status"));
    fireEvent.click(within(row("REFUND MYNTRA")).getByRole("button", { name: "Credit" }));
    expect(cont().disabled).toBe(false);
    fireEvent.click(cont());
    expect(getHandoffState().pending!.rows.map((r) => [r.id, r.description, r.amount, r.direction])).toEqual([
      ["r1", "REFUND MYNTRA", 999, "credit"],
      ["r2", "SWIGGY", 452, "debit"],
    ]);
  });

  it("filters, sorting and the select-all checkbox work with moved columns", () => {
    render(<SmartCaptureStudio />);
    extract(ADM);
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(rowsEls().every((r) => r.dataset.status === "excluded")).toBe(true);
    fireEvent.click(screen.getByLabelText("Select all rows"));
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ })); // by date
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ })); // by amount (largest first)
    expect(rowsEls().map((r) => r.dataset.description)).toEqual(["AMAZON", "REFUND MYNTRA", "SWIGGY"]);
    for (const r of rowsEls()) expect(cols(r)).toEqual(["amount", "date", "merchant"]);
    fireEvent.click(screen.getByRole("button", { name: /^To fix/ }));
    expect(screen.queryAllByTestId("review-row").every((r) => r.dataset.status === "fix")).toBe(true);
  });
});

describe("screenshot capture, Amount | Merchant | Date", () => {
  const LINES = [ocrLine(0, ["452.00 Dr", "SWIGGY", "05/09/2026"]), ocrLine(40, ["810.00 Dr", "ZOMATO", "06/09/2026"], { "810.00": 40 }), ocrLine(80, ["99.00 Dr", "CAFE", "07/09/2026"], { "07/09/2026": 40 })];
  const RESULT: OcrResult = { text: LINES.map((l) => l.text).join("\n"), lines: LINES, confidence: 90, durationMs: 1 };

  async function readOcr() {
    recognize.mockResolvedValue(RESULT);
    render(<SmartCaptureStudio />);
    fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
    fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "s.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    await screen.findByTestId("progress-ready");
  }

  it("follows the screenshot's column order; the clean row is Ready immediately, the low-confidence amount/date rows need one check", async () => {
    await readOcr();
    for (const r of rowsEls()) expect(cols(r)).toEqual(["amount", "merchant", "date"]);
    expect(headerLabels()).toEqual(["Amount", "Merchant", "Date"]);
    // SWIGGY has strong, unambiguous evidence on every field — no row-level click needed.
    expect(row("SWIGGY").dataset.status).toBe("ready");
    // Values present but read unclearly: a check (one action), not a correction.
    expect(row("ZOMATO").dataset.status).toBe("check");
    expect(row("CAFE").dataset.status).toBe("check");
    // Nothing is left for a bulk confirm — unclear reads are never bulk-confirmed, so the action isn't offered.
    expect(screen.queryByRole("button", { name: /Confirm all reviewed rows/ })).toBeNull();
  });

  it("the source-screenshot comparison still opens from an expanded row", async () => {
    await readOcr();
    expand("ZOMATO");
    expect(within(row("ZOMATO")).getByTestId("row-zoom")).toBeTruthy();
    expect(screen.getByTestId("ocr-source")).toBeTruthy();
  });

  it("rearranging columns keeps a field-level verification", async () => {
    await readOcr();
    expand("ZOMATO");
    fireEvent.click(within(row("ZOMATO")).getByRole("button", { name: "Confirm ₹810.00" }));
    expect(row("ZOMATO").dataset.status).toBe("ready");
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Date left" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Date left" }));
    for (const r of rowsEls()) expect(cols(r)).toEqual(["date", "amount", "merchant"]);
    expect(row("ZOMATO").dataset.status).toBe("ready");
    expect(within(row("ZOMATO")).queryByRole("button", { name: /^Confirm/ })).toBeNull();
  });
});

describe("financial invariants — layout operations change no transaction data", () => {
  const TEXT = [
    "1,299.00 Dr\t05/09/2026\tAMAZON",
    "452.00 Dr\t10/09/2026\tSWIGGY",
    "452.00 Dr\t10/09/2026\tSWIGGY", // identical purchase → possible_repeat warning
    "999.00 Cr\t07/09/2026\tREFUND MYNTRA",
    "101.00 Dr\t03/10/2026\tRETAIL STORE",
    "101.00 Cr\t03/10/2026\tRETAIL STORE", // opposite-direction pair
  ].join("\n");

  /** Everything a user could have decided or the parser produced, per row, as the review holds it. */
  const reviewState = () =>
    rowsEls().map((r) => ({
      id: r.dataset.rowId,
      date: r.dataset.date,
      amount: r.dataset.amount,
      paise: Math.round(Number(r.dataset.amount) * 100),
      direction: r.dataset.direction,
      status: r.dataset.status,
      included: (within(r).getAllByRole("checkbox")[0] as HTMLElement).getAttribute("aria-checked"),
    }));

  /** Every layout operation the UI offers, in a deliberately messy order. */
  function layoutOperations() {
    const panelButton = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.click(trigger());
    panelButton(/Customize columns/);
    panelButton("Move Merchant left");
    panelButton("Move Merchant left");
    panelButton("Move Amount left");
    panelButton(/Reset to source/);
    panelButton(/Customize columns/);
    panelButton("Move Date right");
    panelButton(/Auto \(Source order\)/);
    panelButton(/Customize columns/);
    panelButton("Move Amount left");
    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    fireEvent.click(screen.getByRole("button", { name: /Collapse all/ }));
    fireEvent.click(within(rowsEls()[1]).getByRole("button", { name: /^Expand/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    fireEvent.click(screen.getByRole("button", { name: /^To check/ }));
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  }

  /** Review → (optional layout operations) → Continue; returns the review state and the Reconciliation handoff payload. */
  function run(withOperations: boolean) {
    cleanup();
    sessionStorage.clear();
    _resetHandoffForTests();
    render(<SmartCaptureStudio />);
    extract(TEXT);
    fireEvent.click(within(row("AMAZON")).getAllByRole("checkbox")[0]); // the user excludes one row
    // Look-alike repeats each need their one look ("separate transaction") before continuing.
    for (const el of rowsEls().filter((r) => r.dataset.status === "check")) {
      const id = el.dataset.rowId!;
      fireEvent.click(within(el).getByRole("button", { name: /^Expand/ }));
      const now = rowsEls().find((r) => r.dataset.rowId === id)!;
      fireEvent.click(within(now).getByTestId("confirm-row"));
      fireEvent.click(within(rowsEls().find((r) => r.dataset.rowId === id)!).getByRole("button", { name: /^Collapse/ }));
    }
    const before = reviewState();
    if (withOperations) layoutOperations();
    const after = reviewState();
    fireEvent.click(cont());
    const pending = getHandoffState().pending!;
    return { before, after, payload: JSON.stringify({ rows: pending.rows, accountId: pending.accountId, priorSessionIds: pending.priorSessionIds, source: pending.source, fingerprint: pending.fingerprint }) };
  }

  it("ids, dates, paise, directions, include state, status — and the whole handoff payload — are identical with and without layout operations", () => {
    const control = run(false);
    const operated = run(true);
    expect(operated.before).toEqual(control.before);
    expect(operated.after.map((r) => ({ ...r }))).toEqual(operated.before); // unchanged by the operations themselves
    expect(operated.payload).toBe(control.payload);
    expect(operated.after.every((r) => Number.isInteger(r.paise))).toBe(true);
    expect(operated.after.find((r) => r.id === "r1")!.included).toBe("false");
  });

  it("duplicate warnings and the opposite-direction note are untouched by the layout", () => {
    const { payload } = run(true);
    const rows = JSON.parse(payload).rows as { id: string; issues: { code: string; message: string }[] }[];
    const repeat = (id: string) => rows.find((r) => r.id === id)!.issues.find((i) => i.code === "possible_repeat");
    expect(repeat("r2")!.message).toMatch(/row 3/);
    expect(repeat("r3")!.message).toMatch(/row 2/);
    expect(repeat("r5")!.message).toMatch(/opposite/);
    expect(repeat("r6")!.message).toMatch(/opposite/);
    expect(repeat("r1")).toBeUndefined();
  });

  it("verification state: bulk-confirmed screenshot rows stay confirmed through every layout operation, and so does the undo", async () => {
    // Confidence held just below READY (but at/above LOW) on purpose: good enough to need only the generic image
    // check, not good enough to skip it — exactly the band "Confirm all reviewed rows" exists for.
    const lines = [
      ocrLine(0, ["452.00 Dr", "SWIGGY", "05/09/2026"], { "452.00": 88 }),
      ocrLine(40, ["810.00 Dr", "ZOMATO", "06/09/2026"], { "810.00": 88 }),
      ocrLine(80, ["99.00 Cr", "REFUND CAFE", "07/09/2026"], { "99.00": 88 }),
    ];
    recognize.mockResolvedValue({ text: lines.map((l) => l.text).join("\n"), lines, confidence: 95, durationMs: 1 });
    render(<SmartCaptureStudio />);
    fireEvent.click(screen.getByRole("tab", { name: /Screenshot/ }));
    fireEvent.change(screen.getByLabelText("Choose screenshot"), { target: { files: [new File(["x"], "s.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Read text/ }));
    await screen.findByTestId("progress-ready");
    fireEvent.click(screen.getByRole("button", { name: /Confirm all reviewed rows/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Confirm 3 rows/ }));
    const verified = reviewState();
    expect(verified.every((r) => r.status === "ready")).toBe(true);
    layoutOperations();
    expect(reviewState()).toEqual(verified);
    expect(screen.getByTestId("progress-ready").textContent).toMatch(/3 \/ 3/);
    fireEvent.click(screen.getByRole("button", { name: /Undo bulk confirmation \(3\)/ }));
    expect(reviewState().every((r) => r.status === "check")).toBe(true);
  });

  it("a row edited by the user keeps the edit when columns move (the edit is data, the column is not)", () => {
    render(<SmartCaptureStudio />);
    extract(TEXT);
    fireEvent.click(within(rowsEls()[1]).getByRole("button", { name: /^Expand/ }));
    fireEvent.change(within(rowsEls()[1]).getByLabelText("Amount"), { target: { value: "460.50" } });
    const edited = reviewState();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: /Customize columns/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move Amount left" }));
    expect(reviewState()).toEqual(edited);
    expect(rowsEls()[1].dataset.amount).toBe("460.5");
  });
});
