"use client";

/**
 * The Transaction Inbox's one SMS Sync panel, shown while the candidate queue is empty. It changes shape with the live
 * setup state instead of stacking every section at once:
 *
 *  - connect      — no phone paired: progress tracker + the real single-use QR with a compact "how to scan" strip.
 *  - pairAnother  — a phone is paired and the user asked to pair a different one: the QR, without the intro art.
 *  - setup        — paired, waiting on the phone (permission, Auto Sync, first scan): tracker, next action, the device.
 *  - complete     — paired and set up, no candidates yet: collapses to a compact device status row.
 *  - suspended    — the operator paused SMS Sync.
 *
 * Hierarchy: the five-stage tracker (see `sms-sync-stages.ts`) and the next action / QR are primary; the phone's
 * identity and reported facts are secondary; the seven evidence-backed backend steps from
 * `lib/sms-pairing/setup-progress.ts` (grouped Connect → Approve → Review) live in the Details disclosure. A stage or
 * step is only ever complete when it has real evidence — never because a button was clicked.
 *
 * Wording rules: the page reports what the pairing backend recorded and what the phone last *reported*, always with
 * when. It never says the phone is online, installed or syncing right now — it can't know that.
 *
 * Motion is functional (QR frame reveal, expiry bar, stage fills, guide walk) and collapses to instant state changes
 * under reduced motion. The QR modules themselves are never transformed or faded (the scan beam multiplies, so it can
 * only darken), and no animation can create, refresh or approve a code.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudOff,
  Copy,
  Download,
  ExternalLink,
  History,
  Link2Off,
  Loader2,
  LockKeyhole,
  PauseCircle,
  QrCode,
  RefreshCw,
  Smartphone,
  Unplug,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/finance";
import { useAndroidRelease } from "@/hooks/use-android-release";
import type { SmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import { formatApkSize } from "@/lib/sms-pairing/android-release";
import { easings, springs } from "@/lib/motion/tokens";
import { formatCountdown, formatRelative, SMS_PAIRING_TTL_MS_HINT, type SetupStep, type StepId, type StepState } from "@/lib/sms-pairing/setup-progress";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { reachabilityText, SmsDeviceLiveStatus, StatusDot } from "./sms-device-live-status";
import { SmsFlowIllustration } from "./sms-flow-illustration";
import { SmsPairingGuide } from "./sms-pairing-guide";
import { deriveSyncStages } from "./sms-sync-stages";
import { SmsSyncTracker } from "./sms-sync-tracker";

const PRIMARY_BTN =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-e1 transition-[translate,box-shadow] duration-200 select-none hover:-translate-y-0.5 hover:shadow-e2 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60";
const SECONDARY_BTN =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors duration-200 select-none hover:border-border-strong hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60";
const TEXT_LINK = "font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

type Mode = "connect" | "pairAnother" | "setup" | "complete" | "suspended";

// ── Setup checklist (Details): the seven backend steps, grouped ──

const PHASES: { id: string; label: string; steps: StepId[] }[] = [
  { id: "connect", label: "Connect", steps: ["qr", "app"] },
  { id: "approve", label: "Approve", steps: ["paired", "permission", "autoSync"] },
  { id: "review", label: "Review", steps: ["firstScan", "candidates"] },
];

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  active: "In progress",
  failed: "Needs attention",
  expired: "Expired",
  upcoming: "Not started",
};

function phaseState(steps: SetupStep[]): StepState {
  if (steps.some((s) => s.state === "failed")) return "failed";
  if (steps.some((s) => s.state === "expired")) return "expired";
  if (steps.every((s) => s.state === "done")) return "done";
  if (steps.some((s) => s.state === "active" || s.state === "done")) return "active";
  return "upcoming";
}

const DOT_STYLE: Record<StepState, string> = {
  done: "bg-primary-accent-text",
  active: "bg-card ring-2 ring-inset ring-primary-accent-text",
  failed: "bg-danger",
  expired: "bg-warning",
  upcoming: "bg-border-strong/60",
};

const STATE_TEXT: Record<StepState, string> = {
  done: "text-primary-accent-text",
  active: "text-foreground",
  failed: "text-danger",
  expired: "text-warning",
  upcoming: "text-tertiary-foreground",
};

function PhaseProgress({ steps, now }: { steps: SetupStep[]; now: number }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return (
    <ol aria-label="Setup checklist" data-testid="sms-setup-phases" className="grid gap-4 @xl/journey:grid-cols-3">
      {PHASES.map((phase) => {
        const phaseSteps = phase.steps.map((id) => byId.get(id)!);
        const state = phaseState(phaseSteps);
        return (
          <li key={phase.id} data-testid={`sms-phase-${phase.id}`} data-state={state} className="flex min-w-0 flex-col gap-1.5">
            <p className="flex items-baseline justify-between gap-2 text-xs font-semibold text-foreground">
              {phase.label}
              <span className={cn("text-[11px] font-medium", STATE_TEXT[state])}>{STATE_LABEL[state]}</span>
            </p>
            <ul className="flex flex-col gap-1" aria-label={`${phase.label} steps`}>
              {phaseSteps.map((s) => (
                <li key={s.id} data-testid={`sms-setup-step-${s.id}`} data-state={s.state} className="flex min-w-0 items-center gap-2 text-xs">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full transition-colors duration-300", DOT_STYLE[s.state])} />
                  <span className={cn("min-w-0 flex-1 truncate", s.state === "upcoming" ? "text-muted-foreground" : "text-foreground")}>{s.title}</span>
                  <span className="shrink-0 tabular-nums text-tertiary-foreground">{s.state === "done" && s.at !== null ? formatRelative(s.at, now) : ""}</span>
                  <span className="sr-only"> — {STATE_LABEL[s.state]}</span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

// ── Notices ──

function Notice({ icon: Icon, tone, children, testId }: { icon: LucideIcon; tone: "info" | "warning" | "danger"; children: ReactNode; testId?: string }) {
  return (
    <div
      role={tone === "info" ? "note" : "status"}
      data-testid={testId}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed",
        tone === "info" && "border-border/70 bg-background/60 text-muted-foreground",
        tone === "warning" && "border-warning/40 bg-warning/10 text-foreground",
        tone === "danger" && "border-danger/40 bg-danger/10 text-foreground",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "info" ? "text-primary-accent-text" : tone === "warning" ? "text-warning" : "text-danger")} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Android download (from the published release manifest, never assumed) ──

function DownloadHint({ lead }: { lead: string }) {
  const release = useAndroidRelease();
  return (
    <p className="text-xs leading-relaxed text-muted-foreground" data-testid="sms-download-hint" data-release={release.status}>
      {release.status === "ready" ? (
        <>
          {lead}{" "}
          <a href={release.release.url} download className={cn(TEXT_LINK, "inline-flex items-center gap-1")} data-testid="sms-download-apk">
            <Download className="size-3" aria-hidden />
            Download FlowFi for Android
          </a>{" "}
          <span className="text-tertiary-foreground tabular-nums">
            · v{release.release.version} · {formatApkSize(release.release.sizeBytes)}
          </span>
        </>
      ) : release.status === "loading" ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          Checking for the Android app…
        </span>
      ) : release.status === "error" ? (
        <>
          Couldn&apos;t check for the Android download.{" "}
          <button type="button" onClick={release.retry} className={TEXT_LINK}>
            Try again
          </button>
        </>
      ) : (
        "The Android download isn't available from this site right now. If FlowFi is already on your phone, scanning opens it directly."
      )}
    </p>
  );
}

// ── QR ──

function QrCard({ setup }: { setup: SmsSyncSetup }) {
  const reduceMotion = useReducedMotion() ?? false;
  const { session, pairingUrl, now, progress } = setup;
  const qrStep = progress.steps[0]!;
  const opened = session?.status === "opened";
  const remaining = session ? Math.max(0, session.expiresAt - now) : 0;
  const total = session ? Math.max(1, session.expiresAt - session.createdAt) : SMS_PAIRING_TTL_MS_HINT;
  const needsNewCode = qrStep.state === "expired" || qrStep.state === "failed";
  const live = progress.steps.find((s) => s.state === "failed" || s.state === "expired") ?? progress.steps[progress.currentIndex];

  const copyLink = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      toast.success("Pairing link copied — it works once and expires soon");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-3.5 rounded-2xl border border-border/70 bg-background/70 p-4 sm:p-5" data-testid="sms-qr-card">
      <div className="text-center">
        <p className="text-sm font-semibold text-foreground">{opened ? "Approve on your phone" : "Scan with your phone"}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{opened ? "FlowFi opened this code. Tap Approve there." : "Scan the QR using your phone's Camera."}</p>
      </div>

      <div className="relative">
        {/* Corner brackets draw in around the code; the code itself never moves. */}
        {pairingUrl &&
          (["left-0 top-0 border-l-2 border-t-2 rounded-tl-xl", "right-0 top-0 border-r-2 border-t-2 rounded-tr-xl", "bottom-0 left-0 border-b-2 border-l-2 rounded-bl-xl", "bottom-0 right-0 border-b-2 border-r-2 rounded-br-xl"] as const).map(
            (pos, i) => (
              <motion.span
                key={pos}
                aria-hidden
                initial={reduceMotion ? false : { opacity: 0, scale: 1.25 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...springs.snappy, delay: 0.05 * i }}
                className={cn("pointer-events-none absolute z-10 size-6 border-primary-accent-text", pos, "-m-1.5")}
              />
            ),
          )}
        <div className={cn("relative overflow-hidden rounded-[16px] border border-border/60 p-3 shadow-e2", pairingUrl ? "bg-white" : "bg-secondary")}>
          {pairingUrl ? (
            <>
              {/* Always dark-on-white in both themes — inverted QR codes scan unreliably. */}
              <QRCodeSVG value={pairingUrl} size={168} level="M" marginSize={0} title="FlowFi pairing code" data-testid="sms-pairing-qr" />
              {!reduceMotion && !opened && (
                <motion.span
                  aria-hidden
                  initial={{ y: 6, opacity: 0 }}
                  animate={{ y: [6, 178], opacity: [0, 0.9, 0.9, 0] }}
                  transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 2.4, ease: "easeInOut" }}
                  className="pointer-events-none absolute inset-x-2 top-0 h-[3px] rounded-full mix-blend-multiply"
                  style={{ background: "linear-gradient(90deg, transparent, var(--primary) 18%, var(--primary) 82%, transparent)" }}
                />
              )}
            </>
          ) : (
            <div className="grid size-[168px] place-items-center text-muted-foreground" data-testid="sms-pairing-qr-placeholder">
              {qrStep.state === "active" ? (
                <div className="flex flex-col items-center gap-2 text-xs">
                  <Loader2 className={cn("size-6 text-primary-accent-text", !reduceMotion && "animate-spin")} aria-hidden />
                  Creating code…
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2.5 px-4 text-center text-xs">
                  {qrStep.state === "expired" ? (
                    <span className="flex size-10 items-center justify-center rounded-full bg-warning/15">
                      <Clock3 className="size-5 text-warning" aria-hidden />
                    </span>
                  ) : qrStep.state === "failed" ? (
                    <span className="flex size-10 items-center justify-center rounded-full bg-danger/15">
                      <AlertTriangle className="size-5 text-danger" aria-hidden />
                    </span>
                  ) : (
                    <QrCode className="size-6" aria-hidden />
                  )}
                  <span className="font-semibold text-foreground">
                    {qrStep.state === "expired" ? "Code expired" : qrStep.state === "failed" ? "No code yet" : opened ? "Waiting for approval" : "No active code"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        {opened && pairingUrl && (
          <motion.span
            initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springs.snappy}
            className="absolute -right-3 -top-3 z-20 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-e2"
          >
            <Smartphone className="size-3" aria-hidden />
            Opened on phone
          </motion.span>
        )}
      </div>

      {pairingUrl && session && (
        <div className="w-[194px]">
          <div className="h-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <div className="h-full origin-left rounded-full bg-primary-accent-text transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${remaining / total})` }} />
          </div>
          <p className="mt-1.5 text-center text-[11px] tabular-nums text-muted-foreground">
            Single-use · expires in <span className="font-semibold text-foreground">{formatCountdown(session.expiresAt, now)}</span>
          </p>
        </div>
      )}

      {/* The external-camera flow at a glance. Real progress only once the backend recorded that FlowFi opened it. */}
      {(pairingUrl || opened) && <SmsPairingGuide mode={opened ? "opened" : "demo"} />}

      {live && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={live.id + live.state + live.detail}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: easings.out }}
            aria-live="polite"
            data-testid="sms-live-status"
            className={cn(
              "max-w-[40ch] text-center text-xs leading-snug",
              live.state === "failed" ? "text-danger" : live.state === "expired" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {live.detail}
          </motion.p>
        </AnimatePresence>
      )}

      <div className="flex w-full flex-wrap justify-center gap-2">
        {/* On a phone-width layout the visitor may BE on the phone — they can't scan their own screen. */}
        {pairingUrl && (
          <a href={pairingUrl} className={cn(PRIMARY_BTN, "flex-1 whitespace-nowrap @3xl/journey:hidden")}>
            <ExternalLink className="size-4" aria-hidden />
            Open in FlowFi app
          </a>
        )}
        <button
          type="button"
          onClick={setup.newCode}
          disabled={setup.creating || !setup.online}
          className={cn(needsNewCode ? PRIMARY_BTN : SECONDARY_BTN, needsNewCode && "min-w-[160px]")}
        >
          <RefreshCw className={cn("size-4", setup.creating && !reduceMotion && "animate-spin")} aria-hidden />
          New code
        </button>
        {pairingUrl && (
          <button type="button" onClick={copyLink} className={cn(SECONDARY_BTN, "hidden @3xl/journey:inline-flex")}>
            <Copy className="size-4" aria-hidden />
            Copy link
          </button>
        )}
      </div>
    </div>
  );
}

// ── Paired device ──

function DeviceCard({ setup, compact = false }: { setup: SmsSyncSetup; compact?: boolean }) {
  const reduceMotion = useReducedMotion() ?? false;
  const { device, status, now, presenceSummary } = setup;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!device) return null;

  const disconnect = async () => {
    setBusy(true);
    const result = await setup.disconnect();
    setBusy(false);
    setConfirmOpen(false);
    if (result.ok) toast.success(`${device.label} disconnected — it stops sending SMS candidates on its next scan`);
    else toast.error(result.reason === "offline" ? "You're offline — try again when you reconnect" : "Couldn't disconnect the phone. Try again.");
  };

  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-border/70 bg-background/60 p-3.5" data-testid="sms-paired-device">
      <div className="flex items-center gap-3">
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <Smartphone className="size-5" aria-hidden />
          {presenceSummary && <StatusDot reachability={presenceSummary.reachability} reduceMotion={reduceMotion} />}
        </span>
        <div className="min-w-0 flex-1 leading-snug">
          <p className="truncate text-sm font-semibold text-foreground">{device.label}</p>
          <p className="text-xs text-muted-foreground">
            <span>{device.pairedAt ? `Paired ${formatRelative(device.pairedAt, now)}` : "Paired"}</span>
            {presenceSummary && <span className="text-tertiary-foreground"> · {reachabilityText(presenceSummary, now)}</span>}
          </p>
          <p className="text-xs text-tertiary-foreground">{status?.reportedAt ? `Last report from the phone ${formatRelative(status.reportedAt, now)}` : "No report from the phone yet"}</p>
        </div>
      </div>
      <SmsDeviceLiveStatus setup={setup} embedded />
      <div className={cn("flex flex-wrap gap-2", compact && "border-t border-border/60 pt-3")}>
        <button type="button" onClick={setup.pairAnother} className={cn(SECONDARY_BTN, "flex-1 whitespace-nowrap px-3 text-[13px]")}>
          <QrCode className="size-4" aria-hidden />
          Pair a different phone
        </button>
        <button type="button" onClick={() => setConfirmOpen(true)} className={cn(SECONDARY_BTN, "flex-1 whitespace-nowrap px-3 text-[13px] text-danger hover:text-danger")}>
          <Link2Off className="size-4" aria-hidden />
          Disconnect
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disconnect ${device.label}?`}
        description="It stops sending SMS candidates to this account on its next scan. Candidates already here stay for you to review, and messages stay on the phone. You can pair it again any time."
        confirmLabel="Disconnect"
        variant="destructive"
        loading={busy}
        onConfirm={disconnect}
      />
    </div>
  );
}

// ── Next action (paired, setup not finished) ──

const ACTION_TITLE: Partial<Record<StepId, { active: string; failed: string }>> = {
  permission: { active: "Allow SMS access on your phone", failed: "SMS access needs your attention" },
  autoSync: { active: "Turn on SMS Auto Sync", failed: "Cloud Sync couldn't be confirmed" },
  firstScan: { active: "Waiting for the first scan", failed: "The last scan didn't finish" },
  candidates: { active: "Waiting for bank alerts", failed: "The last upload didn't finish" },
};

function NextAction({ setup }: { setup: SmsSyncSetup }) {
  const reduceMotion = useReducedMotion() ?? false;
  const step = setup.progress.steps.find((s) => s.state === "failed") ?? setup.progress.steps[setup.progress.currentIndex];
  if (!step) return null;
  const failed = step.state === "failed";
  const title = ACTION_TITLE[step.id]?.[failed ? "failed" : "active"] ?? step.title;
  const unsupported = step.id === "permission" && failed && setup.status?.smsPermission === "unsupported";

  return (
    <div
      data-testid="sms-next-action"
      data-step={step.id}
      className={cn("flex h-full flex-col gap-2 rounded-2xl border p-4", failed ? "border-danger/40 bg-danger/[0.06]" : "border-primary-accent-text/30 bg-primary/[0.08]")}
    >
      <p className={cn("text-[11px] font-semibold uppercase tracking-[0.14em]", failed ? "text-danger" : "text-primary-accent-text")}>{failed ? "Action required" : "Next on your phone"}</p>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step.id + step.state}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: easings.out }}
          aria-live="polite"
        >
          <p className="flex items-center gap-2 text-base font-semibold text-foreground">
            {failed ? <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden /> : <Loader2 className={cn("size-4 shrink-0 text-primary-accent-text", !reduceMotion && "animate-spin [animation-duration:1.8s]")} aria-hidden />}
            {title}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground" data-testid="sms-live-status">
            {step.detail}
          </p>
        </motion.div>
      </AnimatePresence>
      {unsupported && <DownloadHint lead="Install the FlowFi Android build:" />}
    </div>
  );
}

// ── Footer: download/privacy + the Details disclosure (setup checklist, help) ──

const HELP_STEPS = [
  "Install FlowFi on your Android phone and sign in with this account.",
  "Open FlowFi Web › Transaction Inbox on a laptop and keep this QR on screen.",
  "Scan it with your phone's Camera app and tap the link — it opens FlowFi. Each code works once for 10 minutes.",
  "Review the request in FlowFi and tap Approve. This page follows along.",
] as const;

function Footer({ label, showHelp, left, steps, now }: { label: string; showHelp: boolean; left: ReactNode; steps: SetupStep[]; now: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="flex flex-col gap-2 @3xl/journey:flex-row @3xl/journey:items-start @3xl/journey:justify-between @3xl/journey:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">{left}</div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex w-fit shrink-0 items-center gap-1 rounded-sm text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
          <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
      </div>
      <div id={id} className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} hidden={!open}>
        <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
          {showHelp && (
            <ol className="grid gap-2 @2xl/journey:grid-cols-2">
              {HELP_STEPS.map((text, i) => (
                <li key={text} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">{i + 1}</span>
                  {text}
                </li>
              ))}
            </ol>
          )}
          <div className="rounded-xl border border-border/60 bg-background/50 p-3.5">
            <PhaseProgress steps={steps} now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Panel ──

function LivePill({ online }: { online: boolean }) {
  return online ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 [animation-duration:2.4s] motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-accent-text" />
      </span>
      Updates live
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10.5px] font-medium text-foreground">
      <WifiOff className="size-3 text-warning" aria-hidden />
      Offline
    </span>
  );
}

function modeOf(setup: SmsSyncSetup): Mode {
  if (setup.pairingAnother) return "pairAnother";
  const { phase, paired } = setup.progress;
  if (phase === "suspended" && !paired) return "suspended";
  if (!paired) return "connect";
  return phase === "complete" ? "complete" : "setup";
}

const PRIVACY_NOTE = "FlowFi reads SMS only after you allow it on the phone, picks out bank alerts, and never adds a transaction until you import it.";

export function SmsSetupJourney({ setup }: { setup: SmsSyncSetup }) {
  const headingId = useId();
  const reduceMotion = useReducedMotion() ?? false;
  const { progress, now } = setup;
  const mode = modeOf(setup);
  const deviceReported = setup.status?.reportedAt ?? null;
  const showsDevice = mode === "setup" || mode === "complete";
  const formerDevice = mode === "connect" && setup.device && setup.device.status !== "active" ? setup.device : null;
  const stages = deriveSyncStages(setup);

  const heading =
    mode === "connect"
      ? "Connect your phone"
      : mode === "pairAnother"
        ? "Pair a different phone"
        : mode === "setup"
          ? "Finish setup on your phone"
          : mode === "complete"
            ? "No SMS candidates right now"
            : "SMS Sync is paused";
  const body =
    mode === "connect"
      ? "No SMS candidates yet. Pair your Android phone and eligible bank SMS alerts appear here for you to review."
      : mode === "pairAnother"
        ? "Approving on the new phone makes it the only phone that sends SMS candidates here. The current one stops on its next scan."
        : mode === "setup"
          ? `${setup.device?.label ?? "Your phone"} is paired. A couple of steps on the phone and this page follows along.`
          : mode === "complete"
            ? `New eligible bank alerts from ${setup.device?.label ?? "your phone"} land here for review. Nothing becomes a transaction until you import it.`
            : "FlowFi has temporarily paused SMS uploads for everyone. Your phone keeps alerts locally and nothing is lost.";

  const notices = (
    <>
      {!setup.online && (
        <Notice icon={WifiOff} tone="warning" testId="sms-setup-offline">
          You&apos;re offline. Progress shown here may be out of date and resumes updating when you reconnect.
        </Notice>
      )}
      {setup.online && setup.fromCache && (
        <Notice icon={CloudOff} tone="warning">
          Reconnecting to FlowFi — showing the last status this browser received.
        </Notice>
      )}
      {progress.phase === "suspended" && (
        <Notice icon={PauseCircle} tone="warning" testId="sms-setup-suspended">
          SMS Sync is paused by FlowFi right now, so phones can&apos;t be paired or upload. Candidates already here can still be reviewed.
        </Notice>
      )}
      {formerDevice && (
        <Notice icon={Unplug} tone="info" testId="sms-setup-former-device">
          <span className="font-semibold text-foreground">{formerDevice.label} was disconnected</span>
          {formerDevice.status === "replaced" ? " because another phone was paired." : "."} Scan a new code to pair a phone again.
        </Notice>
      )}
      {showsDevice && progress.staleReport && deviceReported !== null && (
        <Notice icon={AlertTriangle} tone="warning" testId="sms-setup-stale">
          Your phone last reported {formatRelative(deviceReported, now)}. Open FlowFi on it to refresh — background scans only run when a bank alert arrives or the app
          opens.
        </Notice>
      )}
      {showsDevice && progress.pendingNotOwnedCount > 0 && (
        <Notice icon={History} tone="info" testId="sms-setup-unlinked">
          <span className="font-semibold text-foreground">
            {progress.pendingNotOwnedCount} earlier message{progress.pendingNotOwnedCount === 1 ? " is" : "s are"} still only on your phone.
          </span>{" "}
          They arrived before you signed in, so they aren&apos;t linked to this account. To include them, open FlowFi › SMS Inbox › Link earlier messages and confirm on the
          phone.
        </Notice>
      )}
    </>
  );

  const intro = (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-accent-text">SMS Sync · Android</p>
        <LivePill online={setup.online} />
      </div>
      <h2 id={headingId} className="font-heading text-xl font-semibold tracking-tight text-foreground @3xl/journey:text-[22px]">
        {mode === "complete" && <CheckCircle2 className="mr-2 inline size-5 -translate-y-0.5 text-primary-accent-text" aria-hidden />}
        {heading}
      </h2>
      <p className="max-w-[56ch] text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );

  const tracker = <SmsSyncTracker stages={stages} className="rounded-2xl border border-border/60 bg-background/50 px-2 py-3.5 sm:px-3" />;

  let main: ReactNode = null;
  if (mode === "connect") {
    // Phones/tablets: intro → QR → art, so the code is never below the fold behind decoration. Wide: art under the
    // intro, QR alongside.
    main = (
      <div className="grid gap-5 [grid-template-areas:'intro'_'qr'_'art'] @3xl/journey:grid-cols-[minmax(0,1fr)_minmax(290px,330px)] @3xl/journey:grid-rows-[auto_1fr] @3xl/journey:gap-x-8 @3xl/journey:[grid-template-areas:'intro_qr'_'art_qr']">
        <div className="flex min-w-0 flex-col gap-4 [grid-area:intro]">
          {intro}
          {tracker}
        </div>
        <div className="[grid-area:qr] @3xl/journey:self-start">
          <QrCard setup={setup} />
        </div>
        {/* Once the phone has reported, its live status replaces the illustration: the user sees the real phone. */}
        <div className="flex min-w-0 justify-center [grid-area:art] @3xl/journey:items-start @3xl/journey:justify-start">
          {setup.presence ? (
            <div className="w-full">
              <SmsDeviceLiveStatus setup={setup} />
            </div>
          ) : (
            <SmsFlowIllustration />
          )}
        </div>
      </div>
    );
  } else if (mode === "pairAnother") {
    main = (
      <div className="grid gap-5 @3xl/journey:grid-cols-[minmax(0,1fr)_minmax(290px,330px)] @3xl/journey:gap-x-8">
        <div className="flex min-w-0 flex-col gap-4">
          {intro}
          {tracker}
          <button type="button" onClick={setup.stopPairingAnother} className={cn(SECONDARY_BTN, "w-fit")}>
            Keep the current phone
          </button>
        </div>
        <QrCard setup={setup} />
      </div>
    );
  } else if (mode === "setup") {
    main = (
      <div className="flex flex-col gap-4">
        {intro}
        {tracker}
        <div className="grid gap-4 @2xl/journey:grid-cols-2">
          <NextAction setup={setup} />
          <DeviceCard setup={setup} />
        </div>
      </div>
    );
  } else if (mode === "complete") {
    // Collapsed: one compact row — what this means, and the phone.
    main = (
      <div className="grid gap-4 @2xl/journey:grid-cols-[minmax(0,1fr)_minmax(280px,380px)] @2xl/journey:items-start @2xl/journey:gap-8">
        {intro}
        <DeviceCard setup={setup} compact />
      </div>
    );
  } else {
    main = intro;
  }

  const showDownload = mode === "connect" || mode === "pairAnother";

  return (
    <section
      aria-labelledby={headingId}
      data-testid={mode === "connect" || mode === "suspended" ? "sms-connect-panel" : "sms-setup-standalone"}
      className="@container/journey relative overflow-hidden rounded-[22px] border border-border/70 bg-card text-foreground shadow-e1"
    >
      <div aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
      <motion.div
        key={mode}
        // Never fades or shifts a QR in: codes must stay perfectly still to scan.
        initial={reduceMotion || mode === "connect" || mode === "pairAnother" ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: easings.out }}
        className="relative flex flex-col gap-4 px-4 py-5 sm:px-6"
        data-testid="sms-setup-journey"
        data-phase={progress.phase}
        data-mode={mode}
      >
        {main}
        <div className="flex flex-col gap-2.5 empty:hidden">{notices}</div>
        <Footer
          label={showDownload ? "How pairing works" : "Details"}
          showHelp={showDownload}
          steps={progress.steps}
          now={now}
          left={
            <>
              {showDownload && <DownloadHint lead="No FlowFi on the phone yet?" />}
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-tertiary-foreground">
                <LockKeyhole className="mt-0.5 size-3 shrink-0" aria-hidden />
                {PRIVACY_NOTE}
              </p>
            </>
          }
        />
      </motion.div>
    </section>
  );
}
