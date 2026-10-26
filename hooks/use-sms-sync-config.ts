"use client";

/**
 * Whether the signed-in user's `users/{uid}/smsSyncConfig/backgroundUpload` document says Android background
 * upload is switched on (`enabled === true`). Read-only (operator-written; firestore.rules denies client writes).
 *
 * This is a CONFIGURATION signal only. It is not a heartbeat: nothing here can say the phone is connected, online or
 * currently syncing, so callers must not word it that way.
 *
 *  - `loading`:        no answer yet.
 *  - `configured`:     the document exists and `enabled` is exactly `true`.
 *  - `not-configured`: the document is missing or `enabled` is not `true`.
 *  - `unknown`:        the read failed (offline, permission) — callers should fall back to the first-time guidance
 *                      rather than claim anything.
 */

import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { useAuthStore } from "@/store/auth-store";

export type SmsSyncConfigStatus = "loading" | "configured" | "not-configured" | "unknown";

const BACKGROUND_UPLOAD_DOC_ID = "backgroundUpload";

export function useSmsSyncConfig(): SmsSyncConfigStatus {
  const uid = useAuthStore((s) => s.user?.uid);
  const [state, setState] = useState<{ uid: string | undefined; status: SmsSyncConfigStatus }>({ uid: undefined, status: "loading" });

  useEffect(() => {
    if (!uid) return;
    const ref = doc(db, FirestoreCollections.users, uid, FirestoreCollections.smsSyncConfig, BACKGROUND_UPLOAD_DOC_ID);
    return onSnapshot(
      ref,
      (snapshot) => setState({ uid, status: snapshot.exists() && snapshot.data()?.enabled === true ? "configured" : "not-configured" }),
      () => setState({ uid, status: "unknown" }),
    );
  }, [uid]);

  // A result belongs to the uid it was read for; anything else is still loading.
  return uid && state.uid === uid ? state.status : "loading";
}
