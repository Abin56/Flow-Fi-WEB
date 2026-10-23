"use client";

import { Link2, Lock, MoreVertical, Wifi } from "lucide-react";
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StaggerItem } from "@/components/foundation/animated-container";
import { BankLogo } from "@/components/finance/bank-logo";
import { formatCurrency } from "@/lib/format";
import type { CreditCardViewItem } from "@/features/credit-cards/hooks/use-credit-cards-data";
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

function daysUntil(date: Date): number {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
}

function formatDueDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
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

/** Card-stack-style tile styled after real bank card art — a solid gradient face (not a clay surface) so it
 *  reads as "a card" sitting on the page, with the utilization bar flipping to red once usage crosses 80%.
 *  Presentation only: a pointer-following tilt + glare, a hover shine sweep and an animated usage bar. */
export function CreditCardTile({ card, bankId, active, partnerHighlighted, onHoverChange, onClick, onEdit, onDelete }: CreditCardTileProps) {
  // The engine's exposure ratio (outstanding + locked card-EMI principal) — recomputing from the account
  // balance alone hid a card-linked EMI's lock, so the tile disagreed with Available.
  const utilization = Math.min(100, Math.round(card.utilizationPercent));
  const dueInDays = card.dueDate ? daysUntil(card.dueDate) : null;
  const urgent = dueInDays != null && dueInDays <= 5;
  const highUtilization = utilization >= 80;

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
      <div className="h-full [perspective:1100px]">
        <motion.div
          role="button"
          tabIndex={0}
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
          whileHover={reduceMotion ? undefined : { y: -4 }}
          whileTap={reduceMotion ? undefined : { scale: 0.985 }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
          style={{
            background: CARD_GRADIENT[card.accent],
            rotateX: reduceMotion ? 0 : rotateX,
            rotateY: reduceMotion ? 0 : rotateY,
          }}
          className={cn(
            "group/tile relative flex h-full cursor-pointer flex-col gap-2.5 overflow-hidden rounded-[16px] p-3.5 text-white shadow-[0_10px_28px_-12px_rgba(0,0,0,0.55),0_2px_6px_-2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_0_0_1px_rgba(255,255,255,0.12)] outline-none transition-shadow duration-300 hover:shadow-[0_22px_44px_-14px_rgba(0,0,0,0.6),0_4px_10px_-4px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_0_0_1px_rgba(255,255,255,0.18)] focus-visible:ring-2 focus-visible:ring-ring",
            active && "shadow-[0_14px_34px_-14px_rgba(0,0,0,0.5)] ring-2 ring-primary-accent-text ring-offset-2 ring-offset-background",
            partnerHighlighted && !active && "ring-2 ring-white/70 ring-offset-2 ring-offset-background",
          )}
        >
          {/* glass top-light: a soft white wash fading down the face */}
          <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.16] to-transparent" aria-hidden />
          {/* soft sheen, like card stock */}
          <span className="pointer-events-none absolute -top-16 -right-10 size-40 rounded-full bg-white/10 blur-2xl" aria-hidden />
          {/* faint guilloche rings, like printed card art */}
          <span className="pointer-events-none absolute -bottom-24 -left-16 size-56 rounded-full border border-white/[0.07]" aria-hidden />
          <span className="pointer-events-none absolute -bottom-32 -left-24 size-72 rounded-full border border-white/[0.05]" aria-hidden />
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

          <div className="relative flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                {bankId && <BankLogo bankId={bankId} size={22} className="shadow-sm ring-white/40" />}
                <h3 className="truncate font-heading text-[15px] font-semibold">{card.name}</h3>
              </div>
              {/* number + shared-limit pill share one row, so cards stay compact and aligned */}
              <div className="mt-1 flex min-h-[22px] min-w-0 items-center gap-2">
                <p className="shrink-0 text-xs tracking-[0.18em] text-white/75 tabular-nums">•••• {card.last4}</p>
                {card.sharedLimit && (
                  <p className="inline-flex min-w-0 items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] font-semibold text-white/90 ring-1 ring-white/20 backdrop-blur-sm">
                    <span className="relative flex size-3 shrink-0 items-center justify-center">
                      <Link2 className="size-3" strokeWidth={2.25} />
                      {partnerHighlighted && <span className="absolute inset-0 animate-ping rounded-full bg-white/40" aria-hidden />}
                    </span>
                    <span className="truncate">
                      Shared{card.sharedLimit.siblings.length > 0 ? ` · ${card.sharedLimit.siblings.map((s) => s.last4).join(", ")}` : ""}
                    </span>
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[11px] font-bold tracking-wide text-white/75 italic uppercase">{card.network}</span>
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
                <DropdownMenuContent align="end" className="rounded-[8px]">
                  <DropdownMenuItem onSelect={() => onEdit?.()}>Edit</DropdownMenuItem>
                  <DropdownMenuItem className="text-expense" onSelect={() => onDelete?.()}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* frosted-glass panel holding the money figures */}
          <div className="relative rounded-[12px] bg-white/[0.11] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_14px_-6px_rgba(0,0,0,0.35)] ring-1 ring-white/20 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-white/65 uppercase">Credit used</p>
            {/* chip + contactless, like a physical card */}
            <span className="flex items-center gap-1.5" aria-hidden>
              <Wifi className="size-3.5 rotate-90 text-white/60" strokeWidth={2.25} />
              <span className="h-4 w-5.5 rounded-[3px] border border-white/40 bg-gradient-to-br from-amber-100 via-amber-300/90 to-amber-500/70 shadow-[0_1px_3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.6)]" />
            </span>
          </div>
          {/* used amount and limit share one baseline, so figures line up on every card */}
          <div className="mt-1 flex items-end justify-between gap-3">
            <p className="min-w-0 truncate text-[24px] leading-none font-bold tracking-tight tabular-nums">{formatCurrency(card.usedCredit)}</p>
            <div className="shrink-0 text-right leading-none">
              <p className="text-[9.5px] font-semibold tracking-[0.08em] text-white/60 uppercase">{card.sharedLimit ? "Shared limit" : "Limit"}</p>
              <p className="mt-1 text-sm font-semibold text-white/90 tabular-nums">{formatCurrency(card.creditLimit)}</p>
            </div>
          </div>
          <div className="mt-2 flex min-h-[20px] items-center">
            {card.lockedEmiPrincipal > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2 py-0.5 text-[10.5px] font-medium text-white/85 tabular-nums ring-1 ring-white/15">
                <Lock className="size-3" strokeWidth={2.25} />
                {formatCurrency(card.lockedEmiPrincipal)} EMI locked
              </span>
            )}
          </div>

          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-white/75">
              <span>Utilization</span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-white">
                <span className={cn("size-1.5 rounded-full", highUtilization ? "bg-red-400" : utilization >= 50 ? "bg-amber-300" : "bg-emerald-300")} aria-hidden />
                {utilization}%
                <span className="font-medium text-white/65">· {highUtilization ? "High" : utilization >= 50 ? "Moderate" : "Healthy"}</span>
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/25 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  highUtilization
                    ? "bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.7)]"
                    : utilization >= 50
                      ? "bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.6)]"
                      : "bg-white shadow-[0_0_10px_rgba(255,255,255,0.55)]",
                )}
                initial={reduceMotion ? false : { width: 0 }}
                animate={{ width: `${utilization}%` }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-white/75">
              <span>Available{card.sharedLimit ? " (shared)" : ""}</span>
              <span className="font-semibold text-white tabular-nums">{formatCurrency(Math.max(0, card.available))}</span>
            </div>
          </div>
          </div>

          <div className="relative mt-auto flex items-center justify-between border-t border-white/15 pt-2.5 text-[11.5px]">
            <span className="text-white/70">{card.dueDate ? `Due on ${formatDueDate(card.dueDate)}` : "No statement due"}</span>
            {dueInDays != null && (
              <span className={cn("flex items-center gap-1.5 font-semibold", urgent ? "rounded-full bg-red-500/25 px-2 py-0.5 text-red-100 ring-1 ring-red-300/40" : "text-white/70")}>
                {urgent && <span className="size-1.5 animate-pulse rounded-full bg-red-300" aria-hidden />}
                {dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
              </span>
            )}
          </div>
        </motion.div>
      </div>
    </StaggerItem>
  );
}
