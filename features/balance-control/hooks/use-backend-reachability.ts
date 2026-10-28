"use client";

/**
 * READ-ONLY reachability probe for Balance Control. The app's watch hooks report "not loading" with an empty list
 * before their first snapshot and give no error callback while the network is down, so an unreachable backend and a
 * genuinely empty account look the same. This asks the SERVER (never the local cache) for one account document:
 * a reply — even an empty one — proves the backend answered; a rejection or no reply in time means it did not.
 * One bounded read of the signed-in user's own collection; nothing is written.
 */

import { useEffect, useState } from "react";
import { collection, getDocsFromServer, limit, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { useAuthStore } from "@/store/auth-store";

export type Reachability = "checking" | "reachable" | "unreachable";

/** Beyond this with no server reply, the backend is treated as unreachable. */
export const REACHABILITY_TIMEOUT_MS = 8000;

export function useBackendReachability(): Reachability {
  const uid = useAuthStore((s) => s.user?.uid);
  const [state, setState] = useState<{ uid: string | undefined; value: Reachability }>({ uid: undefined, value: "checking" });

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    const settle = (value: Reachability) => {
      if (!cancelled) setState((prev) => (prev.uid === uid && prev.value === "reachable" ? prev : { uid, value }));
    };
    const timer = window.setTimeout(() => settle("unreachable"), REACHABILITY_TIMEOUT_MS);
    getDocsFromServer(query(collection(db, FirestoreCollections.users, uid, FirestoreCollections.accounts), limit(1))).then(
      () => {
        window.clearTimeout(timer);
        // A late reply after the timeout still proves the backend answered.
        if (!cancelled) setState({ uid, value: "reachable" });
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        // The server answered and refused: that is a read error (shown by its own banner), not an unreachable backend.
        if ((error as { code?: string } | null)?.code === "permission-denied") {
          if (!cancelled) setState({ uid, value: "reachable" });
          return;
        }
        settle("unreachable");
      },
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [uid]);

  return state.uid === uid ? state.value : "checking";
}
