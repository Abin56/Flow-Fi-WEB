"use client";

import { Check, Link2, Lock, MoreVertical, Wifi } from "lucide-react";
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StaggerItem } from "@/components/foundation/animated-container";
import { BankLogo } from "@/components/finance/bank-logo";
import { formatCurrency } from "@/lib/format";
import type { CreditCardViewItem } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { cardDueStatus } from "@/features/credit-cards/lib/card-usage-breakdown";
import { gradientFromArgb } from "@/lib/account-color";
import { statementWindowForDate } from "@/lib/repositories/credit-card-repository";
import { cn } from "@/lib/utils";

/** Rich dark card-face gradients — deliberately outside the app's pastel token palette, since these stand in
 *  for real bank card artwork rather than app chrome. Keyed by the card's existing `accent` so each mock card
 *  keeps a stable, distinct look. */
export const CARD_GRADIENT: Record<CreditCardViewItem["accent"], string> = {
  expense: "linear-gradient(135deg, #6d1530 0%, #a81f56 55%, #c2185b 100%)",
  warning: "linear-gradient(135deg, #141414 0%, #2b2b2b 100%)",
  success: "linear-gradient(135deg, #0e3d2e 0%, #146b4d 100%)",
  purple: "linear-gradient(135deg, #1c2a5e 0%, #2d4a9e 100%)",
  primary: "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)",
  teal: "linear-gradient(135deg, #0b3b40 0%, #0f766e 100%)",
  orange: "linear-gradient(135deg, #7a2e0b 0%, #ea580c 100%)",
  gold: "linear-gradient(135deg, #5c4410 0%, #b8862b 100%)",
  rose: "linear-gradient(135deg, #7f1d3a 0%, #e11d48 100%)",
  sky: "linear-gradient(135deg, #0c4a6e 0%, #0ea5e9 100%)",
  emerald: "linear-gradient(135deg, #064e3b 0%, #10b981 100%)",
  violet: "linear-gradient(135deg, #3b0764 0%, #7c3aed 100%)",
  slate: "linear-gradient(135deg, #1e293b 0%, #64748b 100%)",
  bronze: "linear-gradient(135deg, #3f2a14 0%, #8b5a2b 100%)",
  magenta: "linear-gradient(135deg, #701a75 0%, #c026d3 100%)",
  navy: "linear-gradient(135deg, #0a0f2c 0%, #1e2a78 100%)",
};

/** The card face gradient: the named swatch's hand-tuned gradient, or one derived from a custom (mobile-picked) colour. */
export function cardFaceGradient(card: Pick<CreditCardViewItem, "accent" | "customColor">): string {
  return card.customColor != null ? gradientFromArgb(card.customColor) : CARD_GRADIENT[card.accent];
}

function formatDueDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Fine film grain (static SVG turbulence) — gives the gradient a printed-card-stock texture instead of a flat web fill. */
const CARD_GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .6 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

/** Engraved concentric rings (guilloche-style) from two corners, plus a soft diagonal light band — all static. */
const CARD_ENGRAVING = [
  "repeating-radial-gradient(circle at 92% 118%, rgba(255,255,255,0.075) 0 1px, transparent 1px 6px)",
  "repeating-radial-gradient(circle at -8% -18%, rgba(255,255,255,0.05) 0 1px, transparent 1px 7px)",
  "linear-gradient(112deg, transparent 28%, rgba(255,255,255,0.10) 40%, rgba(255,255,255,0.02) 52%, transparent 60%)",
].join(", ");

/** The EMV chip — gold die with the contact-pad lines, like a physical card. */
function EmvChip() {
  return (
    <svg width="28" height="21" viewBox="0 0 28 21" aria-hidden className="shrink-0 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]">
      <defs>
        <linearGradient id="cc-chip-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fdeeb0" />
          <stop offset="0.45" stopColor="#e3b857" />
          <stop offset="1" stopColor="#a8761f" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="27" height="20" rx="4" fill="url(#cc-chip-gold)" stroke="rgba(255,255,255,0.55)" />
      <g stroke="rgba(92,58,8,0.55)" strokeWidth="0.8" fill="none">
        <path d="M0.5 7.5h8.5a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H0.5" />
        <path d="M27.5 7.5H19a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h8.5" />
        <path d="M9 0.5v6M19 0.5v6M9 20.5v-6M19 20.5v-6M11 10.5h6" />
      </g>
    </svg>
  );
}

/** Network wordmark/logo drawn in CSS/SVG (no assets). Unknown / unset networks render nothing. */
function NetworkMark({ network }: { network: string }) {
  switch (network.toLowerCase()) {
    case "visa":
      return <span className="font-heading text-[15px] leading-none font-extrabold tracking-[0.02em] text-white italic drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]">VISA</span>;
    case "mastercard":
      return (
        <span className="flex items-center" role="img" aria-label="Mastercard">
          <span className="size-[15px] rounded-full bg-[#eb001b]/95" />
          <span className="-ml-[7px] size-[15px] rounded-full bg-[#f79e1b]/90 mix-blend-screen" />
        </span>
      );
    case "rupay":
      return (
        <span className="flex flex-col items-end gap-[2px] leading-none">
          <span className="text-[13px] font-extrabold tracking-tight text-white italic drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]">RuPay</span>
          <span className="flex h-[2px] w-full overflow-hidden rounded-full" aria-hidden>
            <span className="flex-1 bg-[#f7941d]" />
            <span className="flex-1 bg-[#1b9e4b]" />
          </span>
        </span>
      );
    case "amex":
      return <span className="rounded-[4px] border border-white/60 px-1 py-[1px] text-[9px] leading-none font-extrabold tracking-[0.12em] text-white">AMEX</span>;
    default:
      return <span className="text-[11px] font-bold tracking-wide text-white/75 uppercase">{network}</span>;
  }
}

/** ₹ with a smaller, softer symbol so the figure itself carries the weight. Falls back to plain text. */
function Money({ value, className }: { value: string; className?: string }) {
  const m = /^(-?)₹(.*)$/.exec(value);
  if (!m) return <span className={className}>{value}</span>;
  return (
    <span className={className}>
      {m[1]}
      <span className="mr-[1px] align-[0.08em] text-[0.72em] font-semibold text-white/70">₹</span>
      {m[2]}
    </span>
  );
}

interface CreditCardTileProps {
  card: CreditCardViewItem;
  /** The issuing bank (from the card's account) — shown as its logo beside the name. */
  bankId?: string | null;
  active?: boolean;
  /** Another card on the same shared limit is hovered — this one lights up as its partner. */
  partnerHighlighted?: boolean;
  onHoverChange?: (hovered: boolean) => void;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** Compact, card-proportioned tile styled after real bank card art — a solid gradient face (not a clay surface)
 *  with identity on top, credit used / limit and the utilization bar at the bottom, and the bill status as a
 *  footer. Presentation only: a pointer-following tilt + glare, a hover shine sweep and an animated usage bar. */
export function CreditCardTile({ card, bankId, active, partnerHighlighted, onHoverChange, onClick, onEdit, onDelete }: CreditCardTileProps) {
  // The engine's exposure ratio (outstanding + locked card-EMI principal) — recomputing from the account
  // balance alone hid a card-linked EMI's lock, so the tile disagreed with Available.
  const utilization = Math.min(100, Math.round(card.utilizationPercent));
  // Due label from the canonical Pay Now scope — `card.dueDate` falls back to an already-paid bill's date.
  const due = cardDueStatus(card.statementPayment);
  const highUtilization = utilization >= 80;
  const network = card.network === "—" ? "" : card.network;
  const holder = card.card.cardHolderName?.trim() ?? "";

  const reduceMotion = useReducedMotion();
  // Pointer position over the card, 0..1 — drives the tilt and where the glare sits.
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const spring = { stiffness: 220, damping: 22, mass: 0.6 };
  const rotateX = useSpring(useTransform(py, [0, 1], [5, -5]), spring);
  const rotateY = useSpring(useTransform(px, [0, 1], [-7, 7]), spring);
  const glareX = useTransform(px, (v) => `${v * 100}%`);
  const glareY = useTransform(py, (v) => `${v * 100}%`);
  const glare = useMotionTemplate`radial-gradient(260px circle at ${glareX} ${glareY}, rgba(255,255,255,0.22), transparent 60%)`;

  return (
    <StaggerItem>
      {/* Width-capped so a lone card (or a wide column) never stretches into a wide banner. */}
      <div className="w-full max-w-[440px] [perspective:1100px]">
        <motion.div
          role="button"
          tabIndex={0}
          aria-current={active || undefined}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick();
            }
          }}
          onPointerMove={(e) => {
            if (reduceMotion || e.pointerType !== "mouse") return;
            const r = e.currentTarget.getBoundingClientRect();
            px.set((e.clientX - r.left) / r.width);
            py.set((e.clientY - r.top) / r.height);
          }}
          onPointerEnter={() => onHoverChange?.(true)}
          onPointerLeave={() => {
            px.set(0.5);
            py.set(0.5);
            onHoverChange?.(false);
          }}
          whileHover={reduceMotion ? undefined : { y: -3 }}
          whileTap={reduceMotion ? undefined : { scale: 0.985 }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
          style={{
            background: cardFaceGradient(card),
            rotateX: reduceMotion ? 0 : rotateX,
            rotateY: reduceMotion ? 0 : rotateY,
          }}
          className={cn(
            // Real card proportions (ID-1 ≈ 1.586 : 1). The tile itself must NOT be overflow-hidden: that would turn off
            // aspect-ratio's grow-to-fit, so on a narrow screen the footer got clipped. The art is clipped by its own
            // inner layer below, which leaves the tile free to grow to fit its content.
            "group/tile relative flex aspect-[1.62/1] w-full cursor-pointer flex-col justify-between gap-3 rounded-[16px] px-5 pt-4 pb-0 text-white shadow-[0_10px_28px_-12px_rgba(0,0,0,0.55),0_2px_6px_-2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_0_0_1px_rgba(255,255,255,0.12)] outline-none transition-shadow duration-300 hover:shadow-[0_22px_44px_-14px_rgba(0,0,0,0.6),0_4px_10px_-4px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_0_0_1px_rgba(255,255,255,0.18)] focus-visible:ring-2 focus-visible:ring-ring",
            active && "shadow-[0_14px_34px_-14px_rgba(0,0,0,0.5)] ring-2 ring-primary-accent-text ring-offset-2 ring-offset-background",
            partnerHighlighted && !active && "ring-2 ring-white/70 ring-offset-2 ring-offset-background",
          )}
        >
          {/* Card art, clipped to the card's rounded face (separate from the content so the tile can still grow) */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
          {/* depth: a lit top-left and a deepened bottom-right, so the flat gradient reads as a curved, lacquered face */}
          <span
            className="absolute inset-0"
            style={{ background: "radial-gradient(120% 90% at 0% 0%, rgba(255,255,255,0.20), transparent 55%), radial-gradient(90% 80% at 100% 100%, rgba(0,0,0,0.38), transparent 60%)" }}
          />
          {/* engraved rings + a soft light band */}
          <span className="absolute inset-0" style={{ background: CARD_ENGRAVING }} />
          {/* film grain */}
          <span className="absolute inset-0 opacity-[0.07] mix-blend-overlay" style={{ backgroundImage: CARD_GRAIN }} />
          {/* soft sheen, like card stock */}
          <span className="absolute -top-16 -right-10 size-40 rounded-full bg-white/10 blur-2xl" />
          {/* bright top edge + hairline bezel, like a polished card rim */}
          <span className="absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
          <span className="absolute inset-0 rounded-[inherit] ring-1 ring-white/15 ring-inset" />
          {/* pointer glare */}
          {!reduceMotion && (
            <motion.span
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/tile:opacity-100"
              style={{ background: glare }}
              aria-hidden
            />
          )}
          {/* one diagonal shine sweep per hover */}
          <span
            className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 group-hover/tile:animate-[cc-shine_0.9s_ease-out] motion-reduce:hidden"
            aria-hidden
          />
          </div>

          {/* Landscape layout: identity strip on top, then card number / holder on the left and the figures on the right
              (like a physical card), then the usage bar. Spacing is spread evenly over the height. */}
          <div className="relative flex flex-1 flex-col justify-between gap-3">
            {/* Identity: bank logo + name, network + options */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {bankId && <BankLogo bankId={bankId} size={24} className="shadow-[0_2px_6px_rgba(0,0,0,0.35)] ring-2 ring-white/45" />}
                <h3 className="truncate font-heading text-[15px] font-semibold tracking-[0.005em] [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">{card.name}</h3>
              </div>
              <div className="-mt-1 -mr-1.5 flex shrink-0 items-center gap-1.5">
                {network && <NetworkMark network={network} />}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-white/75 transition-colors hover:bg-white/15 hover:text-white"
                      aria-label="Card options"
                    >
                      <MoreVertical className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* The menu is portalled, but React still bubbles its events to this tile's onClick / onKeyDown —
                      without this, choosing Edit or Delete would also select the card and open its activity sheet. */}
                  <DropdownMenuContent
                    align="end"
                    className="rounded-[8px]"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <DropdownMenuItem onSelect={() => onEdit?.()}>Edit</DropdownMenuItem>
                    <DropdownMenuItem className="text-expense" onSelect={() => onDelete?.()}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="flex items-end justify-between gap-4">
              {/* Left: chip + contactless, number, holder, and the shared-limit / EMI-lock pills */}
              <div className="flex min-w-0 flex-col gap-1.5">
                {/* chip + contactless with the embossed number on the same line (keeps the left column short) */}
                <div className="flex items-center gap-2.5">
                  <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
                    <EmvChip />
                    <Wifi className="size-3.5 rotate-90 text-white/65" strokeWidth={2.25} />
                  </span>
                  <span className="font-mono text-[13px] font-medium tracking-[0.18em] whitespace-nowrap text-white/90 tabular-nums [text-shadow:0_-1px_0_rgba(0,0,0,0.45),0_1px_0_rgba(255,255,255,0.22)]">
                    •••• {card.last4}
                  </span>
                </div>
                {/* Card holder, printed like on a physical card — only when one was entered (never invented) */}
                {holder && (
                  <span
                    title={holder}
                    className="truncate font-mono text-[10.5px] font-medium tracking-[0.14em] text-white/80 uppercase [text-shadow:0_-1px_0_rgba(0,0,0,0.45),0_1px_0_rgba(255,255,255,0.2)]"
                  >
                    {holder}
                  </span>
                )}
                {(card.lockedEmiPrincipal > 0 || card.sharedLimit) && (
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {card.lockedEmiPrincipal > 0 && (
                      <span
                        title={`${formatCurrency(card.lockedEmiPrincipal)} of card-EMI principal is locked on this card`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-black/25 px-2 py-0.5 text-[10.5px] leading-4 font-medium whitespace-nowrap text-white/90 tabular-nums ring-1 ring-white/20"
                      >
                        <Lock className="size-3 shrink-0" strokeWidth={2.25} />
                        {formatCurrency(card.lockedEmiPrincipal)} locked
                      </span>
                    )}
                    {card.sharedLimit && (
                      <span
                        title={`Shares one limit with ${card.sharedLimit.siblings.map((s) => `•••• ${s.last4}`).join(", ") || "another card"}`}
                        className="inline-flex min-w-0 items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] leading-4 font-semibold text-white/90 ring-1 ring-white/20"
                      >
                        <span className="relative flex size-3 shrink-0 items-center justify-center">
                          <Link2 className="size-3" strokeWidth={2.25} />
                          {partnerHighlighted && <span className="absolute inset-0 animate-ping rounded-full bg-white/40" aria-hidden />}
                        </span>
                        <span className="truncate">
                          Shared{card.sharedLimit.siblings.length > 0 ? ` · ${card.sharedLimit.siblings.map((s) => s.last4).join(", ")}` : ""}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Right: the figure that matters, with its limit underneath */}
              <div className="min-w-0 shrink-0 text-right">
                <p className="text-[10px] font-semibold tracking-[0.14em] text-white/65 uppercase">Credit used</p>
                <p className="mt-1 leading-none">
                  <Money
                    value={formatCurrency(card.usedCredit)}
                    className="text-[28px] font-bold tracking-tight tabular-nums [text-shadow:0_1px_0_rgba(255,255,255,0.18),0_3px_10px_rgba(0,0,0,0.4)]"
                  />
                </p>
                <p className="mt-1.5 text-[10.5px] tracking-[0.02em] text-white/65 tabular-nums">
                  <span className="text-[9.5px] font-semibold tracking-[0.14em] uppercase">{card.sharedLimit ? "Shared limit" : "Limit"}</span>{" "}
                  <Money value={formatCurrency(card.creditLimit)} className="text-[12px] font-semibold text-white/90" />
                </p>
              </div>
            </div>

            <div>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-black/30 shadow-[inset_0_1px_3px_rgba(0,0,0,0.45),0_1px_0_rgba(255,255,255,0.12)]">
                <motion.div
                  className={cn(
                    "relative h-full rounded-full",
                    highUtilization
                      ? "bg-gradient-to-r from-rose-300 to-red-500 shadow-[0_0_12px_rgba(248,113,113,0.75)]"
                      : utilization >= 50
                        ? "bg-gradient-to-r from-amber-200 to-amber-400 shadow-[0_0_12px_rgba(252,211,77,0.6)]"
                        : "bg-gradient-to-r from-white/70 to-white shadow-[0_0_12px_rgba(255,255,255,0.55)]",
                  )}
                  initial={reduceMotion ? false : { width: 0 }}
                  animate={{ width: `${utilization}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
                >
                  {/* glossy top highlight on the fill */}
                  <span className="absolute inset-x-1 top-px h-[2px] rounded-full bg-white/60" aria-hidden />
                </motion.div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-white/75">
                <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-white">
                  <span className={cn("size-1.5 shrink-0 rounded-full", highUtilization ? "bg-red-400" : utilization >= 50 ? "bg-amber-300" : "bg-emerald-300")} aria-hidden />
                  {utilization}% used
                </span>
                <span className="min-w-0 truncate tabular-nums">
                  <span className="font-semibold text-white">{formatCurrency(Math.max(0, card.available))}</span> available{card.sharedLimit ? " (shared)" : ""}
                </span>
              </div>
            </div>
          </div>

          {/* Bill status — from the canonical Pay Now scope only (never an already-paid bill's date) */}
          {/* Full-bleed glass band along the card's bottom edge (negative margin cancels the tile's side padding) */}
          <div className="relative -mx-5 flex items-center justify-between gap-2 rounded-b-[16px] border-t border-white/15 bg-black/25 px-5 py-2.5 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <span className="min-w-0 truncate text-white/75 tabular-nums">
              {due.dueDate
                ? `Bill ${formatCurrency(due.amount)} · ${formatDueDate(due.dueDate)}`
                : `Next statement ${formatDueDate(statementWindowForDate(card.card, new Date()).periodEnd)}`}
            </span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold ring-1",
                due.tone === "overdue" || due.tone === "soon"
                  ? "bg-red-500/25 text-red-50 ring-red-300/40"
                  : due.tone === "clear"
                    ? "bg-emerald-400/15 text-emerald-50 ring-emerald-200/30"
                    : "bg-white/15 text-white ring-white/25",
              )}
            >
              {(due.tone === "overdue" || due.tone === "soon") && <span className="size-1.5 animate-pulse rounded-full bg-red-300" aria-hidden />}
              {due.tone === "clear" && <Check className="size-3 text-emerald-300" strokeWidth={3} aria-hidden />}
              {due.tone === "clear" ? "No bill due" : due.label}
            </span>
          </div>
        </motion.div>
      </div>
    </StaggerItem>
  );
}
