"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, InfoIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast as toastActions, useToastStore, type ToastItem } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const toneIcon = {
  success: CheckIcon,
  warning: TriangleAlertIcon,
  danger: XIcon,
  info: InfoIcon,
} as const;

/**
 * Per-tone accent, kept to three small touches so the card itself stays neutral:
 *  - badge: the icon tile (soft tint + inner ring, solid-tone glyph)
 *  - glow:  a faint wash bleeding in from the left edge behind the badge
 *  - ring:  the countdown arc colour
 * All built on theme tokens, so every appearance theme carries through.
 */
const toneStyle = {
  success: {
    badge: "bg-success/14 text-success ring-success/25",
    glow: "var(--success)",
    ring: "text-success",
  },
  warning: {
    badge: "bg-warning/20 text-[oklch(0.58_0.14_62)] ring-warning/40 dark:text-warning",
    glow: "var(--warning)",
    ring: "text-[oklch(0.7_0.16_68)] dark:text-warning",
  },
  danger: {
    badge: "bg-danger/14 text-danger ring-danger/25",
    glow: "var(--danger)",
    ring: "text-danger",
  },
  info: {
    badge: "bg-primary/14 text-primary-accent-text ring-primary/30",
    glow: "var(--primary)",
    ring: "text-primary-accent-text",
  },
} as const;

/** Countdown ring geometry (SVG units) — wraps the 28px close button. */
const RING_R = 12.25;
const RING_C = 2 * Math.PI * RING_R;

/** True while the tab is in the background — a toast nobody can see shouldn't run out. */
function useDocumentHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return hidden;
}

/**
 * Pausable countdown. Driven by requestAnimationFrame and painted straight onto the ring's stroke (no re-renders).
 * Deliberately not a CSS animation: the global reduced-motion rule shortens animations to 0.01ms, which would
 * dismiss toasts instantly for those users. `revision` restarts the clock when an identical toast is re-fired.
 */
function useCountdown(
  duration: number | null,
  paused: boolean,
  revision: number,
  paint: (fractionLeft: number) => void,
  onDone: () => void,
) {
  const remaining = useRef(duration ?? 0);
  const doneRef = useRef(onDone);
  const paintRef = useRef(paint);
  useEffect(() => {
    doneRef.current = onDone;
    paintRef.current = paint;
  });

  // Declared first: on a restart React runs every cleanup, then this reset, then the clock below.
  useEffect(() => {
    remaining.current = duration ?? 0;
  }, [duration, revision]);

  useEffect(() => {
    if (duration == null) return;
    const draw = (left: number) => paintRef.current(Math.max(0, Math.min(1, left / duration)));
    draw(remaining.current);
    if (paused) return;
    const startedAt = performance.now();
    const startLeft = remaining.current;
    let frame = requestAnimationFrame(function tick(now) {
      const left = startLeft - (now - startedAt);
      draw(left);
      if (left <= 0) {
        remaining.current = 0;
        doneRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      remaining.current = Math.max(0, startLeft - (performance.now() - startedAt));
    };
  }, [duration, paused, revision]);
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = toneIcon[item.tone];
  const style = toneStyle[item.tone];
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hidden = useDocumentHidden();
  const arcRef = useRef<SVGCircleElement>(null);
  const secsRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  // A non-pausable toast mirrors a real deadline (a delayed delete's Undo window), so its clock never stops.
  const paused = item.pausable !== false && (hovered || focused || hidden || dragging);
  const timed = item.duration != null;

  useCountdown(
    item.duration,
    paused,
    item.revision,
    (left) => {
      arcRef.current?.setAttribute("stroke-dashoffset", String(RING_C * (1 - left)));
      // A full-width layer slid left (transform only, no layout per frame); its feathered edge keeps a constant shape.
      if (fillRef.current) fillRef.current.style.transform = `translate3d(${(left - 1) * 100}%,0,0)`;
      // Seconds left, written straight to the DOM (no re-render per frame); only touches text when the second changes.
      const secs = `${Math.max(1, Math.ceil((left * (item.duration ?? 0)) / 1000))}`;
      if (secsRef.current && secsRef.current.textContent !== secs) secsRef.current.textContent = secs;
    },
    () => dismiss(item.id),
  );

  return (
    <motion.div
      layout="position"
      // Transform + opacity only (no filter animation over a backdrop blur — that's what made motion stutter).
      initial={{ opacity: 0, x: 36, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 56, scale: 0.98, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 32,
        mass: 0.8,
        opacity: { duration: 0.18, ease: "easeOut" },
        // Siblings closing a gap settle on a softer spring than the entrance.
        layout: { type: "spring", stiffness: 420, damping: 40 },
      }}
      // Swipe right to dismiss (mouse or touch). Dragging pauses the countdown.
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.04, right: 0.55 }}
      dragSnapToOrigin
      onDragStart={() => setDragging(true)}
      onDragEnd={(_, info) => {
        if (info.offset.x > 90 || info.velocity.x > 650) dismiss(item.id);
        else setDragging(false);
      }}
      // Mouse only: a touch "enter" has no matching leave and would freeze the timer.
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      className="group/toast pointer-events-auto relative w-full overflow-hidden rounded-[14px] bg-popover/95 ring-1 ring-border/80 backdrop-blur-xl sm:w-[21.5rem] dark:ring-white/[0.08]"
      style={{
        boxShadow:
          "0 1px 0 0 color-mix(in oklch, white 6%, transparent) inset, 0 1px 2px -1px rgb(0 0 0 / 0.08), 0 10px 28px -10px rgb(0 0 0 / 0.28)",
      }}
      role={item.tone === "danger" ? "alert" : "status"}
      data-toast-tone={item.tone}
      data-paused={timed && paused ? "" : undefined}
    >
      {/* Tone wash: a soft light from behind the badge — signals the type without colouring the card. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-28 opacity-[0.10] dark:opacity-[0.14]"
        style={{ background: `radial-gradient(80% 90% at 0% 50%, ${style.glow}, transparent 75%)` }}
      />

      {/* Container progression: a soft tone wash across the card that drains right→left with the timer. It brightens
          slightly toward its front and then feathers out over ~2.5rem — no hard edge line crossing the text. */}
      {timed && (
        <span
          ref={fillRef}
          aria-hidden
          data-testid="toast-fill"
          className="pointer-events-none absolute inset-0 transition-opacity duration-300 will-change-transform group-data-[paused]/toast:opacity-60"
          style={{
            background: `linear-gradient(90deg, color-mix(in oklch, ${style.glow} 4%, transparent) 0%, color-mix(in oklch, ${style.glow} 9%, transparent) calc(100% - 2.5rem), color-mix(in oklch, ${style.glow} 4%, transparent) calc(100% - 0.75rem), transparent 100%)`,
          }}
        />
      )}

      {/* Grid: badge | title | actions on one line; the description runs full width beneath title + actions,
          so an Undo button never squeezes it into an extra line. */}
      <div className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 pr-2 pl-3">
        <span className={cn("row-span-2 grid size-7 shrink-0 place-items-center self-start rounded-[9px] ring-1 ring-inset", style.badge)}>
          <Icon className="size-[0.95rem]" strokeWidth={2.6} aria-hidden />
        </span>

        <p className="line-clamp-2 text-[0.8125rem] leading-5 font-semibold tracking-[-0.005em] text-popover-foreground">{item.title}</p>

        {item.description && (
          <p className="col-span-2 col-start-2 row-start-2 -mt-0.5 line-clamp-2 pr-1.5 text-xs leading-[1.05rem] text-muted-foreground">
            {item.description}
          </p>
        )}

        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-1">
          {item.action && (
            <button
              type="button"
              onClick={() => {
                item.action!.onClick();
                dismiss(item.id);
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.055] px-2.5 text-xs font-semibold text-popover-foreground ring-1 ring-foreground/[0.07] transition-[background-color,box-shadow,transform] ring-inset hover:bg-foreground/[0.09] hover:ring-foreground/[0.12] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] dark:bg-white/[0.07] dark:hover:bg-white/[0.11]"
            >
              <RotateCcwIcon className="size-3.5 text-primary-accent-text" strokeWidth={2.4} aria-hidden />
              {item.action.label}
            </button>
          )}

          {/* Close — for timed toasts it doubles as the timer: a slim arc plus the seconds left. Hover/focus pauses the
              countdown and swaps the number for ✕, so time-left and dismiss read as one control. */}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(item.id)}
            className="group/close relative grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {timed && (
              <svg viewBox="0 0 28 28" className="pointer-events-none absolute inset-0 size-7 -rotate-90" aria-hidden>
                <circle cx="14" cy="14" r={RING_R} fill="none" strokeWidth="1.5" className="stroke-foreground/[0.08]" />
                <circle
                  ref={arcRef}
                  cx="14"
                  cy="14"
                  r={RING_R}
                  fill="none"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  stroke="currentColor"
                  strokeDasharray={RING_C}
                  strokeDashoffset={0}
                  className={cn("transition-opacity group-data-[paused]/toast:opacity-45", style.ring)}
                />
              </svg>
            )}
            {timed && (
              <span
                ref={secsRef}
                aria-hidden
                data-testid="toast-seconds"
                className={cn(
                  "absolute inset-0 grid place-items-center text-[0.6875rem] font-semibold tabular-nums transition-opacity duration-150 group-data-[paused]/toast:opacity-0",
                  // A clock that never pauses keeps counting under the pointer; only the close button itself swaps it for ✕.
                  item.pausable === false && "group-hover/close:opacity-0 group-focus-visible/close:opacity-0",
                  style.ring,
                )}
              />
            )}
            <XIcon
              className={cn("relative size-3.5 transition-opacity duration-150", timed && "opacity-0 group-data-[paused]/toast:opacity-100", timed && item.pausable === false && "group-hover/close:opacity-100 group-focus-visible/close:opacity-100")}
              strokeWidth={2.25}
            />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/** Mount once near the app root. Fire toasts from anywhere with `toast.success(...)` etc. from
 *  `@/store/toast-store`. Stacks top-right just under the top bar (full-width on phones), always
 *  topmost via the `command` elevation layer. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-4 top-[calc(3.5rem+env(safe-area-inset-top))] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:top-[calc(4rem+env(safe-area-inset-top))] sm:right-5 sm:items-end lg:right-6"
      style={{ zIndex: "var(--z-command)" }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </section>
  );
}

export { toastActions as toast };
