/**
 * Smart Capture's screenshot OCR — tesseract.js running in a Web Worker,
 * with every asset (worker, WASM engine, English model) served from this
 * app's own /ocr/ folder (see scripts/copy-ocr-assets.mjs). The library
 * itself is imported lazily, so nothing OCR-related is downloaded until the
 * user actually asks to read a screenshot. The image never leaves the
 * browser.
 *
 * Returns positioned lines with per-word confidence so review can
 * highlight a row's source region and block low-confidence dates/amounts.
 * Confidence is a hint, never proof: every OCR row still needs the user's
 * explicit confirmation (see ocr-review.ts).
 */

export const OCR_ASSET_BASE = "/ocr";

export const OCR_WORKER_OPTIONS = {
  workerPath: `${OCR_ASSET_BASE}/worker.min.js`,
  corePath: `${OCR_ASSET_BASE}/core`,
  langPath: `${OCR_ASSET_BASE}/lang`,
  // Load the worker script directly from our origin instead of wrapping it in a blob that importScripts a URL.
  workerBlobURL: false,
  gzip: true,
} as const;

/** OEM 1 = LSTM only — matches the fast `best_int` model and the `*-lstm.wasm.js` engines we host. */
const OEM_LSTM_ONLY = 1;

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  /** 0–100, as reported by Tesseract. */
  confidence: number;
  bbox: OcrBox;
}

export interface OcrLine {
  text: string;
  bbox: OcrBox;
  words: OcrWord[];
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  /** Mean word confidence across the page, 0–100. */
  confidence: number;
  durationMs: number;
}

export type OcrStage = "loading" | "recognizing";

export interface OcrProgress {
  stage: OcrStage;
  /** 0–1 within the overall job (loading ≈ first 40%, recognizing the rest). */
  progress: number;
  label: string;
}

export class OcrCancelledError extends Error {
  constructor() {
    super("Text reading was cancelled.");
    this.name = "OcrCancelledError";
  }
}

interface TesseractLoggerMessage {
  status: string;
  progress: number;
}

/** Maps tesseract.js's status strings onto one monotonic progress bar. */
export function toOcrProgress(message: TesseractLoggerMessage): OcrProgress {
  const p = Math.max(0, Math.min(1, message.progress || 0));
  if (message.status === "recognizing text") return { stage: "recognizing", progress: 0.4 + p * 0.6, label: "Reading text" };
  if (message.status.includes("core")) return { stage: "loading", progress: p * 0.2, label: "Loading OCR engine" };
  if (message.status.includes("language") || message.status.includes("traineddata")) return { stage: "loading", progress: 0.2 + p * 0.15, label: "Loading English model" };
  return { stage: "loading", progress: 0.35 + p * 0.05, label: "Preparing" };
}

/**
 * Joins a line's words, turning a wide horizontal gap into a tab so the statement parser sees columns
 * (description vs amount). Gap threshold scales with the line's own height.
 */
export function wordsToLineText(words: OcrWord[]): string {
  if (words.length === 0) return "";
  const ordered = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const height = Math.max(1, ...ordered.map((w) => w.bbox.y1 - w.bbox.y0));
  let text = ordered[0].text;
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].bbox.x0 - ordered[i - 1].bbox.x1;
    text += (gap > height * 1.5 ? "\t" : " ") + ordered[i].text;
  }
  return text;
}

interface RawLine {
  words: { text: string; confidence: number; bbox: OcrBox }[];
  bbox: OcrBox;
}

interface RawPage {
  blocks: { paragraphs: { lines: RawLine[] }[] }[] | null;
}

export function pageToResult(page: RawPage, durationMs: number): OcrResult {
  const lines: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words = line.words.filter((w) => w.text.trim() !== "").map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
        if (words.length === 0) continue;
        lines.push({ text: wordsToLineText(words), bbox: line.bbox, words });
      }
    }
  }
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const allWords = lines.flatMap((l) => l.words);
  const confidence = allWords.length ? allWords.reduce((s, w) => s + w.confidence, 0) / allWords.length : 0;
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence, durationMs };
}

export async function recognizeScreenshot(
  image: Blob | HTMLCanvasElement,
  { onProgress, signal }: { onProgress?: (p: OcrProgress) => void; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  if (signal?.aborted) throw new OcrCancelledError();
  const started = performance.now();
  const { createWorker } = await import("tesseract.js");
  if (signal?.aborted) throw new OcrCancelledError();

  let cancelled = false;
  const worker = await createWorker("eng", OEM_LSTM_ONLY, {
    ...OCR_WORKER_OPTIONS,
    logger: (m: TesseractLoggerMessage) => {
      if (!cancelled) onProgress?.(toOcrProgress(m));
    },
  });

  const onAbort = () => {
    cancelled = true;
    void worker.terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) throw new OcrCancelledError();
    // PSM 6: one uniform block of text — a cropped transaction table. Keep spacing so columns survive.
    await worker.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1" });
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
    if (cancelled) throw new OcrCancelledError();
    return pageToResult(data as unknown as RawPage, performance.now() - started);
  } catch (error) {
    if (cancelled) throw new OcrCancelledError();
    // tesseract.js rejects with a bare string/undefined when the worker script itself fails to load.
    throw error instanceof Error ? error : new Error(typeof error === "string" && error ? error : "the OCR engine couldn't start (its files didn't load)");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!cancelled) await worker.terminate().catch(() => undefined);
  }
}
