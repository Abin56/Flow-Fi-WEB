"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV_BY_HREF, NAV_ITEMS, navItemForPath } from "@/components/layout/nav-items";
import { previousPage, readNavPrefs, recordVisit, useNavPrefs } from "@/components/layout/nav-prefs";

/** True while the user is typing — single-letter shortcuts must never steal keystrokes from a field. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** An open dialog/sheet means the user is mid-task (maybe mid-form): shortcuts stay out of the way. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

const CHORDS = new Map(NAV_ITEMS.map((item) => [item.chord, item]));
const CHORD_WINDOW_MS = 1800;

/**
 * Fast navigation for keyboard users (mounted once in the app shell; renders only a small hint while armed):
 *   Alt+1 … Alt+4   open the pinned Quick access pages
 *   Alt+P           flip back to the previous page
 *   g then a letter go to any page (g a Accounts, g l Loan & EMI, g d Dashboard …) — letters are shown in ⌘K
 * Also records each page visit so "Recent" and "previous" work. Presentation/navigation only.
 */
export function NavShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const prefs = useNavPrefs();
  const reduceMotion = useReducedMotion();
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const timer = useRef(0);
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
    const item = navItemForPath(pathname);
    if (item) recordVisit(item.href);
  }, [pathname]);

  useEffect(() => {
    const go = (href: string) => {
      if (navItemForPath(pathRef.current)?.href === href) return;
      router.push(href);
    };
    const disarm = () => {
      armedRef.current = false;
      window.clearTimeout(timer.current);
      setArmed(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;

      // Alt shortcuts — layout-independent via e.code (Option+digit types symbols on a Mac).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const digit = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
        const wantsPrevious = e.code === "KeyP";
        if (!digit && !wantsPrevious) return;
        if (overlayOpen()) return;
        const { pins, recents } = readNavPrefs();
        const href = digit ? pins[Number(digit[1]) - 1] : previousPage(recents, navItemForPath(pathRef.current)?.href);
        if (!href) return;
        e.preventDefault();
        go(href);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (armedRef.current) {
        disarm();
        if (e.key === "Escape") return;
        const item = CHORDS.get(e.key.toLowerCase());
        if (item) {
          e.preventDefault();
          go(item.href);
        }
        return;
      }

      if (e.key === "g" && !e.shiftKey && !isTyping(e.target) && !overlayOpen()) {
        armedRef.current = true;
        setArmed(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(disarm, CHORD_WINDOW_MS);
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer.current);
    };
  }, [router]);

  const hints = prefs.pins.flatMap((href) => {
    const item = NAV_BY_HREF.get(href);
    return item ? [item] : [];
  });

  return (
    <AnimatePresence>
      {armed && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
          className="pointer-events-none fixed bottom-5 left-1/2 z-command flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 overflow-hidden rounded-full border border-border bg-popover/95 px-4 py-2 text-xs text-popover-foreground shadow-lg backdrop-blur"
        >
          <span className="font-semibold">Go to</span>
          {hints.map((item) => (
            <span key={item.href} className="flex items-center gap-1.5 whitespace-nowrap text-foreground/75">
              <kbd className="rounded-md border border-border bg-muted px-1.5 py-px font-sans text-[11px] font-semibold uppercase text-foreground">{item.chord}</kbd>
              {item.label}
            </span>
          ))}
          <span className="hidden whitespace-nowrap text-foreground/50 sm:inline">any page letter is in ⌘K · Esc cancels</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
