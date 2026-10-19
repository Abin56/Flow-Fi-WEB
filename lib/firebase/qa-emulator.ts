/**
 * LOCAL MANUAL-QA ONLY (removable together with `app/dev/qa` and `features/dev-qa`).
 *
 * Points the Firebase client at the local Emulator Suite — but only when ALL of these hold:
 *   - the bundle is a development build (`NODE_ENV === "development"`; Next inlines this constant, so the
 *     whole branch is dead code in a production build),
 *   - `NEXT_PUBLIC_QA_EMULATOR === "1"` was set explicitly when the dev server started,
 *   - the Firebase project id is a `demo-*` id (Firebase never contacts real services for those),
 *   - the page is served from localhost.
 * Anything else leaves the client exactly as it was.
 */

import type { Auth } from "firebase/auth";
import { connectAuthEmulator } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import { connectFirestoreEmulator } from "firebase/firestore";
import type { Functions } from "firebase/functions";
import { connectFunctionsEmulator } from "firebase/functions";
import type { FirebaseStorage } from "firebase/storage";
import { connectStorageEmulator } from "firebase/storage";

export const QA_EMULATOR_HOST = "127.0.0.1";
/** Defaults match `firebase.json`; override per run (NEXT_PUBLIC_QA_*_PORT) to keep QA off any emulator already running. */
export function qaEmulatorPorts() {
  return {
    auth: Number(process.env.NEXT_PUBLIC_QA_AUTH_PORT ?? 9099),
    firestore: Number(process.env.NEXT_PUBLIC_QA_FIRESTORE_PORT ?? 8080),
    storage: Number(process.env.NEXT_PUBLIC_QA_STORAGE_PORT ?? 9199),
    functions: Number(process.env.NEXT_PUBLIC_QA_FUNCTIONS_PORT ?? 5001),
  };
}

export function qaEmulatorRequested(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env.NEXT_PUBLIC_QA_EMULATOR !== "1") return false;
  if (!(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "").startsWith("demo-")) return false;
  if (typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname)) return false;
  return true;
}

export function connectQaEmulators(services: { auth: Auth; db: Firestore; storage: FirebaseStorage; functions: Functions }): boolean {
  if (!qaEmulatorRequested()) return false;
  const host = QA_EMULATOR_HOST;
  const QA_EMULATOR_PORTS = qaEmulatorPorts();
  connectAuthEmulator(services.auth, `http://${host}:${QA_EMULATOR_PORTS.auth}`, { disableWarnings: true });
  connectFirestoreEmulator(services.db, host, QA_EMULATOR_PORTS.firestore);
  connectStorageEmulator(services.storage, host, QA_EMULATOR_PORTS.storage);
  connectFunctionsEmulator(services.functions, host, QA_EMULATOR_PORTS.functions);
  return true;
}
