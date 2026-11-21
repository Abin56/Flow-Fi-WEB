import { create } from "zustand";

/**
 * The ONE globally selected accounting-cycle window, set from the top-bar Month Cycle navigator and
 * followed by any page that opts in (see `useGlobalCycle`). This is only "which cycle window is being
 * viewed right now" — never the configured cycle RULE (Settings → Month cycle, `monthCycleStartDay`),
 * which stays untouched. Not persisted: like every existing page-local cycle switcher, it resets to
 * "today's cycle" on reload.
 */
interface GlobalCycleState {
  /** A day inside the globally selected cycle; null = the cycle containing today. */
  referenceDay: Date | null;
  setReferenceDay: (day: Date | null) => void;
}

export const useGlobalCycleStore = create<GlobalCycleState>((set) => ({
  referenceDay: null,
  setReferenceDay: (referenceDay) => set({ referenceDay }),
}));
