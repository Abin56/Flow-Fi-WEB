"use client";

import { useEffect } from "react";
import { subscribeToAuthState } from "@/services/auth/auth-service";
import { useAuthStore } from "@/store/auth-store";

/** Wires Firebase's onAuthStateChanged into the Zustand auth store. Mount once, at the app root. */
export function useAuthListener() {
  const setUser = useAuthStore((state) => state.setUser);

  useEffect(() => {
    const unsubscribe = subscribeToAuthState(setUser);
    return unsubscribe;
  }, [setUser]);
}
