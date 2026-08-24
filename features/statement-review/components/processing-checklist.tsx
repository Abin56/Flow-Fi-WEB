"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const STEPS = [
  "Uploading file",
  "Extracting text (OCR)",
  "Detecting tables",
  "Extracting transactions",
  "Normalizing merchants",
  "Detecting duplicates",
  "Detecting transfers",
  "Suggesting categories",
  "Calculating confidence",
];

const STEP_INTERVAL_MS = 650;

interface ProcessingChecklistProps {
  /** Real signal: `financialDocuments/{id}.status === "parsing"` (or "decrypting"/unresolved yet). */
  isProcessing: boolean;
  /** Real signal: status has left the in-flight phase (parsed/needs_review/awaiting_password/failed). */
  isDone: boolean;
}

/**
 * The backend pipeline is a single opaque call — there is no real per-step progress signal
 * (docs/state-machine.md: only "parsing" as one in-flight status). This checklist is a cosmetic
 * simulated progression that advances on a timer while `isProcessing` is true, and snaps straight
 * to fully-checked the instant the real `isDone` signal arrives — it never claims completion
 * before the backend actually finishes.
 */
export function ProcessingChecklist({ isProcessing, isDone }: ProcessingChecklistProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!isProcessing || isDone) return;
    const timer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
    }, STEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isProcessing, isDone]);

  const completedCount = isDone ? STEPS.length : stepIndex;
  const overallPercent = Math.round((completedCount / STEPS.length) * 100);

  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border/50 bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          2
        </span>
        <h3 className="text-sm font-semibold text-foreground">Processing &amp; Analysis</h3>
      </div>

      <ul className="flex flex-col gap-1.5">
        {STEPS.map((step, i) => {
          const done = i < completedCount;
          const active = !done && i === stepIndex && isProcessing && !isDone;
          return (
            <li key={step} className="flex items-center justify-between gap-2 text-sm">
              <span className={cn("flex items-center gap-2", done ? "text-foreground" : "text-muted-foreground")}>
                {done ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                ) : active ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle className="size-4 shrink-0 text-muted-foreground/40" />
                )}
                {step}
              </span>
              <span className={cn("shrink-0 text-xs tabular-nums", done ? "text-success" : "text-muted-foreground")}>
                {done ? "100%" : active ? "…" : "0%"}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <Progress value={overallPercent} className="h-2" />
        <p className="text-xs text-muted-foreground">
          {isDone ? "Analysis complete!" : `${overallPercent}% complete…`}
        </p>
      </div>
    </div>
  );
}
