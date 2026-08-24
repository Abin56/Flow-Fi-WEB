import {
  GoogleAuthProvider,
  type User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { auth } from "@/lib/firebase/client";

/**
 * Mirrors lib/features/auth/data/auth_repository.dart in the Flutter app:
 * Google Sign-In is the only supported method, no email/password/phone/anonymous.
 */
const googleProvider = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export function signOut() {
  return firebaseSignOut(auth);
}

export function subscribeToAuthState(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}