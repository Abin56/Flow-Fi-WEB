#!/usr/bin/env node
/**
 * Local-only real-statement parser validation. Reads a PDF from disk, runs the parser's text extraction and
 * extractor registry IN MEMORY, and prints a summary. It never initializes Firebase, never writes to Firestore or
 * Storage, and never imports a transaction — there is no code path here that can.
 *
 *   npm --prefix functions run build
 *   set FLOWFI_PDF_PASSWORD=...            (only if the PDF is encrypted; never pass it as an argument)
 *   node functions/scripts/validate-real-statement.mjs <statement.pdf> [--expect expected.json] [--show-rows] [--redact-out <file.items.json>]
 *
 * Default output is aggregate only (counts, totals, flag tallies) — no merchant text, no card/account numbers.
 * `--show-rows` adds date / amount / direction / confidence / flags per row (still no merchant text).
 * `--expect` compares against figures YOU read off the PDF (format: see docs/real-statement-validation.md).
 * `--redact-out` writes a layout-preserving, identifier-stripped snapshot for use as a regression fixture, after
 * proving the redacted copy parses to the same rows. Review it by eye before committing.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(here, "..", "lib");

if (!existsSync(resolve(libDir, "tools", "statement-validation.js"))) {
  console.error("functions/lib is missing. Run: npm --prefix functions run build");
  process.exit(2);
}

const { PdfjsDocumentProvider } = require(resolve(libDir, "pdf", "pdfjs-document-provider.js"));
const { summarizeExtraction, compareWithExpected, redactPages, redactionPreservesParse, findResidualIdentifiers } = require(
  resolve(libDir, "tools", "statement-validation.js"),
);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pdfPath = args.find((a) => !a.startsWith("--") && a !== option("--expect") && a !== option("--redact-out"));

if (!pdfPath) {
  console.error("usage: node validate-real-statement.mjs <statement.pdf> [--expect expected.json] [--show-rows] [--redact-out <file.items.json>]");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(pdfPath));
let handle;
try {
  handle = await new PdfjsDocumentProvider().open(bytes, process.env.FLOWFI_PDF_PASSWORD);
} catch (error) {
  console.error(`Could not open the PDF: ${error?.code ?? "error"} — ${error?.message ?? ""}`);
  process.exit(1);
}
const pages = await handle.getAllPageText();
await handle.destroy();

const summary = summarizeExtraction(pages);
const printable = { ...summary, rows: undefined };
console.log("== Extraction summary (nothing was imported or written) ==");
console.log(JSON.stringify(printable, null, 2));

if (!summary.usableTextLayer) console.log("\nNo usable text layer: this looks like a scanned PDF. Parsing is not possible without OCR.");
else if (!summary.extractor) console.log("\nNo extractor recognized a transaction table in this PDF.");

if (flag("--show-rows")) {
  console.log("\n== Rows (date | amount | direction | confidence | direction basis | flags) ==");
  for (const r of summary.rows) {
    console.log(`p${r.page} ${r.date} ${r.amount.toFixed(2).padStart(12)} ${r.direction.padEnd(6)} ${r.confidence.toFixed(2)} ${(r.directionBasis ?? "-").padEnd(8)} ${r.flags.join(",") || "-"}`);
  }
}

let exitCode = 0;
if (summary.flaggedRowCount > 0) console.log(`\n${summary.flaggedRowCount} row(s) are flagged for manual review — check them against the PDF.`);

const expectPath = option("--expect");
if (expectPath) {
  const expected = JSON.parse(readFileSync(expectPath, "utf8"));
  const report = compareWithExpected(summary, expected);
  console.log("\n== Comparison with the figures you read off the PDF ==");
  console.log(report.pass ? "PASS — counts, totals and rows all match." : "FAIL");
  for (const p of report.problems) console.log(` - ${p}`);
  for (const m of report.missing) console.log(`   missing : ${m.date} ${m.amount.toFixed(2)} ${m.direction}`);
  for (const e of report.extra) console.log(`   extra   : ${e.date} ${e.amount.toFixed(2)} ${e.direction}${e.flags.length ? `  [flagged: ${e.flags.join(",")}]` : "  [NOT flagged]"}`);
  for (const d of report.directionMismatches) console.log(`   direction: ${d.date} ${d.amount.toFixed(2)} expected ${d.expected}, got ${d.actual} (basis: ${d.basis ?? "n/a"})`);
  if (!report.pass) exitCode = 1;
}

const redactOut = option("--redact-out");
if (redactOut) {
  const target = resolve(redactOut);
  if (existsSync(target)) {
    console.error(`\nRefusing to overwrite ${target}`);
    process.exit(2);
  }
  const redacted = redactPages(pages);
  const parity = redactionPreservesParse(pages, redacted);
  const residual = findResidualIdentifiers(redacted);
  console.log(`\n== Redaction ==\nparses identically after redaction: ${parity.same} (${parity.originalRows} rows -> ${parity.redactedRows} rows)`);
  if (residual.length > 0) console.log(`possible leftover identifiers (${residual.length}):\n - ${[...new Set(residual)].join("\n - ")}`);
  if (!parity.same) {
    console.error("Not written: the redacted copy does not parse like the original.");
    exitCode = 1;
  } else {
    writeFileSync(target, JSON.stringify(redacted, null, 1));
    console.log(`written: ${target}\nReview it by eye (names, addresses, numbers) before committing; never commit the PDF itself.`);
  }
}

process.exit(exitCode);
