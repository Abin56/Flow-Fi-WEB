#!/usr/bin/env node
/**
 * FlowFi Android sideload release tooling (docs/sms-sync-pairing.md → "Android APK distribution").
 *
 *   node scripts/android-release.mjs prepare <path-to-signed-release.apk>   validate + copy into release/android/
 *   node scripts/android-release.mjs stage                                  copy release/android/* into out/downloads/ (runs after `next build`)
 *   node scripts/android-release.mjs verify-remote [origin]                 download the live APK and compare it with the live manifest
 *
 * Why `stage` exists: every Firebase Hosting deploy replaces the WHOLE site with the contents of `out/`. An APK that is
 * not copied into `out/` again is silently removed by the next ordinary web deploy, so `npm run build` stages it.
 *
 * `prepare` refuses (and publishes nothing) unless the APK is: signed with a non-debug certificate (APK Signature
 * Scheme v2+), package `com.flowfi.app`, built with READ_SMS (the sideload flavor), and — once a first release
 * was recorded — signed by the SAME certificate as before (Android refuses in-place updates across keys). It never reads
 * keystore files or passwords; it only inspects the finished APK.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PACKAGE = "com.flowfi.app";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = join(ROOT, "release", "android");
const OUT_DIR = join(ROOT, "out", "downloads");
const MANIFEST = "flowfi-android.json";
const LATEST = "flowfi-android.apk";
const SIGNER_RECORD = "signer.sha256";
const DEFAULT_ORIGIN = "https://flowfi.web.app";

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Names of the release files in `dir` whose SHA-256 differs from `manifest.sha256` — the versioned APK AND the
 * `flowfi-android.apk` alias, so the "latest" download can never be a different build from the one the manifest names.
 */
export function releaseHashMismatches(dir, manifest) {
  return [manifest.file, LATEST].filter((name) => sha256File(join(dir, name)) !== manifest.sha256);
}

function sdkTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
  const buildTools = join(sdk, "build-tools");
  if (!existsSync(buildTools)) fail(`Android SDK build-tools not found under ${sdk}. Set ANDROID_HOME.`);
  const versions = readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    for (const ext of process.platform === "win32" ? [".bat", ".exe"] : [""]) {
      const candidate = join(buildTools, v, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return fail(`${name} not found in ${buildTools}.`);
}

const run = (file, args) => execFileSync(file, args, { encoding: "utf8", shell: process.platform === "win32" && file.endsWith(".bat") });

/** Parses `apksigner verify --print-certs -v` output. Exported for tests. */
export function parseSignerOutput(text) {
  const verified = /Verifies/.test(text);
  const v2plus = /Verified using v2 scheme \(APK Signature Scheme v2\): true|Verified using v3 scheme[^:]*: true/.test(text);
  const dn = /Signer #1 certificate DN: (.+)/.exec(text)?.[1]?.trim() ?? "";
  const sha256 = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/i.exec(text)?.[1]?.toLowerCase() ?? "";
  return { verified, v2plus, dn, sha256, isDebug: /Android Debug/i.test(dn) };
}

/** Parses `aapt dump badging` output. Exported for tests. */
export function parseBadging(text) {
  const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(text);
  return {
    packageName: pkg?.[1] ?? "",
    versionCode: pkg ? Number(pkg[2]) : 0,
    versionName: pkg?.[3] ?? "",
    readSms: /uses-permission: name='android\.permission\.READ_SMS'/.test(text),
  };
}

function prepare(apkArg) {
  if (!apkArg) fail("Usage: android-release.mjs prepare <path-to-signed-release.apk>");
  const apk = resolve(apkArg);
  if (!existsSync(apk) || !statSync(apk).isFile()) fail(`APK not found: ${apk}`);

  let signerOut;
  try {
    signerOut = run(sdkTool("apksigner"), ["verify", "--print-certs", "-v", apk]);
  } catch (e) {
    fail(`apksigner could not verify this APK (unsigned or tampered): ${String(e.stderr ?? e.message).split("\n")[0]}`);
  }
  const signer = parseSignerOutput(signerOut);
  if (!signer.verified || !signer.v2plus) fail("The APK signature is not valid under APK Signature Scheme v2 or later.");
  if (signer.isDebug) fail("This APK is signed with the Android DEBUG certificate. Public downloads must use the release key. Nothing was published.");
  if (!signer.sha256) fail("Could not read the signing certificate fingerprint.");

  const badging = parseBadging(run(sdkTool("aapt"), ["dump", "badging", apk]));
  if (badging.packageName !== EXPECTED_PACKAGE) fail(`Package is "${badging.packageName}", expected "${EXPECTED_PACKAGE}". The package id must not change silently.`);
  if (!badging.readSms) fail("READ_SMS is missing — this looks like the play flavor. Build with: flutter build apk --release --flavor sideload");
  if (!badging.versionName || badging.versionCode < 1) fail("Could not read the app version.");

  mkdirSync(RELEASE_DIR, { recursive: true });
  const recordFile = join(RELEASE_DIR, SIGNER_RECORD);
  if (existsSync(recordFile)) {
    const recorded = readFileSync(recordFile, "utf8").trim();
    if (recorded !== signer.sha256) fail(`Signing certificate differs from the one recorded for earlier releases (${recorded.slice(0, 16)}… vs ${signer.sha256.slice(0, 16)}…). Android would refuse to update installed apps. Nothing was published.`);
  }
  const manifestFile = join(RELEASE_DIR, MANIFEST);
  if (existsSync(manifestFile)) {
    const previous = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (badging.versionCode <= previous.versionCode) fail(`versionCode ${badging.versionCode} is not higher than the published ${previous.versionCode}. Bump the version in pubspec.yaml.`);
  }

  const safeVersion = badging.versionName.replace(/[^0-9A-Za-z.+_-]/g, "_");
  const versionedName = `flowfi-android-${safeVersion}.apk`;
  const digest = sha256File(apk);
  copyFileSync(apk, join(RELEASE_DIR, versionedName));
  copyFileSync(apk, join(RELEASE_DIR, LATEST));
  writeFileSync(recordFile, `${signer.sha256}\n`);
  const manifest = {
    version: badging.versionName,
    versionCode: badging.versionCode,
    sha256: digest,
    sizeBytes: statSync(apk).size,
    file: versionedName,
    packageName: EXPECTED_PACKAGE,
    signerSha256: signer.sha256,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`✓ Prepared ${versionedName}`);
  console.log(`  version     ${badging.versionName} (${badging.versionCode})`);
  console.log(`  size        ${manifest.sizeBytes} bytes`);
  console.log(`  SHA-256     ${digest}`);
  console.log(`  signer      ${signer.dn}`);
  console.log(`  cert SHA-256 ${signer.sha256}`);
  console.log("Next: npm run build (stages it into out/downloads), then deploy hosting.");
}

function stage() {
  if (!existsSync(join(RELEASE_DIR, MANIFEST))) {
    console.log("android-release: no prepared release in release/android — hosting will have NO APK download (the /pair page then says so).");
    return;
  }
  const manifest = JSON.parse(readFileSync(join(RELEASE_DIR, MANIFEST), "utf8"));
  for (const name of [manifest.file, LATEST]) {
    if (!existsSync(join(RELEASE_DIR, name))) fail(`release/android/${name} is missing — run "prepare" again.`);
  }
  const mismatched = releaseHashMismatches(RELEASE_DIR, manifest);
  if (mismatched.length > 0) fail(`${mismatched.join(", ")} does not match the recorded SHA-256. Refusing to stage a modified file.`);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of [manifest.file, LATEST, MANIFEST]) copyFileSync(join(RELEASE_DIR, name), join(OUT_DIR, name));
  console.log(`android-release: staged ${manifest.file} (${manifest.version}) + ${LATEST} + ${MANIFEST} into out/downloads/`);
}

async function verifyRemote(originArg) {
  const origin = (originArg ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const manifestRes = await fetch(`${origin}/downloads/${MANIFEST}`, { cache: "no-store" });
  if (!manifestRes.ok) fail(`Manifest not reachable: ${manifestRes.status} ${origin}/downloads/${MANIFEST}`);
  const manifest = await manifestRes.json();
  const results = [];
  for (const name of [manifest.file, LATEST]) {
    const res = await fetch(`${origin}/downloads/${name}`, { cache: "no-store" });
    if (!res.ok) fail(`APK not reachable: ${res.status} ${name}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== manifest.sha256) fail(`${name}: downloaded SHA-256 ${digest} does not match the manifest ${manifest.sha256}`);
    if (bytes.length !== manifest.sizeBytes) fail(`${name}: downloaded ${bytes.length} bytes, manifest says ${manifest.sizeBytes}`);
    results.push({ name, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), bytes: bytes.length });
  }
  for (const r of results) console.log(`✓ ${origin}/downloads/${r.name}  ${r.bytes} bytes  ${r.type}  ${r.disposition ?? ""}`);
  console.log(`✓ SHA-256 matches the manifest: ${manifest.sha256}  (version ${manifest.version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  if (command === "prepare") prepare(arg);
  else if (command === "stage") stage();
  else if (command === "verify-remote") await verifyRemote(arg);
  else fail("Usage: android-release.mjs <prepare <apk> | stage | verify-remote [origin]>");
}
