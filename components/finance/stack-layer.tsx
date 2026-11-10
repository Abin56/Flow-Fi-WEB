"use client";

/**
 * Stacked popups for the Loan & EMI screens.
 *
 * `StackBase` is the centred workspace window (an EMI's or Loan's details: a summary rail beside the schedule). Every action
 * opened from it — Record Payment, Past payments, Edit, a recorded payment's details — opens in a `StackLayer` that is a
 * step *deeper in the same window*: a payment flow (`size="wide"`) takes exactly the window's footprint, a small form
 * (`size="compact"`) sits centred over it. Either way there is a Back button (and Escape) that returns to the base exactly
 * as it was; on a phone the layer rises from the bottom edge. Neither ever grows the page; each scrolls inside itself.
 *
 * Shells that normally open as a top sheet or a side drawer (`PaymentSheet`, `LoanEmiFormDialog`, `FormDialog`) render as a
 * `StackLayer` when they are mounted inside a `<StackProvider>`, so the existing forms are reused untouched and everywhere
 * else (People, the Add flow, …) keeps its own look. The shells only draw — nothing here writes any data.
 */

import { createContext, useContext, useEffect, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
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
 * The centred workspace window: a header (the caller's `header`, plus the close button), then `children` — which fill the
 * rest of the fixed-height window and scroll inside it — then an optional footer. While a layer is open the window stays
 * where it is, a little smaller and dimmer, so the layer reads as one step deeper.
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
          "flex h-[min(46rem,calc(100dvh-1.5rem))] w-[calc(100%-1rem)] max-w-[62rem] flex-col gap-0 overflow-hidden rounded-[18px] border border-border bg-card p-0 ring-0 sm:max-w-[62rem]",
          "shadow-[0_28px_70px_-24px_rgba(10,12,8,0.55)]",
          "transition-[scale,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          // A layer is open: the window steps back a touch.
          layered && "scale-[0.985] brightness-[0.95]",
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

// ---- a layer one step deeper ---------------------------------------------------------------------------------------------

/**
 * A step deeper than the base. `size="wide"` (the payment flows) takes exactly the base window's footprint, so it reads as
 * the same window changing page; `size="compact"` (a form) is a smaller card centred over it. `tone="hero"` is the dark
 * header Record Payment uses (its caller passes the hero content); `tone="light"` is the plain header the forms use. When
 * a base window is open the header's close button becomes "Back" — it returns to the base; Escape does the same. The
 * optional `toolbar` stays pinned between the header and the scrolling body (the payment flow's intent switch).
 * Clicking outside never closes a layer (a half-filled payment is not lost to a stray click).
 */
export function StackLayer({
  open,
  onRequestClose,
  closeDisabled = false,
  closeLabel = "Close",
  tone = "light",
  size = "compact",
  instant = false,
  header,
  toolbar,
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
  size?: "wide" | "compact";
  /** Skip the enter animation — a sibling layer of the same flow just closed, so this one replaces it in place. */
  instant?: boolean;
  /** Must contain the layer's `DialogTitle`. */
  header: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  testId?: string;
  bodyClassName?: string;
}) {
  useRegister(open, "layer");
  const { base } = useStackState();
  const hero = tone === "hero";
  const wide = size === "wide";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !closeDisabled && onRequestClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        data-stack-layer=""
        data-size={size}
        // The base stays visible behind (dimmed by its own step-back); a clear scrim only on a phone, where the layer covers most of it.
        overlayClassName={cn("bg-transparent backdrop-blur-none dark:bg-transparent max-sm:bg-black/30 max-sm:dark:bg-black/50", instant && "data-open:animate-none")}
        onKeyDown={onKeyDown}
        onEscapeKeyDown={blurFieldOnEscape}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn(
          "flex flex-col gap-0 overflow-hidden bg-card p-0 text-foreground ring-1 ring-black/10 dark:ring-white/10",
          "shadow-[0_28px_70px_-22px_rgba(10,12,8,0.6)] ease-[cubic-bezier(0.22,1,0.36,1)] duration-200",
          // Phone: rises from the bottom edge.
          "top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-t-[20px] rounded-b-none max-h-[92dvh] max-sm:data-open:slide-in-from-bottom-8 max-sm:data-closed:slide-out-to-bottom-8",
          wide && "max-sm:h-[92dvh]",
          // Tablet and up, always centred: a wide layer is the base window's own footprint, a compact one a card over it.
          "sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[18px] sm:data-open:slide-in-from-right-6 sm:data-closed:slide-out-to-right-6",
          wide
            ? "sm:h-[min(46rem,calc(100dvh-1.5rem))] sm:max-h-none sm:w-[calc(100%-1rem)] sm:max-w-[62rem]"
            : "sm:w-[36rem] sm:max-w-[calc(100vw-2rem)] sm:max-h-[calc(100dvh-1.5rem)]",
          instant && "data-open:animate-none sm:data-open:animate-none",
        )}
      >
        <header className={cn("relative shrink-0", hero ? "bg-surface-hero text-hero-foreground" : "border-b border-border bg-gradient-to-b from-primary/20 via-primary/[0.06] to-transparent")}>
          {hero && <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]" />}
          <div className="relative flex items-start gap-2 px-3 py-3 sm:px-4">
            {base && (
              <button
                type="button"
                aria-label="Back"
                onClick={onRequestClose}
                disabled={closeDisabled}
                className={cn(
                  "mt-0.5 inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[10px] pr-2.5 pl-1.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                  hero ? "bg-white/[0.07] text-hero-foreground/90 ring-1 ring-white/10 hover:bg-white/15 hover:text-hero-foreground" : "text-foreground hover:bg-secondary",
                )}
              >
                <ChevronLeft className="size-4" strokeWidth={2} />
                Back
              </button>
            )}
            <div className="min-w-0 flex-1">{header}</div>
            {!base && (
              <button
                type="button"
                aria-label={closeLabel}
                onClick={onRequestClose}
                disabled={closeDisabled}
                className={cn(CLOSE_BUTTON, hero ? "bg-white/[0.07] text-hero-foreground/80 ring-1 ring-white/10 hover:bg-white/15 hover:text-hero-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            )}
          </div>
        </header>
        {toolbar && <div className="shrink-0 border-b border-border bg-card px-3 py-2 sm:px-4">{toolbar}</div>}
        <div data-testid="layer-body" className={cn("@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain", hero ? "bg-secondary/55" : "bg-card", bodyClassName)}>
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
