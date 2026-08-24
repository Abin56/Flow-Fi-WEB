/**
 * PDF Analyzer — thin Firestore accessors for a card's saved (encrypted)
 * statement password. Server-side only — no client-side equivalent, since
 * the client model (`lib/models/pdf-analyzer-config.ts`) deliberately omits
 * this field entirely (see that file's module comment).
 *
 * Storage location: `users/{uid}/pdfAnalyzerConfig/{cardId}`'s existing
 * doc, in a sibling field `savedPassword` — not nested inside `rule`, and
 * not a separate collection (1:1 with the card's config, no reason to
 * split reads). The value stored here is always ciphertext
 * (`PasswordVault.EncryptedValue`) — plaintext never reaches Firestore.
 */

import type { Firestore } from "firebase-admin/firestore";
import type { EncryptedValue } from "./password-vault";

function configDocRef(db: Firestore, uid: string, cardId: string) {
  return db.collection("users").doc(uid).collection("pdfAnalyzerConfig").doc(cardId);
}

export async function getSavedPasswordCiphertext(
  db: Firestore,
  uid: string,
  cardId: string,
): Promise<EncryptedValue | null> {
  const snap = await configDocRef(db, uid, cardId).get();
  if (!snap.exists) return null;
  const value = snap.get("savedPassword") as EncryptedValue | undefined;
  return value ?? null;
}

export async function setSavedPasswordCiphertext(
  db: Firestore,
  uid: string,
  cardId: string,
  value: EncryptedValue,
): Promise<void> {
  await configDocRef(db, uid, cardId).set({ savedPassword: value }, { merge: true });
}
