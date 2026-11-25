"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, CreditCard, Landmark, UserRound } from "lucide-react";
import { awarenessKey, deriveAwareness, type AwarenessInput, type AwarenessKind, type AwarenessModel } from "@/features/loans/lib/payment-awareness";
import { cn } from "@/lib/utils";

/**
 * Payment awareness — a compact indicator in the middle of the Loan & EMI header that says where a payment's money goes.
 *
 * PRESENTATION ONLY. The Record Payment dialog already knows its mode, account, amount and success flag; it hands them to
 * `PaymentAwarenessPublisher`, which turns them into a display model (`deriveAwareness`) and parks it in this provider.
 * The indicator reads that model. Nothing here fetches, subscribes, writes or calls a payment handler, and without a
 * provider (the list windows) publishing is a no-op. "Done" is shown only from the dialog's own success flag.
 */

const ModelContext = createContext<AwarenessModel | null>(null);
const PublishContext = createContext<((m: AwarenessModel | null) => void) | null>(null);

export function PaymentAwarenessProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<AwarenessModel | null>(null);
  return (
    <PublishContext.Provider value={setModel}>
      <ModelContext.Provider value={model}>{children}</ModelContext.Provider>
    </PublishContext.Provider>
  );
}

/**
 * Rendered by the Record Payment dialog while it is open. Publishes the derived model whenever it changes and clears it on
 * unmount (cancel / close). Renders nothing.
 */
export function PaymentAwarenessPublisher({ input }: { input: AwarenessInput | null }) {
  const publish = useContext(PublishContext);
  const model = input ? deriveAwareness(input) : null;
  const key = awarenessKey(model);
  // `key` is the model's serialisation: the effect re-runs only when what the header shows has actually changed.
  useEffect(() => {
    publish?.(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, key]);
  useEffect(() => () => publish?.(null), [publish]);
  return null;
}

const TONE: Record<AwarenessKind | "done", string> = {
  pay: "border-border bg-card text-foreground",
  choose: "border-border bg-secondary/60 text-foreground",
  low: "border-warning/50 bg-warning/10 text-foreground",
  recorded: "border-success/30 bg-success/10 text-foreground",
  direct: "border-success/30 bg-success/10 text-foreground",
  receive: "border-success/30 bg-success/10 text-foreground",
  card: "border-border bg-secondary/60 text-foreground",
  done: "border-success/40 bg-success/15 text-foreground",
};

/** How long the confirmation stays after the dialog has closed. */
const DONE_HOLD_MS = 4500;

/**
 * The header's centre slot. Always occupies its place (so nothing around it moves); empty while no payment is being set up.
 * Each state enters once with a short slide/fade — no loops; the warning pulses a single time.
 */
export function PaymentAwareness({ className }: { className?: string }) {
  const model = useContext(ModelContext);
  const [done, setDone] = useState<string | null>(null);
  // The existing workflow reporting success is the only way in. A retry / reopened dialog (success false) clears it.
  if (model?.success && done !== model.doneText) setDone(model.doneText);
  if (model && !model.success && done != null) setDone(null);
  useEffect(() => {
    if (done == null) return;
    const t = window.setTimeout(() => setDone(null), DONE_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [done]);

  const shownKind: AwarenessKind | "done" | null = done != null ? "done" : (model?.kind ?? null);

  return (
    <div data-testid="payment-awareness" className={cn("flex h-8 min-w-0 items-center justify-center", className)}>
      {shownKind != null && (
        <div
          // Keyed by the kind only: a changing amount updates in place, a new kind enters once.
          key={shownKind}
          role="status"
          aria-live="polite"
          data-awareness={shownKind}
          className={cn(
            "flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-e1 duration-300 animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none",
            TONE[shownKind],
            shownKind === "low" && "animate-[pulse_1.2s_ease-in-out_1] motion-reduce:animate-none",
          )}
        >
          {done != null ? (
            <>
              <CheckCircle2 className="size-3.5 shrink-0 text-success" strokeWidth={2} aria-hidden />
              <span className="truncate font-semibold">{done}</span>
            </>
          ) : model ? (
            <Body model={model} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function Body({ model }: { model: AwarenessModel }) {
  const { kind } = model;
  const Icon = kind === "low" ? AlertTriangle : kind === "card" ? CreditCard : kind === "direct" ? UserRound : kind === "recorded" ? CheckCircle2 : Landmark;
  const iconTone = kind === "low" ? "text-warning" : kind === "recorded" || kind === "direct" || kind === "receive" ? "text-success" : "text-muted-foreground";
  // Money visibly travels only when it really moves, and only on a payment with a valid amount: out of my account (pay),
  // into it (receive) or onto a card. The arrow enters once; it never loops.
  const flows = (kind === "pay" || kind === "receive" || kind === "card") && model.amount != null && model.from != null;
  const arrow = <ArrowRight className="size-3 shrink-0 text-muted-foreground duration-1000 animate-in fade-in-0 slide-in-from-left-3 motion-reduce:animate-none" aria-hidden />;
  return (
    <>
      <Icon className={cn("size-3.5 shrink-0", iconTone)} strokeWidth={2} aria-hidden />
      {flows ? (
        <span className="flex min-w-0 items-center gap-1.5 font-semibold tabular-nums">
          {kind === "receive" ? (
            <>
              <span>{model.amount}</span>
              {arrow}
              <span className="truncate">{model.from}</span>
            </>
          ) : (
            <>
              <span className="truncate">{model.from}</span>
              {arrow}
              <span>{model.amount}</span>
            </>
          )}
        </span>
      ) : (
        <span className="min-w-0 truncate font-semibold tabular-nums">{model.title}</span>
      )}
      {flows && kind === "pay" && <span className="hidden shrink-0 text-muted-foreground lg:inline">from your account</span>}
      {flows && kind === "card" && <span className="hidden shrink-0 text-muted-foreground lg:inline">· bank unchanged</span>}
      {!flows && model.detail && <span className="hidden min-w-0 truncate text-muted-foreground lg:inline">{model.detail}</span>}
    </>
  );
}
