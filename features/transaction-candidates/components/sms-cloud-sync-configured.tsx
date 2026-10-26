"use client";

/**
 * Compact empty state for a user whose Cloud Sync switch (`smsSyncConfig/backgroundUpload`) is on but whose candidate
 * queue is empty. It replaces the full "install the Android app" hero, which would be wrong for someone who already
 * did.
 *
 * Wording is deliberately about CONFIGURATION only. There is no heartbeat anywhere in Firestore, so nothing here says
 * the phone is connected, online, active or syncing — and it says so out loud. It also explains the one common reason
 * a configured account still looks empty: SMS captured on the phone before sign-in stay on the phone.
 */

import { ChevronDown, History, LifeBuoy, ShieldCheck, Workflow } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type PanelId = "how" | "troubleshoot";

const HOW_IT_WORKS = [
  "FlowFi for Android reads eligible bank SMS alerts on your phone and stores them there first.",
  "Alerts received after you signed in are uploaded here as transaction candidates, once Cloud Sync is on.",
  "Nothing becomes a transaction until you review and import it. Imported or dismissed alerts are not shown again.",
];

const TROUBLESHOOT = [
  "On Android, open the SMS Inbox and check the SMS Auto Sync card: permission granted, Auto Sync on, and the last scan time.",
  "Tap Scan now after a new bank alert arrives, then refresh this page. Scans only start when an alert arrives, the app opens, or you scan manually.",
  "Check the card's counts of pending messages linked to this account. Messages that are not linked stay on the phone.",
  "Make sure the phone and this page use the same FlowFi account.",
  "Battery restrictions or force-stopping the app can pause background capture on Android.",
];

function Disclosure({
  id,
  open,
  onToggle,
  icon,
  label,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="inline-flex h-11 items-center gap-2 rounded-2xl border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-e1 transition-colors duration-200 select-none hover:border-border-strong hover:bg-secondary"
      >
        {icon}
        {label}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      <div id={id} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="mt-3 flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-background/60 p-4">
      {items.map((text, i) => (
        <li key={text} className="flex items-start gap-3 text-[13px] leading-relaxed text-muted-foreground">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary-accent-text">
            {i + 1}
          </span>
          <span className="min-w-0">{text}</span>
        </li>
      ))}
    </ol>
  );
}

export function SmsCloudSyncConfigured() {
  const baseId = useId();
  const [open, setOpen] = useState<PanelId | null>(null);
  const toggle = (panel: PanelId) => setOpen((current) => (current === panel ? null : panel));

  return (
    <section
      aria-label="SMS Cloud Sync configured"
      data-testid="sms-cloud-sync-configured"
      className="relative overflow-hidden rounded-[24px] border border-border/60 text-foreground shadow-e2"
      style={{ background: "linear-gradient(125deg, var(--card) 0%, var(--card) 55%, color-mix(in oklch, var(--primary) 10%, var(--card)) 100%)" }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-40 size-[340px] rounded-full bg-primary/[0.12] blur-[90px] dark:bg-primary/[0.08]" />
        <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
      </div>

      <div className="relative flex flex-col gap-5 px-5 py-6 sm:px-8 sm:py-7">
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-accent-text">
            <span className="h-px w-6 bg-primary-accent-text" />
            FlowFi SMS Sync
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-foreground">
              <ShieldCheck className="size-3 text-primary-accent-text" />
              Cloud Sync configured
            </span>
          </p>
          <h2 className="font-heading text-2xl font-semibold leading-tight tracking-[-0.03em] sm:text-3xl">No SMS candidates right now.</h2>
          <p className="max-w-[62ch] text-[15px] leading-relaxed text-muted-foreground">
            Cloud Sync is switched on for your account, so new eligible bank alerts from Android can appear here for review. This page can&apos;t see whether your phone is
            connected or syncing at this moment.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/60 p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary-accent-text">
            <History className="size-4" />
          </span>
          <p className="min-w-0 text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">Older messages may stay on your phone.</span> SMS captured before you signed in to FlowFi on Android are not
            linked to your account, so they may not appear on the web. Messages that arrive after sign-in can.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <Disclosure id={`${baseId}-how`} open={open === "how"} onToggle={() => toggle("how")} icon={<Workflow className="size-4 text-muted-foreground" />} label="How syncing works">
            <Steps items={HOW_IT_WORKS} />
          </Disclosure>
          <Disclosure
            id={`${baseId}-troubleshoot`}
            open={open === "troubleshoot"}
            onToggle={() => toggle("troubleshoot")}
            icon={<LifeBuoy className="size-4 text-muted-foreground" />}
            label="Troubleshoot SMS sync"
          >
            <Steps items={TROUBLESHOOT} />
          </Disclosure>
        </div>
      </div>
    </section>
  );
}
