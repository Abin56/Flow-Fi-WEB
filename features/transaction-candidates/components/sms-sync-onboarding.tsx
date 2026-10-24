"use client";

/**
 * Shown in place of the plain empty state whenever the (unfiltered) candidate queue is empty. An empty queue is NOT
 * proof that SMS Auto Sync was never set up — a configured device can simply have no eligible alerts right now — so
 * nothing here claims a connection/sync status it can't back up. There is no real device-connection, sync-status, or
 * last-synced signal anywhere in Firestore for this feature (see `lib/models/sms-transaction-candidate.ts` — Android
 * owns this collection and writes nothing else).
 *
 * The phone scene is a product illustration with fictional sample data (`SAMPLE_*` below), confined to that scene and
 * marked as a preview. Its loop (SMS arrives → detected → lands as a candidate → ready for review) runs identically
 * whether or not SMS Auto Sync is configured, and it pauses while scrolled off-screen or under reduced motion.
 */

import { AnimatePresence, motion, useInView, useReducedMotion, type Variants } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowDown,
  ArrowRight,
  BatteryFull,
  Bell,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Eye,
  EyeOff,
  House,
  Inbox,
  ListChecks,
  LockKeyhole,
  MessageSquareText,
  PackageOpen,
  RefreshCw,
  ScanText,
  ShieldCheck,
  Signal,
  Smartphone,
  Sparkles,
  UserRound,
  Wallet,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { easings, springs, stagger } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

const APK_DOWNLOAD_URL = process.env.NEXT_PUBLIC_ANDROID_APK_URL ?? "";
const APK_CONFIGURED = APK_DOWNLOAD_URL.length > 0;

// ── Fictional sample data — lives only inside the illustration, never mixed with the user's real candidates ──

const SAMPLE_SMS = {
  sender: "NWBANK",
  merchant: "Blueleaf Café",
  amount: "₹1,249.00",
  account: "••4821",
  // `key` segments are the fields the illustration highlights while it "detects" the alert.
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

const SAMPLE_FIELDS = [
  ["Amount", SAMPLE_SMS.amount],
  ["Type", "Debit"],
  ["Account", SAMPLE_SMS.account],
  ["Merchant", SAMPLE_SMS.merchant],
] as const;

const SAMPLE_EARLIER = [
  { initials: "GM", name: "Greenmart", amount: "−₹2,310.40", income: false },
  { initials: "AC", name: "Acme Ltd salary", amount: "+₹62,000.00", income: true },
] as const;

// ── Copy ──

const HIGHLIGHTS = [
  { icon: ScanText, title: "Auto-detect", description: "Spots eligible bank SMS alerts" },
  { icon: Eye, title: "Review first", description: "Nothing is imported on its own" },
  { icon: ShieldCheck, title: "Permission-first", description: "SMS access only after you allow it" },
] as const;

const SETUP_STAGES = [
  { number: "01", icon: Download, title: "Get the app", description: "Download and install FlowFi for Android from this page.", visual: "app" },
  { number: "02", icon: ShieldCheck, title: "Connect securely", description: "Sign in with this FlowFi account, allow SMS access, then turn on Auto Sync.", visual: "connect" },
  { number: "03", icon: ListChecks, title: "Review your alerts", description: "Eligible SMS candidates appear in this Transaction Inbox for you to confirm.", visual: "review" },
] as const;

const SETUP_STEPS = [
  { title: "Download the APK", description: "Use the Download APK button or scan the QR code on this page." },
  { title: "Install FlowFi", description: "Confirm Android's install prompts. It may ask you to allow installs from your browser." },
  { title: "Sign in", description: "Use the same FlowFi account you're signed in with here." },
  { title: "Grant SMS permission", description: "The app explains why before Android asks — you can decline." },
  { title: "Enable Auto Sync", description: "Turn it on in the app's settings." },
  { title: "Review alerts here", description: "Detected transactions land in this inbox, waiting for your confirmation." },
] as const;

const SCAN_STEPS = ["Open the camera on your Android phone.", "Point it at this code and tap the link.", "Download the APK and confirm the install prompts."] as const;

// ── Shared styles ──

const PRIMARY_CTA =
  "group relative inline-flex h-12 shrink-0 items-center justify-center gap-2 overflow-hidden rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-[translate,box-shadow] duration-300 ease-out select-none hover:-translate-y-0.5 active:translate-y-0";
const SECONDARY_CTA =
  "inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl border border-border bg-card px-5 text-sm font-semibold text-foreground shadow-e1 transition-colors duration-200 select-none hover:border-border-strong hover:bg-secondary";
const PRIMARY_GLOW = { boxShadow: "0 14px 34px -14px color-mix(in oklch, var(--primary) 75%, transparent)" };

/** One-pass diagonal sheen across a lime CTA on hover. */
function CtaSheen() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 -skew-x-12 bg-white/45 opacity-0 transition-[translate,opacity] duration-700 ease-out group-hover:translate-x-[460%] group-hover:opacity-100"
    />
  );
}

const heroContainer: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } };
const heroItem: Variants = {
  hidden: { opacity: 0, y: 18, filter: "blur(6px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.6, ease: easings.out } },
};

// ── "Hide setup guide" preference — per-browser convenience only, falls back to in-memory when storage is blocked ──

const GUIDE_STORAGE_KEY = "flowfi:sms-sync-guide-hidden";
const guideListeners = new Set<() => void>();
let guideHiddenCache: boolean | null = null;

function readGuideHidden() {
  if (guideHiddenCache === null) {
    try {
      guideHiddenCache = window.localStorage.getItem(GUIDE_STORAGE_KEY) === "1";
    } catch {
      guideHiddenCache = false;
    }
  }
  return guideHiddenCache;
}

function setGuideHidden(hidden: boolean) {
  guideHiddenCache = hidden;
  try {
    if (hidden) window.localStorage.setItem(GUIDE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(GUIDE_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage — the in-memory value still applies for this session.
  }
  guideListeners.forEach((listener) => listener());
}

function subscribeGuide(listener: () => void) {
  guideListeners.add(listener);
  return () => {
    guideListeners.delete(listener);
  };
}

// ── Illustration story ──

/** 0 idle → 1 bank SMS arrives → 2 FlowFi detects it → 3 it lands as a candidate → 4 ready for review. */
type Beat = 0 | 1 | 2 | 3 | 4;
const BEAT_MS: Record<Beat, number> = { 0: 1100, 1: 1700, 2: 1900, 3: 1300, 4: 3200 };
// Reduced motion shows one static frame that still tells the whole story.
const FINAL_BEAT: Beat = 4;

const STORY_STEPS = [
  { beat: 1, label: "Bank SMS" },
  { beat: 2, label: "Detected" },
  { beat: 4, label: "Ready for review" },
] as const;

function useStoryBeat(playing: boolean): Beat {
  const [beat, setBeat] = useState<Beat>(0);

  useEffect(() => {
    if (!playing) return;
    const timeout = setTimeout(() => setBeat((b) => ((b + 1) % 5) as Beat), BEAT_MS[beat]);
    return () => clearTimeout(timeout);
  }, [playing, beat]);

  return beat;
}

/** The incoming sample SMS as an Android heads-up notification; while detecting, its key fields light up. */
function SmsNotification({ detecting }: { detecting: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -48, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // Exits downward, toward the list slot the candidate lands in.
      exit={{ opacity: 0, y: 72, scale: 0.9, transition: { duration: 0.45, ease: easings.inOut } }}
      transition={springs.smooth}
      className={cn(
        "absolute inset-x-2.5 top-9 z-20 overflow-hidden rounded-[20px] border bg-card p-3 transition-[border-color,box-shadow] duration-500",
        detecting ? "border-primary/80 shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_22%,transparent),var(--shadow-e4)]" : "border-border/60 shadow-e4",
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
      <div className="flex items-center gap-1.5 text-[9.5px] text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded-[5px] bg-success text-success-foreground">
          <MessageSquareText className="size-2.5" />
        </span>
        <span className="font-semibold text-foreground">Messages</span>
        <span>· {SAMPLE_SMS.sender}</span>
        <span className="ml-auto">now</span>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-[1.45] text-foreground/85">
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
      {/* Always laid out (only faded) so the card never changes height mid-animation. */}
      <div className={cn("mt-2 flex items-center gap-1.5 text-[9.5px] transition-opacity duration-300", detecting ? "opacity-100" : "opacity-0")}>
        <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 font-semibold text-primary-foreground">
          <ScanText className="size-2.5" />
          Bank alert detected
        </span>
        <span className="text-muted-foreground">Debit · {SAMPLE_SMS.amount}</span>
      </div>
    </motion.div>
  );
}

function SampleCandidateCard({ fresh, ready }: { fresh: boolean; ready: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-3 transition-[border-color,box-shadow] duration-700",
        fresh ? "border-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_25%,transparent),var(--shadow-e2)]" : "border-border/60 shadow-e2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/15 text-[10px] font-semibold text-primary-accent-text">BC</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold">{SAMPLE_SMS.merchant}</p>
          <p className="truncate text-[9.5px] text-muted-foreground">
            {SAMPLE_SMS.sender} · {SAMPLE_SMS.account}
          </p>
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-expense">−{SAMPLE_SMS.amount}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <AnimatePresence mode="wait" initial={false}>
          {ready ? (
            <motion.span
              key="ready"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-[3px] text-[9.5px] font-semibold text-primary-foreground"
            >
              <Check className="size-2.5" strokeWidth={3} />
              Ready for review
            </motion.span>
          ) : (
            <motion.span
              key="checking"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-[3px] text-[9.5px] font-medium text-muted-foreground"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-warning" />
              Checking details
            </motion.span>
          )}
        </AnimatePresence>
        <span
          className={cn(
            "rounded-full border px-2.5 py-[3px] text-[9.5px] font-semibold transition-colors duration-500",
            ready ? "border-transparent bg-foreground text-background" : "border-border text-muted-foreground",
          )}
        >
          Review
        </span>
      </div>
    </div>
  );
}

/** A CSS-built Android phone running an illustrative FlowFi inbox screen. Never a live status readout. */
function PhoneMockup({ beat, playing }: { beat: Beat; playing: boolean }) {
  const smsVisible = beat === 1 || beat === 2;
  const landed = beat >= 3;
  const ready = beat === 4;

  return (
    <motion.div
      animate={playing ? { y: [0, -8, 0] } : { y: 0 }}
      transition={playing ? { duration: 7, repeat: Infinity, ease: "easeInOut" } : { duration: 0.6 }}
      className="relative h-[572px] w-[276px]"
    >
      {/* Hardware keys */}
      <span className="absolute -right-[3px] top-[128px] h-[64px] w-[4px] rounded-r-[3px] bg-gradient-to-b from-[#5a5d56] to-[#2a2c28]" />
      <span className="absolute -right-[3px] top-[210px] h-[40px] w-[4px] rounded-r-[3px] bg-gradient-to-b from-[#5a5d56] to-[#2a2c28]" />

      {/* Metal rim → black bezel → screen */}
      <div
        className="absolute inset-0 rounded-[48px] p-[3px] shadow-[0_50px_90px_-35px_rgba(0,0,0,0.85),0_24px_48px_-24px_rgba(0,0,0,0.7)]"
        style={{ background: "linear-gradient(150deg, #73766f 0%, #2b2d29 26%, #191a18 60%, #545750 100%)" }}
      >
        <div className="size-full rounded-[45px] bg-[#070807] p-[9px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
          <div className="relative flex size-full flex-col overflow-hidden rounded-[36px] bg-background text-foreground">
            {/* Status bar + punch-hole camera */}
            <div className="relative flex h-8 shrink-0 items-center justify-between px-6 pt-1 text-[11px] font-semibold tabular-nums">
              <span>9:41</span>
              <span className="absolute left-1/2 top-[10px] size-[11px] -translate-x-1/2 rounded-full bg-[#050505] ring-[1.5px] ring-black/15" />
              <span className="flex items-center gap-1">
                <Signal className="size-3" />
                <Wifi className="size-3" />
                <BatteryFull className="size-3.5" />
              </span>
            </div>

            {/* App bar */}
            <div className="flex shrink-0 items-center gap-2.5 px-4 pt-2">
              <span className="flex size-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-primary via-primary to-success/70 font-heading text-[13px] font-bold text-primary-foreground">
                F
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-tight">Inbox</p>
                <p className="text-[10px] leading-tight text-muted-foreground">SMS candidates</p>
              </div>
              <span className="flex size-8 items-center justify-center rounded-full bg-secondary">
                <Bell className="size-3.5" />
              </span>
            </div>

            {/* Mirrors the web inbox's near-black overview */}
            <div className="mx-3 mt-3 flex shrink-0 items-center justify-between rounded-2xl bg-surface-hero px-3.5 py-3 text-hero-foreground">
              <div>
                <p className="text-[8.5px] font-semibold uppercase tracking-[0.14em] text-hero-foreground/60">Waiting for review</p>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={landed ? 1 : 0}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.2 }}
                    className="mt-0.5 font-heading text-[22px] font-semibold leading-none tabular-nums"
                  >
                    {landed ? 1 : 0}
                  </motion.p>
                </AnimatePresence>
              </div>
              <span className="whitespace-nowrap rounded-full bg-primary/15 px-2 py-1 text-[9px] font-medium text-primary">You confirm each</span>
            </div>

            <div className="mt-3 flex shrink-0 gap-1.5 px-3 text-[10px] font-medium">
              <span className="rounded-full bg-foreground px-2.5 py-1 text-background">To review</span>
              <span className="rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">Imported</span>
              <span className="rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">Dismissed</span>
            </div>

            <div className="mt-3 flex min-h-0 flex-1 flex-col px-3">
              <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Today</p>
              {/* grid-rows 0fr↔1fr animates height in pure CSS, so nothing here depends on layout measurement. */}
              <div className={cn("grid transition-[grid-template-rows,opacity] duration-500 ease-out", landed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}>
                <div className="min-h-0 overflow-hidden">
                  <div className="pt-2">
                    <div className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[10px] text-muted-foreground">No new alerts yet</div>
                  </div>
                </div>
              </div>
              <div className={cn("grid transition-[grid-template-rows,opacity] duration-500 ease-out", landed ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                <div className="min-h-0 overflow-hidden">
                  <motion.div
                    initial={false}
                    animate={{ y: landed ? 0 : -14, scale: landed ? 1 : 0.97 }}
                    transition={springs.smooth}
                    className="px-0.5 pb-1 pt-2"
                  >
                    <SampleCandidateCard fresh={beat === 3} ready={ready} />
                  </motion.div>
                </div>
              </div>

              <p className="mt-3 px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Earlier</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {SAMPLE_EARLIER.map((row) => (
                  <div key={row.name} className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-card px-2.5 py-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-[9.5px] font-semibold text-muted-foreground">{row.initials}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium">{row.name}</p>
                      <p className="flex items-center gap-1 text-[9px] text-muted-foreground">
                        <Check className="size-2.5 text-success" strokeWidth={3} />
                        Imported
                      </p>
                    </div>
                    <span className={cn("text-[11px] font-semibold tabular-nums", row.income ? "text-success" : "text-foreground")}>{row.amount}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom navigation + gesture bar */}
            <div className="mt-auto shrink-0 border-t border-border/50 bg-card/80 px-7 pb-2.5 pt-3">
              <div className="flex items-center justify-between text-muted-foreground">
                <House className="size-4" />
                <span className="relative text-foreground">
                  <Inbox className="size-4" />
                  <span className={cn("absolute -right-1 -top-1 size-2 rounded-full bg-primary ring-2 ring-card transition-transform duration-300", landed ? "scale-100" : "scale-0")} />
                </span>
                <Wallet className="size-4" />
                <UserRound className="size-4" />
              </div>
              <div className="mx-auto mt-3 h-1 w-24 rounded-full bg-foreground/25" />
            </div>

            <AnimatePresence>{smsVisible && <SmsNotification key="sms" detecting={beat === 2} />}</AnimatePresence>

            {/* Glass reflection */}
            <div className="pointer-events-none absolute inset-0 rounded-[36px] bg-[linear-gradient(115deg,rgb(255_255_255/0.14)_0%,transparent_26%)]" />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function FlowCard({
  step,
  title,
  visible,
  current,
  pulse,
  className,
  children,
}: {
  step: string;
  title: string;
  visible: boolean;
  current: boolean;
  pulse: boolean;
  className: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      aria-hidden
      initial={false}
      animate={visible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 14, scale: 0.96 }}
      transition={springs.smooth}
      className={cn(
        "absolute z-20 w-[176px] rounded-2xl border bg-card p-3 text-foreground transition-[border-color,box-shadow] duration-500",
        current ? "border-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_22%,transparent),var(--shadow-dialog)]" : "border-border shadow-[var(--shadow-dialog)]",
        className,
      )}
    >
      {current && pulse && (
        <motion.span
          aria-hidden
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.1 }}
          transition={{ duration: 1.1, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-primary"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[10px] font-semibold tabular-nums transition-colors duration-300",
            current ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {step}
        </span>
        <p className="text-[11.5px] font-semibold leading-tight">{title}</p>
      </div>
      <div className="mt-2">{children}</div>
    </motion.div>
  );
}

/**
 * The phone plus the floating "flow" cards around it. Its own container: wide enough (≥520px) it lays the cards
 * around the device; narrower it drops them for a compact step ticker under the phone.
 */
function ProductScene() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const playing = !reduceMotion && inView;
  const loopBeat = useStoryBeat(playing);
  const beat = reduceMotion ? FINAL_BEAT : loopBeat;

  return (
    <div ref={ref} className="@container relative min-w-0">
      <div className="relative mx-auto flex w-full max-w-[640px] flex-col items-center justify-center gap-5 py-2 @min-[520px]:h-[620px] @min-[520px]:py-0">
        {/* Backdrop: lime glow, orbit rings, floor shadow */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="absolute size-[420px] rounded-full bg-primary/30 blur-[100px] dark:bg-primary/20" />
          {[340, 470, 600].map((d) => (
            <div key={d} className="absolute rounded-full border border-foreground/[0.08]" style={{ width: d, height: d }} />
          ))}
        </div>

        <span className="absolute left-0 top-0 z-30 hidden items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-2.5 py-1 text-[11px] text-muted-foreground @min-[520px]:inline-flex @min-[620px]:left-auto @min-[620px]:right-0">
          <Sparkles className="size-3 text-primary-accent-text" />
          Illustration · sample data
        </span>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 40, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ ...springs.gentle, delay: 0.25 }}
          role="img"
          aria-label="Illustration with sample data: a bank SMS alert arrives on an Android phone, FlowFi detects it, and it becomes a transaction candidate ready for your review."
          className="relative z-10 [zoom:0.82] @min-[284px]:[zoom:1]"
        >
          <div aria-hidden className="absolute -bottom-6 left-1/2 h-8 w-[230px] -translate-x-1/2 rounded-[50%] bg-black/25 blur-xl dark:bg-black/60" />
          <PhoneMockup beat={beat} playing={playing} />
        </motion.div>

        <div className="hidden @min-[520px]:contents">
          <FlowCard step="01" title="SMS alert received" visible={beat >= 1} current={beat === 1} pulse={playing} className="left-0 top-[56%] @min-[620px]:top-[15%]">
            <div className="flex items-center gap-2 rounded-xl bg-secondary/70 px-2 py-1.5">
              <MessageSquareText className="size-3.5 text-muted-foreground" />
              <span className="font-mono text-[10px] font-semibold">{SAMPLE_SMS.sender}</span>
              <span className="ml-auto text-[9.5px] text-muted-foreground">now</span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">Rs.1,249.00 debited from A/c XX4821 at BLUELEAF CAFE</p>
          </FlowCard>

          <FlowCard step="02" title="Eligible alert detected" visible={beat >= 2} current={beat === 2 || beat === 3} pulse={playing} className="right-0 top-[8%] @min-[620px]:top-[38%]">
            <dl className="flex flex-col gap-1">
              {SAMPLE_FIELDS.map(([label, value], i) => (
                <div key={label} className="flex items-center gap-1.5 text-[10px]">
                  <motion.span
                    initial={false}
                    animate={beat >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
                    transition={{ ...springs.snappy, delay: beat >= 2 && playing ? 0.3 + i * 0.14 : 0 }}
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  >
                    <Check className="size-2" strokeWidth={3.5} />
                  </motion.span>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="ml-auto truncate font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </FlowCard>

          <FlowCard step="03" title="Ready for review" visible={beat >= 4} current={beat === 4} pulse={playing} className="bottom-[6%] right-[2%] @min-[620px]:bottom-[8%] @min-[620px]:left-[3%] @min-[620px]:right-auto">
            <p className="text-[10px] leading-snug text-muted-foreground">Nothing reaches your books until you confirm it.</p>
            <div className="mt-2 flex items-center gap-1.5 text-[9.5px] font-semibold">
              <span className="rounded-full bg-primary px-2 py-[3px] text-primary-foreground">Import</span>
              <span className="rounded-full border border-border px-2 py-[3px] text-muted-foreground">Dismiss</span>
            </div>
          </FlowCard>
        </div>

        {/* Narrow layouts: a compact ticker replaces the floating cards */}
        <div aria-hidden className="relative z-10 flex w-full max-w-[300px] flex-col items-center gap-3 @min-[520px]:hidden">
          <ol className="grid w-full grid-cols-3 gap-2">
            {STORY_STEPS.map((s) => {
              const reached = beat >= s.beat;
              return (
                <li key={s.label} className="flex flex-col gap-1.5">
                  <span className="h-1 overflow-hidden rounded-full bg-foreground/10">
                    <span className={cn("block h-full rounded-full bg-primary transition-[width] duration-700 ease-out", reached ? "w-full" : "w-0")} />
                  </span>
                  <span className={cn("text-[11px] font-medium transition-colors duration-300", reached ? "text-foreground" : "text-tertiary-foreground")}>{s.label}</span>
                </li>
              );
            })}
          </ol>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-tertiary-foreground">
            <Sparkles className="size-3 text-primary-accent-text" />
            Illustration · sample data
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Download ──

const QR_CORNERS = [
  "left-0 top-0 rounded-tl-[14px] border-l-[2.5px] border-t-[2.5px]",
  "right-0 top-0 rounded-tr-[14px] border-r-[2.5px] border-t-[2.5px]",
  "bottom-0 left-0 rounded-bl-[14px] border-b-[2.5px] border-l-[2.5px]",
  "bottom-0 right-0 rounded-br-[14px] border-b-[2.5px] border-r-[2.5px]",
] as const;

/**
 * The QR module grid is rendered untouched at a fixed size on a plain white tile with its own quiet zone — never
 * scaled, transformed or faded. Brackets and the beam are separate, non-interactive overlays; the beam uses
 * `mix-blend-multiply`, which can only darken, so dark modules stay dark and light/dark contrast is preserved.
 */
function QrFrame({ animate }: { animate: boolean }) {
  return (
    <div className="relative w-fit shrink-0 p-2.5">
      {QR_CORNERS.map((corner) => (
        <motion.span
          key={corner}
          aria-hidden
          animate={animate ? { opacity: [0.5, 1, 0.5] } : { opacity: 0.9 }}
          transition={animate ? { duration: 2.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}
          className={cn("absolute size-6 border-primary-accent-text", corner)}
        />
      ))}
      {/* Always a white tile with dark modules, in both themes — inverted QR codes scan unreliably. */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-white p-3 shadow-e3">
        <QRCodeSVG value={APK_DOWNLOAD_URL} size={128} level="M" />
        {animate && (
          <motion.span
            aria-hidden
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: [8, 141], opacity: [0, 0.9, 0.9, 0] }}
            transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 1.8, ease: "easeInOut" }}
            className="pointer-events-none absolute inset-x-2 top-0 h-[3px] rounded-full mix-blend-multiply"
            style={{ background: "linear-gradient(90deg, transparent, var(--primary) 18%, var(--primary) 82%, transparent)" }}
          />
        )}
      </div>
    </div>
  );
}

function ComingSoonTile({ animate }: { animate: boolean }) {
  return (
    <div aria-hidden className="relative grid size-[132px] shrink-0 place-items-center rounded-[26px] border border-border/70 bg-card shadow-e2">
      <motion.div
        animate={animate ? { rotate: 360 } : { rotate: 0 }}
        transition={animate ? { duration: 24, repeat: Infinity, ease: "linear" } : { duration: 0 }}
        className="absolute inset-4 rounded-full border border-dashed border-border-strong/60"
      >
        <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_12px_2px_color-mix(in_oklch,var(--primary)_60%,transparent)]" />
      </motion.div>
      <span className="relative flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary via-primary to-success/70 text-primary-foreground">
        <Smartphone className="size-5" />
      </span>
    </div>
  );
}

function DownloadPanel({ anchorRef, pulse }: { anchorRef: RefObject<HTMLDivElement | null>; pulse: number }) {
  const reduceMotion = useReducedMotion();
  const inView = useInView(anchorRef, { amount: 0.35 });
  const animate = !reduceMotion && inView;
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const timer = copiedTimer;
    return () => clearTimeout(timer.current);
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(APK_DOWNLOAD_URL);
      toast.success("Download link copied");
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2200);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <div
      ref={anchorRef}
      tabIndex={-1}
      role="region"
      aria-labelledby={titleId}
      className="relative border-t border-border/60 bg-secondary/50 px-5 py-6 outline-none @2xl:px-10 @2xl:py-7"
    >
      {pulse > 0 && (
        <motion.span
          key={pulse}
          aria-hidden
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.6, delay: 0.4, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 bg-primary/[0.07] shadow-[inset_0_0_0_2px_var(--primary)]"
        />
      )}

      {APK_CONFIGURED ? (
        <div className="relative flex flex-col gap-6 @3xl:flex-row @3xl:items-center @3xl:gap-10">
          <div className="flex min-w-0 flex-1 flex-col gap-5 @md:flex-row @md:items-center @md:gap-7">
            <QrFrame animate={animate} />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-accent-text">Install on Android</p>
              <h3 id={titleId} className="mt-1.5 font-heading text-lg font-semibold tracking-tight @2xl:text-xl">
                Scan with your Android phone
              </h3>
              <ol className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
                {SCAN_STEPS.map((text, i) => (
                  <li key={text} className="flex items-start gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold tabular-nums text-foreground">
                      {i + 1}
                    </span>
                    {text}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-tertiary-foreground">Android may ask you to allow installs from your browser first.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 @sm:flex-row @3xl:w-[236px] @3xl:flex-col">
            <a href={APK_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className={cn(PRIMARY_CTA, "@sm:flex-1 @3xl:flex-none")} style={PRIMARY_GLOW}>
              <CtaSheen />
              <Download className="size-4" />
              Download APK
            </a>
            <button type="button" onClick={handleCopy} className={cn(SECONDARY_CTA, "@sm:flex-1 @3xl:flex-none")}>
              {copied ? <Check className="size-4 text-primary-accent-text" /> : <Copy className="size-4" />}
              {copied ? "Link copied" : "Copy download link"}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-col gap-5 @md:flex-row @md:items-center @md:gap-7">
          <ComingSoonTile animate={animate} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-accent-text">Android app</p>
            <h3 id={titleId} className="mt-1.5 font-heading text-lg font-semibold tracking-tight @2xl:text-xl">
              Android download coming soon
            </h3>
            <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
              The FlowFi Android download isn&apos;t available on this site yet. When it is, a download button and QR code will appear right
              here — the setup steps below stay the same.
            </p>
          </div>
          <span className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-full border border-border bg-card px-3.5 text-xs font-medium text-muted-foreground @md:self-center">
            <Clock3 className="size-3.5 text-primary-accent-text" />
            Coming soon
          </span>
        </div>
      )}
    </div>
  );
}

// ── Setup guide ──

function StageVisual({ visual }: { visual: (typeof SETUP_STAGES)[number]["visual"] }) {
  if (visual === "app") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-2.5 shadow-e2 transition-[translate] duration-300 group-hover:-translate-y-0.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary via-primary to-success/70 text-primary-foreground">
          <PackageOpen className="size-4" />
        </span>
        <div>
          <p className="text-xs font-semibold">FlowFi for Android</p>
          <p className="text-[10px] text-muted-foreground">APK download</p>
        </div>
        <span className="ml-1 flex size-6 items-center justify-center rounded-full bg-foreground text-background transition-[translate] duration-300 group-hover:translate-y-0.5">
          <ArrowDown className="size-3" />
        </span>
      </div>
    );
  }

  if (visual === "connect") {
    // Neutral "off" switches at rest — an instruction, never a status. Hover previews the action.
    const rows = [
      { icon: LockKeyhole, label: "Sign in", toggle: false },
      { icon: MessageSquareText, label: "SMS access", toggle: true },
      { icon: RefreshCw, label: "Auto Sync", toggle: true },
    ] as const;
    return (
      <div className="flex w-[188px] flex-col gap-1.5">
        {rows.map((row, i) => (
          <div key={row.label} className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 shadow-e1">
            <row.icon className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] font-medium">{row.label}</span>
            {row.toggle ? (
              <span className="relative ml-auto h-3.5 w-6 rounded-full bg-border transition-colors duration-300 group-hover:bg-primary" style={{ transitionDelay: `${i * 90}ms` }}>
                <span
                  className="absolute left-0.5 top-0.5 size-2.5 rounded-full bg-card shadow-e1 transition-[translate] duration-300 group-hover:translate-x-2.5"
                  style={{ transitionDelay: `${i * 90}ms` }}
                />
              </span>
            ) : (
              <span className="ml-auto size-3.5 rounded-full border border-border" />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="w-[200px] rounded-xl border border-border/60 bg-card p-2.5 shadow-e2 transition-[translate] duration-300 group-hover:-translate-y-0.5">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-[9.5px] font-semibold text-primary-accent-text">BC</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold">{SAMPLE_SMS.merchant}</p>
          <p className="text-[9.5px] text-muted-foreground">Sample alert</p>
        </div>
        <span className="text-[11px] font-semibold tabular-nums text-expense">−₹1,249</span>
      </div>
      <div className="mt-2 flex justify-end gap-1.5 text-[9.5px] font-semibold">
        <span className="rounded-full border border-border px-2 py-[3px] text-muted-foreground">Dismiss</span>
        <span className="rounded-full bg-primary px-2 py-[3px] text-primary-foreground">Import</span>
      </div>
    </div>
  );
}

function Disclosure({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="rounded-xl border border-border/60 bg-secondary/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-medium text-foreground"
      >
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-primary-accent-text" />
          {title}
        </span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SetupGuide({ sectionRef, hidden }: { sectionRef: RefObject<HTMLElement | null>; hidden: boolean }) {
  const reduceMotion = useReducedMotion();
  const headingId = useId();
  const bodyId = useId();

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      className="@container scroll-mt-6 rounded-[24px] border border-border/60 bg-card p-5 shadow-e1 @2xl:p-8"
    >
      <div className="flex flex-col gap-4 @xl:flex-row @xl:items-end @xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-accent-text">Setup guide</p>
          <h3 id={headingId} className="mt-1.5 font-heading text-xl font-semibold tracking-tight text-foreground @2xl:text-2xl">
            Up and running in three steps
          </h3>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">Everything happens on your Android phone. This inbox simply waits for the alerts it finds.</p>
        </div>
        <button
          type="button"
          aria-expanded={!hidden}
          aria-controls={bodyId}
          onClick={() => setGuideHidden(!hidden)}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 self-start rounded-xl border border-border bg-card px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground @xl:self-auto"
        >
          {hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          {hidden ? "Show setup guide" : "Hide guide"}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!hidden && (
          <motion.div
            id={bodyId}
            key="guide"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: easings.out }}
            className="overflow-hidden"
          >
            <motion.ol
              variants={stagger.container}
              initial={reduceMotion ? false : "hidden"}
              whileInView="show"
              viewport={{ once: true, amount: 0.25 }}
              className="mt-6 grid gap-5 @3xl:grid-cols-3"
            >
              {SETUP_STAGES.map((stage, index) => (
                <motion.li
                  key={stage.number}
                  variants={stagger.item}
                  className="group relative flex flex-col rounded-2xl border border-border/60 bg-background/60 p-3 transition-[translate,box-shadow,border-color] duration-300 hover:-translate-y-1 hover:border-border hover:shadow-e3"
                >
                  <div
                    className="flex h-[124px] items-center justify-center overflow-hidden rounded-xl bg-secondary/70"
                    style={{ backgroundImage: "radial-gradient(circle, var(--border-subtle) 1px, transparent 1px)", backgroundSize: "14px 14px" }}
                  >
                    <StageVisual visual={stage.visual} />
                  </div>
                  <div className="mt-4 flex items-center gap-2.5 px-1">
                    <span className="font-heading text-[13px] font-semibold tabular-nums text-primary-accent-text">{stage.number}</span>
                    <span className="h-px flex-1 bg-border/70" />
                    <span className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary-accent-text">
                      <stage.icon className="size-3.5" />
                    </span>
                  </div>
                  <h4 className="mt-2 px-1 font-heading text-base font-semibold tracking-tight text-foreground">{stage.title}</h4>
                  <p className="mt-1 px-1 pb-1 text-sm leading-relaxed text-muted-foreground">{stage.description}</p>

                  {index < SETUP_STAGES.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute -bottom-[17px] left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-e1 @3xl:bottom-auto @3xl:left-auto @3xl:-right-[17px] @3xl:top-[62px] @3xl:translate-x-0"
                    >
                      <ArrowDown className="size-3.5 @3xl:hidden" />
                      <ArrowRight className="hidden size-3.5 @3xl:block" />
                    </span>
                  )}
                </motion.li>
              ))}
            </motion.ol>

            <div className="mt-5 flex flex-col gap-2">
              <Disclosure icon={ListChecks} title="Detailed setup instructions">
                <ol className="grid gap-x-8 gap-y-3 px-4 pb-4 pt-1 @2xl:grid-cols-2">
                  {SETUP_STEPS.map((step, i) => (
                    <li key={step.title} className="flex gap-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-card text-[11px] font-semibold tabular-nums text-foreground shadow-e1">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{step.title}</p>
                        <p className="text-xs leading-relaxed text-muted-foreground">{step.description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Disclosure>
              <Disclosure icon={ShieldCheck} title="What FlowFi does with your SMS">
                <p className="px-4 pb-4 pt-1 text-sm leading-relaxed text-muted-foreground">
                  The Android app only reads messages that look like bank transaction alerts, and only to suggest entries here — nothing is
                  added to your books automatically. Every candidate waits for you to review and confirm it before it becomes a real
                  transaction.
                </p>
              </Disclosure>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ── Page ──

export function SmsSyncOnboarding() {
  const reduceMotion = useReducedMotion();
  const downloadRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef<HTMLElement>(null);
  const [downloadPulse, setDownloadPulse] = useState(0);
  const guideHidden = useSyncExternalStore(subscribeGuide, readGuideHidden, () => false);
  const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";

  const goToDownload = () => {
    downloadRef.current?.scrollIntoView({ behavior, block: "center" });
    downloadRef.current?.focus({ preventScroll: true });
    setDownloadPulse((n) => n + 1);
  };

  const goToSetup = () => {
    if (guideHidden) setGuideHidden(false);
    setupRef.current?.scrollIntoView({ behavior, block: "start" });
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <section
        aria-label="SMS Auto Sync"
        // Theme-aware surface: a card with a soft lime wash toward the phone — light in light mode, dark in dark mode.
        className="@container/hero relative overflow-hidden rounded-[28px] border border-border/60 text-foreground shadow-e3"
        style={{ background: "linear-gradient(125deg, var(--card) 0%, var(--card) 42%, color-mix(in oklch, var(--primary) 12%, var(--card)) 100%)" }}
      >
        {/* Atmosphere: masked grid, corner glow, top highlight */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(to right, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 6%, transparent) 1px, transparent 1px)",
              backgroundSize: "44px 44px",
              maskImage: "radial-gradient(ellipse 70% 65% at 68% 42%, black, transparent 78%)",
              WebkitMaskImage: "radial-gradient(ellipse 70% 65% at 68% 42%, black, transparent 78%)",
            }}
          />
          <div className="absolute -left-40 -top-48 size-[460px] rounded-full bg-primary/[0.12] blur-[110px] dark:bg-primary/[0.08]" />
          <div className="absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        </div>

        {/* Very wide heroes cap the composition and tighten the split, so the copy and the phone stay one group instead of
            drifting to opposite edges with dead space between them. */}
        <div className="relative grid gap-8 px-5 pb-6 pt-7 @2xl/hero:px-10 @2xl/hero:pt-10 @4xl/hero:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @4xl/hero:items-center @4xl/hero:gap-6 @4xl/hero:px-8 @4xl/hero:py-8 @6xl/hero:mx-auto @6xl/hero:w-full @6xl/hero:max-w-[1400px] @6xl/hero:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @6xl/hero:gap-10 @6xl/hero:px-12">
          {/* Story */}
          <motion.div
            variants={heroContainer}
            initial={reduceMotion ? false : "hidden"}
            animate="show"
            className="@container flex min-w-0 max-w-2xl flex-col gap-6"
          >
            <motion.p variants={heroItem} className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-accent-text">
              <span className="h-px w-6 bg-primary-accent-text" />
              FlowFi SMS Sync
              <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">Android</span>
            </motion.p>

            <div className="flex flex-col gap-4">
              <motion.h2
                variants={heroItem}
                className="font-heading text-[length:clamp(1.75rem,9.6cqi,3.5rem)] font-semibold leading-[1.04] tracking-[-0.035em]"
              >
                <span className="block">Every bank alert.</span>
                {/* Lime text only reads on dark; light mode uses the deep olive accent with a lime underline swash. */}
                <span className="relative isolate block w-fit text-primary-accent-text">
                  One clear view.
                  <span aria-hidden className="absolute inset-x-0 bottom-[0.06em] -z-10 h-[0.28em] rounded-full bg-primary/55 dark:hidden" />
                </span>
              </motion.h2>
              <motion.p variants={heroItem} className="max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
                FlowFi for Android spots eligible bank SMS alerts and turns them into transaction candidates. Review each one here before it
                touches your books.
              </motion.p>
            </div>

            <motion.div variants={heroItem} className="flex flex-wrap gap-3">
              {/* Phone-width layouts download directly; wider ones jump to the QR, which is what a desktop visitor needs. */}
              {APK_CONFIGURED && (
                <a href={APK_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className={cn(PRIMARY_CTA, "@2xl/hero:hidden")} style={PRIMARY_GLOW}>
                  <CtaSheen />
                  <Download className="size-4" />
                  Download APK
                </a>
              )}
              <button
                type="button"
                onClick={goToDownload}
                className={cn(PRIMARY_CTA, APK_CONFIGURED && "hidden @2xl/hero:inline-flex")}
                style={PRIMARY_GLOW}
              >
                <CtaSheen />
                <Smartphone className="size-4" />
                Get Android App
                <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
              </button>
              <button type="button" onClick={goToSetup} className={SECONDARY_CTA}>
                How it works
                <ArrowDown className="size-4 text-muted-foreground" />
              </button>
            </motion.div>

            <motion.ul variants={heroItem} className="flex flex-col divide-y divide-border/60 border-y border-border/60">
              {HIGHLIGHTS.map((h) => (
                <li key={h.title} className="flex items-center gap-3 py-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary-accent-text">
                    <h.icon className="size-4" />
                  </span>
                  <p className="min-w-0 text-[13px] leading-snug">
                    <span className="font-semibold text-foreground">{h.title}</span>
                    <span className="text-muted-foreground"> — {h.description}</span>
                  </p>
                </li>
              ))}
            </motion.ul>

            <motion.div variants={heroItem} className="flex items-start gap-2.5">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                No SMS candidates right now. Already using the Android app? New eligible alerts will show up here for review.
              </p>
            </motion.div>
          </motion.div>

          <ProductScene />
        </div>

        <DownloadPanel anchorRef={downloadRef} pulse={downloadPulse} />
      </section>

      <SetupGuide sectionRef={setupRef} hidden={guideHidden} />
    </div>
  );
}
