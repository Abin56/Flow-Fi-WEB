"use client";

import { ArrowDownLeft, ArrowUpRight, CalendarClock, Check, X } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";

/** Which way money moves for an option — decides its icon and colour (literal classes, so Tailwind sees them). */
export type FlowTone = "in" | "out" | "wait";

const TONE = {
  in: { icon: ArrowDownLeft, solid: "bg-settle-receivable-text text-white", text: "text-settle-receivable-text" },
  out: { icon: ArrowUpRight, solid: "bg-settle-payable-text text-white", text: "text-settle-payable-text" },
  // Not a money direction — "nothing paid yet": neutral, never red or green.
  wait: { icon: CalendarClock, solid: "bg-foreground text-card", text: "text-foreground" },
} as const;

export interface FlowSwitchOption<T extends string> {
  value: T;
  tone: FlowTone;
  /** Bold first word(s), e.g. "Received". */
  title: string;
  /** Muted rest of the first line, e.g. "from SHAMBU". */
  sub?: string;
  /** Second line — what choosing it means or what's due that way. */
  meta?: React.ReactNode;
  /** Full accessible name, e.g. "Money received from SHAMBU". */
  label: string;
}

/**
 * Two-way money choice used across the People workspace (Record payment, Add transaction): a grey track with
 * a card that slides under the chosen side. With no choice yet (`value` null) the card is hidden and both
 * sides read as equal invitations. Arrow keys move between the options; `locked` fixes the current one.
 * Presentation only.
 */
export function FlowSwitch<T extends string>({
  value,
  onChange,
  options,
  label,
  locked = false,
  invalid = false,
  className,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: FlowSwitchOption<T>[];
  label: string;
  locked?: boolean;
  /** Draws attention when a choice is required and missing. */
  invalid?: boolean;
  className?: string;
}) {
  const index = options.findIndex((o) => o.value === value);
  const chosen = index >= 0 ? options[index] : null;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Three or more choices stack icon over text on phones so each one stays readable.
  const compact = options.length > 2;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-invalid={invalid || undefined}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      className={cn(
        "relative grid rounded-[14px] bg-secondary p-1 ring-1 ring-black/[0.05] ring-inset transition-shadow duration-200 dark:ring-white/[0.06]",
        invalid && "ring-2 ring-warning/60 dark:ring-warning/60",
        className,
      )}
    >
      {/* The sliding selection — one element that moves, rather than two that swap. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-1 rounded-[11px] bg-card shadow-[0_1px_2px_rgb(0_0_0/0.06),0_6px_16px_-8px_rgb(0_0_0/0.22)] ring-1 ring-black/[0.04] transition-[transform,opacity] duration-300 ease-[var(--ease-spring)] dark:ring-white/[0.07]",
          chosen ? "opacity-100" : "opacity-0",
        )}
        style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${Math.max(0, index) * 100}%)` }}
      />
      {options.map((o, i) => {
        const active = o.value === value;
        const disabled = locked && !active;
        const tone = TONE[o.tone];
        const Icon = tone.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            aria-disabled={disabled || undefined}
            // Roving focus: the chosen option (or the first, before any choice) is the one Tab stop.
            tabIndex={active || (index < 0 && i === 0) ? 0 : -1}
            title={disabled ? "This can't change while editing" : undefined}
            onClick={() => !disabled && onChange(o.value)}
            onKeyDown={(e) => {
              if (locked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              const next = (i + 1) % options.length;
              onChange(options[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              "relative z-10 flex min-w-0 rounded-[11px] px-3 py-2.5 text-left outline-none transition-[opacity,transform,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
              compact ? "flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3" : "items-center gap-3",
              disabled ? "cursor-not-allowed opacity-45" : "active:scale-[0.98]",
              !active && !disabled && "hover:bg-card/50",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
                active ? cn(tone.solid, "shadow-[0_2px_6px_-2px_rgb(0_0_0/0.25)]") : "bg-card text-foreground/80 shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
              )}
            >
              <Icon className="size-4" strokeWidth={2.5} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[13px] leading-tight transition-colors", compact ? "break-words sm:truncate" : "truncate", active ? "font-bold text-foreground" : "font-semibold text-foreground/90")}>
                {o.title}
                {o.sub && <span className="font-medium text-foreground/75"> {o.sub}</span>}
              </span>
              {o.meta != null && <span className={cn("mt-0.5 block text-[11px] leading-tight text-foreground/75", compact ? "break-words sm:truncate" : "truncate")}>{o.meta}</span>}
            </span>
            {active && <Check aria-hidden className={cn("hidden size-4 shrink-0 duration-200 animate-in zoom-in-50 sm:block", tone.text)} strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

/** Coloured text for an amount on a given side — e.g. the "₹200 due" inside an option's meta line. */
export const flowText = (tone: FlowTone) => TONE[tone].text;

/** The composer's primary value — a large "₹ amount" entry; the same text input semantics as `CompactAmountInput`. */
export function HeroAmount({
  label,
  value,
  onChange,
  autoFocus = true,
  invalid = false,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  invalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span aria-hidden className="text-xs font-semibold text-foreground/80">
        {label}
      </span>
      {/* One focus ring, on the wrapper: the app's keyboard ring moves from the input (inline `outline: none`,
          which outranks the unlayered global rule) to the whole ₹ field, so focus stays visible, drawn once. */}
      <div
        className={cn(
          "flex items-center rounded-[10px] border bg-card outline-offset-2 transition-[border-color,box-shadow] duration-200 focus-within:border-primary-accent-text focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-primary)_18%,transparent)] hover:border-muted-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus-ring)]",
          invalid ? "border-expense" : "border-border-strong",
        )}
      >
        <span aria-hidden className="pl-4 font-heading text-[26px] font-semibold text-foreground/40">
          ₹
        </span>
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          aria-label={label}
          aria-invalid={invalid || undefined}
          autoFocus={autoFocus}
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ outline: "none" }}
          className="h-14 w-full min-w-0 appearance-none rounded-none border-0 bg-transparent px-2 font-heading text-[30px] font-bold tracking-tight text-foreground tabular-nums shadow-none ring-0 outline-none placeholder:text-foreground/25 focus:border-0 focus:shadow-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>
    </div>
  );
}

/**
 * The top of a People drawer panel, in the Transaction Details style: a near-black hero strip with the person's
 * monogram tile (tinted by direction), the title with an optional status pill, the person and one context pill, an
 * optional live amount, and a round close button. Sticky; solid (no blur).
 */
export function PanelHeader({
  title,
  personName,
  context,
  tone,
  onClose,
  amount,
  status,
}: {
  title: string;
  personName: string;
  context?: React.ReactNode;
  tone: FlowTone | null;
  onClose: () => void;
  /** A live figure on the right — e.g. the amount being received (already formatted). */
  amount?: string;
  /** A short pill beside the title — e.g. "Received". */
  status?: string;
}) {
  const t = tone ? TONE[tone] : null;
  const Badge = t?.icon;
  const avatar = tone === "in" ? "bg-primary/16 text-primary ring-primary/35" : tone === "out" ? "bg-[oklch(0.8_0.13_28)]/14 text-[oklch(0.88_0.09_28)] ring-[oklch(0.8_0.13_28)]/30" : "bg-white/[0.08] text-hero-foreground ring-white/12";
  const amountTone = tone === "in" ? "text-primary" : tone === "out" ? "text-[oklch(0.8_0.13_28)]" : "text-hero-foreground";
  return (
    <div className="sticky top-0 z-30 overflow-hidden bg-surface-hero text-hero-foreground">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]" />
      <div className="relative flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="relative shrink-0">
            <span className={cn("grid size-9 place-items-center rounded-[11px] text-[13px] font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 transition-colors duration-300", avatar)}>
              {personName.slice(0, 1).toUpperCase()}
            </span>
            {t && Badge && (
              <span key={tone} className={cn("absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full ring-2 ring-surface-hero duration-200 animate-in zoom-in-50", t.solid)}>
                <Badge className="size-2.5" strokeWidth={3} />
              </span>
            )}
          </span>
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold tracking-[0.08em] text-hero-foreground/65 uppercase">People</p>
            <h3 className="flex min-w-0 items-center gap-2 text-[15px] leading-tight font-semibold tracking-tight">
              <span className="truncate">
                {title}
                <span className="sr-only"> · {personName}</span>
              </span>
              {status && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-hero-foreground ring-1 ring-white/12">{status}</span>}
            </h3>
            <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs">
              <span aria-hidden className="truncate font-semibold text-hero-foreground/90">
                {personName}
              </span>
              {context && <span className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-medium text-hero-foreground/70">{context}</span>}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {amount && <span className={cn("font-heading text-[22px] leading-none font-bold tracking-tight tabular-nums sm:text-[26px]", amountTone)}>{amount}</span>}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.07] text-hero-foreground/80 ring-1 ring-white/10 outline-none transition-colors hover:bg-[oklch(0.6_0.2_25)]/25 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <X className="size-4" strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
