"use client";

/**
 * Live phone status for SMS Sync, from the phone's own heartbeat (`smsDevicePresence`) plus the server-written pairing
 * records. Five separate facts — reachability, SMS access, notification access, Auto Sync, pairing — and the current
 * sync, each with its own state. Nothing here collapses them into one "Connected".
 *
 *  - SmsDeviceLiveStatus — the card inside the SMS Sync panel (empty inbox).
 *  - SmsSyncStatusBar (sms-sync-status-bar.tsx) uses the same pieces above a non-empty inbox.
 *
 * Motion: the phone→web link animates only while a sync is actually running, status values cross-fade on change, and
 * everything is static under reduced motion.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bell, CheckCircle2, CircleSlash, Link2, Loader2, MessageSquareText, Monitor, RefreshCw, Smartphone, TriangleAlert, type LucideIcon } from "lucide-react";

import type { SmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import type { DevicePresenceView, PresenceSummary } from "@/lib/sms-pairing/device-presence";
import { easings } from "@/lib/motion/tokens";
import { formatRelative } from "@/lib/sms-pairing/setup-progress";
import { cn } from "@/lib/utils";

type Tone = "ok" | "active" | "warn" | "danger" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-primary-accent-text",
  active: "text-primary-accent-text",
  warn: "text-warning",
  danger: "text-danger",
  muted: "text-tertiary-foreground",
};

interface Fact {
  id: string;
  icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
}

function facts(setup: SmsSyncSetup, p: DevicePresenceView, s: PresenceSummary): Fact[] {
  const sms: Pick<Fact, "value" | "tone"> =
    p.smsPermission === "granted"
      ? { value: "Allowed", tone: "ok" }
      : p.smsPermission === "denied"
        ? { value: "Not allowed", tone: "warn" }
        : p.smsPermission === "permanentlyDenied"
          ? { value: "Blocked in Settings", tone: "danger" }
          : p.smsPermission === "unsupported"
            ? { value: "Not in this build", tone: "danger" }
            : { value: "Not asked yet", tone: "muted" };
  const notif: Pick<Fact, "value" | "tone"> =
    p.notificationAccess === "granted" ? { value: "On", tone: "ok" } : p.notificationAccess === "denied" ? { value: "Off (optional)", tone: "muted" } : { value: "Not needed", tone: "muted" };
  const opened = setup.session?.status === "opened";
  const paired: Pick<Fact, "value" | "tone"> = setup.hasPairedDevice ? { value: "Paired", tone: "ok" } : opened ? { value: "Approving…", tone: "active" } : { value: "Not paired", tone: "muted" };
  const sync: Pick<Fact, "value" | "tone"> = s.syncRunning
    ? { value: s.syncPhase === "scanning" ? "Scanning…" : p.syncTotal ? `Uploading ${p.syncDone}/${p.syncTotal}` : "Uploading…", tone: "active" }
    : !setup.hasPairedDevice
      ? // A scan on an unpaired phone uploads nothing, so it is never "up to date" for the web.
        { value: "After pairing", tone: "muted" }
      : s.syncPhase === "failed"
        ? { value: "Last sync failed", tone: "danger" }
        : p.lastSyncAt
        ? { value: "Up to date", tone: "ok" }
        : { value: "Not synced yet", tone: "muted" };
  return [
    { id: "sms", icon: MessageSquareText, label: "SMS access", ...sms },
    { id: "notifications", icon: Bell, label: "Notifications", ...notif },
    { id: "autoSync", icon: RefreshCw, label: "Auto Sync", ...(p.autoSyncEnabled ? { value: "On", tone: "ok" as const } : { value: "Off", tone: "muted" as const }) },
    { id: "paired", icon: Link2, label: "Pairing", ...paired },
    { id: "sync", icon: CheckCircle2, label: "Sync", ...sync },
  ];
}

export function reachabilityText(s: PresenceSummary, now: number): string {
  if (s.reachability === "online") return "Online";
  const seen = s.lastSeenAt ? formatRelative(s.lastSeenAt, now) : "a while ago";
  return s.reachability === "background" ? `In background · seen ${seen}` : `Offline · last seen ${seen}`;
}

export function StatusDot({ reachability, reduceMotion }: { reachability: PresenceSummary["reachability"]; reduceMotion: boolean }) {
  const color = reachability === "online" ? "bg-primary" : reachability === "background" ? "bg-warning" : "bg-border-strong";
  return (
    <span className="absolute -right-0.5 -top-0.5 flex size-3">
      {reachability === "online" && !reduceMotion && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-50 [animation-duration:2.4s]" />}
      <span className={cn("relative inline-flex size-3 rounded-full border-2 border-card", color)} />
    </span>
  );
}

/** Phone ⟶ web link. Dashed when not paired, solid when paired, with a travelling pulse only while syncing. */
export function LinkBeam({ paired, syncing, reduceMotion }: { paired: boolean; syncing: boolean; reduceMotion: boolean }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      <Smartphone className="size-3.5 text-muted-foreground" />
      <span className={cn("relative h-px w-10 overflow-hidden", paired ? "bg-primary/60" : "border-t border-dashed border-border-strong bg-transparent")}>
        {syncing && !reduceMotion && (
          <motion.span
            className="absolute inset-y-[-1px] w-3 rounded-full bg-primary"
            initial={{ x: -12 }}
            animate={{ x: 40 }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </span>
      <Monitor className="size-3.5 text-muted-foreground" />
    </div>
  );
}

function SyncProgress({ p, s, now, paired }: { p: DevicePresenceView; s: PresenceSummary; now: number; paired: boolean }) {
  const reduceMotion = useReducedMotion() ?? false;
  const counts = `${p.syncUploaded} uploaded · ${p.syncSkipped} skipped${p.syncFailed ? ` · ${p.syncFailed} failed` : ""}`;
  if (s.syncRunning) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="sms-live-sync-progress">
        <div className="relative h-1.5 overflow-hidden rounded-full bg-border/70" role="progressbar" aria-label="Sync progress" {...(s.syncFraction !== null ? { "aria-valuenow": Math.round(s.syncFraction * 100), "aria-valuemin": 0, "aria-valuemax": 100 } : {})}>
          {s.syncFraction !== null ? (
            <motion.span className="absolute inset-y-0 left-0 rounded-full bg-primary" initial={false} animate={{ width: `${s.syncFraction * 100}%` }} transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: easings.out }} />
          ) : (
            // Total unknown: an indeterminate sweep, never a made-up percentage.
            <motion.span
              className="absolute inset-y-0 w-1/3 rounded-full bg-primary/80"
              initial={{ x: "-100%" }}
              animate={reduceMotion ? { x: "100%" } : { x: ["-100%", "300%"] }}
              transition={reduceMotion ? { duration: 0 } : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
        </div>
        <p className="text-[11.5px] tabular-nums text-muted-foreground">{s.syncPhase === "scanning" ? "Reading bank SMS on the phone…" : counts}</p>
      </div>
    );
  }
  if (!paired || (!p.lastSyncAt && s.syncPhase !== "failed")) return null;
  return (
    <p className="text-[11.5px] tabular-nums text-muted-foreground" data-testid="sms-live-last-sync">
      {s.syncPhase === "failed" ? "Last sync didn't finish — it retries on the next scan. " : ""}
      {p.lastSyncAt ? `Last sync ${formatRelative(p.lastSyncAt, now)} · ${counts}` : counts}
    </p>
  );
}

function FactPills({ list, reduceMotion }: { list: Fact[]; reduceMotion: boolean }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Phone status">
      {list.map((f) => (
        <li
          key={f.id}
          data-testid={`sms-live-${f.id}`}
          data-tone={f.tone}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
            f.tone === "danger" ? "border-danger/40 bg-danger/[0.06]" : f.tone === "warn" ? "border-warning/40 bg-warning/[0.06]" : "border-border/70 bg-card",
          )}
        >
          <f.icon className={cn("size-3.5 shrink-0", TONE_TEXT[f.tone])} aria-hidden />
          <span className="text-muted-foreground">{f.label}</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={f.value}
              initial={reduceMotion ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
              transition={{ duration: 0.18, ease: easings.out }}
              className={cn("inline-flex items-center gap-1 whitespace-nowrap font-semibold", f.tone === "muted" ? "text-muted-foreground" : "text-foreground")}
            >
              {f.tone === "active" && <Loader2 className={cn("size-3 shrink-0 text-primary-accent-text", !reduceMotion && "animate-spin")} aria-hidden />}
              {f.tone === "danger" && <TriangleAlert className="size-3 shrink-0 text-danger" aria-hidden />}
              {f.tone === "muted" && f.value.startsWith("Not") && <CircleSlash className="size-3 shrink-0" aria-hidden />}
              {f.value}
            </motion.span>
          </AnimatePresence>
        </li>
      ))}
    </ul>
  );
}

/**
 * The phone as it last reported itself. `embedded` drops the identity row and frame, for use inside the paired
 * device card (which already names the phone).
 */
export function SmsDeviceLiveStatus({ setup, embedded = false }: { setup: SmsSyncSetup; embedded?: boolean }) {
  const reduceMotion = useReducedMotion() ?? false;
  const { presence: p, presenceSummary: s, now } = setup;

  if (!p || !s) {
    if (embedded) return null;
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border-strong/70 bg-background/50 p-3.5" data-testid="sms-live-status-empty">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Phone not seen yet</p>
          <p className="text-xs text-muted-foreground">Open FlowFi on Android, signed in to this account.</p>
        </div>
      </div>
    );
  }

  const list = facts(setup, p, s);
  if (embedded) {
    return (
      <div className="flex flex-col gap-2" data-testid="sms-live-device" data-reachability={s.reachability}>
        <FactPills list={list} reduceMotion={reduceMotion} />
        <SyncProgress p={p} s={s} now={now} paired={setup.hasPairedDevice} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/60 p-3.5" data-testid="sms-live-device" data-reachability={s.reachability}>
      <div className="flex items-center gap-3">
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <Smartphone className="size-5" aria-hidden />
          <StatusDot reachability={s.reachability} reduceMotion={reduceMotion} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{p.label}</p>
          <p className={cn("text-xs", s.reachability === "online" ? "text-primary-accent-text" : "text-muted-foreground")} data-testid="sms-live-reachability" aria-live="polite">
            {reachabilityText(s, now)}
          </p>
        </div>
        <LinkBeam paired={setup.hasPairedDevice} syncing={s.syncRunning} reduceMotion={reduceMotion} />
      </div>
      <FactPills list={list} reduceMotion={reduceMotion} />
      <SyncProgress p={p} s={s} now={now} paired={setup.hasPairedDevice} />
    </div>
  );
}
