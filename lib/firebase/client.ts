import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";
import {
  type Firestore,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { type Functions, getFunctions } from "firebase/functions";
import { type FirebaseStorage, getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const firebaseApp: FirebaseApp = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);

export const auth: Auth = getAuth(firebaseApp);

/**
 * Offline reads + queued writes: without this, a dropped connection leaves
 * every live listener stalled with nothing to show — no cached data, no
 * fallback. `initializeFirestore` must run before any other Firestore call
 * touches this app and can only be called once per app instance; wrapped in
 * try/catch because it throws if called twice (e.g. a hot-reload
 * re-evaluating this module) or if the environment has no IndexedDB (some
 * private-browsing modes) — either falls back to the plain, non-persistent
 * client rather than crashing the app over a best-effort enhancement.
 * `persistentMultipleTabManager` lets multiple open tabs share one cache
 * instead of the default single-tab exclusive lock.
 */
function createFirestore(): Firestore {
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return getFirestore(firebaseApp);
  }
}

export const db: Firestore = createFirestore();
export const storage: FirebaseStorage = getStorage(firebaseApp);
export const functions: Functions = getFunctions(firebaseApp);
