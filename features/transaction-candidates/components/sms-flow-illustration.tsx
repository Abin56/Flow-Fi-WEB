"use client";

/**
 * Compact product illustration for the Transaction Inbox connect panel: a bank SMS arrives, FlowFi spots the amount,
 * account and merchant, and it lands as a transaction candidate waiting for review. Fictional sample data only (the
 * `SAMPLE_*` constants), labelled as such, never mixed with the user's real candidates, and never a live status.
 *
 * The loop pauses off-screen and collapses to one static final frame under reduced motion.
 */

import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { Check, MessageSquareText, ScanText, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { easings, springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

const SAMPLE_SMS = {
  sender: "NWBANK",
  merchant: "Blueleaf Café",
  amount: "₹1,249.00",
  account: "••4821",
  // `key` segments are what the illustration highlights while it "detects" the alert.
  body: [
    { text: "Rs." },
    { text: "1,249.00", key: true },
    { text: " debited from A/c " },
    { text: "XX4821", key: true },
    { text: " at " },
    { text: "BLUELEAF CAFE", key: true },
    { text: ". Avl bal Rs.18,420.55" },
  ],
} as const;

/** 0 idle → 1 bank SMS arrives → 2 FlowFi detects it → 3 it lands as a candidate → 4 ready for review. */
type Beat = 0 | 1 | 2 | 3 | 4;
const BEAT_MS: Record<Beat, number> = { 0: 900, 1: 1500, 2: 1900, 3: 1200, 4: 3200 };
const FINAL_BEAT: Beat = 4;

function useStoryBeat(playing: boolean): Beat {
  const [beat, setBeat] = useState<Beat>(0);
  useEffect(() => {
    if (!playing) return;
    const timeout = setTimeout(() => setBeat((b) => ((b + 1) % 5) as Beat), BEAT_MS[beat]);
    return () => clearTimeout(timeout);
  }, [playing, beat]);
  return beat;
}

function SmsBubble({ visible, detecting }: { visible: boolean; detecting: boolean }) {
  return (
    <motion.div
      initial={false}
      animate={visible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0.35, y: -6, scale: 0.98 }}
      transition={springs.smooth}
      className={cn(
        "relative overflow-hidden rounded-[18px] border bg-card p-3 transition-[border-color,box-shadow] duration-500",
        detecting ? "border-primary/80 shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_20%,transparent),var(--shadow-e3)]" : "border-border/70 shadow-e2",
      )}
    >
      {detecting && (
        <motion.span
          aria-hidden
          initial={{ x: "-120%" }}
          animate={{ x: "330%" }}
          transition={{ duration: 1.2, ease: easings.inOut }}
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-primary/30 to-transparent"
        />
      )}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded-[5px] bg-success text-success-foreground">
          <MessageSquareText className="size-2.5" />
        </span>
        <span className="font-semibold text-foreground">Messages</span>
        <span>· {SAMPLE_SMS.sender}</span>
        <span className="ml-auto">now</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-[1.45] text-foreground/85">
        {SAMPLE_SMS.body.map((segment, i) =>
          "key" in segment ? (
            <span
              key={i}
              className={cn("rounded-[3px] transition-colors duration-500", detecting ? "bg-primary/45 text-foreground" : "bg-transparent")}
              style={{ transitionDelay: detecting ? `${200 + i * 90}ms` : "0ms" }}
            >
              {segment.text}
            </span>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
      </p>
    </motion.div>
  );
}

function Connector({ active, reduceMotion }: { active: boolean; reduceMotion: boolean }) {
  return (
    <div aria-hidden className="relative mx-auto flex h-9 w-full items-center justify-center @min-[540px]/flow:h-auto @min-[540px]/flow:w-auto @min-[540px]/flow:flex-col @min-[540px]/flow:px-2">
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-border via-primary/50 to-border @min-[540px]/flow:inset-x-0 @min-[540px]/flow:inset-y-auto @min-[540px]/flow:top-1/2 @min-[540px]/flow:left-0 @min-[540px]/flow:h-px @min-[540px]/flow:w-auto @min-[540px]/flow:translate-x-0 @min-[540px]/flow:-translate-y-1/2 @min-[540px]/flow:bg-gradient-to-r" />
      {active && !reduceMotion && (
        <motion.span
          className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_10px_var(--primary)] @min-[540px]/flow:hidden"
          initial={{ y: 0, opacity: 0 }}
          animate={{ y: 30, opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.9, ease: easings.inOut }}
        />
      )}
      <span
        className={cn(
          "relative inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors duration-500",
          active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground",
        )}
      >
        <ScanText className="size-3" />
        Bank alert detected
      </span>
    </div>
  );
}

function CandidateCard({ visible, fresh, ready }: { visible: boolean; fresh: boolean; ready: boolean }) {
  return (
    <motion.div
      initial={false}
      animate={visible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0.35, y: 8, scale: 0.98 }}
      transition={springs.smooth}
      className={cn(
        "rounded-[18px] border bg-card p-3 transition-[border-color,box-shadow] duration-700",
        fresh ? "border-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_22%,transparent),var(--shadow-e3)]" : "border-border/70 shadow-e2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/15 text-[10px] font-semibold text-primary-accent-text">BC</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-foreground">{SAMPLE_SMS.merchant}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {SAMPLE_SMS.sender} · {SAMPLE_SMS.account}
          </p>
        </div>
        <span className="text-[12.5px] font-semibold tabular-nums text-expense">−{SAMPLE_SMS.amount}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5">
        <AnimatePresence mode="wait" initial={false}>
          {ready ? (
            <motion.span
              key="ready"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-primary px-2 py-[3px] text-[10px] font-semibold text-primary-foreground"
            >
              <Check className="size-2.5" strokeWidth={3} />
              Ready for review
            </motion.span>
          ) : (
            <motion.span
              key="waiting"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-secondary px-2 py-[3px] text-[10px] font-medium text-muted-foreground"
            >
              <span className="size-1.5 rounded-full bg-warning" />
              Transaction candidate
            </motion.span>
          )}
        </AnimatePresence>
        <span className="flex gap-1 text-[10px] font-semibold">
          <span className={cn("rounded-full px-2 py-[3px] transition-colors duration-500", ready ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}>Import</span>
          <span className="rounded-full border border-border px-2 py-[3px] text-muted-foreground">Dismiss</span>
        </span>
      </div>
    </motion.div>
  );
}

export function SmsFlowIllustration({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const playing = !reduceMotion && inView;
  const loopBeat = useStoryBeat(playing);
  const beat = reduceMotion ? FINAL_BEAT : loopBeat;

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Illustration with sample data: a bank SMS alert becomes a transaction candidate that waits for you to import or dismiss it."
      className={cn("@container/flow relative w-full max-w-[340px] @3xl/journey:max-w-[680px]", className)}
    >
      <div aria-hidden className="pointer-events-none absolute -inset-6 rounded-full bg-primary/15 blur-[48px] dark:bg-primary/10" />
      <div aria-hidden className="relative grid grid-cols-1 @min-[540px]/flow:grid-cols-[minmax(240px,1fr)_auto_minmax(240px,1fr)] @min-[540px]/flow:items-center">
        <SmsBubble visible={beat >= 1} detecting={beat === 2} />
        <Connector active={beat >= 2} reduceMotion={reduceMotion} />
        <CandidateCard visible={beat >= 3} fresh={beat === 3} ready={beat === 4} />
        <span className="mt-2.5 inline-flex items-center gap-1.5 justify-self-center text-[10.5px] text-tertiary-foreground @min-[540px]/flow:col-span-3">
          <Sparkles className="size-3 text-primary-accent-text" />
          Illustration · sample data
        </span>
      </div>
    </div>
  );
}
