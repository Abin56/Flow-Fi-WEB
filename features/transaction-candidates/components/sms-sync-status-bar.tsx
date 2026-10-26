"use client";

/** A one-line live SMS Sync bar above a non-empty Transaction Inbox. It only watches; the full panel (which may create a pairing code) mounts when the user asks. */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Smartphone } from "lucide-react";
import { useState } from "react";
import { useSmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import { easings } from "@/lib/motion/tokens";
import { formatRelative } from "@/lib/sms-pairing/setup-progress";
import { cn } from "@/lib/utils";
import { LinkBeam, reachabilityText, StatusDot } from "./sms-device-live-status";
import { SmsSetupJourney } from "./sms-setup-journey";

/** Above a non-empty inbox: the phone's live state in one line; expands to the full SMS Sync panel on demand. */
export function SmsSyncStatusBar() {
  const [open, setOpen] = useState(false);
  const watch = useSmsSyncSetup({ autoPair: false });
  const reduceMotion = useReducedMotion() ?? false;
  if (!watch.loaded) return null;
  const s = watch.presenceSummary;
  const p = watch.presence;
  const paired = watch.hasPairedDevice;
  // A scan on an unpaired phone uploads nothing here, so it never animates the link.
  const syncing = paired && !!s?.syncRunning;

  const summary = !p || !s ? (paired ? (watch.device?.label ?? "Paired phone") : "Phone not seen yet") : `${p.label} · ${reachabilityText(s, watch.now)}`;
  const syncLine =
    p && syncing ? (s!.syncPhase === "scanning" ? "Scanning…" : p.syncTotal ? `Uploading ${p.syncDone}/${p.syncTotal}` : "Uploading…") : paired && p?.lastSyncAt ? `Last sync ${formatRelative(p.lastSyncAt, watch.now)}` : null;

  return (
    <div className="flex flex-col gap-3" data-testid="sms-sync-status-bar" data-paired={paired}>
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 overflow-hidden rounded-2xl border border-border/70 bg-card px-3.5 py-2.5 shadow-e1">
        <span className={cn("relative flex size-8 shrink-0 items-center justify-center rounded-xl", paired ? "bg-primary/20 text-primary-accent-text" : "bg-secondary text-muted-foreground")}>
          <Smartphone className="size-4" aria-hidden />
          {s && <StatusDot reachability={s.reachability} reduceMotion={reduceMotion} />}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-semibold text-foreground">{summary}</p>
          <p className="truncate text-[11.5px] text-muted-foreground" data-testid="sms-status-bar-detail" aria-live="polite">
            {paired ? "Paired" : "Not paired — pair your phone to keep receiving SMS candidates"}
            {p && paired ? ` · SMS ${p.smsPermission === "granted" ? "allowed" : "not allowed"} · Auto Sync ${p.autoSyncEnabled ? "on" : "off"}` : ""}
            {syncLine ? ` · ${syncLine}` : ""}
          </p>
        </div>
        {s && paired && <LinkBeam paired syncing={syncing} reduceMotion={reduceMotion} />}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            paired || open ? "border border-border bg-background text-foreground hover:bg-secondary" : "bg-primary text-primary-foreground hover:brightness-95",
          )}
        >
          {paired ? "Details" : "Pair phone"}
          <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
        {/* Sync activity: a hairline along the bar's bottom edge, only while the phone reports a running sync. */}
        {syncing && p && s && (
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-border/50">
            {s.syncFraction !== null ? (
              <motion.span className="absolute inset-y-0 left-0 bg-primary-accent-text" initial={false} animate={{ width: `${s.syncFraction * 100}%` }} transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: easings.out }} />
            ) : (
              !reduceMotion && (
                <motion.span className="absolute inset-y-0 w-1/4 bg-primary-accent-text" initial={{ x: "-100%" }} animate={{ x: ["-100%", "400%"] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }} />
              )
            )}
          </span>
        )}
      </div>
      {/* Mounting the full panel is what may create a pairing code — only when the user asks. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="panel" initial={reduceMotion || !paired ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? undefined : { opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: easings.out }}>
            <SmsSyncPanelOnDemand />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SmsSyncPanelOnDemand() {
  const setup = useSmsSyncSetup();
  if (!setup.loaded) return null;
  return <SmsSetupJourney setup={setup} />;
}
