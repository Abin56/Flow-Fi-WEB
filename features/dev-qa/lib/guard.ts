/**
 * LOCAL MANUAL-QA ONLY — removable with `app/dev/qa`, `features/dev-qa` and `lib/firebase/qa-emulator.ts`.
 *
 * The runtime guard the QA portal refuses to operate without. Every check must pass; anything that cannot
 * be verified is a failure, and the portal renders nothing but the failure list. The server page also
 * 404s outside development, so this is not the only line of defence.
 */

import type { User } from "firebase/auth";
import { auth, db } from "@/lib/firebase/client";
import { QA_EMULATOR_HOST, qaEmulatorPorts, qaEmulatorRequested } from "@/lib/firebase/qa-emulator";

export const QA_USER_EMAIL = "qa.tester@flowfi-qa.test";

/**
 * The synthetic QA user's password is NOT in the source: the local launcher (`npm run test:e2e-qa`) generates a
 * random one per run and passes it as NEXT_PUBLIC_QA_USER_PASSWORD to the dev server only. Missing → the portal
 * is blocked. (It only ever protects a throw-away user inside the local Auth emulator.)
 */
export function qaUserPassword(): string {
  return process.env.NEXT_PUBLIC_QA_USER_PASSWORD ?? "";
}
export const QA_DISPLAY_NAME = "QA Tester (synthetic)";

export interface GuardCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface GuardReport {
  /** True only when every check passed. */
  allowed: boolean;
  checks: GuardCheck[];
}

const check = (id: string, label: string, ok: boolean, detail: string): GuardCheck => ({ id, label, ok, detail });

async function emulatorReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://${QA_EMULATOR_HOST}:${port}/`, { mode: "no-cors", signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

/** Static checks — safe to evaluate on every render. */
export function staticChecks(): GuardCheck[] {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "";
  const authHost = (auth.emulatorConfig as { host?: string; port?: number } | null)?.host ?? null;
  const firestoreHost = (db as unknown as { _settings?: { host?: string } })._settings?.host ?? "";
  const local = typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname);
  return [
    check("dev-mode", "Local development build", process.env.NODE_ENV === "development", `NODE_ENV=${process.env.NODE_ENV}`),
    check("flag", "Emulator flag set", process.env.NEXT_PUBLIC_QA_EMULATOR === "1", `NEXT_PUBLIC_QA_EMULATOR=${process.env.NEXT_PUBLIC_QA_EMULATOR ?? "(unset)"}`),
    check("demo-project", "Demo project id (never a real project)", projectId.startsWith("demo-"), `projectId=${projectId || "(unset)"}`),
    check("localhost", "Served from localhost", local, typeof window === "undefined" ? "no window" : window.location.hostname),
    check("qa-credential", "Per-run QA credential supplied by the local launcher", qaUserPassword().length >= 16, qaUserPassword().length >= 16 ? "present (not shown)" : "missing — start via npm run test:e2e-qa"),
    check("client-wired", "Firebase client in emulator mode", qaEmulatorRequested(), qaEmulatorRequested() ? "emulator wiring active" : "emulator wiring inactive"),
    check("auth-emulator", "Auth is connected to the emulator", authHost === QA_EMULATOR_HOST && (auth.emulatorConfig as { port?: number } | null)?.port === qaEmulatorPorts().auth, `auth emulator=${authHost ?? "(none — production auth!)"}`),
    check("firestore-emulator", "Firestore is connected to the emulator", firestoreHost === `${QA_EMULATOR_HOST}:${qaEmulatorPorts().firestore}`, `firestore host=${firestoreHost || "(unknown)"}`),
  ];
}

/** Static checks plus a live reachability probe of the emulators. */
export async function runGuard(): Promise<GuardReport> {
  const checks = staticChecks();
  const [fs, au] = await Promise.all([emulatorReachable(qaEmulatorPorts().firestore), emulatorReachable(qaEmulatorPorts().auth)]);
  checks.push(check("firestore-up", "Firestore emulator reachable", fs, `${QA_EMULATOR_HOST}:${qaEmulatorPorts().firestore}`));
  checks.push(check("auth-up", "Auth emulator reachable", au, `${QA_EMULATOR_HOST}:${qaEmulatorPorts().auth}`));
  return { allowed: checks.every((c) => c.ok), checks };
}

/** The user check: only the synthetic QA user of the emulator may seed, reset or be tested. */
export function isQaUser(user: User | null): boolean {
  return user != null && user.email === QA_USER_EMAIL;
}

/** Throws unless the static guard passes — called before every write the portal makes. */
export function assertQaEnvironment(): void {
  const failed = staticChecks().filter((c) => !c.ok);
  if (failed.length > 0) throw new Error(`QA guard blocked: ${failed.map((c) => c.label).join("; ")}`);
}
