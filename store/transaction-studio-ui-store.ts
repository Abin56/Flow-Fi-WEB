/**
 * Transaction Studio's local display preferences (row density, so far) —
 * purely a rendering choice, never written to Firestore. Mirrors
 * `transaction-studio-session-store.ts`'s pattern (a small Zustand store
 * scoped to this one feature) rather than adding a new Settings-page field,
 * since this is Studio-local and unrelated to the global `/settings` route.
 */

import { create } from "zustand";

export type StudioRowDensity = "compact" | "comfortable";

export const ROW_HEIGHT_BY_DENSITY: Record<StudioRowDensity, number> = {
  compact: 36,
  comfortable: 44,
};

interface TransactionStudioUiState {
  rowDensity: StudioRowDensity;
  setRowDensity: (density: StudioRowDensity) => void;
}

export const useTransactionStudioUiStore = create<TransactionStudioUiState>((set) => ({
  rowDensity: "compact",
  setRowDensity: (rowDensity) => set({ rowDensity }),
}));
