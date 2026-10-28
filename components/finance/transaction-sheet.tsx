"use client";

/**
 * The sheet transaction editors open in: it drops down from the top edge of the viewport and spans its full width on
 * every screen size, so the form spreads across the screen and the list below it stays in view. It is rendered in a
 * portal (never inside a table's scroll container) over a light scrim.
 *
 * Layout: a near-black hero header (the same surface as FlowFi's hero cards and workspace headers) carrying the
 * transaction's identity, amount and navigation; a light body — the form on the left, a context rail on the right
 * (it stacks under the form on narrow screens); a sticky action footer; and a grab handle on the bottom edge.
 *
 * Height follows the content — on desktop the editors lay their sections out side by side so everything fits without
 * scrolling — up to about 90% of the viewport; only then does the body scroll. "Collapse" folds the sheet to its header
 * and footer (the content is hidden, never unmounted, so nothing typed is lost). Escape inside a text field leaves the
 * field first; the next Escape closes. The sheet itself never writes anything — closing, collapsing and moving are the
 * caller's to handle.
 *
 * The small building blocks below (`SheetNav`, `SheetSection`, `SheetPicker`, `SheetChoice`, `SheetRail`,
 * `SheetRailBlock`, `SheetDisclosure`, and the `SHEET_*` styles) exist so every editor in this shell looks and behaves
 * the same.
 */

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Content never stretches past this on very wide screens — the sheet is full width, its columns aren't. */
const CONTENT = "mx-auto w-full max-w-[1360px]";

/** Icon buttons sitting on the hero header. */
const HERO_ICON =
  "grid size-8 shrink-0 place-items-center rounded-[10px] text-hero-foreground/70 transition-colors hover:bg-white/10 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:outline-none disabled:opacity-35";

// ---- shared styles ---------------------------------------------------------------------------------------------------

/** Text inputs and textareas inside a sheet. */
export const SHEET_FIELD =
  "h-10 w-full rounded-[10px] border border-border-strong bg-card px-3 text-sm text-foreground shadow-e1 outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-primary-accent-text focus-visible:ring-0 focus-visible:shadow-[0_0_0_3px_oklch(0.912_0.185_126/0.4)] aria-invalid:border-expense";
/** Select triggers inside a sheet. */
export const SHEET_TRIGGER =
  "h-10 w-full rounded-[10px] border-border-strong bg-card px-3 text-sm shadow-e1 transition-[border-color,box-shadow] hover:border-muted-foreground focus-visible:border-primary-accent-text focus-visible:ring-0 focus-visible:shadow-[0_0_0_3px_oklch(0.912_0.185_126/0.4)] aria-invalid:border-expense dark:bg-card";
/** A field's label. */
export const SHEET_LABEL = "text-[12px] font-medium text-foreground/70";

const BUTTON = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold whitespace-nowrap transition-[background-color,box-shadow,color,opacity] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:pointer-events-none disabled:opacity-50";
export const SHEET_BUTTON = {
  primary: cn(BUTTON, "bg-primary text-primary-foreground shadow-e2 hover:bg-[var(--primary-hover)]"),
  /** The primary action while something is still missing: calm and neutral (it still explains itself on click). */
  primaryIdle: cn(BUTTON, "bg-secondary text-foreground/72 hover:bg-secondary/80"),
  secondary: cn(BUTTON, "border border-border-strong bg-card text-foreground shadow-e1 hover:border-muted-foreground hover:bg-secondary/60"),
  ghost: cn(BUTTON, "text-foreground/75 hover:bg-secondary hover:text-foreground"),
  danger: cn(BUTTON, "px-3 text-[oklch(0.5_0.19_25)] dark:text-danger hover:bg-danger/10"),
};

/** Signed amounts on the hero header: a soft coral for money out, the brand lime for money in. */
export const SHEET_AMOUNT_TONE = { debit: "text-[oklch(0.8_0.13_28)]", credit: "text-primary", unknown: "text-hero-foreground" } as const;

// ---- building blocks -------------------------------------------------------------------------------------------------

const AVATAR_TONE = {
  debit: "bg-[oklch(0.8_0.13_28)]/14 text-[oklch(0.88_0.09_28)] ring-[oklch(0.8_0.13_28)]/30",
  credit: "bg-primary/16 text-primary ring-primary/35",
  neutral: "bg-white/[0.08] text-hero-foreground ring-white/12",
} as const;

/** The monogram tile on the hero header, tinted by direction: coral for money out, lime for money in. */
export function SheetAvatar({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof AVATAR_TONE }) {
  return (
    <span aria-hidden className={cn("grid size-12 shrink-0 place-items-center rounded-[15px] text-[15px] font-bold tracking-tight tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1", AVATAR_TONE[tone])}>
      {children}
    </span>
  );
}

/** "‹  3 of 21  ›" — the queue position and arrows, as one pill on the hero header. Moving never writes anything. */
export function SheetNav({
  label,
  position,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
  disabled = false,
  positionTestId,
}: {
  label: string;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  prevLabel: string;
  nextLabel: string;
  disabled?: boolean;
  positionTestId?: string;
}) {
  const arrow = "grid size-8 place-items-center rounded-[8px] text-hero-foreground/80 transition-colors hover:bg-white/12 hover:text-hero-foreground disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:outline-none";
  return (
    <div className="flex items-center rounded-[12px] bg-white/[0.07] p-0.5 ring-1 ring-white/10" role="group" aria-label={label}>
      <button type="button" className={arrow} aria-label={prevLabel} disabled={disabled || !onPrev} onClick={onPrev}>
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span data-testid={positionTestId} aria-live="polite" className="min-w-[4rem] text-center text-xs font-semibold text-hero-foreground tabular-nums">
        {position}
      </span>
      <button type="button" className={arrow} aria-label={nextLabel} disabled={disabled || !onNext} onClick={onNext}>
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** A titled group of fields in the form column. */
export function SheetSection({ title, hint, aside, children, className, ...rest }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section aria-label={title} className={cn("flex flex-col gap-3.5 rounded-2xl border border-border bg-card p-4 shadow-e1 sm:p-5", className)} {...rest}>
      <div className="flex min-h-6 items-center gap-3">
        <span aria-hidden className="h-4 w-1 shrink-0 rounded-full bg-primary" />
        <h3 className="-ml-1 text-[12px] font-bold tracking-[0.08em] whitespace-nowrap text-foreground uppercase">{title}</h3>
        {hint && <span className="text-[11px] font-medium text-foreground/72">{hint}</span>}
        <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface SheetPickerOption {
  value: string;
  label: string;
  /** A 20px-ish visual: a category icon, a bank logo… */
  icon?: ReactNode;
  /** A short second line shown in the list. */
  detail?: string;
}

const CAPTION_TONE = { muted: "text-foreground/72", success: "text-[oklch(0.44_0.13_149)] dark:text-success", warning: "text-[oklch(0.5_0.12_70)] dark:text-warning", danger: "text-[oklch(0.5_0.19_25)] dark:text-danger" } as const;

/**
 * A selection card: a large trigger showing the choice's icon, its name and a one-line caption ("Matched by your phone",
 * "Required"), opening the usual list. The visible text is the chosen label — or the placeholder — exactly.
 */
export function SheetPicker({
  value,
  onValueChange,
  options,
  placeholder,
  emptyIcon,
  caption,
  captionTone = "muted",
  invalid = false,
  ariaLabel,
  extraItems,
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SheetPickerOption[];
  placeholder: string;
  /** Shown in the icon tile while nothing is chosen. */
  emptyIcon: ReactNode;
  caption?: ReactNode;
  captionTone?: keyof typeof CAPTION_TONE;
  invalid?: boolean;
  ariaLabel?: string;
  /** Extra list entries after the options (e.g. "Add new person"). */
  extraItems?: ReactNode;
}) {
  const selected = value != null ? options.find((o) => o.value === value) : undefined;
  return (
    <Select value={value ?? undefined} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-auto min-h-14 w-full gap-3 rounded-xl border-border-strong bg-card px-3 py-2 text-left shadow-e1 transition-[border-color,box-shadow,background-color] hover:border-muted-foreground hover:bg-secondary/30 focus-visible:border-primary-accent-text focus-visible:ring-0 focus-visible:shadow-[0_0_0_3px_oklch(0.912_0.185_126/0.4)] data-[state=open]:border-primary-accent-text data-[state=open]:ring-0 data-[state=open]:shadow-[0_0_0_3px_oklch(0.912_0.185_126/0.4)] aria-invalid:border-expense aria-invalid:ring-expense/20 dark:bg-card dark:hover:bg-secondary/40",
          "[&>svg:last-child]:size-4 [&>svg:last-child]:opacity-60",
        )}
      >
        <span className={cn("grid size-9 shrink-0 place-items-center overflow-hidden rounded-[10px] [&>[role=img]]:size-full! [&>span]:size-full!", selected ? "bg-secondary text-foreground/80" : "border border-dashed border-border bg-card text-foreground/72")}>
          {selected?.icon ?? emptyIcon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-sm leading-snug", selected ? "font-semibold text-foreground" : "font-medium text-foreground/72")}>{selected?.label ?? placeholder}</span>
          {caption && <span className={cn("truncate text-[11.5px] leading-snug font-medium", CAPTION_TONE[captionTone])}>{caption}</span>}
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="py-2">
            <span className="flex items-center gap-2.5">
              {o.icon && <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-secondary text-foreground/80 [&>[role=img]]:size-full! [&>span]:size-full!">{o.icon}</span>}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.label}</span>
                {o.detail && <span className="truncate text-[11px] text-muted-foreground">{o.detail}</span>}
              </span>
            </span>
          </SelectItem>
        ))}
        {extraItems}
      </SelectContent>
    </Select>
  );
}

/**
 * A segmented choice — one radio group in a single 56px control, the same height as the picker cards beside it. The
 * selected segment lifts onto a white pill with a lime icon; what each option means is for the caller to show as one
 * caption underneath (and it is the button's tooltip).
 */
export function SheetChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; aria: string; hint: string; icon: LucideIcon; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="@container">
    <div role="radiogroup" aria-label={label} className="grid min-h-14 grid-cols-[1fr_1.4fr_1fr] gap-1 rounded-xl border border-border-strong bg-secondary/70 p-1">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.aria}
            title={o.hint}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-[9px] px-1.5 text-[12.5px] font-semibold whitespace-nowrap transition-[background-color,color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50",
              active ? "bg-card text-foreground shadow-e2 ring-1 ring-primary-accent-text/30" : "text-foreground/72 hover:bg-card/60 hover:text-foreground",
            )}
          >
            <span className={cn("hidden size-5 shrink-0 place-items-center rounded-[6px] @min-[22rem]:grid", active ? "bg-primary text-primary-foreground" : "text-foreground/72")}>
              <o.icon className="size-3" strokeWidth={2.5} aria-hidden />
            </span>
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
    </div>
  );
}

/** The right-hand context column: what the reviewer should know, never what they must fill in. */
export function SheetRail({ children, className, label = "Context" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <aside aria-label={label} className={cn("flex min-w-0 flex-col gap-3", className)}>
      {children}
    </aside>
  );
}

const BLOCK_TONE = {
  neutral: "bg-secondary text-foreground/72",
  success: "bg-success/12 text-[oklch(0.44_0.13_149)] dark:text-success",
  warning: "bg-warning/20 text-[oklch(0.5_0.12_70)] dark:text-warning",
  danger: "bg-danger/12 text-[oklch(0.5_0.19_25)] dark:text-danger",
} as const;

/** One block of the context rail: an icon tile, a small heading and its content. */
export function SheetRailBlock({ icon: Icon, title, tone = "neutral", children, className, ...rest }: { icon: LucideIcon; title: string; tone?: keyof typeof BLOCK_TONE; children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-e1", className)} {...rest}>
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-[11px]", BLOCK_TONE[tone])}>
        <Icon className="size-4" strokeWidth={2.25} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground/85">
        <p className="text-[11px] font-bold tracking-[0.08em] text-foreground/72 uppercase">{title}</p>
        <div className="mt-0.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * A secondary section as a chip: closed it is a compact pill (icon + name); open it spans the row as a card with the
 * name, the current value (`hint`) and the content. Put several in a `flex flex-wrap` container whose open child
 * takes `basis-full` (see `SHEET_CHIPS`).
 */
export const SHEET_CHIPS = "flex flex-wrap gap-1.5 [&>*:has([aria-expanded=true])]:order-last [&>*:has([aria-expanded=true])]:basis-full";
export function SheetDisclosure({ id, icon: Icon, title, hint, open, onToggle, children }: { id: string; icon: LucideIcon; title: string; hint?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={cn(open && "overflow-hidden rounded-2xl border border-border bg-card shadow-e1")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={hint ? `${title}, ${hint}` : title}
        onClick={onToggle}
        className={cn(
          "flex items-center gap-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          open ? "min-h-10 w-full px-3 hover:bg-secondary/40" : "h-9 rounded-full border border-border-strong bg-card px-3 shadow-e1 hover:border-muted-foreground hover:bg-secondary/40",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-foreground/72" strokeWidth={2} aria-hidden />
        <span className="shrink-0 text-[13px] font-semibold whitespace-nowrap text-foreground">{title}</span>
        {open && hint && <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-foreground/72">{hint}</span>}
        <ChevronDown className={cn("size-3.5 shrink-0 text-foreground/72 transition-transform duration-200", open && !hint && "ml-auto", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id={id} className="px-3 pt-0.5 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ---- the sheet ---------------------------------------------------------------------------------------------------------

export function TransactionSheet({
  open,
  onRequestClose,
  header,
  footer,
  children,
  closeDisabled = false,
  closeLabel = "Close",
  progress,
  onKeyDown,
  testId,
  className,
}: {
  open: boolean;
  /** Close was asked for (X, Escape, a click outside the sheet). The caller decides — it may ask about unsaved edits first. */
  onRequestClose: () => void;
  /** The hero header's content (light text on near-black). Must contain the sheet's `DialogTitle`. */
  header: ReactNode;
  /** The sticky action row. */
  footer?: ReactNode;
  children: ReactNode;
  closeDisabled?: boolean;
  closeLabel?: string;
  /** Where the reviewer is in a queue — drawn as a thin lime line along the header's bottom edge. */
  progress?: { current: number; total: number };
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  testId?: string;
  className?: string;
}) {
  const [peek, setPeek] = useState(false);
  // A fresh open always shows the content.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPeek(false);
  }
  const togglePeek = () => setPeek((p) => !p);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !closeDisabled && onRequestClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        data-sheet-size={peek ? "peek" : "open"}
        // A light, barely-blurred scrim: the page below stays readable, only clearly behind the sheet.
        overlayClassName="bg-black/[0.3] backdrop-blur-none duration-200 dark:bg-black/55"
        onKeyDown={onKeyDown}
        // Escape while typing leaves the field (each field handles its own Escape first); the next Escape closes.
        onEscapeKeyDown={(e) => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) {
            e.preventDefault();
            setTimeout(() => active.blur(), 0);
          }
        }}
        className={cn(
          // Full width at every breakpoint: override the dialog's own centring and `sm:max-w-md` cap.
          "top-0 bottom-auto left-0 flex w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-none rounded-b-[22px] border-0 bg-card p-0 text-foreground ring-1 ring-black/5 sm:max-w-none dark:ring-white/10",
          "shadow-[0_24px_60px_-30px_rgba(10,12,8,0.5)]",
          // Opening moves only transform and opacity (compositor work, no layout), on its own layer.
          "transform-gpu will-change-[transform,opacity] ease-[cubic-bezier(0.22,1,0.36,1)]",
          "data-open:zoom-in-100 data-open:fade-in-0 data-open:slide-in-from-top-5 data-closed:zoom-out-100 data-closed:fade-out-0 data-closed:slide-out-to-top-5 data-open:duration-200 data-closed:duration-150 motion-reduce:data-open:slide-in-from-top-0 motion-reduce:data-closed:slide-out-to-top-0",
          "max-h-[90dvh] max-sm:max-h-[88dvh]",
          className,
        )}
      >
        <header className="relative shrink-0 bg-surface-hero pt-[env(safe-area-inset-top)] text-hero-foreground" data-testid="sheet-header">
          {/* A soft lime glow from the top-left corner gives the near-black surface some depth. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]" />
          <div className={cn(CONTENT, "relative flex items-start gap-4 px-4 py-4 sm:px-6 lg:px-8")}>
            <div className="min-w-0 flex-1">{header}</div>
            {/* Window controls, styled as one family with the queue arrows. */}
            <div className="flex shrink-0 items-center rounded-[12px] bg-white/[0.07] p-0.5 ring-1 ring-white/10">
              <button type="button" className={HERO_ICON} aria-label={peek ? "Show details" : "Collapse sheet"} title={peek ? "Show details" : "Collapse to the header and actions"} onClick={togglePeek}>
                {peek ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
              </button>
              <span aria-hidden className="h-4 w-px bg-white/12" />
              <button type="button" className={cn(HERO_ICON, "hover:bg-[oklch(0.6_0.2_25)]/25 hover:text-hero-foreground")} aria-label={closeLabel} onClick={onRequestClose} disabled={closeDisabled}>
                <X className="size-4" />
              </button>
            </div>
          </div>
          {progress && progress.total > 1 && (
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-white/[0.07]">
              <div className="h-full rounded-r-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${Math.max(2, Math.min(100, (progress.current / progress.total) * 100))}%` }} />
            </div>
          )}
        </header>

        {/* Hidden, not unmounted, while peeking — values, open sections and split rows all survive. */}
        <div className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-secondary/55 [scrollbar-gutter:stable]", peek && "hidden")} data-testid="sheet-body">
          <div className={CONTENT}>{children}</div>
        </div>

        {footer && (
          <div className="shrink-0 border-t border-border bg-card">
            <div className={CONTENT}>{footer}</div>
          </div>
        )}

        <div className="flex shrink-0 justify-center bg-card pb-2 pt-0.5">
          <button
            type="button"
            aria-label={peek ? "Show details" : "Collapse sheet"}
            title={peek ? "Show details" : "Collapse"}
            onClick={togglePeek}
            className="group/handle flex h-4 w-20 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span aria-hidden className="h-1 w-10 rounded-full bg-border transition-[width,background-color] group-hover/handle:w-14 group-hover/handle:bg-border-strong" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
