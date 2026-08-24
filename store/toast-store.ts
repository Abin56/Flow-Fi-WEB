import { create } from "zustand";
import type { BannerTone } from "@/components/feedback/banner";

/** A28 — an optional action button (e.g. "Undo") a toast can carry, rendered next to the dismiss button. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  tone: BannerTone;
  title: string;
  description?: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) =>
    set((state) => ({ toasts: [...state.toasts, { ...toast, id: crypto.randomUUID() }] })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Fire a toast from anywhere — `toast.success("Saved")`, `toast.error("Title", "Description")`, or with an action: `toast.success("Updated 12 rows", undefined, { label: "Undo", onClick: () => ... })`. */
export const toast = {
  success: (title: string, description?: string, action?: ToastAction) => useToastStore.getState().push({ tone: "success", title, description, action }),
  warning: (title: string, description?: string, action?: ToastAction) => useToastStore.getState().push({ tone: "warning", title, description, action }),
  error: (title: string, description?: string, action?: ToastAction) => useToastStore.getState().push({ tone: "danger", title, description, action }),
  info: (title: string, description?: string, action?: ToastAction) => useToastStore.getState().push({ tone: "info", title, description, action }),
};
