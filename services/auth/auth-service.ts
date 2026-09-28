import {
  GoogleAuthProvider,
  type User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { assertAccessGranted, clearAccess } from "@/services/access/access-gate";

/**
 * Mirrors lib/features/auth/data/auth_repository.dart in the Flutter app:
 * Google Sign-In is the only supported method, no email/password/phone/anonymous.
 */
const googleProvider = new GoogleAuthProvider();

/** Refuses to start Google Sign-In until the private-access gate has been passed (services/access/access-gate.ts). */
export function signInWithGoogle() {
  assertAccessGranted();
  return signInWithPopup(auth, googleProvider);
}

export function signOut() {
  clearAccess();
  return firebaseSignOut(auth);
}

export function subscribeToAuthState(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}
