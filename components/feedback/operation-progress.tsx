"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Check, Loader2, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { springs } from "@/lib/motion/tokens";
import {
  createOperation,
  operationPercent,
  type OperationHandle,
  type OperationOptions,
  type OperationSnapshot,
} from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { useOperationProgressStore } from "@/store/operation-progress-store";

/**
 * The one progress language for FlowFi writes: headline + percentage, a thin bar, and the stage being run.
 *
 *   Recording payment                      72%
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────
 *   Updating installment schedule
 *
 * The percentage is operation-stage progress (see `lib/operation-progress`), not network progress. It
 * reaches 100% only when the write has succeeded, then shows a check; a failure stops the bar where it was.
 *
 * Two placements, same visuals:
 *   - inline   — inside a form/dialog, next to its action (`useOperation()` + `<OperationProgressView>`)
 *   - floating — page-level writes (`startOperation()` + `<OperationProgressHost>` mounted once)
 */

/** A floating failure dismisses itself after this long (it stays until closed when it offers a retry). */
const ERROR_DISMISS_MS = 8000;

/** The percentage as displayed: follows the model every frame and glides over stage jumps. */
function useDisplayPercent(snapshot: OperationSnapshot): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(() => operationPercent(snapshot, Date.now()));
  const shownRef = useRef(shown);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const target = operationPercent(snapshot, Date.now());
      const dt = t - last;
      last = t;
      const current = shownRef.current;
      // Glide ~120ms toward the target; snap under reduced motion. Never overshoots, so 100 appears only on success.
      const next = reduced ? target : current + (target - current) * Math.min(1, dt / 120);
      const settled = Math.abs(target - next) < 0.5 ? target : next;
      shownRef.current = settled;
      setShown(settled);
      if (snapshot.status === "running" || settled !== target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, reduced]);

  return snapshot.status === "success" && shown > 99 ? 100 : Math.min(Math.floor(shown), 99);
}

export function OperationProgressView({
  snapshot,
  onDismiss,
  className,
}: {
  snapshot: OperationSnapshot;
  /** Renders a close button (floating surface, or an inline failure the user can clear). */
  onDismiss?: () => void;
  className?: string;
}) {
  const percent = useDisplayPercent(snapshot);
  const { status } = snapshot;
  const headline = status === "success" ? snapshot.successLabel : status === "error" ? snapshot.errorLabel : snapshot.label;
  const secondary = status === "error" ? snapshot.errorDetail : status === "running" ? snapshot.detail : null;

  return (
    <div
      role={status === "error" ? "alert" : "status"}
      aria-live={status === "error" ? "assertive" : "polite"}
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          {status === "success" ? (
            <span className="flex size-4 items-center justify-center rounded-full bg-success text-white animate-in zoom-in-50 fade-in-0 duration-200">
              <Check className="size-2.5" strokeWidth={3.5} />
            </span>
          ) : status === "error" ? (
            <AlertCircle className="size-4 text-expense" strokeWidth={2} />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" strokeWidth={2} />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[13px] font-semibold", status === "error" ? "text-expense" : "text-foreground")}>{headline}</span>
        <span
          className={cn(
            "shrink-0 font-heading text-[13px] font-semibold tabular-nums",
            status === "success" ? "text-success" : status === "error" ? "text-muted-foreground" : "text-foreground",
          )}
          aria-hidden={status === "error"}
        >
          {percent}%
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={headline}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none",
            status === "success" ? "bg-success" : status === "error" ? "bg-expense" : "bg-primary-accent-text",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      {(secondary || (status === "error" && snapshot.retry)) && (
        <div className="flex min-w-0 items-start justify-between gap-3">
          {secondary ? (
            // A stage name fits one line; a failure reason must be readable in full, so it wraps.
            <span className={cn("min-w-0 text-[11.5px] text-muted-foreground", status === "error" ? "leading-snug" : "truncate")}>{secondary}</span>
          ) : (
            <span />
          )}
          {status === "error" && snapshot.retry && (
            <button
              type="button"
              onClick={snapshot.retry}
              className="inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs font-semibold text-primary-accent-text outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCw className="size-3" strokeWidth={2.25} />
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FloatingOperation({ snapshot }: { snapshot: OperationSnapshot }) {
  const remove = useOperationProgressStore((s) => s.remove);
  const failedWithoutRetry = snapshot.status === "error" && snapshot.retry == null;

  useEffect(() => {
    if (!failedWithoutRetry) return;
    const timer = setTimeout(() => remove(snapshot.id), ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [failedWithoutRetry, remove, snapshot.id]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
      transition={springs.snappy}
      className="pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded-[10px] border border-border bg-popover px-3.5 py-3"
      style={{ boxShadow: "var(--shadow-e3)" }}
    >
      <OperationProgressView snapshot={snapshot} onDismiss={snapshot.status === "error" ? () => remove(snapshot.id) : undefined} />
    </motion.div>
  );
}

/** Mount once near the app root (next to the Toaster). Shows operations started with `startOperation()`. */
export function OperationProgressHost() {
  const operations = useOperationProgressStore((s) => s.operations);
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 pb-[env(safe-area-inset-bottom)]"
      style={{ zIndex: "var(--z-command)" }}
    >
      <AnimatePresence>
        {operations.map((o) => (
          <FloatingOperation key={o.id} snapshot={o} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * An operation rendered inline by the calling form/dialog. `start()` returns the same handle as
 * `startOperation()`; render `snapshot` with `<OperationProgressView>` while it's non-null. A success keeps
 * the snapshot (the surface is usually closing); `clear()` resets it, e.g. when the user edits after a failure.
 */
export function useOperation() {
  const [snapshot, setSnapshot] = useState<OperationSnapshot | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback((opts: OperationOptions): OperationHandle => {
    return createOperation(opts, {
      update: (s) => mounted.current && setSnapshot(s),
      // Inline success stays visible until the surface closes; nothing to remove.
      remove: () => undefined,
      toast: (t) => toast.success(t.title, t.description, t.action),
    });
  }, []);
  const clear = useCallback(() => setSnapshot(null), []);
  return { snapshot, start, clear };
}
