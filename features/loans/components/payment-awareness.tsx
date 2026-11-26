"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, CreditCard, Landmark, UserRound, Wallet, type LucideIcon } from "lucide-react";
import { awarenessKey, deriveAwareness, type AwarenessInput, type AwarenessKind, type AwarenessModel } from "@/features/loans/lib/payment-awareness";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Payment awareness — the Loan & EMI header's centre: a small animated "money flow" that shows where a payment goes.
 *
 * PRESENTATION ONLY. The Record Payment dialog already knows its mode, account, amount and success flag; it hands them to
 * `PaymentAwarenessPublisher`, which turns them into a display model (`deriveAwareness`) and parks it in this provider.
 * The indicator reads that model. Nothing here fetches, subscribes, writes or calls a payment handler, and without a
 * provider (the list windows) publishing is a no-op. "Done" is shown only from the dialog's own success flag.
 *
 * Motion: a coin travels from source to destination a fixed two times and the flow settles; a state entering plays one ring
 * pulse; nothing loops. Every element keeps its width, so nothing moves the header.
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

/** The next installment, from figures the schedule dialogs already compute (their `NextStrip`). */
export interface UpcomingPayment {
  amount: number;
  dueDate: Date;
  sequenceNumber: number;
  overdue: boolean;
}

type Shown = AwarenessKind | "done" | "upcoming";

const SURFACE: Record<Shown, string> = {
  pay: "border-border bg-gradient-to-r from-card via-secondary/60 to-card",
  choose: "border-dashed border-border-strong bg-secondary/50",
  low: "border-warning/60 bg-gradient-to-r from-warning/15 via-warning/5 to-warning/15",
  recorded: "border-success/35 bg-gradient-to-r from-success/10 via-card to-success/10",
  direct: "border-success/35 bg-gradient-to-r from-success/10 via-card to-success/10",
  receive: "border-success/35 bg-gradient-to-r from-success/10 via-card to-success/10",
  card: "border-border bg-gradient-to-r from-card via-secondary/60 to-card",
  done: "border-success/50 bg-gradient-to-r from-success/20 via-success/10 to-success/20",
  upcoming: "border-border bg-card",
};

const RING: Partial<Record<Shown, string>> = { low: "border-warning", done: "border-success", recorded: "border-success", direct: "border-success", receive: "border-success", pay: "border-foreground/40", card: "border-foreground/40" };

/** How long the confirmation stays after the dialog has closed. */
const DONE_HOLD_MS = 4500;

/**
 * The header's centre slot. Always occupies its place (so nothing around it moves); empty while there is nothing to say.
 * Priority: confirmation → the payment being set up → the next installment.
 */
export function PaymentAwareness({ className, upcoming, progressPercent, confirmationOnly }: { className?: string; upcoming?: UpcomingPayment | null; progressPercent?: number; confirmationOnly?: boolean }) {
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

  if (confirmationOnly) {
    return done && (
      <p role="status" data-testid="payment-awareness" data-awareness="done" className="mt-2 text-xs font-semibold text-success">
        {done}
      </p>
    );
  }

  const shown: Shown | null = done != null ? "done" : model ? model.kind : upcoming ? "upcoming" : null;

  return (
    <div data-testid="payment-awareness" className={cn("@container flex h-11 min-w-0 items-center justify-center", className)}>
      {shown != null && (
        // Keyed by the state only: a changing amount updates in place (no replay); a new state enters once.
        <div
          key={shown}
          role="status"
          aria-live="polite"
          data-awareness={shown}
          className={cn(
            "relative flex h-11 w-full max-w-[32rem] min-w-0 items-center overflow-hidden rounded-[22px] border px-2 text-xs shadow-e2 duration-300 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none",
            SURFACE[shown],
          )}
        >
          {/* One ring pulse when the state appears — the "attention" beat. */}
          {RING[shown] && <span aria-hidden className={cn("pointer-events-none absolute inset-0 rounded-[22px] border-2 [animation:pa-ring-out_900ms_ease-out_1_both]", RING[shown])} />}
          {shown === "done" ? <Done text={done!} /> : shown === "upcoming" ? <Upcoming upcoming={upcoming!} progressPercent={progressPercent} /> : (
            <>
              <span className="sr-only">{[model!.title, model!.detail].filter(Boolean).join(". ")}</span>
              <span aria-hidden className="contents">
                <Flow model={model!} />
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Tone = "plain" | "warn" | "good";

/** A round icon node of the flow. `pop` plays one entrance beat. */
function Dot({ icon: Icon, tone, pop, dashed, arrive }: { icon: LucideIcon; tone: Tone; pop?: boolean; dashed?: boolean; arrive?: boolean }) {
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full border",
        dashed && "border-dashed",
        tone === "warn" ? "border-warning/50 bg-warning/15 text-warning" : tone === "good" ? "border-success/40 bg-success/15 text-success" : "border-border bg-secondary text-foreground",
        pop && "[animation:pa-pop_450ms_ease-out_1_both]",
        arrive && "[animation:pa-arrive_1.8s_ease-in-out_4_both]",
      )}
    >
      <Icon className="size-4" strokeWidth={2} aria-hidden />
    </span>
  );
}

/** Show one coin movement for a confirmed transfer. */
function Track({ tone, once = false }: { tone: Tone; once?: boolean }) {
  const color = tone === "good" ? "text-success/70" : "text-foreground/35";
  return (
    <span aria-hidden className="relative mx-1.5 h-4 w-12 shrink-0 @md:w-24">
      <span className={cn("absolute inset-x-0 top-1/2 h-px -translate-y-1/2 [background:repeating-linear-gradient(90deg,currentColor_0_5px,transparent_5px_8px)]", color)} />
      {once && <span className="absolute top-1/2 grid size-4 place-items-center rounded-full bg-primary text-[9px] leading-none font-bold text-primary-foreground [animation:pa-coin_650ms_ease-in-out_1_both] motion-reduce:hidden">₹</span>}
    </span>
  );
}

export function PaymentSavedMotion({ kind, label }: { kind: "pay" | "receive" | "card" | "recorded"; label: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
      <span aria-hidden className="flex shrink-0 items-center">
        {kind === "pay" || kind === "receive" ? (
          <>
            <Dot icon={kind === "pay" ? Landmark : UserRound} tone="good" />
            <Track tone="good" once />
            <Dot icon={kind === "pay" ? Wallet : Landmark} tone="good" />
          </>
        ) : <Dot icon={kind === "card" ? CreditCard : CheckCircle2} tone="good" />}
      </span>
      {label}
    </div>
  );
}

export function PaymentSuccessFeedback({ input }: { input: AwarenessInput }) {
  const model = deriveAwareness(input);
  if (!model?.success) return null;
  const kind = model.kind === "pay" || model.kind === "receive" || model.kind === "card" ? model.kind : "recorded";
  return <PaymentSavedMotion kind={kind} label={kind === "card" ? `Card EMI recorded on ${model.from}` : model.doneText} />;
}

/** The pill's interior: a small graphic on the left, a two-line label on the right (fits the ~260px the header leaves). */
function Cell({ graphic, line1, line2, tone = "plain", bar }: { graphic: ReactNode; line1: ReactNode; line2?: ReactNode; tone?: Tone; bar?: number | "full" }) {
  return (
    <>
      <span className="flex shrink-0 items-center">{graphic}</span>
      <span className="ml-2.5 flex min-w-0 flex-1 flex-col justify-center leading-[1.15]">
        <span className={cn("truncate text-[13.5px] font-bold tabular-nums", tone === "warn" ? "text-warning-foreground dark:text-warning" : "text-foreground")}>{line1}</span>
        {line2 != null && <span className="truncate text-[11px] font-medium text-muted-foreground tabular-nums">{line2}</span>}
      </span>
      {bar != null && (
        <span aria-hidden className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-foreground/10">
          <span className={cn("block h-full origin-left rounded-full [animation:pa-fill_1100ms_ease-out_1_both]", tone === "good" ? "bg-success" : "bg-primary")} style={{ width: bar === "full" ? "100%" : `${bar}%` }} />
        </span>
      )}
    </>
  );
}

function Flow({ model }: { model: AwarenessModel }) {
  const { kind, amount } = model;
  const DestIcon = model.agreement === "EMI" ? CreditCard : Wallet;
  const destLabel = kind === "receive" ? "You" : kind === "direct" ? "Lender" : model.agreement;
  const flow = (from: LucideIcon, to: LucideIcon, tone: Tone = "plain") => (
    <>
      <Dot icon={from} tone={tone} />
      <Track tone={tone} />
      <Dot icon={to} tone={tone} arrive />
      <span className="ml-1.5 hidden text-[11px] font-bold tracking-wide text-muted-foreground uppercase @md:inline">{destLabel}</span>
    </>
  );
  switch (kind) {
    case "low":
      return <Cell tone="warn" graphic={<Dot icon={AlertTriangle} tone="warn" pop />} line1="Low balance" line2={`Short by ${model.shortfall} · ${model.from}`} />;
    case "choose":
      return <Cell graphic={<Dot icon={Landmark} tone="plain" dashed />} line1={amount ? `${amount} · ${model.agreement}` : `${model.agreement} payment`} line2="Choose paying account" />;
    case "recorded":
      return <Cell tone="good" bar="full" graphic={<Dot icon={CheckCircle2} tone="good" pop />} line1="Already recorded" line2="No new debit" />;
    case "direct":
      return <Cell tone="good" graphic={flow(UserRound, DestIcon, "good")} line1="Paid directly" line2="Account unchanged" />;
    case "receive":
      return <Cell tone="good" graphic={flow(DestIcon, Landmark, "good")} line1={amount ? `${amount} received` : "Repayment received"} line2={`into ${model.from ?? "your account"}`} />;
    case "card":
      return <Cell graphic={flow(CreditCard, DestIcon)} line1={amount ? `${amount} on card` : "On card"} line2={`${model.from} · bank unchanged`} />;
    default:
      return <Cell graphic={flow(Landmark, DestIcon)} line1={amount ?? "Payment"} line2={`from ${model.from}`} />;
  }
}

function Done({ text }: { text: string }) {
  const [first, ...rest] = text.split(" · ");
  return (
    <>
      <span className="sr-only">{text}</span>
      {/* A single light sweep across the confirmation. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/50 to-transparent [animation:pa-sheen_1100ms_ease-out_1_both]" />
      <span aria-hidden className="contents">
        <Cell tone="good" graphic={<span className="grid size-6 place-items-center rounded-full bg-success text-white [animation:pa-pop_450ms_ease-out_1_both]"><CheckCircle2 className="size-3.5" strokeWidth={2.5} /></span>} line1={first} line2={rest.join(" · ") || undefined} />
      </span>
    </>
  );
}

const dueShort = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** No payment open: the next installment from the schedule, with the paid-so-far line drawn once beneath it. */
function Upcoming({ upcoming, progressPercent }: { upcoming: UpcomingPayment; progressPercent?: number }) {
  const pct = Math.max(0, Math.min(100, progressPercent ?? 0));
  const sentence = `${upcoming.overdue ? "Overdue" : "Next"} · ${formatCurrencyExact(upcoming.amount)} · ${dueShort(upcoming.dueDate)}`;
  return (
    <>
      <span className="sr-only">{sentence}</span>
      <span aria-hidden className="contents">
        <Cell
          bar={pct}
          graphic={<Dot icon={CalendarClock} tone={upcoming.overdue ? "warn" : "plain"} />}
          tone={upcoming.overdue ? "warn" : "plain"}
          line1={`${upcoming.overdue ? "Overdue" : "Next"} · ${formatCurrencyExact(upcoming.amount)}`}
          line2={`${dueShort(upcoming.dueDate)} · installment #${upcoming.sequenceNumber}`}
        />
      </span>
    </>
  );
}
