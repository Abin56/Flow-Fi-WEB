"use client";

/**
 * Stacked popups for the Loan & EMI screens.
 *
 * `StackBase` is the compact, centred popup (an EMI's or Loan's details). Every action opened from it — Record Payment,
 * Past payments, Edit, a recorded payment's details — opens in a `StackLayer` instead: a second, compact popup that sits
 * *beside* the base on a wide screen (the base slides left, stays fully visible), cascades over it on a tablet, and rises
 * from the bottom edge on a phone. Neither ever grows the page; each scrolls inside itself. Closing the layer returns to
 * the base exactly as it was.
 *
 * Shells that normally open as a top sheet or a side drawer (`PaymentSheet`, `LoanEmiFormDialog`, `FormDialog`) render as a
 * `StackLayer` when they are mounted inside a `<StackProvider>`, so the existing forms are reused untouched and everywhere
 * else (People, the Add flow, …) keeps its own look. The shells only draw — nothing here writes any data.
 */

import { createContext, useContext, useEffect, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---- which popups are open ----------------------------------------------------------------------------------------------

let bases = 0;
let layers = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => (bases > 0 ? 1 : 0) + (layers > 0 ? 2 : 0);

/** `{ base, layers }` — whether a base popup and at least one layer are open right now. */
function useStackState() {
  const s = useSyncExternalStore(subscribe, snapshot, () => 0);
  return { base: (s & 1) !== 0, layered: (s & 2) !== 0 };
}

function useRegister(open: boolean, kind: "base" | "layer") {
  useEffect(() => {
    if (!open) return;
    if (kind === "base") bases += 1;
    else layers += 1;
    emit();
    return () => {
      if (kind === "base") bases -= 1;
      else layers -= 1;
      emit();
    };
  }, [open, kind]);
}

const InStack = createContext(false);

/** Everything inside opens its actions as stacked layers (see the file header). */
export function StackProvider({ children }: { children: ReactNode }) {
  return <InStack.Provider value>{children}</InStack.Provider>;
}

/** True under a `StackProvider`. */
export function useInStack(): boolean {
  return useContext(InStack);
}

// ---- shared bits -----------------------------------------------------------------------------------------------------------

const CLOSE_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

/** Escape while typing leaves the field first (each field handles its own Escape); the next Escape closes. */
function blurFieldOnEscape(e: { preventDefault: () => void }) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) {
    e.preventDefault();
    setTimeout(() => active.blur(), 0);
  }
}

// ---- the base popup ----------------------------------------------------------------------------------------------------

/**
 * The compact centred popup: a header (the caller's `header`, plus the close button), then `children` — which fill the
 * rest of the fixed-height popup and scroll inside it — then an optional footer. While a layer is open the popup slides
 * to the left (wide screens) and stays fully visible.
 */
export function StackBase({
  open,
  onOpenChange,
  header,
  footer,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must contain the popup's `DialogTitle`. */
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  useRegister(open, "base");
  const { layered } = useStackState();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        data-stack-base=""
        data-stacked={layered || undefined}
        overlayClassName="bg-black/40 backdrop-blur-[2px] dark:bg-black/60"
        className={cn(
          "flex h-[min(44rem,calc(100dvh-1.5rem))] w-[calc(100%-1rem)] max-w-[32rem] flex-col gap-0 overflow-hidden rounded-[18px] border border-border bg-card p-0 ring-0 sm:max-w-[32rem]",
          "shadow-[0_28px_70px_-24px_rgba(10,12,8,0.55)]",
          "transition-[left,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          // A layer is open: cascade left on a tablet, sit fully to the left of the layer on a wide screen.
          layered && "brightness-[0.97] sm:left-[calc(50%-1.5rem)] xl:left-[calc(50%-18.375rem)]",
        )}
      >
        <div className="relative flex shrink-0 items-start gap-2 border-b border-border bg-gradient-to-b from-primary/20 via-primary/[0.06] to-transparent px-4 pt-3.5 pb-3">
          <div className="min-w-0 flex-1">{header}</div>
          <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} className={cn(CLOSE_BUTTON, "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        {children}
        {footer && <div className="shrink-0 border-t border-border bg-secondary/40">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}

// ---- a layer beside the base --------------------------------------------------------------------------------------------

/**
 * A secondary popup stacked on the base. `tone="hero"` is the dark header Record Payment uses (its caller passes the
 * hero content); `tone="light"` is the plain header the forms use. The body scrolls inside; the footer stays put.
 * Clicking outside never closes a layer (a half-filled payment is not lost to a stray click) — use the close button,
 * Cancel or Escape.
 */
export function StackLayer({
  open,
  onRequestClose,
  closeDisabled = false,
  closeLabel = "Close",
  tone = "light",
  header,
  footer,
  children,
  onKeyDown,
  testId,
  bodyClassName,
}: {
  open: boolean;
  onRequestClose: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
  tone?: "hero" | "light";
  /** Must contain the layer's `DialogTitle`. */
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  testId?: string;
  bodyClassName?: string;
}) {
  useRegister(open, "layer");
  const { base } = useStackState();
  const hero = tone === "hero";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !closeDisabled && onRequestClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        data-stack-layer=""
        // The base stays visible behind: a clear scrim only on a phone, where the layer covers most of it.
        overlayClassName="bg-transparent backdrop-blur-none max-sm:bg-black/30"
        onKeyDown={onKeyDown}
        onEscapeKeyDown={blurFieldOnEscape}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn(
          "flex flex-col gap-0 overflow-hidden bg-card p-0 text-foreground ring-1 ring-black/10 dark:ring-white/10",
          "shadow-[0_28px_70px_-22px_rgba(10,12,8,0.6)] ease-[cubic-bezier(0.22,1,0.36,1)] duration-200",
          // Phone: rises from the bottom edge.
          "top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-t-[20px] rounded-b-none max-h-[90dvh] max-sm:data-open:slide-in-from-bottom-8 max-sm:data-closed:slide-out-to-bottom-8",
          // Tablet and up: a compact popup, centred on the base — or just right of it when there is room for both.
          "sm:top-1/2 sm:bottom-auto sm:w-[36rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-y-1/2 sm:rounded-[18px] sm:max-h-[calc(100dvh-1.5rem)] sm:data-open:slide-in-from-right-6 sm:data-closed:slide-out-to-right-6",
          base ? "sm:left-[calc(50%+1.5rem)] sm:-translate-x-1/2 xl:left-[calc(50%-1.625rem)] xl:translate-x-0" : "sm:left-1/2 sm:-translate-x-1/2",
        )}
      >
        <header className={cn("relative shrink-0", hero ? "bg-surface-hero text-hero-foreground" : "border-b border-border bg-gradient-to-b from-primary/20 via-primary/[0.06] to-transparent")}>
          {hero && <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]" />}
          <div className="relative flex items-start gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">{header}</div>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onRequestClose}
              disabled={closeDisabled}
              className={cn(CLOSE_BUTTON, hero ? "bg-white/[0.07] text-hero-foreground/80 ring-1 ring-white/10 hover:bg-white/15 hover:text-hero-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </header>
        <div data-testid="layer-body" className={cn("@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain", hero ? "bg-secondary/55" : "bg-card", bodyClassName)}>
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
