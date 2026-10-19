/**
 * Local, emulator-only configuration for the browser QA suite — and the checks that make it refuse to run
 * anywhere else. Nothing here is a secret: the one credential (the synthetic QA user's password) is generated
 * per run by the launcher and lives only in that run's environment.
 */

import { randomBytes } from "node:crypto";

export const HOST = "127.0.0.1";

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${name} must be a port between 1024 and 65535 (got "${raw}")`);
  return n;
};

/** Defaults deliberately differ from `firebase.json` (8080/9099) so the suite never lands on an emulator someone else is using. */
export const PORTS = {
  app: num("QA_APP_PORT", 3210),
  firestore: num("QA_FIRESTORE_PORT", 8380),
  auth: num("QA_AUTH_PORT", 9399),
  hub: num("QA_HUB_PORT", 4410),
  logging: num("QA_LOGGING_PORT", 4510),
  firestoreWs: num("QA_FIRESTORE_WS_PORT", 9350),
};

export const PROJECT_ID = process.env.QA_PROJECT_ID ?? "demo-flowfi-qa";
export const BASE_URL = `http://localhost:${PORTS.app}`;
export const FIRESTORE_DOCS = `http://${HOST}:${PORTS.firestore}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const BROWSER_CHANNEL = process.env.QA_BROWSER_CHANNEL ?? "chrome";

/** Random per run; never written to disk or printed. */
export function newRunPassword() {
  return `qa-${randomBytes(18).toString("base64url")}`;
}

/**
 * Throws unless this process is configured for the local emulator only. Called by the launcher before anything
 * starts, and again by the harness before it touches a browser or the emulator.
 */
export function assertLocalEmulatorOnly() {
  const problems = [];
  if (!PROJECT_ID.startsWith("demo-")) problems.push(`project id "${PROJECT_ID}" is not a demo-* project`);
  if (process.env.NODE_ENV === "production") problems.push("NODE_ENV=production");
  for (const name of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
    const v = process.env[name];
    if (v && !/^(127\.0\.0\.1|localhost)(:|$)/.test(v)) problems.push(`${name}=${v} is not local`);
  }
  for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN"]) {
    if (process.env[name]) problems.push(`${name} is set — real credentials must not be present in a QA run`);
  }
  if (problems.length > 0) {
    throw new Error(`QA suite refused to run (fail closed):\n  - ${problems.join("\n  - ")}`);
  }
}

/** Hosts a QA browser may talk to. Anything else (Firebase/Google APIs in particular) is blocked and fails the run. */
export function isAllowedHost(hostname) {
  return hostname === "localhost" || hostname === HOST || hostname === "[::1]" || hostname === "::1";
}
