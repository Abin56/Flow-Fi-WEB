import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCR_WORKER_OPTIONS, OcrCancelledError, pageToResult, recognizeScreenshot, toOcrProgress, wordsToLineText } from "./tesseract-ocr";
import { displayToNatural, imageWarnings, isUsableCrop, ocrScaleFor, rectFromPoints } from "./image-crop";
import { annotateOcrRows, LOW_CONFIDENCE } from "./ocr-review";
import { parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, canContinue, confirmField, openIssues, toReviewRows } from "./capture-review";
import { ocrLine, ocrText } from "./ocr-test-helpers";

// ---- tesseract.js mock: a controllable fake worker ----
const worker = {
  setParameters: vi.fn(async () => ({})),
  recognize: vi.fn(),
  terminate: vi.fn(async () => ({})),
};
const createWorker = vi.fn();
vi.mock("tesseract.js", () => ({ createWorker: (...args: unknown[]) => createWorker(...args) }));

const PAGE = {
  blocks: [
    {
      paragraphs: [
        {
          lines: [
            { bbox: { x0: 0, y0: 40, x1: 300, y1: 60 }, words: [{ text: "06/09/2026", confidence: 96, bbox: { x0: 0, y0: 40, x1: 90, y1: 60 } }] },
            {
              bbox: { x0: 0, y0: 0, x1: 300, y1: 20 },
              words: [
                { text: "05/09/2026", confidence: 96, bbox: { x0: 0, y0: 0, x1: 90, y1: 20 } },
                { text: "AMAZON", confidence: 93, bbox: { x0: 100, y0: 0, x1: 160, y1: 20 } },
                { text: "1,299.00", confidence: 91, bbox: { x0: 240, y0: 0, x1: 300, y1: 20 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("tesseract OCR wrapper", () => {
  beforeEach(() => {
    createWorker.mockReset();
    worker.recognize.mockReset();
    worker.terminate.mockClear();
    createWorker.mockImplementation(async (_lang: string, _oem: number, opts: { logger: (m: unknown) => void }) => {
      opts.logger({ status: "loading tesseract core", progress: 1 });
      opts.logger({ status: "recognizing text", progress: 0.5 });
      return worker;
    });
    worker.recognize.mockResolvedValue({ data: PAGE });
  });
  afterEach(() => vi.useRealTimers());

  it("initialises an LSTM-only English worker from self-hosted /ocr assets (never a CDN)", async () => {
    await recognizeScreenshot(new Blob());
    const [lang, oem, opts] = createWorker.mock.calls[0];
    expect(lang).toBe("eng");
    expect(oem).toBe(1);
    expect(opts).toMatchObject({ workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang", workerBlobURL: false, gzip: true });
    expect(JSON.stringify(OCR_WORKER_OPTIONS)).not.toMatch(/https?:/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("reports monotonic progress and returns lines sorted top-to-bottom with tabbed columns", async () => {
    const progress: number[] = [];
    const result = await recognizeScreenshot(new Blob(), { onProgress: (p) => progress.push(p.progress) });
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(result.text).toBe("05/09/2026 AMAZON\t1,299.00\n06/09/2026");
    expect(result.lines[0].words.map((w) => w.confidence)).toEqual([96, 93, 91]);
  });

  it("cancels: terminates the worker and throws OcrCancelledError", async () => {
    const controller = new AbortController();
    worker.recognize.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("terminated")), 20)));
    const run = recognizeScreenshot(new Blob(), { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(OcrCancelledError);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("never starts a worker when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(recognizeScreenshot(new Blob(), { signal: controller.signal })).rejects.toBeInstanceOf(OcrCancelledError);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("surfaces asset/engine failures, and a retry succeeds", async () => {
    createWorker.mockRejectedValueOnce(new Error("Failed to fetch /ocr/lang/eng.traineddata.gz"));
    await expect(recognizeScreenshot(new Blob())).rejects.toThrow(/traineddata/);
    await expect(recognizeScreenshot(new Blob())).resolves.toMatchObject({ lines: expect.any(Array) });
  });

  it("maps tesseract statuses to stages", () => {
    expect(toOcrProgress({ status: "loading tesseract core", progress: 0.5 }).stage).toBe("loading");
    expect(toOcrProgress({ status: "loading language traineddata", progress: 1 }).label).toMatch(/English/);
    expect(toOcrProgress({ status: "recognizing text", progress: 1 }).progress).toBe(1);
  });

  it("handles an empty page", () => {
    expect(pageToResult({ blocks: null }, 5)).toMatchObject({ text: "", lines: [], confidence: 0 });
    expect(wordsToLineText([])).toBe("");
  });
});

describe("screenshot cropping geometry", () => {
  it("normalises a drag in any direction and clamps to the image", () => {
    expect(rectFromPoints({ x: 300, y: 200 }, { x: -20, y: 50 }, { width: 250, height: 400 })).toEqual({ x: 0, y: 50, width: 250, height: 150 });
  });

  it("maps a displayed selection to natural pixels", () => {
    expect(displayToNatural({ x: 10, y: 20, width: 100, height: 50 }, { width: 500, height: 250 }, { width: 2000, height: 1000 })).toEqual({ x: 40, y: 80, width: 400, height: 200 });
  });

  it("treats tiny selections as clicks, not crops", () => {
    expect(isUsableCrop({ x: 0, y: 0, width: 10, height: 200 })).toBe(false);
    expect(isUsableCrop({ x: 0, y: 0, width: 200, height: 200 })).toBe(true);
    expect(isUsableCrop(null)).toBe(false);
  });

  it("upscales short crops and caps huge ones", () => {
    expect(ocrScaleFor({ width: 800, height: 300 })).toBe(3);
    expect(ocrScaleFor({ width: 1200, height: 700 })).toBe(2);
    expect(ocrScaleFor({ width: 8000, height: 2000 })).toBe(0.5);
  });

  it("warns about tiny areas and tall uncropped screenshots", () => {
    expect(imageWarnings({ width: 1000, height: 3000 }, null)[0]).toMatch(/tall screenshot/);
    expect(imageWarnings({ width: 1000, height: 1000 }, { x: 0, y: 0, width: 200, height: 40 })[0]).toMatch(/very small/);
  });
});

function ocrRows(lines: ReturnType<typeof ocrLine>[]) {
  const parsed = parsePastedStatement(ocrText(lines), { today: new Date(2026, 9, 26) });
  return toReviewRows(annotateOcrRows(parsed.rows, lines), "ocr");
}

describe("OCR review safety", () => {
  const clean = [
    ocrLine(0, ["05/09/2026", "AMAZON PAY", "1,299.00"]),
    ocrLine(40, ["07/09/2026", "REFUND MYNTRA", "999.00 Cr"]),
    ocrLine(80, ["Total Amount Due", "2,298.00"]),
  ];

  it("recognises dates, amounts and debit/credit from OCR lines and ignores totals", () => {
    const rows = ocrRows(clean);
    expect(rows.map((r) => [r.date?.getDate(), r.amount, r.direction])).toEqual([
      [5, 1299, "debit"],
      [7, 999, "credit"],
    ]);
    expect(rows[1].kind).toBe("refund");
  });

  it("requires explicit confirmation of every OCR row, even at high confidence", () => {
    const rows = ocrRows(clean);
    expect(rows.every((r) => r.source === "ocr" && openIssues(r).some((i) => i.code === "ocr_unverified"))).toBe(true);
    expect(canContinue(rows)).toBe(false);
    // Editing a value is not the same as confirming the row against the image.
    const edited = rows.map((r) => applyRowPatch(r, { description: r.description + " " }));
    expect(canContinue(edited)).toBe(false);
    expect(canContinue(rows.map((r) => applyRowPatch(r, { confirmed: true })))).toBe(true);
  });

  it("says when direction was inferred (no Cr/Dr read) instead of hiding it", () => {
    const row = ocrRows(clean)[0];
    expect(row.issues.find((i) => i.code === "direction_inferred")?.message).toMatch(/shown as a Charge/);
  });

  it("blocks low-confidence amounts until edited or individually confirmed — a row confirm is not enough", () => {
    const [row] = ocrRows([ocrLine(0, ["05/09/2026", "SWIGGY", "4,52.00"], { "4,52.00": LOW_CONFIDENCE - 30 })]);
    expect(row.ocr?.lowConfidenceWords).toEqual(["4,52.00"]);
    const rowConfirmed = applyRowPatch(row, { confirmed: true });
    expect(openIssues(rowConfirmed).map((i) => i.code)).toEqual(["low_confidence_amount"]);
    // "4,52.00" isn't a valid amount, so there's no value to confirm — confirming an empty field does nothing.
    expect(row.amount).toBeNull();
    expect(openIssues(confirmField(rowConfirmed, "amount")).map((i) => i.code)).toEqual(["low_confidence_amount"]);
    // Typing the correct amount resolves a low-confidence read; a valid value can also be confirmed as read.
    const typed = applyRowPatch(rowConfirmed, { amount: 452 });
    expect(openIssues(typed)).toEqual([]);
    expect(openIssues(confirmField(applyRowPatch(row, { amount: 452 }), "amount")).map((i) => i.code)).toEqual(["ocr_unverified", "direction_unclear"]); // no amount was read, so no C/D either
  });

  it("blocks low-confidence dates and Cr/Dr markers separately", () => {
    const [row] = ocrRows([ocrLine(0, ["O5/09/2026", "UBER", "389.50 Cr"], { "O5/09/2026": 40, Cr: 50 })]);
    // "O5" (letter O in the day) is never silently "fixed" to 05 — the line is kept as a row that needs its date.
    expect(row).toMatchObject({ date: null, amount: 389.5, direction: "credit", description: "O5/09/2026 UBER" }); // misread date text stays visible
    expect(openIssues(row).map((i) => i.code)).toContain("no_date");

    const [dated] = ocrRows([ocrLine(0, ["05/09/2026", "UBER", "389.50 Cr"], { "05/09/2026": 40, Cr: 50 })]);
    const codes = openIssues(applyRowPatch(dated, { confirmed: true })).map((i) => i.code);
    expect(codes).toEqual(["low_confidence_date", "low_confidence_direction"]);
    expect(openIssues(applyRowPatch(confirmField(applyRowPatch(dated, { confirmed: true }), "date"), { direction: "credit" }))).toEqual([]);
  });

  it("maps each row to the exact OCR line boxes it came from (for highlighting)", () => {
    const rows = ocrRows(clean);
    expect(rows[0].ocr?.box.y0).toBe(0);
    expect(rows[1].ocr?.box.y0).toBe(40);
  });
});
