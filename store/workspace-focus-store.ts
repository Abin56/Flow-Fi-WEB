import { create } from "zustand";

/**
 * Focus Mode for a full-screen workspace (Reconciliation): while `active`, the app shell hides the sidebar and the
 * global topbar and drops the page padding, so the workspace gets the whole viewport. Only a workspace that offers
 * Focus Mode turns it on, and it turns it off again when it unmounts — every other page always sees `false`.
 */
interface WorkspaceFocusState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useWorkspaceFocusStore = create<WorkspaceFocusState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
