"use client";

/**
 * SMS Sync's delivery-style progress tracker: five stages on one line, joined by a track that fills as each stage is
 * confirmed. States come from {@link deriveSyncStages} only — nothing here advances on a click or a timer.
 *
 * Motion: a completed stage draws its check and fills the track to its right; the current stage gets a ring that
 * settles once (no endless pulse). Everything is instant under reduced motion. Captions fold into one "current stage"
 * line on narrow containers so labels never clip.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Clock3 } from "lucide-react";
import { easings, springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";
import { currentStage, type StageState, type SyncStage } from "./sms-sync-stages";

const STATE_LABEL: Record<StageState, string> = {
  done: "Done",
  active: "Current step",
  failed: "Needs attention",
  expired: "Expired",
  upcoming: "Not yet",
};

const NODE: Record<StageState, string> = {
  done: "border-primary bg-primary text-primary-foreground",
  active: "border-primary-accent-text bg-card text-primary-accent-text",
  failed: "border-danger bg-danger text-danger-foreground",
  expired: "border-warning bg-warning text-warning-foreground",
  upcoming: "border-border bg-card text-tertiary-foreground",
};

function Node({ stage, index, reduceMotion }: { stage: SyncStage; index: number; reduceMotion: boolean }) {
  const { state } = stage;
  return (
    <span className="relative z-10 flex size-7 shrink-0">
      {/* Keyed by state: the ring grows in once whenever this stage becomes current. */}
      <AnimatePresence>
        {(state === "active" || state === "failed" || state === "expired") && (
          <motion.span
            key={state}
            aria-hidden
            initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: easings.out }}
            className={cn(
              "absolute -inset-[5px] rounded-full",
              state === "active" ? "bg-primary/25" : state === "failed" ? "bg-danger/15" : "bg-warning/15",
            )}
          />
        )}
      </AnimatePresence>
      <span className={cn("relative flex size-7 items-center justify-center rounded-full border-2 text-[11px] font-semibold tabular-nums transition-colors duration-300", NODE[state])}>
      <AnimatePresence mode="wait" initial={false}>
        {state === "done" ? (
          <motion.svg key="done" viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, ease: easings.out }} />
          </motion.svg>
        ) : state === "failed" ? (
          <motion.span key="failed" initial={reduceMotion ? false : { scale: 0.6 }} animate={{ scale: 1 }} transition={springs.snappy} className="flex">
            <AlertTriangle className="size-3.5" aria-hidden />
          </motion.span>
        ) : state === "expired" ? (
          <motion.span key="expired" initial={reduceMotion ? false : { scale: 0.6 }} animate={{ scale: 1 }} transition={springs.snappy} className="flex">
            <Clock3 className="size-3.5" aria-hidden />
          </motion.span>
        ) : (
          <motion.span key="n" initial={false}>
            {index + 1}
          </motion.span>
        )}
      </AnimatePresence>
      </span>
    </span>
  );
}

export function SmsSyncTracker({ stages, className }: { stages: SyncStage[]; className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  const current = currentStage(stages);
  const doneCount = stages.filter((s) => s.state === "done").length;

  return (
    <div className={cn("@container/tracker flex flex-col gap-2", className)} data-testid="sms-stage-tracker" data-current={current.id}>
      <ol aria-label={`SMS Sync progress: ${doneCount} of ${stages.length} done`} className="grid grid-cols-5">
        {stages.map((stage, i) => {
          const next = stages[i + 1];
          const trackFilled = stage.state === "done" && next !== undefined && next.state !== "upcoming";
          const muted = stage.state === "upcoming";
          return (
            <li key={stage.id} data-testid={`sms-stage-${stage.id}`} data-state={stage.state} className="relative flex min-w-0 flex-col items-center gap-1.5 text-center">
              {next && (
                <span aria-hidden className="absolute left-[calc(50%+18px)] right-[calc(-50%+18px)] top-[13px] h-[2px] overflow-hidden rounded-full bg-border">
                  <motion.span
                    className="absolute inset-0 origin-left rounded-full bg-primary-accent-text"
                    initial={false}
                    animate={{ scaleX: trackFilled ? 1 : stage.state === "done" ? 0.5 : 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.55, ease: easings.out }}
                  />
                </span>
              )}
              <Node stage={stage} index={i} reduceMotion={reduceMotion} />
              <div className="flex min-w-0 flex-col items-center px-0.5 leading-tight">
                <p className={cn("line-clamp-2 break-words text-[11px] @lg/tracker:text-[11.5px] font-semibold @md/tracker:text-xs", muted ? "text-muted-foreground" : "text-foreground")}>
                  <span className="@lg/tracker:hidden" aria-hidden>
                    {stage.short}
                  </span>
                  <span className="hidden @lg/tracker:inline">{stage.label}</span>
                  <span className="sr-only">
                    {" "}
                    — {STATE_LABEL[stage.state]}
                    {stage.caption ? `: ${stage.caption}` : ""}
                  </span>
                </p>
                {stage.caption && (
                  <p
                    aria-hidden
                    className={cn(
                      "mt-0.5 hidden max-w-full truncate text-[11px] tabular-nums @lg/tracker:block",
                      stage.state === "failed" ? "text-danger" : stage.state === "expired" ? "text-warning" : "text-tertiary-foreground",
                    )}
                  >
                    {stage.caption}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {/* Narrow containers: one line for the current stage instead of five clipped captions. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={current.id + current.state + (current.caption ?? "")}
          initial={reduceMotion ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
          transition={{ duration: 0.18, ease: easings.out }}
          aria-hidden
          className="text-center text-xs text-muted-foreground @lg/tracker:hidden"
        >
          <span className="font-semibold text-foreground">{current.label}</span>
          {current.caption ? ` · ${current.caption}` : ""}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
