import type { User } from "firebase/auth";
import { create } from "zustand";

interface AuthState {
  user: User | null;
  status: "loading" | "signed-in" | "signed-out";
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: "loading",
  setUser: (user) => set({ user, status: user ? "signed-in" : "signed-out" }),
}));
