"use client";

import { Link2 } from "lucide-react";
import { BankLogo } from "@/components/finance/bank-logo";
import { bankById } from "@/lib/data/bank-registry";
import { motion } from "framer-motion";
import type { CardNetwork } from "@/lib/models/credit-card";
import { cn } from "@/lib/utils";

const NETWORK_LABEL: Record<CardNetwork, string> = { visa: "VISA", mastercard: "Mastercard", rupay: "RuPay", amex: "AMEX" };

export interface PreviewCard {
  name: string;
  holder: string;
  last4: string;
  network: CardNetwork | null;
  /** Its own bank (the second card may differ); defaults to the preview's. */
  bankId?: string | null;
  /** Its own gradient; defaults to the preview's. */
  background?: string;
}

function Face({ card, background, bank, className }: { card: PreviewCard; background: string; bank: string | null; className?: string }) {
  return (
    <div
      style={{ background }}
      className={cn(
        "relative flex min-h-[116px] flex-col justify-between gap-3 rounded-[10px] border border-black/10 p-3.5 text-white shadow-e1 sm:aspect-[1.586] sm:min-h-0",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-4.5 w-6 rounded-[3px] border border-white/40 bg-gradient-to-br from-amber-200/90 to-amber-500/70" />
          {(card.bankId ?? bank) && (
            <span className="flex items-center gap-1.5">
              <BankLogo bankId={card.bankId ?? bank} size={18} className="ring-white/40" />
              <span className="text-[10px] font-bold tracking-[0.08em] text-white/80 uppercase">{bankById(card.bankId ?? bank)?.shortCode}</span>
            </span>
          )}
        </div>
        {card.network && (
          <span className="flex h-5 shrink-0 items-center justify-center rounded-[4px] border border-white/25 bg-white/10 px-1.5 text-[9px] font-bold tracking-wide italic">
            {NETWORK_LABEL[card.network]}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-mono text-sm tracking-[0.12em] whitespace-nowrap text-white/90">•••• •••• •••• {card.last4 || "••••"}</p>
        <p className="truncate text-xs font-semibold tracking-wide text-white/85 uppercase">{card.name}</p>
        {card.holder && <p className="truncate text-[10px] font-medium tracking-wide text-white/70 uppercase">{card.holder}</p>}
      </div>
    </div>
  );
}

/**
 * Add/Edit Card live preview — this card, the bank, its limit, and (when sharing) the other card peeking
 * out behind it, so "two cards, one limit" is visible before saving.
 */
export function CardFormPreview({
  card,
  partner,
  background,
  bank,
  limitLine,
  variant = "stack",
}: {
  card: PreviewCard;
  partner: PreviewCard | null;
  background: string;
  /** Issuing bank id — shown as its logo + short code. */
  bank: string | null;
  limitLine: string | null;
  /** "stack": the other card peeks out behind. "pair": both shown in full, one above the other (side panel). */
  variant?: "stack" | "pair";
}) {
  if (variant === "pair") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">This card</span>
        <Face card={card} background={card.background ?? background} bank={bank} className="sm:aspect-[1.586]" />
        {partner && (
          <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2">
            <span className="flex items-center gap-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              <Link2 className="size-3" strokeWidth={2} />
              Other card
            </span>
            <Face card={partner} background={partner.background ?? background} bank={bank} className="sm:aspect-[1.586]" />
          </motion.div>
        )}
        {limitLine && <p className="text-[11.5px] leading-snug font-medium text-foreground">{limitLine}</p>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={cn("relative", partner && "pt-2.5 pl-2.5")}>
        {partner && (
          <Face
            card={partner}
            background={partner.background ?? background}
            bank={bank}
            className="absolute top-0 right-2.5 bottom-2.5 left-0 min-h-0 opacity-60 sm:aspect-auto"
          />
        )}
        <Face card={card} background={card.background ?? background} bank={bank} className="relative" />
      </div>
      {limitLine && (
        <p className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          {partner && <Link2 className="size-3" strokeWidth={2} />}
          {limitLine}
        </p>
      )}
    </div>
  );
}
