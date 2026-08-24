"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast as toastActions, useToastStore, type ToastItem } from "@/store/toast-store";
import { springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

const toneIcon = {
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  danger: AlertCircleIcon,
  info: InfoIcon,
} as const;

const toneIconClass = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-primary",
} as const;

const AUTO_DISMISS_MS = 5000;

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = toneIcon[item.tone];

  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [item.id, dismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
      transition={springs.snappy}
      className="pointer-events-auto flex w-80 items-start gap-3 rounded-2xl bg-popover p-4"
      style={{ boxShadow: "var(--shadow-e3)" }}
      role="status"
    >
      <Icon className={cn("mt-0.5 size-4.5 shrink-0", toneIconClass[item.tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-popover-foreground">{item.title}</p>
        {item.description && <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>}
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action!.onClick();
              dismiss(item.id);
            }}
            className="mt-1.5 text-sm font-semibold text-primary transition-colors hover:text-primary/80"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(item.id)}
        className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <XIcon className="size-4" />
      </button>
    </motion.div>
  );
}

/** Mount once near the app root. Fire toasts from anywhere with `toast.success(...)` etc. from
 *  `@/store/toast-store` — always topmost via the `command` elevation layer. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 flex flex-col items-end gap-2"
      style={{ zIndex: "var(--z-command)" }}
    >
      <AnimatePresence>
        {toasts.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export { toastActions as toast };
