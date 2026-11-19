"use client";

/**
 * The Inbox list: a transaction-led ledger browsed Month → Day → rows (the day bar in `day-navigator.tsx`), replacing the old status-first table + card stack. ONE row
 * component serves every width — it reflows from its container (not the viewport, because the app's sidebar leaves a
 * 768px tablet only ~500px):
 *
 *   narrow  (< 56rem): checkbox · avatar · merchant / meta / attention notice · amount; then a full-width Review + Dismiss line
 *   wide    (≥ 56rem): one aligned line = checkbox · avatar · merchant/meta · notice · amount · actions
 *
 * Every control is independent (checkbox, notice button, Review, Dismiss) and nothing wraps them in a button role. A mouse
 * click on empty row space opens the review as a convenience; the keyboard path is each row's Review button.
 *
 * Presentation only: every fact shown comes from the candidate / `CandidateRowModel` the workspace computed with the
 * existing status, matching and duplicate logic. Month headers show a COUNT, never a money total — these are unconfirmed
 * SMS candidates, not transactions.
 */

import { BankLogo } from "@/components/finance/bank-logo";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, LayoutGrid, MessageSquareText, Rows3, ScanSearch, TriangleAlert } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { revealBlock } from "@/features/people/lib/row-reveal";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { smsCandidateEventTypeLabel, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { MatchedIdentity } from "../lib/candidate-account-matching";
import { looksLikeRawReference } from "../lib/candidate-details-view";
import { buildDayIndex } from "../lib/candidate-day-nav";
import type { CandidateGroup } from "../lib/candidate-month-groups";
import { candidateDayKey } from "../lib/filters";
import {
  amountSummary,
  candidateTitle,
  CHECKBOX_CLASS,
  FOCUS_RING,
  ReviewButton,
  RowCheckbox,
  signedAmountText,
  type CandidateRowModel,
} from "./candidate-row-parts";
import { CandidateMatchPanel, DuplicateSticker } from "./candidate-match-panel";
import { DayHeading, DayNavBar, useSelectedDay } from "./day-navigator";
import { IgnoreCandidateButton } from "./ignore-candidate-button";

const INTERACTIVE = "button, a, input, label, [role='checkbox'], [role='combobox']";

export interface LedgerGroup extends Omit<CandidateGroup, "candidates"> {
  rows: CandidateRowModel[];
}

interface RowActions {
  onToggle: (id: string, checked: boolean) => void;
  onReview: (id: string) => void;
  candidateRepository: SmsTransactionCandidateRepository | null;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
}

// ── avatar ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Up to two initials from a real merchant name; `null` when there's no name or it's a raw reference (initials of "IGST-VPS27…" would mislead). */
export function merchantInitials(merchant: string | null): string | null {
  if (!merchant || looksLikeRawReference(merchant)) return null;
  const words = merchant
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[1])[0]];
  return letters.join("").toUpperCase();
}

/**
 * Neutral monogram tile — the same quiet surface for every merchant, never a logo or a random hue (so it can't suggest a
 * business the SMS didn't name). The corner arrow carries direction as a SHAPE, so debit vs credit never rests on colour.
 */
function MerchantAvatar({ candidate, compact = false }: { candidate: Pick<SmsTransactionCandidate, "merchant" | "direction">; compact?: boolean }) {
  const initials = merchantInitials(candidate.merchant);
  const credit = candidate.direction === "credit";
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center border border-border bg-secondary font-semibold tracking-wide text-foreground",
        compact ? "size-8 rounded-[7px] text-[11.5px]" : "size-10 rounded-xl text-[13px]",
      )}
    >
      {initials ?? <MessageSquareText className={cn("text-muted-foreground", compact ? "size-3.5" : "size-4")} />}
      <span
        className={cn(
          "absolute flex items-center justify-center rounded-full border-2 border-card",
          compact ? "-right-1 -bottom-1 size-[15px]" : "-right-1 -bottom-1 size-[18px]",
          credit ? "bg-success text-success-foreground" : "bg-foreground text-background",
        )}
      >
        {credit ? <ArrowDownLeft className={compact ? "size-2" : "size-2.5"} strokeWidth={3} /> : <ArrowUpRight className={compact ? "size-2" : "size-2.5"} strokeWidth={3} />}
      </span>
    </span>
  );
}

// ── amount ───────────────────────────────────────────────────────────────────────────────────────────────────────

function LedgerAmount({ candidate, className }: { candidate: Pick<SmsTransactionCandidate, "amount" | "direction">; className?: string }) {
  const credit = candidate.direction === "credit";
  return (
    <span aria-label={`${credit ? "Credit" : "Debit"} ${amountSummary(candidate)}`} className={cn("flex flex-col items-end leading-tight", className)}>
      <span className={cn("text-base font-bold tracking-tight whitespace-nowrap tabular-nums @4xl:text-lg", credit ? "text-success" : "text-foreground")}>{signedAmountText(candidate)}</span>
      <span aria-hidden className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {credit ? "Credit" : "Debit"}
      </span>
    </span>
  );
}

// ── attention notice: shown ONLY when the candidate needs the reviewer; a clean row shows nothing ─────────────────────

const NOTICE_BASE = "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap text-foreground";

/** Grid cards: a small squared tag that sits on the account line instead of a full pill on its own line. */
const NOTICE_COMPACT = "h-6 gap-1 rounded-[5px] px-1.5 text-[11.5px]";

function AttentionNotice({ row, onReview, compact = false }: { row: CandidateRowModel; onReview: (id: string) => void; compact?: boolean }) {
  const { candidate, status } = row;
  const title = candidateTitle(candidate);
  const detail = [status.explanation, ...status.reasons].filter(Boolean).join(" ");

  if (status.lane === "noIssues") return null;

  // A possible duplicate is told ONCE, by the row's corner sticker — never repeated here.
  if (status.lane === "duplicate") return null;

  if (status.lane === "needsAccount") {
    // The one notice that is also an action: it opens the review drawer where the destination is chosen.
    return (
      <button
        type="button"
        onClick={() => onReview(candidate.id)}
        title={detail}
        className={cn(NOTICE_BASE, "border-warning/70 bg-warning/20 transition-colors hover:bg-warning/30 motion-reduce:transition-none", FOCUS_RING, compact && NOTICE_COMPACT)}
      >
        <TriangleAlert className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
        Needs account
        <ChevronRight className="-mr-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="sr-only">
          {" "}
          — choose an account for {title} {amountSummary(candidate)}
        </span>
      </button>
    );
  }

  const low = candidate.confidenceLevel === "low";
  return (
    <span className={cn(NOTICE_BASE, "border-warning/50 bg-warning/10", compact && NOTICE_COMPACT)} title={detail}>
      <ScanSearch className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
      {low ? "Needs review" : "Review suggested"}
    </span>
  );
}

// ── bank / card identity ──

/** Verified match only: the bank's logo (existing BankLogo, monogram fallback), the card/account name and the masked last four. */
export function IdentityChip({ identity, className, logoSize = 18, logoShape }: { identity: MatchedIdentity; className?: string; logoSize?: number; logoShape?: "circle" | "square" }) {
  const label = `${identity.name}${identity.last4 ? ` •••• ${identity.last4}` : ""}`;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/60 py-0.5 pr-2 pl-0.5 text-xs font-semibold text-foreground", className)} title={`${identity.kind === "card" ? "Credit card" : "Account"}: ${label}`}>
      <BankLogo bankId={identity.bankId} size={logoSize} {...(logoShape ? { shape: logoShape } : {})} />
      <span className="min-w-0 truncate">{identity.name}</span>
      {identity.last4 && <span className="shrink-0 font-medium text-muted-foreground tabular-nums">•••• {identity.last4}</span>}
    </span>
  );
}

// ── quick preview: the parsed facts already on the candidate that the row itself doesn't show — never the raw SMS
// text, which the model doesn't carry (see docs/sms-candidate-contract.md). Collapsed by default so it never adds a
// permanent third line; a reviewer who wants it taps once instead of opening the drawer. ──────────────────────────

function quickPreviewFacts(row: CandidateRowModel): string[] {
  const { candidate, status } = row;
  const facts: string[] = [];
  if (row.rematch) {
    const why =
      row.rematch.reason === "stale"
        ? "its previous account no longer ends in these digits"
        : row.rematch.reason === "missing"
          ? "its previous account was removed"
          : "an account now ends in these digits";
    facts.push(`Matched to ${row.rematch.label} by last-4${row.rematch.bankConfirmed ? " and bank" : ""} — ${why}.`);
  }
  if (status.lane !== "noIssues" && status.lane !== "duplicate") {
    const detail = status.explanation || status.reasons.join(" ");
    if (detail) facts.push(detail);
  }
  // The identity chip already names the bank when matched — only worth repeating here when nothing matched.
  if (!row.identity && candidate.bankName && candidate.bankName !== candidate.merchant) facts.push(`Bank: ${candidate.bankName}`);
  if (candidate.referenceNumber) facts.push(`Reference: ${candidate.referenceNumber}`);
  return facts;
}

function QuickPreviewToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Hide SMS details" : "Show SMS details"}
      title={open ? "Hide SMS details" : "Show SMS details"}
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground motion-reduce:transition-none", FOCUS_RING)}
    >
      <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
    </button>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function Dot() {
  return (
    <span aria-hidden className="text-border-strong">
      ·
    </span>
  );
}

/**
 * Memoized: opening the details sheet re-renders the whole workspace, and re-drawing every row of a long inbox at that
 * moment is what made the sheet's slide-in stutter. A row only redraws when its own model (or the stable `actions`) changes.
 */
const LedgerRow = memo(function LedgerRow({ row, actions, showDate, index }: { row: CandidateRowModel; actions: RowActions; showDate: boolean; index: number }) {
  const { candidate, status } = row;
  const isDuplicate = status.lane === "duplicate";
  const matches = row.matches ?? [];
  // Strict duplicate OR a similar saved transaction the strict check didn't flag: both get the same single corner sticker
  // (the lane and every count are unchanged — the sticker is presentation only).
  const flagged = isDuplicate || matches.length > 0;
  const [matchesOpen, setMatchesOpen] = useState(false);
  const matchesId = useId();
  const unnamed = candidate.merchant == null;
  // Under a day heading the date is already known — show the time instead (only when the candidate carries one).
  const d = candidate.transactionDate;
  const timeText = d.getHours() !== 0 || d.getMinutes() !== 0 ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }) : null;
  const dateText = showDate ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : timeText;
  const confidenceNote = candidate.confidenceLevel === "high" ? null : `${candidate.confidenceLevel === "medium" ? "Medium" : "Low"} confidence`;
  const previewFacts = quickPreviewFacts(row);
  const [previewOpen, setPreviewOpen] = useState(false);

  function onRowClick(e: MouseEvent<HTMLLIElement>) {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    actions.onReview(candidate.id);
  }

  return (
    <li
      data-testid="candidate-row"
      data-candidate-id={candidate.id}
      data-lane={status.lane}
      onClick={onRowClick}
      className={cn(
        "group/row relative cursor-pointer transition-colors duration-150 motion-reduce:transition-none",
        // Rows past the first screenful skip layout + paint until they near the viewport (the browser remembers each row's real height
        // once seen), which keeps scrolling smooth through a long inbox. The first rows are never skipped, so they are always fully
        // rendered, readable (innerText) and focusable the moment the list appears; `auto` keeps find-in-page and scrollIntoView working.
        index >= 20 && "[contain-intrinsic-size:auto_4.5rem] [content-visibility:auto]",
        row.selected ? "bg-primary/12 hover:bg-primary/16" : "hover:bg-muted/60",
        "focus-within:bg-muted/60",
      )}
    >
      {/* State rail: lime = selected (the checked box says it too). A duplicate is told by the corner sticker alone. */}
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", row.selected ? "bg-primary" : "bg-transparent")} />
      {flagged && (
        <DuplicateSticker
          exact={isDuplicate || matches[0]?.kind === "exact"}
          open={matches.length > 0 ? matchesOpen : null}
          controls={matches.length > 0 ? matchesId : undefined}
          onClick={() => (matches.length > 0 ? setMatchesOpen((o) => !o) : actions.onReview(candidate.id))}
        />
      )}
      <div
        className={cn(
          "grid grid-cols-[2.75rem_2.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 py-2 pr-2.5 pl-1 @4xl:grid-cols-[2.75rem_2.5rem_minmax(0,1fr)_10rem_9rem_11rem] @4xl:gap-y-0 @4xl:py-2.5 @4xl:pr-3",
          // Room for the corner sticker, so it never sits on the avatar or the merchant name.
          flagged && "pt-6 @4xl:pt-6",
        )}
      >
        <RowCheckbox row={row} onToggle={actions.onToggle} className="col-start-1 row-start-1" />
        <div className="col-start-2 row-start-1">
          <MerchantAvatar candidate={candidate} />
        </div>

        <div className="col-start-3 row-start-1 flex min-w-0 flex-col gap-0.5">
          <span className={cn("truncate text-[15px] leading-snug font-semibold @4xl:text-base", unnamed ? "text-muted-foreground italic" : "text-foreground")} title={candidate.merchant ?? undefined}>
            {unnamed ? "Unknown merchant" : candidateTitle(candidate)}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-snug text-muted-foreground @4xl:flex-nowrap">
            <span className="flex min-w-0 items-center gap-1.5">
              {dateText && (
                <>
                  <span className="shrink-0 whitespace-nowrap">{dateText}</span>
                  <Dot />
                </>
              )}
              <span className="min-w-0 truncate">{smsCandidateEventTypeLabel(candidate.eventType)}</span>
            </span>
            <span className="hidden @4xl:inline">
              <Dot />
            </span>
            {row.identity ? (
              <IdentityChip identity={row.identity} className="basis-full @4xl:basis-auto" />
            ) : (
              <span className="min-w-0 basis-full truncate @4xl:basis-auto" title={row.accountHint}>
                {row.accountHint}
              </span>
            )}
            {row.accountSuggestion && (
              <span aria-hidden className="hidden @4xl:inline">
                <Dot />
              </span>
            )}
            {row.accountSuggestion && (
              <span className="min-w-0 basis-full truncate font-medium text-foreground/80 @4xl:basis-auto" title="A saved account ends in the same last-4 — open Review to confirm it. Nothing is linked automatically." data-testid="account-suggestion">
                Suggested: {row.accountSuggestion}
              </span>
            )}
            {previewFacts.length > 0 && <QuickPreviewToggle open={previewOpen} onToggle={() => setPreviewOpen((o) => !o)} />}
          </span>
          {(confidenceNote || looksLikeRawReference(candidate.merchant) || (row.selectBlockedReason && !row.selected)) && (
            <span className="truncate text-xs leading-snug text-muted-foreground">
              {[confidenceNote, looksLikeRawReference(candidate.merchant) ? "Name unclear" : null, row.selectBlockedReason && !row.selected ? "Review individually" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {/* The saved transaction(s) behind the sticker — folded until the sticker is clicked. */}
          {matches.length > 0 && <CandidateMatchPanel id={matchesId} matches={matches} open={matchesOpen} onCompare={() => actions.onReview(candidate.id)} />}
          {/* Narrow only: the notice sits with the merchant it's about. Wide rows use the aligned notice column below. */}
          <div className="mt-1 flex empty:hidden @4xl:hidden">
            <AttentionNotice row={row} onReview={actions.onReview} />
          </div>
        </div>

        <LedgerAmount candidate={candidate} className="col-start-4 row-start-1 @4xl:col-start-5" />

        {/* Narrow: its own full-width line. Wide: dissolves so the notice and the actions join the single aligned row. */}
        <div className="col-span-2 col-start-3 row-start-2 flex items-center gap-2 @4xl:contents">
          <div className="hidden min-w-0 @4xl:col-start-4 @4xl:row-start-1 @4xl:block">
            <AttentionNotice row={row} onReview={actions.onReview} />
          </div>
          <div className="flex flex-1 items-center justify-end gap-1.5 @4xl:col-start-6 @4xl:row-start-1 @4xl:flex-none">
            <ReviewButton candidate={candidate} onReview={actions.onReview} className="h-11 flex-1 @4xl:h-10 @4xl:min-w-[4.75rem] @4xl:flex-none" />
            {actions.candidateRepository && (
              <IgnoreCandidateButton
                candidate={candidate}
                candidateRepository={actions.candidateRepository}
                onHide={actions.onHide}
                onUnhide={actions.onUnhide}
                className={cn("h-11 w-28 shrink-0 border border-border-strong @4xl:h-10 @4xl:w-auto @4xl:border-transparent @4xl:px-2.5", FOCUS_RING)}
              />
            )}
          </div>
        </div>
      </div>
      {previewOpen && previewFacts.length > 0 && (
        <div className="pb-2.5 pl-16 pr-3 @4xl:pb-2" data-testid="candidate-quick-preview">
          <ul className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-snug text-muted-foreground">
            {previewFacts.map((fact, i) => (
              <li key={i} className="truncate">
                {fact}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
});

// ── grid card: the same facts and actions as a row, laid out as a tile ───────────────────────────────────────────

/**
 * Grid view tile. Presentation only — the same `CandidateRowModel`, the same checkbox / Review / Dismiss controls and the same
 * single duplicate sticker as the list row; a click on empty card space opens Review, exactly like a row.
 */
const LedgerCard = memo(function LedgerCard({ row, actions, index }: { row: CandidateRowModel; actions: RowActions; index: number }) {
  const { candidate, status } = row;
  const isDuplicate = status.lane === "duplicate";
  const matches = row.matches ?? [];
  const flagged = isDuplicate || matches.length > 0;
  const [matchesOpen, setMatchesOpen] = useState(false);
  const matchesId = useId();
  const unnamed = candidate.merchant == null;
  const d = candidate.transactionDate;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  const dayText = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const timeText = hasTime ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }) : null;
  const credit = candidate.direction === "credit";

  function onCardClick(e: MouseEvent<HTMLLIElement>) {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    // Clicks bubble here from portalled content too (the Dismiss tooltip) — only a click inside the card itself counts.
    if (!e.currentTarget.contains(e.target as Node)) return;
    // Selecting text (to copy an amount or merchant) is not a request to open Review.
    if (window.getSelection()?.toString()) return;
    actions.onReview(candidate.id);
  }

  return (
    <li
      data-testid="candidate-row"
      data-layout="grid"
      data-candidate-id={candidate.id}
      data-lane={status.lane}
      onClick={onCardClick}
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
      className={cn(
        // Neutral surface, 10px corners; colour is only an accent (left rail, amount, direction tag). No hover lift: a card that moves
        // under the pointer invites a mis-click on the action row.
        "group/card relative isolate flex cursor-pointer flex-col overflow-hidden rounded-[10px] border bg-card shadow-e1",
        "animate-in fade-in-0 fill-mode-backwards duration-200 motion-reduce:animate-none",
        "transition-[box-shadow,border-color,background-color] duration-150 hover:shadow-e2 motion-reduce:transition-none",
        row.selected ? "border-primary bg-primary/[0.04] ring-1 ring-primary/40" : flagged ? "border-danger/35 hover:border-danger/55" : "border-border hover:border-border-strong",
      )}
    >
      {/* Direction rail: Money In = green, Money Out = coral. The sign, the tag and the avatar arrow say it too — never colour alone. */}
      <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px]", credit ? "bg-success/75" : "bg-expense/60")} />
      {flagged && (
        <DuplicateSticker
          exact={isDuplicate || matches[0]?.kind === "exact"}
          open={matches.length > 0 ? matchesOpen : null}
          controls={matches.length > 0 ? matchesId : undefined}
          onClick={() => (matches.length > 0 ? setMatchesOpen((o) => !o) : actions.onReview(candidate.id))}
        />
      )}

      <div className={cn("flex flex-col gap-1.5 pr-2.5 pb-2.5 pl-3.5", flagged ? "pt-6" : "pt-2.5")}>
        {/* Date · time, and selection (the 32px target overlaps the padding so it adds no height). */}
        <div className="flex h-4 items-center justify-between gap-2">
          <span className="truncate text-[11.5px] font-medium text-muted-foreground tabular-nums">
            {dayText}
            {timeText && <span className="text-muted-foreground/80"> · {timeText}</span>}
          </span>
          <RowCheckbox row={row} onToggle={actions.onToggle} className="-my-2 -mr-1.5 size-8" />
        </div>

        {/* Amount — the strongest element — with its direction tag. */}
        <div className="flex items-center justify-between gap-2">
          <span
            aria-label={`${credit ? "Credit" : "Debit"} ${amountSummary(candidate)}`}
            className={cn("truncate font-heading text-[22px] leading-[1.1] font-bold tracking-tight tabular-nums", credit ? "text-success" : "text-foreground")}
          >
            {signedAmountText(candidate)}
          </span>
          <span
            aria-hidden
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-[4px] px-1.5 py-[3px] text-[10px] leading-none font-bold tracking-[0.06em] uppercase",
              credit ? "bg-success/12 text-success" : "bg-expense/10 text-expense",
            )}
          >
            {credit ? <ArrowDownLeft className="size-3" strokeWidth={2.75} /> : <ArrowUpRight className="size-3" strokeWidth={2.75} />}
            {credit ? "Credit" : "Debit"}
          </span>
        </div>

        {/* Merchant + transaction type */}
        <div className="flex min-w-0 items-center gap-2">
          <MerchantAvatar candidate={candidate} compact />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className={cn("truncate text-[13.5px] font-semibold", unnamed ? "text-muted-foreground" : "text-foreground")} title={candidate.merchant ?? undefined}>
              {unnamed ? "Unknown merchant" : candidateTitle(candidate)}
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">{smsCandidateEventTypeLabel(candidate.eventType)}</span>
          </div>
        </div>

        {/* Account line — the attention notice (Needs account / Needs review) shares it on ONE line, so flagged cards keep the same
            height; the account text truncates first (full text in its tooltip). */}
        <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {row.identity ? (
            <IdentityChip identity={row.identity} logoSize={16} logoShape="square" className="max-w-full min-w-0 rounded-[5px] border-transparent bg-secondary/70 py-[3px] pr-1.5 pl-[3px] text-[11.5px]" />
          ) : (
            <span className="min-w-0 truncate" title={row.accountHint}>
              {row.accountHint}
            </span>
          )}
          {row.accountSuggestion && (
            <span className="min-w-0 truncate font-medium text-foreground/80" data-testid="account-suggestion" title="A saved account ends in the same last-4 — open Review to confirm it.">
              Suggested: {row.accountSuggestion}
            </span>
          )}
          <span className="ml-auto flex shrink-0 empty:hidden">
            <AttentionNotice row={row} onReview={actions.onReview} compact />
          </span>
        </div>

        {matches.length > 0 && <CandidateMatchPanel id={matchesId} matches={matches} open={matchesOpen} onCompare={() => actions.onReview(candidate.id)} />}
      </div>

      {/* Actions: Review (primary, fills on card hover — a card click opens it too) at the left; Dismiss, labelled, at the far right,
          so the two are never side by side. */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border-subtle px-2 py-1.5">
        <ReviewButton
          candidate={candidate}
          onReview={actions.onReview}
          className="h-[30px] min-w-[5.5rem] rounded-[7px] px-3 text-[13px] group-hover/card:border-primary group-hover/card:bg-primary group-hover/card:text-primary-foreground hover:bg-[var(--primary-hover)]"
        />
        {actions.candidateRepository && (
          <IgnoreCandidateButton
            candidate={candidate}
            candidateRepository={actions.candidateRepository}
            onHide={actions.onHide}
            onUnhide={actions.onUnhide}
            className={cn("h-[30px] shrink-0 rounded-[7px] px-2 text-[12.5px] text-muted-foreground", FOCUS_RING)}
          />
        )}
      </div>
    </li>
  );
});

// ── groups ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type LedgerLayout = "list" | "grid";

/** What "Select all eligible" would do for a set of cards — computed by the workspace with the same bulk-selection rules as the list. */
export interface ScopeSelection {
  allSelected: boolean;
  someSelected: boolean;
  disabled: boolean;
}

export function CandidateLedger({
  groups,
  shownCount,
  queueCount,
  allSelected,
  someSelected,
  selectAllDisabled,
  onToggleAll,
  selectionForScope,
  stickyTop = 0,
  ...liveActions
}: {
  groups: LedgerGroup[];
  /** Where a day heading / the day bar sticks (px, sticky-offset space): right under the page's own pinned bars. */
  stickyTop?: number;
  /** Rows currently shown / total in the queue — "Showing 12 of 126". */
  shownCount: number;
  queueCount: number;
  allSelected: boolean;
  someSelected: boolean;
  selectAllDisabled: boolean;
  /** `scopeIds` is the open day's rows (Grid and List alike): "all" means those — never rows the reviewer can't see. */
  onToggleAll: (checked: boolean, scopeIds?: readonly string[]) => void;
  /** The select-all state for just the open day's rows. Without it the whole-list state above is used. */
  selectionForScope?: (scopeIds: readonly string[]) => ScopeSelection;
} & RowActions) {
  // A stable `actions` object: its handlers always call the latest props, so the memoized rows never see a new identity
  // (and never act on a stale closure). Only the repository — which rows read as a value — can change it.
  const latest = useRef(liveActions);
  useEffect(() => {
    latest.current = liveActions;
  });
  const candidateRepository = liveActions.candidateRepository;
  const actions: RowActions = useMemo(
    () => ({
      onToggle: (id, checked) => latest.current.onToggle(id, checked),
      onReview: (id) => latest.current.onReview(id),
      onHide: (id) => latest.current.onHide(id),
      onUnhide: (id) => latest.current.onUnhide(id),
      candidateRepository,
    }),
    [candidateRepository],
  );
  const [layout, setLayout] = useLedgerLayout();
  const grid = layout === "grid";

  // ── Month → Day → Cards (Grid) or Rows (List) ──
  // The days come from the rows the workspace already filtered and sorted, so every count follows the active filters, and a
  // card that is dismissed (or imported) leaves its day's count at once.
  const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const dayIndex = useMemo(() => buildDayIndex(allRows, (r) => r.candidate.transactionDate), [allRows]);
  // A date sort opens on the day of its first row (Oldest first → the oldest day); any other sort opens on the newest day.
  const firstRowDay = groups[0] && !groups[0].flat && allRows[0] ? candidateDayKey(allRows[0].candidate.transactionDate) : null;
  const { day, select: selectDay } = useSelectedDay(dayIndex.days, firstRowDay);
  const dayRows = useMemo(() => (day ? (dayIndex.byDay.get(day) ?? []) : []), [dayIndex, day]);
  const selectedElsewhere = useMemo(() => {
    let n = 0;
    for (const [key, list] of dayIndex.byDay) if (key !== day) for (const r of list) if (r.selected) n++;
    return n;
  }, [dayIndex, day]);

  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const dayHeadingId = `${idBase}-heading`;
  const dayHeadingRef = useRef<HTMLDivElement>(null);
  // Changing day can leave the page scrolled past the new day's heading (a long day, then a short one): bring it back under the
  // pinned bars. A no-op when the heading is already in view, so it never moves the page needlessly.
  const shownDay = useRef(day);
  useEffect(() => {
    if (shownDay.current === day) return;
    shownDay.current = day;
    if (dayHeadingRef.current) revealBlock(dayHeadingRef.current);
  }, [day]);

  // "Select all" means the open day's rows in either layout — never rows the reviewer can't see.
  const scopeIds = dayRows.map((r) => r.candidate.id);
  const scoped = selectionForScope ? selectionForScope(scopeIds) : null;
  const allOn = scoped ? scoped.allSelected : allSelected;
  const someOn = scoped ? scoped.someSelected : someSelected;
  const selectOff = scoped ? scoped.disabled : selectAllDisabled;

  return (
    <div className="@container flex flex-col" data-testid="candidates-ledger">
      <div className="flex min-h-9 items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="candidates-shown">
          {shownCount === queueCount ? (
            <>
              <span className="font-semibold text-foreground tabular-nums">{queueCount}</span> in your inbox
            </>
          ) : (
            <>
              Showing <span className="font-semibold text-foreground tabular-nums">{shownCount}</span> of <span className="tabular-nums">{queueCount}</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-3">
          <LayoutSwitch value={layout} onChange={setLayout} />
          <label className={cn("flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground", selectOff && "cursor-not-allowed opacity-60")}>
            <Checkbox
              className={CHECKBOX_CLASS}
              checked={allOn ? true : someOn ? "indeterminate" : false}
              disabled={selectOff}
              onCheckedChange={(checked) => onToggleAll(checked === true, scopeIds)}
              aria-label="Select all visible candidates on this day that can be imported together"
            />
            Select all eligible on this day
          </label>
        </div>
      </div>

      {day && (
        <>
          <DayNavBar days={dayIndex.days} months={dayIndex.months} selected={day} onSelect={selectDay} stickyTop={stickyTop} idBase={idBase} panelId={panelId} />
          <DayHeading
            selected={day}
            count={dayRows.length}
            selectedElsewhere={selectedElsewhere}
            headingId={dayHeadingId}
            headingRef={dayHeadingRef}
          />
          {/* Keyed by day: the rows of a newly chosen day fade in (the same short fade a card always had; none under reduced motion) instead of snapping. */}
          <div role="tabpanel" id={panelId} aria-labelledby={`${idBase}-${day}`} data-testid="candidate-group" data-group-key={day}>
            {grid ? (
              <ul key={day} className="grid grid-cols-[repeat(auto-fill,minmax(14.5rem,1fr))] gap-2.5 pt-0.5 pb-2.5" aria-labelledby={dayHeadingId} data-testid="candidate-grid">
                {dayRows.map((row, i) => (
                  <LedgerCard key={row.candidate.id} row={row} actions={actions} index={i} />
                ))}
              </ul>
            ) : (
              <ul
                key={day}
                className="animate-in divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-e1 fade-in-0 duration-150 motion-reduce:animate-none"
                aria-labelledby={dayHeadingId}
                data-testid="candidate-list"
              >
                {dayRows.map((row, i) => (
                  <LedgerRow key={row.candidate.id} row={row} actions={actions} showDate={false} index={i} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const LAYOUT_KEY = "flowfi.inbox.layout";

/** List / Grid preference — a per-viewer convenience only (storage may be unavailable; it then simply defaults to List). */
function useLedgerLayout(): [LedgerLayout, (next: LedgerLayout) => void] {
  const [layout, setLayoutState] = useState<LedgerLayout>("list");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LAYOUT_KEY) === "grid") setLayoutState("grid");
    } catch {
      // storage blocked: keep List
    }
  }, []);
  function setLayout(next: LedgerLayout) {
    setLayoutState(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // storage blocked: the choice lasts for this visit only
    }
  }
  return [layout, setLayout];
}

function LayoutSwitch({ value, onChange }: { value: LedgerLayout; onChange: (next: LedgerLayout) => void }) {
  const options = [
    { value: "list" as const, label: "List view", Icon: Rows3 },
    { value: "grid" as const, label: "Grid view", Icon: LayoutGrid },
  ];
  return (
    <div role="group" aria-label="Layout" className="inline-flex shrink-0 rounded-[10px] border border-border-strong bg-card p-0.5" data-testid="layout-switch">
      {options.map(({ value: v, label, Icon }) => {
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            aria-label={label}
            title={label}
            onClick={() => onChange(v)}
            className={cn("inline-flex size-8 items-center justify-center rounded-lg transition-colors motion-reduce:transition-none", FOCUS_RING, on ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

/** Ledger-shaped placeholder: same month heading + rounded row surface, so nothing jumps when the real rows arrive. */
export function CandidateLedgerSkeleton() {
  return (
    <div className="flex flex-col gap-1" data-testid="candidates-loading" aria-busy="true" aria-label="Loading candidates">
      <div className="px-1 pt-3 pb-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="size-10 shrink-0 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
            <div className="h-4 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
