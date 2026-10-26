"use client";

/**
 * What a phone's camera opens after scanning the pairing QR on FlowFi Web. Public (no sign-in, no access gate): it
 * never reads or writes anything about the account — it only hands the one-time token to the FlowFi Android app, which
 * does the real, authenticated pairing. Opening this page proves nothing and is never counted as a setup step.
 *
 * Two ways forward: "Download FlowFi" (the signed APK published on this site, described by
 * /downloads/flowfi-android.json) and "Open FlowFi" (an `intent://` link — Chrome opens the app if it is installed,
 * otherwise returns here with `missing=1`). A timeout or `missing=1` is only a hint that the app may be absent, so the
 * wording stays "if it isn't installed yet". Downloading a file never proves it was installed: the Download → Install
 * → Pair row only moves its "you are here" marker to the next instruction — it never ticks a step off — and after the
 * download the page tells the user to come back to THIS page (the one-time code is still in its address) and tap Open.
 *
 * Install help never coaches anyone past a security block: if Google Play Protect blocks the install, the page says to
 * stop and keep Play Protect on (Android blocks web-downloaded apps that request SMS access).
 */

import { ChevronDown, Download, ExternalLink, KeyRound, Monitor, RefreshCw, ShieldCheck, Smartphone, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useAndroidRelease } from "@/hooks/use-android-release";
import { codeLikelyExpired, formatApkSize } from "@/lib/sms-pairing/android-release";
import { buildAppPairingLinks, isPairingToken } from "@/lib/sms-pairing/pairing-links";
import { cn } from "@/lib/utils";

/** Build-time fallback for deployments that host the APK elsewhere; the published manifest wins when present. */
const ENV_APK_URL = process.env.NEXT_PUBLIC_ANDROID_APK_URL ?? "";

const subscribeNever = () => () => {};
const readIsAndroid = () => /Android/i.test(navigator.userAgent);
const readHref = () => window.location.href;

// ── When this phone first saw this code (to estimate expiry; the page can't read the session) ──

const TICK_MS = 15_000;
let tickValue = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const tickListeners = new Set<() => void>();
function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  tickValue = Date.now();
  tickTimer ??= setInterval(() => {
    tickValue = Date.now();
    tickListeners.forEach((l) => l());
  }, TICK_MS);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}
const readTick = () => tickValue || (tickValue = Date.now());

function firstSeenKey(token: string) {
  return `flowfi.pair.firstSeen.${token.slice(0, 12)}`;
}
/** Idempotent: the first read stores "now" for this code in this tab; storage failures just disable the estimate. */
function readFirstSeen(token: string | null): number {
  if (!token) return 0;
  try {
    const key = firstSeenKey(token);
    const stored = Number(window.sessionStorage.getItem(key));
    if (stored > 0) return stored;
    const now = Date.now();
    window.sessionStorage.setItem(key, String(now));
    return now;
  } catch {
    return 0;
  }
}

// ── Presentation ──

const BTN_BASE =
  "inline-flex h-13 w-full items-center justify-center gap-2 rounded-2xl px-5 text-[15px] font-semibold transition-[transform,background-color,box-shadow] duration-150 active:scale-[0.98]";
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-[0_12px_28px_-14px_var(--primary-accent-text)] hover:bg-[var(--primary-hover)]`;
const BTN_SECONDARY = `${BTN_BASE} border border-border bg-card text-foreground hover:bg-secondary`;

/** Staggered entrance: one small step per block, so the page settles top to bottom in well under half a second. */
const rise = (i: number): CSSProperties => ({ animationDelay: `${i * 55}ms` });

const STEPS = ["Download", "Install", "Pair"] as const;

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex size-7 items-center justify-center overflow-hidden rounded-[9px] bg-gradient-to-br from-primary via-primary to-success/70 font-heading text-[13px] font-bold text-primary-foreground ring-1 ring-primary-accent-text/30">
        <span aria-hidden className="absolute -top-2.5 -right-2.5 size-5 rounded-full bg-white/40 blur-md" />
        <span className="relative">F</span>
      </span>
      <span className="font-heading text-[15px] font-semibold tracking-tight">
        FlowFi <span className="text-muted-foreground">Connect</span>
      </span>
    </div>
  );
}

/** Web → phone hand-off. Illustration only: it loops the same way whatever the real state is, and says nothing. */
function HandoffArt() {
  return (
    <div
      aria-hidden
      className="relative flex h-24 items-center overflow-hidden rounded-3xl border border-border/60 bg-card px-6 shadow-e2 [background-image:radial-gradient(120%_140%_at_100%_50%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_60%)]"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-secondary text-muted-foreground">
        <Monitor className="size-5" />
      </span>
      <span className="relative mx-3 h-0 flex-1 border-t-2 border-dotted border-border-strong/70">
        <span className="animate-pair-travel absolute inset-x-0 -top-[5px] block">
          <span className="absolute -left-1 block size-2 rounded-full bg-primary-accent-text shadow-[0_0_10px_2px_color-mix(in_oklch,var(--primary)_70%,transparent)]" />
        </span>
      </span>
      <span className="relative flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/20 text-primary-accent-text ring-1 ring-primary-accent-text/25">
        <span className="animate-pair-halo absolute inset-0 rounded-2xl ring-2 ring-primary-accent-text/60" />
        <Smartphone className="relative size-5" />
      </span>
    </div>
  );
}

/** Where the user is in the instructions — a marker, not a record of anything having happened. */
function StepRow({ current }: { current: number }) {
  return (
    <ol aria-label="Setup steps" className="flex items-center gap-2 text-[12px] font-medium" data-testid="pair-steps">
      {STEPS.map((label, i) => {
        const here = i === current;
        return (
          <li key={label} aria-current={here ? "step" : undefined} className="flex flex-1 items-center gap-2 last:flex-none">
            <span className={cn("flex items-center gap-1.5 transition-colors duration-300", here ? "text-foreground" : "text-tertiary-foreground")}>
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors duration-300",
                  here ? "bg-primary text-primary-foreground" : "border border-border bg-card",
                )}
              >
                {i + 1}
              </span>
              {label}
            </span>
            {i < STEPS.length - 1 && <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

/** Height-animated disclosure (grid 0fr → 1fr), so expanding help never jumps the page. */
function Collapsible({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return (
    <div id={id} className={cn("grid transition-[grid-template-rows] duration-300 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")} inert={!open}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function Notice({ tone, children, ...rest }: { tone: "warning" | "muted"; children: ReactNode } & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...rest}
      className={cn(
        "flex items-start gap-2.5 rounded-2xl p-3.5 text-[13px] leading-relaxed",
        tone === "warning" ? "border border-warning/40 bg-warning/10 text-foreground" : "bg-secondary/70 text-muted-foreground",
      )}
    >
      {tone === "warning" && <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

export function PairLanding() {
  const params = useSearchParams();
  const token = params.get("t");
  const missing = params.get("missing") === "1";
  const isAndroid = useSyncExternalStore(subscribeNever, readIsAndroid, () => false);
  const href = useSyncExternalStore(subscribeNever, readHref, () => "");
  const now = useSyncExternalStore(subscribeTick, readTick, () => 0);
  const valid = isPairingToken(token);
  const firstSeen = useSyncExternalStore(subscribeNever, () => readFirstSeen(valid ? token : null), () => 0);
  const links = valid && href ? buildAppPairingLinks(token!, href) : null;
  const host = href ? new URL(href).host : "";

  const releaseState = useAndroidRelease();
  const release = releaseState.status === "ready" ? releaseState.release : null;
  const downloadUrl = release?.url ?? (ENV_APK_URL || null);
  const downloadPending = releaseState.status === "loading" && !ENV_APK_URL;

  // The click only means the browser was asked to fetch the file — never that FlowFi is installed.
  const [downloadTapped, setDownloadTapped] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [checksumOpen, setChecksumOpen] = useState(false);
  const helpId = useId();
  const checksumId = useId();
  const likelyExpired = valid && firstSeen > 0 && now > 0 && codeLikelyExpired(firstSeen, now);

  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] text-foreground sm:items-center sm:py-10">
      <div className="flex w-full max-w-[420px] flex-col gap-5">
        <header style={rise(0)} className="animate-pair-rise">
          <Brand />
        </header>

        {!valid ? (
          <section style={rise(1)} className="animate-pair-rise flex flex-col gap-4">
            <h1 className="font-heading text-[26px] leading-tight font-semibold tracking-tight">This pairing link isn&apos;t valid</h1>
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              It may be incomplete. On FlowFi Web, open the Transaction Inbox and scan the pairing code again.
            </p>
            <Link href="/transaction-candidates/" className={BTN_SECONDARY}>
              <RefreshCw className="size-4" aria-hidden />
              Open Transaction Inbox
            </Link>
          </section>
        ) : (
          <>
            <div style={rise(1)} className="animate-pair-rise">
              <HandoffArt />
            </div>

            <div style={rise(2)} className="animate-pair-rise">
              <h1 className="font-heading text-[28px] leading-[1.15] font-semibold tracking-tight">Connect your phone</h1>
              <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                Install FlowFi, then approve pairing in the app. Nothing is shared until you approve.
              </p>
            </div>

            {likelyExpired && (
              <Notice tone="warning" role="alert" data-testid="pair-likely-expired">
                This code has probably expired — you opened it over 10 minutes ago. On FlowFi Web, tap <strong>New code</strong> and scan again.
              </Notice>
            )}

            {href && !isAndroid && (
              <Notice tone="muted" data-testid="pair-not-android">
                SMS Sync needs an Android phone. Scan the code with the phone you want to connect.
              </Notice>
            )}

            {downloadUrl && (
              <div style={rise(3)} className="animate-pair-rise">
                <StepRow current={downloadTapped ? 1 : 0} />
              </div>
            )}

            <div style={rise(4)} className="animate-pair-rise flex flex-col gap-2.5">
              {downloadUrl && (
                <a href={downloadUrl} download data-testid="pair-download-apk" onClick={() => setDownloadTapped(true)} className={BTN_PRIMARY}>
                  <Download className="size-[18px]" aria-hidden />
                  Download FlowFi
                </a>
              )}
              {links && (
                <a href={isAndroid ? links.intentUrl : links.schemeUrl} data-testid="pair-open-app" className={downloadUrl ? BTN_SECONDARY : BTN_PRIMARY}>
                  <ExternalLink className="size-4" aria-hidden />
                  Open FlowFi
                </a>
              )}

              {release && (
                <div className="flex flex-col">
                  <p className="flex items-center justify-center gap-2 text-[12px] text-tertiary-foreground tabular-nums">
                    <span>Android · v{release.version}</span>
                    <span aria-hidden>·</span>
                    <span>{formatApkSize(release.sizeBytes)}</span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      aria-expanded={checksumOpen}
                      aria-controls={checksumId}
                      onClick={() => setChecksumOpen((o) => !o)}
                      className="-my-2 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 font-medium text-muted-foreground underline-offset-2 hover:underline"
                    >
                      SHA-256
                      <ChevronDown className={cn("size-3 transition-transform duration-200", checksumOpen && "rotate-180")} aria-hidden />
                    </button>
                  </p>
                  <Collapsible open={checksumOpen} id={checksumId}>
                    <p className="mt-2 rounded-xl bg-secondary/70 px-3 py-2 text-center font-mono text-[11px] leading-relaxed break-all text-muted-foreground" data-testid="pair-sha256">
                      {release.sha256}
                    </p>
                  </Collapsible>
                </div>
              )}
            </div>

            {missing && (
              <Notice tone="warning" role="status">
                FlowFi didn&apos;t open. If it isn&apos;t installed yet,{" "}
                {downloadUrl
                  ? "download and install it, then come back to this page and tap Open FlowFi."
                  : "the Android download isn't published on this site yet — install FlowFi from the link you were given, then come back and tap Open FlowFi."}
              </Notice>
            )}

            {!downloadUrl && !downloadPending && !missing && (
              <Notice tone="muted">FlowFi for Android isn&apos;t published on this site yet. If FlowFi is already on this phone, tap Open FlowFi.</Notice>
            )}

            {downloadTapped && (
              <p role="status" data-testid="pair-download-started" className="animate-pair-rise text-center text-[13px] leading-relaxed text-muted-foreground">
                Download requested. Downloading doesn&apos;t install FlowFi — open the file to install it, then tap{" "}
                <strong className="text-foreground">Open FlowFi</strong>.
              </p>
            )}

            {downloadUrl && (
              <div style={rise(5)} className="animate-pair-rise rounded-2xl border border-border/60 bg-card">
                <button
                  type="button"
                  aria-expanded={helpOpen}
                  aria-controls={helpId}
                  onClick={() => setHelpOpen((o) => !o)}
                  data-testid="pair-install-help-toggle"
                  className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 text-left text-[14px] font-medium"
                >
                  Trouble installing?
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-300", helpOpen && "rotate-180")} aria-hidden />
                </button>
                <Collapsible open={helpOpen} id={helpId}>
                  <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground" data-testid="pair-install-help">
                    <ol className="list-decimal space-y-1.5 pl-4 marker:text-tertiary-foreground">
                      <li>
                        Chrome may ask you to confirm downloading an app file. Continue only if the address bar shows{" "}
                        <strong className="text-foreground">{host || "this site"}</strong>.
                      </li>
                      <li>
                        Open the file from your notifications. If Android asks, allow Chrome to <em>install unknown apps</em> for this install.
                      </li>
                      <li>
                        Come back here and tap <strong className="text-foreground">Open FlowFi</strong>. Your code is still in this page&apos;s address.
                      </li>
                    </ol>
                    <p data-testid="pair-play-protect" className="rounded-xl bg-secondary/70 p-3 text-foreground">
                      <strong>If Google Play Protect blocks FlowFi, stop there and keep Play Protect on.</strong>{" "}
                      <span className="text-muted-foreground">
                        Android can block apps that ask for SMS access when they&apos;re downloaded from a website. You can keep using FlowFi on the web.
                      </span>
                    </p>
                  </div>
                </Collapsible>
              </div>
            )}

            <ul style={rise(6)} className="animate-pair-rise flex flex-col gap-3 border-t border-border/60 pt-5 text-[13px] leading-relaxed text-muted-foreground">
              <li className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary-accent-text" aria-hidden />
                <span>
                  SMS access is used only to find bank alerts. They reach your account only after you approve pairing, and nothing becomes a transaction until
                  you review it.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-primary-accent-text" aria-hidden />
                <span>Sign in with your FlowFi Web account. This code works once and expires 10 minutes after it was created.</span>
              </li>
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
