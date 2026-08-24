import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Single shared Admin SDK Firestore handle for all Cloud Functions in this
 * package. When FIRESTORE_EMULATOR_HOST is set (local dev, tests — see
 * functions/tests/), the Admin SDK auto-targets the emulator; no
 * credentials are needed either way in that mode.
 */
export function getDb(): Firestore {
  const app = getApps().length ? getApps()[0]! : initializeApp();
  return getFirestore(app);
}
