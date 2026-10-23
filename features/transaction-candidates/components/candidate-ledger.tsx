"use client";

/**
 * The Inbox list: a transaction-led ledger grouped by month, replacing the old status-first table + card stack. ONE row
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
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, CopyX, MessageSquareText, ScanSearch, TriangleAlert } from "lucide-react";
import { useId, useState, type MouseEvent } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { smsCandidateEventTypeLabel, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { MatchedIdentity } from "../lib/candidate-account-matching";
import { looksLikeRawReference } from "../lib/candidate-details-view";
import type { CandidateGroup } from "../lib/candidate-month-groups";
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
function MerchantAvatar({ candidate }: { candidate: Pick<SmsTransactionCandidate, "merchant" | "direction"> }) {
  const initials = merchantInitials(candidate.merchant);
  const credit = candidate.direction === "credit";
  return (
    <span aria-hidden className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-secondary text-[13px] font-semibold tracking-wide text-foreground">
      {initials ?? <MessageSquareText className="size-4 text-muted-foreground" />}
      <span
        className={cn(
          "absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full border-2 border-card",
          credit ? "bg-success text-success-foreground" : "bg-foreground text-background",
        )}
      >
        {credit ? <ArrowDownLeft className="size-2.5" strokeWidth={3} /> : <ArrowUpRight className="size-2.5" strokeWidth={3} />}
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

function AttentionNotice({ row, onReview }: { row: CandidateRowModel; onReview: (id: string) => void }) {
  const { candidate, status } = row;
  const title = candidateTitle(candidate);
  const detail = [status.explanation, ...status.reasons].filter(Boolean).join(" ");

  if (status.lane === "noIssues") return null;

  if (status.lane === "duplicate") {
    return (
      <span className={cn(NOTICE_BASE, "border-danger/60 bg-danger/12")} title={detail}>
        <CopyX className="size-3.5 shrink-0 text-danger" aria-hidden />
        Possible duplicate
      </span>
    );
  }

  if (status.lane === "needsAccount") {
    // The one notice that is also an action: it opens the review drawer where the destination is chosen.
    return (
      <button
        type="button"
        onClick={() => onReview(candidate.id)}
        title={detail}
        className={cn(NOTICE_BASE, "border-warning/70 bg-warning/20 transition-colors hover:bg-warning/30 motion-reduce:transition-none", FOCUS_RING)}
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
    <span className={cn(NOTICE_BASE, "border-warning/50 bg-warning/10")} title={detail}>
      <ScanSearch className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
      {low ? "Needs review" : "Review suggested"}
    </span>
  );
}

// ── bank / card identity ──

/** Verified match only: the bank's logo (existing BankLogo, monogram fallback), the card/account name and the masked last four. */
export function IdentityChip({ identity, className }: { identity: MatchedIdentity; className?: string }) {
  const label = `${identity.name}${identity.last4 ? ` •••• ${identity.last4}` : ""}`;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/60 py-0.5 pr-2 pl-0.5 text-xs font-semibold text-foreground", className)} title={`${identity.kind === "card" ? "Credit card" : "Account"}: ${label}`}>
      <BankLogo bankId={identity.bankId} size={18} />
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
  if (status.lane !== "noIssues") {
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

function LedgerRow({ row, actions, showDate }: { row: CandidateRowModel; actions: RowActions; showDate: boolean }) {
  const { candidate, status } = row;
  const isDuplicate = status.lane === "duplicate";
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
        row.selected ? "bg-primary/12 hover:bg-primary/16" : isDuplicate ? "bg-danger/[0.05] hover:bg-danger/[0.09]" : "hover:bg-muted/60",
        "focus-within:bg-muted/60",
      )}
    >
      {/* State rail: lime = selected, red = duplicate. Colour-independent cues (the notice text, the checked box) always accompany it. */}
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", row.selected ? "bg-primary" : isDuplicate ? "bg-danger" : "bg-transparent")} />
      <div className="grid grid-cols-[2.75rem_2.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 py-2 pr-2.5 pl-1 @4xl:grid-cols-[2.75rem_2.5rem_minmax(0,1fr)_10rem_9rem_11rem] @4xl:gap-y-0 @4xl:py-1.5 @4xl:pr-3">
        <RowCheckbox row={row} onToggle={actions.onToggle} className="col-start-1 row-start-1" />
        <div className="col-start-2 row-start-1">
          <MerchantAvatar candidate={candidate} />
        </div>

        <div className="col-start-3 row-start-1 flex min-w-0 flex-col gap-0.5">
          <span className={cn("truncate text-[15px] leading-snug font-semibold", unnamed ? "text-muted-foreground italic" : "text-foreground")} title={candidate.merchant ?? undefined}>
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
            {previewFacts.length > 0 && <QuickPreviewToggle open={previewOpen} onToggle={() => setPreviewOpen((o) => !o)} />}
          </span>
          {(confidenceNote || looksLikeRawReference(candidate.merchant) || (row.selectBlockedReason && !row.selected)) && (
            <span className="truncate text-xs leading-snug text-muted-foreground">
              {[confidenceNote, looksLikeRawReference(candidate.merchant) ? "Name unclear" : null, row.selectBlockedReason && !row.selected ? "Review individually" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
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
}

// ── groups ───────────────────────────────────────────────────────────────────────────────────────────────────────

function LedgerGroupSection({ group, actions }: { group: LedgerGroup; actions: RowActions }) {
  const headingId = useId();
  const count = group.rows.length;
  return (
    <section aria-labelledby={headingId} data-testid="candidate-group" data-group-key={group.key}>
      <div className="sticky -top-4 z-[1] flex items-baseline sm:-top-6 justify-between gap-3 bg-background px-1 pt-1.5 pb-1.5 sm:pt-2.5">
        <h2 id={headingId} className="flex items-baseline gap-2 font-heading text-[15px] font-semibold tracking-tight text-foreground">
          {group.label}
          {group.dateText && <span className="text-xs font-medium tracking-normal text-muted-foreground">{group.dateText}</span>}
        </h2>
        <p className="text-xs font-medium text-muted-foreground tabular-nums">
          {count} {count === 1 ? "transaction" : "transactions"}
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-e1" aria-labelledby={headingId}>
        {group.rows.map((row) => (
          <LedgerRow key={row.candidate.id} row={row} actions={actions} showDate={group.flat} />
        ))}
      </ul>
    </section>
  );
}

export function CandidateLedger({
  groups,
  shownCount,
  queueCount,
  allSelected,
  someSelected,
  selectAllDisabled,
  onToggleAll,
  ...actions
}: {
  groups: LedgerGroup[];
  /** Rows currently shown / total in the queue — "Showing 12 of 126". */
  shownCount: number;
  queueCount: number;
  allSelected: boolean;
  someSelected: boolean;
  selectAllDisabled: boolean;
  onToggleAll: (checked: boolean) => void;
} & RowActions) {
  return (
    <div className="@container flex flex-col" data-testid="candidates-ledger">
      <div className="flex min-h-10 items-center justify-between gap-3 px-1 sm:min-h-11">
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
        <label className={cn("flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground sm:min-h-11", selectAllDisabled && "cursor-not-allowed opacity-60")}>
          <Checkbox
            className={CHECKBOX_CLASS}
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            disabled={selectAllDisabled}
            onCheckedChange={(checked) => onToggleAll(checked === true)}
            aria-label="Select all visible candidates that can be imported together"
          />
          Select all eligible
        </label>
      </div>
      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <LedgerGroupSection key={group.key} group={group} actions={actions} />
        ))}
      </div>
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
