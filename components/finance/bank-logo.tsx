"use client";

import { Landmark } from "lucide-react";
import { useState } from "react";
import { bankById, GENERIC_BANK, type BankInfo } from "@/lib/data/bank-registry";
import { cn } from "@/lib/utils";

type BankLogoShape = "circle" | "square";

interface BankLogoProps {
  /** Either an account/card's persisted `bankId`, or `null`/`undefined` for "no bank set". */
  bankId?: string | null;
  /** Rendered box size in px — the image is scaled to fit inside it. */
  size?: number;
  shape?: BankLogoShape;
  className?: string;
}

const LOGO_DIR = "/banks/logos";

function shapeClass(shape: BankLogoShape) {
  return shape === "circle" ? "rounded-full" : "rounded-lg";
}

/** Colored-initials badge — used until a real logo file exists for a bank, and forever for "Other". */
function MonogramBadge({ bank, size, shape, className }: { bank: BankInfo; size: number; shape: BankLogoShape; className?: string }) {
  return (
    <span
      role="img"
      aria-label={bank.name}
      className={cn("flex shrink-0 items-center justify-center font-bold text-white", shapeClass(shape), className)}
      style={{ width: size, height: size, background: bank.color, fontSize: Math.max(9, Math.round(size * 0.3)) }}
    >
      {bank.shortCode.slice(0, 4)}
    </span>
  );
}

function UnknownBadge({ size, shape, className }: { size: number; shape: BankLogoShape; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Bank not set"
      className={cn("flex shrink-0 items-center justify-center bg-muted text-muted-foreground", shapeClass(shape), className)}
      style={{ width: size, height: size }}
    >
      <Landmark style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

/**
 * Single source of truth for "show this bank's identity" everywhere in the app — Dashboard,
 * Accounts, Add/Edit forms, Bank Picker, Credit Cards, Transactions, Bills, Settings.
 *
 * Looks for `/banks/logos/{bankId}.svg`, then `.png`, in that order. Neither ships with the repo
 * yet — see `docs/bank-logo-assets.md` for the exact file list — so today every bank renders its
 * `MonogramBadge` (brand-colored initials). Drop a real logo file in with the matching bank id as
 * its filename and this component picks it up automatically, no code change required.
 */
export function BankLogo({ bankId, size = 32, shape = "circle", className }: BankLogoProps) {
  const bank = bankById(bankId);
  const [triedPng, setTriedPng] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Reset the onError fallback chain whenever the bank identity itself changes (e.g. switching
  // banks in the picker) — otherwise a previous bank's failed-image state would leak forward.
  // (React's documented "adjust state during render" pattern — cheaper than an effect + re-render.)
  const [lastBankId, setLastBankId] = useState(bank?.id);
  if (bank?.id !== lastBankId) {
    setLastBankId(bank?.id);
    setTriedPng(false);
    setImageFailed(false);
    setImageLoaded(false);
  }

  if (!bank) return <UnknownBadge size={size} shape={shape} className={className} />;
  if (bank.id === GENERIC_BANK.id) return <MonogramBadge bank={bank} size={size} shape={shape} className={className} />;
  if (imageFailed) return <MonogramBadge bank={bank} size={size} shape={shape} className={className} />;

  return (
    <span
      className={cn("relative flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-border/60", shapeClass(shape), className)}
      style={{ width: size, height: size }}
    >
      {/* Monogram shows immediately and stays underneath until the real logo has actually
          finished loading — no asset exists yet for most banks, so without this the broken-image
          box would flash at its default intrinsic size for the two failed svg/png requests. */}
      {!imageLoaded && (
        <span className="absolute inset-0">
          <MonogramBadge bank={bank} size={size} shape={shape} />
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- bank id set is open-ended and file
          presence is unknown at build time, so this needs a runtime onError fallback chain that
          next/image's static import pipeline doesn't support for this use case. */}
      <img
        key={bank.id}
        src={`${LOGO_DIR}/${bank.id}.${triedPng ? "png" : "svg"}`}
        alt={bank.name}
        width={size}
        height={size}
        decoding="async"
        className={cn("relative size-full object-contain p-[14%]", !imageLoaded && "invisible")}
        onLoad={() => setImageLoaded(true)}
        onError={() => {
          if (!triedPng) setTriedPng(true);
          else setImageFailed(true);
        }}
      />
    </span>
  );
}
