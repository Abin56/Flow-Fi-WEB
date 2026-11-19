import { create } from "zustand";
import type { BannerTone } from "@/components/feedback/banner";

/** A28 — an optional action button (e.g. "Undo") a toast can carry, rendered next to the dismiss button. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Per-toast options. `duration` in ms; `null` keeps the toast until the user closes it. */
export interface ToastOptions {
  duration?: number | null;
  /** Default true: hover / focus / a hidden tab pause the countdown. `false` when the countdown mirrors a real deadline
   *  elsewhere (a delayed delete's Undo window) — pausing would leave an action on screen after it stopped working. */
  pausable?: boolean;
  /** Default true: an identical visible toast is refreshed instead of stacked. `false` for toasts whose action belongs to
   *  one specific thing (each dismissed candidate's own Undo) — refreshing would replace the earlier action. */
  dedupe?: boolean;
}

export interface ToastItem {
  id: string;
  tone: BannerTone;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Resolved auto-dismiss time in ms, or `null` = stays until dismissed. */
  duration: number | null;
  /** Bumped when an identical toast is fired again, so the visible one restarts its countdown instead of duplicating. */
  revision: number;
  /** `false` = the countdown never pauses (see `ToastOptions.pausable`). */
  pausable?: boolean;
}

/** Default lifetimes per tone. Errors stay until closed so a failure is never missed. */
export const TOAST_DURATIONS: Record<BannerTone, number | null> = {
  success: 4000,
  info: 5000,
  warning: 6000,
  danger: null,
};

/** A toast offering an action (Undo) gets at least this long, so the action is reachable. */
const ACTION_MIN_MS = 6000;

/** At most this many toasts are on screen; the oldest auto-dismissing one gives way first. */
export const MAX_VISIBLE_TOASTS = 4;

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id" | "duration" | "revision">, options?: ToastOptions) => void;
  dismiss: (id: string) => void;
}

function resolveDuration(tone: BannerTone, hasAction: boolean, options?: ToastOptions): number | null {
  if (options && options.duration !== undefined) return options.duration;
  const base = TOAST_DURATIONS[tone];
  if (base == null) return null;
  return hasAction ? Math.max(base, ACTION_MIN_MS) : base;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast, options) =>
    set((state) => {
      const duration = resolveDuration(toast.tone, !!toast.action, options);
      // Same message already visible → refresh it (new action closure, restarted timer) rather than stacking a copy.
      const dup =
        options?.dedupe === false
          ? undefined
          : state.toasts.find(
              (t) => t.pausable !== false && t.tone === toast.tone && t.title === toast.title && (t.description ?? "") === (toast.description ?? ""),
            );
      if (dup) {
        return {
          toasts: state.toasts.map((t) =>
            t.id === dup.id ? { ...t, action: toast.action, duration, revision: t.revision + 1 } : t,
          ),
        };
      }
      let next = [
        ...state.toasts,
        { ...toast, id: crypto.randomUUID(), duration, revision: 0, ...(options?.pausable === false ? { pausable: false } : {}) },
      ];
      while (next.length > MAX_VISIBLE_TOASTS) {
        // Drop the oldest timed toast first; persistent ones (errors) only go if everything is persistent.
        const idx = next.findIndex((t) => t.duration != null);
        next = next.filter((_, i) => i !== (idx === -1 ? 0 : idx));
      }
      return { toasts: next };
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

type Fire = (title: string, description?: string, action?: ToastAction, options?: ToastOptions) => void;
const fire =
  (tone: BannerTone): Fire =>
  (title, description, action, options) =>
    useToastStore.getState().push({ tone, title, description, action }, options);

/** Fire a toast from anywhere — `toast.success("Saved")`, `toast.error("Title", "Description")`, with an action:
 *  `toast.success("Updated 12 rows", undefined, { label: "Undo", onClick: () => ... })`, or a custom lifetime:
 *  `toast.info("Syncing", undefined, undefined, { duration: 8000 })` (`null` = until closed). */
export const toast = {
  success: fire("success"),
  warning: fire("warning"),
  error: fire("danger"),
  info: fire("info"),
};
