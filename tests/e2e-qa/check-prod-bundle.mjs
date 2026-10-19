/**
 * npm run test:qa-bundle [-- --full]
 *
 * Proves the QA tooling does not ship: builds the app the way production does (in a temporary copy, so your
 * checkout and any running dev server are untouched) — but with the worst-case QA environment variables set,
 * including a sentinel "password" — then searches the whole build output for QA code and credentials and checks
 * that /dev/qa is a 404 on a production server.
 *
 *   --full   copy node_modules too and build with Turbopack (slower; default junctions node_modules and uses webpack)
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const full = process.argv.includes("--full");
const port = Number(process.env.QA_BUNDLE_PORT ?? 3220);
const sentinel = `qa-sentinel-${randomBytes(12).toString("hex")}`;

/** Strings that must not appear anywhere in a production build. */
const FORBIDDEN_EVERYWHERE = [sentinel, "FlowFi Manual QA", "qa.tester@flowfi-qa.test", "Emulator verified", "QA portal blocked", "__qa", "NEXT_PUBLIC_QA_USER_PASSWORD", "dev-qa/components"];
/** Inert emulator-wiring names: must be absent from the CLIENT bundle; tolerated (unreachable: NODE_ENV gate) in the server output. */
const FORBIDDEN_IN_CLIENT = ["NEXT_PUBLIC_QA_EMULATOR", "NEXT_PUBLIC_QA_AUTH_PORT", "connectAuthEmulator", "qaEmulatorRequested"];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const isText = (p) => /\.(js|mjs|cjs|json|html|txt|css|rsc|map|body|meta)$/.test(p);

function run(command, args, options) {
  return spawnSync(command, args, { ...options, shell: true, encoding: "utf8", windowsHide: true });
}

let tmp = null;
let server = null;
function cleanup() {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-server.pid, "SIGTERM");
  }
  if (!tmp) return;
  const link = path.join(tmp, "app", "node_modules");
  try {
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link);
      }
    }
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) return; // never recurse through a link we couldn't remove
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    console.warn(`Couldn't remove ${tmp}: ${e.message}`);
  }
}

async function main() {
  const failures = [];
  tmp = mkdtempSync(path.join(os.tmpdir(), "flowfi-qa-bundle-"));
  const dest = path.join(tmp, "app");
  console.log(`Copying the checkout to ${dest} (no .env*, no git, no build output) …`);
  const skip = new Set([".git", ".next", "node_modules", ".results", "qa-screenshots"]);
  cpSync(repoRoot, dest, { recursive: true, filter: (src) => !(skip.has(path.basename(src)) && !(full && path.basename(src) === "node_modules")) && !/^\.env(\..+)?$/.test(path.basename(src)) });
  if (!full) symlinkSync(path.join(repoRoot, "node_modules"), path.join(dest, "node_modules"), "junction");
  else cpSync(path.join(repoRoot, "node_modules"), path.join(dest, "node_modules"), { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "production",
    // Worst case: every QA flag set at build time.
    NEXT_PUBLIC_QA_EMULATOR: "1",
    NEXT_PUBLIC_QA_USER_PASSWORD: sentinel,
    NEXT_PUBLIC_QA_AUTH_PORT: "9399",
    NEXT_PUBLIC_QA_FIRESTORE_PORT: "8380",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-flowfi-bundle-check",
    NEXT_PUBLIC_FIREBASE_API_KEY: "fake",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "localhost",
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "x",
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "0",
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:x",
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: "",
  };
  delete env.NODE_ENV; // next build sets production itself; leaving it unset avoids a non-standard NODE_ENV warning
  console.log(`Building (${full ? "Turbopack, full copy" : "webpack, junctioned node_modules"}) — this takes a few minutes …`);
  const build = run("npx", ["next", "build", ...(full ? [] : ["--webpack"])], { cwd: dest, env });
  if (build.status !== 0) {
    console.error(`${build.stdout?.slice(-1500)}\n${build.stderr?.slice(-1500)}`);
    throw new Error("next build failed");
  }
  const routes = /\/dev\/qa/.test(build.stdout ?? "");
  console.log(`Build ok. (/dev/qa listed in the route table: ${routes ? "yes — as a static 404 shell; verified below" : "no"})`);

  const buildDir = path.join(dest, ".next");
  const traceNotes = [];
  const hits = new Map(); // pattern -> files
  const contexts = new Map(); // pattern -> first match with surrounding text, for diagnosis
  let scanned = 0;
  for (const file of walk(buildDir)) {
    if (!isText(file) || statSync(file).size > 40_000_000) continue;
    const rel = path.relative(buildDir, file).split(path.sep).join("/");
    if (rel.startsWith("cache/") || rel.startsWith("dev/")) continue;
    const text = readFileSync(file, "utf8");
    scanned++;
    const client = rel.startsWith("static/");
    for (const pattern of [...FORBIDDEN_EVERYWHERE, ...(client ? FORBIDDEN_IN_CLIENT : [])]) {
      const at = text.indexOf(pattern);
      // A file-trace manifest (*.nft.json) is a list of source PATHS Next may package, not built code. The portal's
      // path appearing there is reported as a note (below) — every string/credential check stays strict.
      if (at >= 0 && pattern === "dev-qa/components" && rel.endsWith(".nft.json")) {
        traceNotes.push(rel);
        continue;
      }
      if (at >= 0) {
        hits.set(pattern, [...(hits.get(pattern) ?? []), rel]);
        if (!contexts.has(pattern)) contexts.set(pattern, `${rel}: …${text.slice(Math.max(0, at - 80), at + pattern.length + 80).replace(/\s+/g, " ")}…`);
      }
    }
  }
  console.log(`Scanned ${scanned} build files.`);
  if (traceNotes.length > 0) {
    console.log(`NOTE: ${traceNotes.join(", ")} lists the portal's source PATH (Next's file-trace manifest). No portal code, text or credential is in any built file; the path is only relevant if a deploy step packages traced source files.`);
  }
  for (const [pattern, files] of hits) {
    const label = pattern === sentinel ? "<the per-run sentinel credential>" : pattern;
    failures.push(`"${label}" found in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3})` : ""}${pattern === sentinel ? "" : `\n      ${contexts.get(pattern)}`}`);
  }

  console.log(`Starting the production server on :${port} …`);
  server = spawn("npx", ["next", "start", "-p", String(port)], { cwd: dest, env, shell: true, windowsHide: true, stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ready = await fetch(`http://localhost:${port}/dashboard`, { redirect: "manual" }).then(() => true, () => false);
  }
  if (!ready) failures.push("production server did not start");
  else {
    const qa = await fetch(`http://localhost:${port}/dev/qa`, { redirect: "manual" });
    const missing = await fetch(`http://localhost:${port}/this-route-does-not-exist`, { redirect: "manual" });
    if (qa.status !== 404) failures.push(`GET /dev/qa returned ${qa.status}, expected 404`);
    console.log(`GET /dev/qa -> ${qa.status} (an unknown route -> ${missing.status})`);
    const html = await qa.text();
    for (const p of ["FlowFi Manual QA", "Sign in as QA user"]) if (html.includes(p)) failures.push(`/dev/qa HTML contains "${p}"`);
  }

  console.log(failures.length === 0 ? "\nPASS — no QA code, credentials or emulator wiring in the production client bundle; /dev/qa is a 404." : `\nFAIL\n  - ${failures.join("\n  - ")}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
