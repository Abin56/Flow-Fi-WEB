"use client";

/**
 * A compact picture of the existing pairing flow, shown under the QR: Web QR → phone Camera → Open FlowFi → Approve →
 * Connected. FlowFi has no in-app scanner — the phone's own Camera reads this code and its link opens FlowFi.
 *
 *  - "demo"   — nothing has happened yet: a highlight walks the five steps (a demonstration, never a status; no checks).
 *  - "opened" — the backend recorded that FlowFi opened this code, so the first three steps are real and Approve is next.
 *
 * Purely visual: no timers touch the QR, the session or any callback. The walk pauses off-screen and is static under
 * reduced motion.
 */

import { motion, useReducedMotion } from "framer-motion";
import { Camera, CheckCheck, ExternalLink, Link2, QrCode, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { easings } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

const STEPS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "qr", label: "Web QR", icon: QrCode },
  { id: "camera", label: "Camera", icon: Camera },
  { id: "open", label: "Open FlowFi", icon: ExternalLink },
  { id: "approve", label: "Approve", icon: CheckCheck },
  { id: "connected", label: "Connected", icon: Link2 },
];

const BEAT_MS = 1500;

/** Visible on screen? Assumes yes where IntersectionObserver is missing (old browsers, jsdom). */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setOn(entry?.isIntersecting ?? true), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

function useWalk(playing: boolean): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setI((v) => (v + 1) % STEPS.length), i === STEPS.length - 1 ? BEAT_MS * 1.6 : BEAT_MS);
    return () => clearTimeout(t);
  }, [playing, i]);
  return i;
}

export function SmsPairingGuide({ mode }: { mode: "demo" | "opened" }) {
  const reduceMotion = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useOnScreen(ref);
  const walk = useWalk(mode === "demo" && inView && !reduceMotion);
  const highlight = mode === "opened" ? 3 : reduceMotion ? -1 : walk;

  return (
    <div ref={ref} className="w-full" data-testid="sms-pairing-guide" data-mode={mode}>
      <ol className="relative grid grid-cols-5" aria-label="How pairing works: scan this QR with your phone's Camera, tap the link to open FlowFi, then approve on the phone.">
        {STEPS.map((step, i) => {
          // Only the "opened" mode marks anything done, and only what the backend recorded.
          const done = mode === "opened" && i < 3;
          const lit = i === highlight;
          return (
            <li key={step.id} className="relative flex min-w-0 flex-col items-center gap-1">
              {i < STEPS.length - 1 && (
                <span aria-hidden className="absolute left-[calc(50%+15px)] right-[calc(-50%+15px)] top-[13px] h-px bg-border">
                  <motion.span
                    className="absolute inset-0 origin-left bg-primary-accent-text"
                    initial={false}
                    animate={{ scaleX: done || (mode === "demo" && i < highlight) ? 1 : 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: easings.out }}
                  />
                </span>
              )}
              <motion.span
                aria-hidden
                initial={false}
                animate={{ scale: lit && !reduceMotion ? 1.12 : 1 }}
                transition={{ duration: 0.3, ease: easings.out }}
                className={cn(
                  "relative z-10 flex size-[27px] items-center justify-center rounded-full border transition-colors duration-300",
                  done
                    ? "border-primary bg-primary text-primary-foreground"
                    : lit
                      ? "border-primary-accent-text bg-primary/20 text-primary-accent-text"
                      : "border-border bg-card text-muted-foreground",
                )}
              >
                <step.icon className="size-3.5" strokeWidth={2.2} />
              </motion.span>
              <span className={cn("max-w-full text-center text-[10px] font-medium leading-tight transition-colors duration-300 sm:text-[10.5px]", lit || done ? "text-foreground" : "text-tertiary-foreground")}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
