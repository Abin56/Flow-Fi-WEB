#!/usr/bin/env node
/**
 * Copies Smart Capture's self-hosted OCR assets from node_modules into public/ocr/, so the browser never fetches
 * them from a CDN (tesseract.js defaults to jsDelivr). Runs before `dev` and `build`; idempotent.
 *
 *   public/ocr/worker.min.js                     tesseract.js worker
 *   public/ocr/core/tesseract-core-*-lstm.wasm.js  LSTM-only engine (relaxed-SIMD, SIMD, plain fallback)
 *   public/ocr/lang/eng.traineddata.gz           fast English model (4.0.0_best_int)
 *
 * Only the LSTM variants are copied because Smart Capture runs Tesseract with OEM 1 (LSTM only); the browser
 * downloads exactly one of the three engine files, picked by tesseract.js's own feature detection.
 */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "ocr");

export const OCR_ASSETS = [
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "core/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "core/tesseract-core-lstm.wasm.js"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "lang/eng.traineddata.gz"],
];

for (const [from, to] of OCR_ASSETS) {
  const src = join(nm, from);
  const dest = join(out, to);
  mkdirSync(dirname(dest), { recursive: true });
  let fresh = false;
  try {
    const a = statSync(src);
    const b = statSync(dest);
    fresh = a.size === b.size && a.mtimeMs <= b.mtimeMs;
  } catch {
    // dest missing — copy below (a missing src throws from copyFileSync with a clear message)
  }
  if (!fresh) copyFileSync(src, dest);
}
console.log(`OCR assets ready in public/ocr (${OCR_ASSETS.length} files)`);
