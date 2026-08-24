/**
 * users/{uid}/pdfAnalyzerConfig/{cardId} — one fixed-id doc per card,
 * holding only an encrypted `savedPassword` field written server-side by
 * `saveCardPasswordCallable`. The client never reads, writes, or holds the
 * ciphertext itself — this repository only checks presence and allows
 * deleting the whole doc (removing the saved password).
 */

import { deleteDoc, doc, getDoc, type Firestore } from "firebase/firestore";
import { FirestoreCollections } from "@/lib/firestore/collections";

function configDocRef(db: Firestore, uid: string, cardId: string) {
  return doc(db, FirestoreCollections.users, uid, FirestoreCollections.pdfAnalyzerConfig, cardId);
}

/** Checks whether a card has a saved (encrypted) password stored — never fetches or exposes the ciphertext itself, only its presence. */
export async function hasSavedPassword(db: Firestore, uid: string, cardId: string): Promise<boolean> {
  const snapshot = await getDoc(configDocRef(db, uid, cardId));
  if (!snapshot.exists()) return false;
  return snapshot.get("savedPassword") != null;
}

export async function deleteConfig(db: Firestore, uid: string, cardId: string): Promise<void> {
  await deleteDoc(configDocRef(db, uid, cardId));
}
