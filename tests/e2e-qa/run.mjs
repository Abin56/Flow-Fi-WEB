/**
 * One command for the browser QA suite:   npm run test:e2e-qa [-- <scenario-id-prefix>]
 *
 * Starts throw-away Auth + Firestore emulators and a local dev server — all on localhost, on ports that differ
 * from the defaults — runs the scenarios in real Chrome, then stops everything it started. It refuses to run
 * (fail closed) if the configuration could reach anything but the local emulator. See README.md.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLocalEmulatorOnly, BASE_URL, HOST, newRunPassword, PORTS, PROJECT_ID } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const argv = process.argv.slice(2);
const filter = argv.find((a) => !a.startsWith("-")) ?? "";
/** --copy: run the app from a temporary copy of the checkout (use when you already have `next dev` running here). --copy=full also copies node_modules. */
const copyMode = argv.find((a) => a === "--copy" || a === "--copy=full") ?? null;
const children = [];
let tmpDir = null;

function fail(message) {
  console.error(`\nQA suite: ${message}`);
  process.exitCode = 1;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

async function waitFor(label, probe, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function start(label, command, args, options) {
  const child = spawn(command, args, { ...options, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (d) => {
    output = (output + d).slice(-6000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  children.push({ label, child, output: () => output });
  return children.at(-1);
}

/** Removes the temp dir. A junctioned node_modules is unlinked FIRST so recursion can never reach the real one. */
function cleanupTmp() {
  if (!tmpDir) return;
  try {
    const link = path.join(tmpDir, "app", "node_modules");
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link);
      }
    }
    if (existsSync(path.join(tmpDir, "app", "node_modules")) && lstatSync(path.join(tmpDir, "app", "node_modules")).isSymbolicLink()) return; // never recurse through a link we couldn't remove
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    console.warn(`Couldn't remove ${tmpDir}: ${e.message}`);
  }
}

function stopAll() {
  for (const { child } of children) {
    if (child.exitCode != null || child.pid == null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  }
}

/** A throw-away copy of the checkout WITHOUT .env* files, git history, build output or this suite's results. */
function makeCheckoutCopy(tmp, full) {
  const dest = path.join(tmp, "app");
  const skip = new Set([".git", ".next", "node_modules", ".results", "qa-screenshots"]);
  console.log(`Copying the checkout to ${dest} (${full ? "with" : "without"} node_modules) …`);
  cpSync(repoRoot, dest, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (skip.has(name) && !(name === "node_modules" && full)) return false;
      if (/^\.env(\..+)?$/.test(name)) return false; // no real Firebase config can come along
      return true;
    },
  });
  if (!full) symlinkSync(path.join(repoRoot, "node_modules"), path.join(dest, "node_modules"), "junction");
  else cpSync(path.join(repoRoot, "node_modules"), path.join(dest, "node_modules"), { recursive: true });
  return dest;
}

/** Names (never values) of NEXT_PUBLIC_FIREBASE_* keys defined in the repo's env files. Each must be overridden below. */
function firebaseEnvKeysInRepo() {
  const keys = new Set();
  for (const f of readdirSync(repoRoot).filter((n) => /^\.env(\..+)?$/.test(n))) {
    for (const line of readFileSync(path.join(repoRoot, f), "utf8").split(/\r?\n/)) {
      const m = /^\s*(NEXT_PUBLIC_FIREBASE_[A-Z_]+)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

async function main() {
  assertLocalEmulatorOnly();

  const password = newRunPassword();
  const appEnv = {
    ...process.env,
    NEXT_PUBLIC_QA_EMULATOR: "1",
    NEXT_PUBLIC_QA_USER_PASSWORD: password,
    NEXT_PUBLIC_QA_AUTH_PORT: String(PORTS.auth),
    NEXT_PUBLIC_QA_FIRESTORE_PORT: String(PORTS.firestore),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_API_KEY: "fake-qa-key",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "localhost",
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${PROJECT_ID}.appspot.com`,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "0",
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:qa",
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: "",
  };
  // Fail closed: a Firebase setting in .env.local that this launcher doesn't override would reach the dev server.
  const unoverridden = (copyMode ? [] : [...firebaseEnvKeysInRepo()]).filter((k) => !(k in appEnv));
  if (unoverridden.length > 0) return fail(`repo env files define ${unoverridden.join(", ")} which this launcher does not override — refusing to start.`);

  for (const [name, port] of Object.entries({ app: PORTS.app, firestore: PORTS.firestore, auth: PORTS.auth, hub: PORTS.hub, logging: PORTS.logging, firestoreWs: PORTS.firestoreWs })) {
    if (!(await portFree(port))) return fail(`port ${port} (${name}) is already in use — the suite never shares ports with running services. Free it or set QA_*_PORT (see README).`);
  }

  // 1) Emulators — generated config in a temp dir; rules come from the repo (read only).
  const tmp = mkdtempSync(path.join(os.tmpdir(), "flowfi-qa-"));
  tmpDir = tmp;
  const config = {
    firestore: { rules: path.join(repoRoot, "firestore.rules") },
    emulators: {
      singleProjectMode: true,
      hub: { port: PORTS.hub, host: HOST },
      logging: { port: PORTS.logging, host: HOST },
      auth: { port: PORTS.auth, host: HOST },
      firestore: { port: PORTS.firestore, host: HOST, websocket_port: PORTS.firestoreWs },
      ui: { enabled: false },
    },
  };
  const configPath = path.join(tmp, "firebase.qa.json");
  writeFileSync(configPath, JSON.stringify(config));
  console.log(`Starting Auth + Firestore emulators (${PROJECT_ID}) on ${HOST}:${PORTS.auth} / ${HOST}:${PORTS.firestore} …`);
  const emu = start("emulators", "npx", ["firebase", "emulators:start", "--only", "auth,firestore", "--project", PROJECT_ID, "--config", `"${configPath}"`], { cwd: tmp, env: process.env });
  const probe = (port) => () => fetch(`http://${HOST}:${port}/`).then((r) => r.ok);
  try {
    await waitFor("the Firestore emulator", probe(PORTS.firestore), 120_000);
    await waitFor("the Auth emulator", probe(PORTS.auth), 60_000);
  } catch (e) {
    return fail(`${e.message}\n${emu.output().slice(-1200)}\n(Java is required for the Firestore emulator.)`);
  }

  // 2) App — a normal dev server in this checkout, env-overridden to the emulators (process env beats .env.local).
  const appDir = copyMode ? makeCheckoutCopy(tmp, copyMode === "--copy=full") : repoRoot;
  console.log(`Starting the dev server on ${BASE_URL} (${copyMode ? "temporary copy" : "this checkout"}) …`);
  // A junctioned node_modules lies outside the copy's root, which Turbopack rejects — webpack follows it fine.
  const devArgs = ["next", "dev", "-p", String(PORTS.app), ...(copyMode === "--copy" ? ["--webpack"] : [])];
  const app = start("next dev", "npx", devArgs, { cwd: appDir, env: appEnv });
  try {
    await waitFor("the dev server", () => fetch(`${BASE_URL}/dev/qa`).then((r) => r.ok), 180_000);
  } catch (e) {
    const out = app.output();
    return fail(`${e.message}${/already running/i.test(out) ? "\nAnother `next dev` is running in this directory. Stop it, or re-run with `npm run test:e2e-qa -- --copy` to use a temporary copy." : ""}\n${out.slice(-800)}`);
  }
  console.log("Warming routes (first compile is slow) …");
  for (const route of ["/transactions", "/loans-installments", "/accounts", "/credit-cards", "/bills", "/people", "/dashboard", "/month-cycle"]) {
    await fetch(`${BASE_URL}${route}`, { signal: AbortSignal.timeout(240_000) }).catch(() => {});
  }

  // 3) Scenarios
  const core = await import(pathToFileURL(path.join(here, "lib", "core.mjs")).href);
  const harness = await import(pathToFileURL(path.join(here, "lib", "harness.mjs")).href);
  const suiteDir = path.join(here, "suites");
  for (const f of readdirSync(suiteDir).filter((n) => n.endsWith(".mjs") && n !== "safety.mjs").sort()) await import(pathToFileURL(path.join(suiteDir, f)).href);
  const ran = (await core.runAll(filter).catch((e) => (filter.startsWith("safety") ? 0 : Promise.reject(e)))) ?? 0;
  if (!filter || filter === "all" || filter.startsWith("safety")) {
    const { runSafetyChecks } = await import(pathToFileURL(path.join(suiteDir, "safety.mjs")).href);
    await runSafetyChecks();
    core.writeResults();
  }

  const all = Object.entries(core.results);
  const failed = all.filter(([, r]) => r.verdict !== "pass");
  console.log(`\n──────── QA summary ────────\n${all.length - failed.length} passed, ${failed.length} failed (${ran} scenarios + safety checks)`);
  for (const [id, r] of failed) console.log(`  FAIL ${id}: ${r.checks.filter((c) => !c.ok).map((c) => c.d).join("; ")}`);
  const findings = all.flatMap(([id, r]) => r.checks.filter((c) => c.finding).map((c) => `${id}: ${c.d}`));
  if (findings.length > 0) console.log(`Documented findings observed (do not fail the run):\n  ${findings.join("\n  ")}`);
  if (harness.egressViolations.length > 0) {
    console.log(`  FAIL unexpected non-local requests were attempted (and blocked):\n    ${harness.egressViolations.join("\n    ")}`);
    process.exitCode = 1;
  }
  if (failed.length > 0) process.exitCode = 1;
  console.log(`Results + screenshots: ${path.relative(repoRoot, harness.RESULTS_DIR)}${existsSync(harness.RESULTS_DIR) ? "" : " (not written)"}`);
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

main()
  .catch((e) => fail(e.message))
  .finally(async () => {
    stopAll();
    await new Promise((r) => setTimeout(r, 1500)); // let the killed servers release their files
    cleanupTmp();
  });
