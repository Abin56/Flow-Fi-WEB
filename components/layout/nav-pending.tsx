"use client";

import { useLinkStatus } from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The ONE source of truth for "a page from the menu is opening" — drives the optimistic row highlight and the slim bar
 * along the top of the window.
 *
 * Why this exists (recurring bug, three earlier fixes): the sidebar used to set its own `pendingHref` on `pointerdown`
 * and clear it only when the pathname changed. Re-rendering on pointerdown swapped the DOM node under the cursor (the
 * hover pill became the active pill), so Chrome dropped the `click` — no navigation, yet the flag stayed set: a dead
 * first click and a bar frozen at 85 %. Nothing else could clear it, because nothing but a successful route change did.
 *
 * Now the flag is never ours to guess: it mirrors the router's own pending state (`useLinkStatus`, which Next resets when
 * a navigation commits, is superseded by another click, or fails), and nothing re-renders the link until `click`.
 */

type Listener = () => void;
let current: string | null = null;
const listeners = new Set<Listener>();

function emit(next: string | null) {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

/** One entry per mounted link that currently reports pending, in start order; the newest is the one shown. */
const pendingLinks: string[] = [];

export function beginNav(href: string) {
  pendingLinks.push(href);
  emit(href);
}

export function endNav(href: string) {
  const at = pendingLinks.indexOf(href);
  if (at !== -1) pendingLinks.splice(at, 1);
  emit(pendingLinks.length > 0 ? pendingLinks[pendingLinks.length - 1] : null);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Href of the menu page that is opening right now, or null (non-hook read). */
export function getNavPending(): string | null {
  return current;
}

/** Href of the menu page that is opening right now, or null. */
export function useNavPending(): string | null {
  return useSyncExternalStore(subscribe, getNavPending, () => null);
}

/**
 * Render as a child of a menu `<Link>` (renders nothing). Reports that link's pending state to the store. The cleanup
 * also ends the report, so an unmounting link (collapsing the rail, the mobile drawer closing) can never leave it set.
 */
export function NavLinkStatus({ href }: { href: string }) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (!pending) return;
    beginNav(href);
    return () => endNav(href);
  }, [pending, href]);
  return null;
}

type Phase = "idle" | "running" | "done";

/**
 * The slim bar along the top of the window. Mount once. It runs while a menu navigation is pending, then completes
 * (fills, fades) and removes itself — the same path for success, supersession and failure, because it only watches the store.
 */
export function NavProgressBar() {
  const active = useNavPending() != null;
  const [phase, setPhase] = useState<Phase>("idle");
  const [grown, setGrown] = useState(false);
  const [prevActive, setPrevActive] = useState(false);

  // Derived during render (no effect): starting restarts the bar at 0 %; stopping a running bar completes it.
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) {
      setPhase("running");
      setGrown(false);
    } else if (phase === "running") {
      setPhase("done");
    }
  }

  useEffect(() => {
    if (phase === "running") {
      // Two frames so the browser paints 0 % first, then eases toward 85 %.
      let inner = 0;
      const outer = window.requestAnimationFrame(() => {
        inner = window.requestAnimationFrame(() => setGrown(true));
      });
      return () => {
        window.cancelAnimationFrame(outer);
        window.cancelAnimationFrame(inner);
      };
    }
    if (phase === "done") {
      const t = window.setTimeout(() => setPhase("idle"), 360);
      return () => window.clearTimeout(t);
    }
  }, [phase]);

  if (phase === "idle") return null;
  const width = phase === "done" ? 100 : grown ? 85 : 0;
  return (
    <div
      aria-hidden
      data-testid="nav-progress"
      data-phase={phase}
      className="pointer-events-none fixed inset-x-0 top-0 z-command h-0.5 overflow-hidden"
      style={{ opacity: phase === "done" ? 0 : 1, transition: phase === "done" ? "opacity 220ms ease 140ms" : undefined }}
    >
      <div
        className="h-full bg-primary-accent-text shadow-[0_0_8px_color-mix(in_oklch,var(--primary)_80%,transparent)] motion-reduce:transition-none"
        style={{
          width: `${width}%`,
          transition: width === 0 ? "none" : width === 100 ? "width 140ms ease-out" : "width 700ms cubic-bezier(0.1, 0.8, 0.2, 1)",
        }}
      />
    </div>
  );
}
