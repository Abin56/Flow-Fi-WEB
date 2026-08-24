/**
 * Transaction Studio's "People Session" (architecture §4d) — purely a UI
 * convenience that biases new-row defaults (Shared Expense's participant
 * picker, Someone Else's Expense's person picker) toward whoever the user
 * says they're reviewing with. Never writes anywhere by itself.
 */

import { create } from "zustand";

interface TransactionStudioSessionState {
  reviewingWithPersonId: string | null;
  setReviewingWith: (personId: string | null) => void;
}

export const useTransactionStudioSessionStore = create<TransactionStudioSessionState>((set) => ({
  reviewingWithPersonId: null,
  setReviewingWith: (personId) => set({ reviewingWithPersonId: personId }),
}));
