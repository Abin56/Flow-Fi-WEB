import type { User } from "firebase/auth";
import { create } from "zustand";

interface AuthState {
  user: User | null;
  status: "loading" | "signed-in" | "signed-out";
  setUser: (user: User | null) => void;
  /** Bumped after `updateProfile` mutates the (same-reference) Firebase user, so subscribers re-render with the new name. */
  profileVersion: number;
  bumpProfile: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: "loading",
  profileVersion: 0,
  bumpProfile: () => set((s) => ({ profileVersion: s.profileVersion + 1 })),
  setUser: (user) => set({ user, status: user ? "signed-in" : "signed-out" }),
}));
