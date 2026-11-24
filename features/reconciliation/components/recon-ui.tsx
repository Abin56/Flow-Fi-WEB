"use client";

/**
 * Shared presentation for Reconciliation: state/decision vocabulary and small display helpers. A possible match is
 * never worded or coloured as a confirmed duplicate — "exact candidate" stays neutral until the user links it.
 */

import { CheckCircle2, CircleHelp, Copy, EyeOff, Inbox, Link2, Plus, Search, Split, TriangleAlert, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { RowStatus, RowStatusKind } from "../lib/row-status";
import type { DecisionKind, ExistingOrigin, ExistingOwner, MatchState, MerchantStrength, ReconRow } from "../lib/types";

type Tone = "neutral" | "primary" | "warning" | "danger" | "success" | "purple" | "muted";

const TONE: Record<Tone, string> = {
  neutral: "bg-foreground/[0.06] text-foreground",
  primary: "bg-primary/15 text-primary-accent-text",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/10 text-danger",
  success: "bg-success/12 text-success",
  purple: "bg-purple/12 text-purple",
  muted: "bg-muted text-muted-foreground",
};

/** Text-only tones for the sheets' quiet marks (no fill — the grids stay calm; pills are for decisions). */
const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-foreground",
  primary: "text-primary-accent-text",
  warning: "text-warning",
  danger: "text-danger",
  success: "text-success",
  purple: "text-purple",
  muted: "text-muted-foreground",
};

/**
 * Match status vocabulary (2026-11-19): Possible match · No match · Account missing · Imported · Excluded. Every
 * similarity — even identical amount, day and account — is only a "Possible match" that needs checking; it is never
 * called a duplicate and never linked for the user. The evidence is explained once, beside the compared rows.
 */
export const STATE_META: Record<MatchState, { label: string; short: string; tone: Tone; icon: LucideIcon; hint: string }> = {
  exact_candidate: { label: "Possible match", short: "Possible", tone: "primary", icon: Copy, hint: "Same account, amount and day as one FlowFi transaction. Still your decision — nothing is linked for you." },
  near_amount: { label: "Possible match", short: "Possible", tone: "primary", icon: Copy, hint: "A similar FlowFi transaction — the amount or date differs. Needs checking before you decide." },
  same_merchant_date: { label: "Possible match", short: "Possible", tone: "primary", icon: Copy, hint: "Same merchant and day; the amount differs slightly. Needs checking before you decide." },
  multiple: { label: "Possible matches", short: "Multiple", tone: "primary", icon: Layers, hint: "More than one FlowFi transaction could be this row." },
  no_match: { label: "No match", short: "No match", tone: "muted", icon: Search, hint: "Nothing on this account looks like this row." },
  in_inbox: { label: "In Inbox", short: "Inbox", tone: "purple", icon: Inbox, hint: "An SMS for this is waiting in the Transaction Inbox." },
  conflict: { label: "Conflict", short: "Conflict", tone: "danger", icon: TriangleAlert, hint: "Something doesn't add up — check it by hand." },
  already_imported: { label: "Imported", short: "Imported", tone: "success", icon: CheckCircle2, hint: "This exact row was imported earlier." },
  excluded: { label: "Excluded", short: "Excluded", tone: "muted", icon: EyeOff, hint: "Excluded from this review." },
};

/** "Account missing" — the statement account isn't chosen, so nothing is compared yet (hints only). */
export const ACCOUNT_MISSING_META = { label: "Account missing", tone: "warning" as Tone, icon: TriangleAlert, hint: "Choose the statement account — matches are only checked on that one account." };

/**
 * Decision vocabulary — Git-merge style. `label` is the action ("Keep existing — skip import"); `short` is how a made
 * decision reads in the sheets ("Keep existing"). An Import on a row that HAS a possible match reads "Keep both"
 * (see `decisionShort`). The underlying kinds (link / import_new / ignore / investigate / inbox) and their gates are
 * unchanged.
 */
export const DECISION_META: Record<DecisionKind, { label: string; short: string; icon: LucideIcon; tone: Tone }> = {
  link: { label: "Keep existing — skip import", short: "Keep existing", icon: Link2, tone: "success" },
  import_new: { label: "Import new transaction", short: "Import new", icon: Plus, tone: "primary" },
  ignore: { label: "Skip this transaction", short: "Skipped", icon: EyeOff, tone: "muted" },
  investigate: { label: "Review later", short: "Review later", icon: CircleHelp, tone: "warning" },
  inbox: { label: "Handle in Inbox", short: "Handle in Inbox", icon: Inbox, tone: "purple" },
};

export const ORIGIN_LABEL: Record<ExistingOrigin, string> = {
  sms: "From SMS",
  statement_import: "Statement import",
  smart_capture: "Smart Capture",
  manual: "Added by hand",
  unknown: "Origin unknown",
};

export const OWNER_LABEL: Record<ExistingOwner, string> = {
  loan: "Managed by Loans",
  emi: "Managed by EMI",
  bill: "Bill payment",
  people: "People ledger",
  split: "Split expense",
  person: "Assigned to a person",
};

export const STRENGTH_LABEL: Record<MerchantStrength, string> = { same: "Same merchant", similar: "Similar merchant", different: "Different merchant", unknown: "No merchant to compare" };

export { Split as SplitIcon };

export function Chip({ tone = "neutral", icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4", TONE[tone], className)}>
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function StateBadge({ state, compact = false }: { state: MatchState; compact?: boolean }) {
  const meta = STATE_META[state];
  return (
    <Chip tone={meta.tone} icon={meta.icon} title={meta.hint}>
      {compact ? meta.short : meta.label}
    </Chip>
  );
}

/** Both sheets' column header row: fixed over the scrolling body, slightly stronger rules than the body's. */
export const SHEET_HEAD =
  "grid h-7 shrink-0 items-stretch border-b border-border-strong/70 bg-muted/70 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase [&>*:not(:first-child)]:border-border/70!";
/** Both sheets' title bar — flat, one slim line. */
export const SHEET_TITLE_BAR = "flex h-9 shrink-0 items-center gap-x-2 border-b border-border-strong/60 bg-card px-2.5";
/** Spreadsheet frame shared by both sheets: square-ish, ruled, no shadow. */
export const SHEET_FRAME = "@container flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-strong/70 bg-card";
/** One spreadsheet row: 36px, ruled cells, zebra striping. */
export const SHEET_ROW = "relative grid h-9 cursor-pointer scroll-my-1 items-stretch border-b border-border/60 transition-colors even:bg-muted/[0.22]";
/** Ruled cells: stretch to the row, centre the content, hairline column rules. */
export const SHEET_CELLS = "[&>*]:self-stretch [&>*]:content-center [&>*]:px-2 [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-border/45";

/** A compact match indicator for dense grids: icon + label in the state's colour, no pill. Same words as StateBadge. */
export function Mark({ tone = "neutral", icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex max-w-full min-w-0 items-center gap-1 text-[11px] leading-4 font-semibold", TONE_TEXT[tone], className)}>
      {Icon ? <Icon className="size-3 shrink-0" aria-hidden /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function StateMark({ state, compact = false }: { state: MatchState; compact?: boolean }) {
  const meta = STATE_META[state];
  return (
    <Mark tone={meta.tone} icon={meta.icon} title={meta.hint}>
      {compact ? meta.short : meta.label}
    </Mark>
  );
}

/** "Keep both" when an Import was chosen although a possible match exists — the user confirmed they're separate. */
export const KEEP_BOTH_LABEL = "Keep both";

export function decisionShort(kind: DecisionKind, keepBoth = false): string {
  return kind === "import_new" && keepBoth ? KEEP_BOTH_LABEL : DECISION_META[kind].short;
}

/** The label of a row nobody has decided yet — one word for "your decision is still needed". */
export function pendingLabelFor(_possibleMatch = false): string {
  return "Needs review";
}

/** The row's decision as quiet text: an amber dot while open, the outcome (ticked) once decided. No pills. */
export function DecisionChip({ kind, keepBoth = false }: { kind: DecisionKind | null; keepBoth?: boolean }) {
  if (!kind) {
    return (
      <span data-testid="decision-chip" data-pending="true" title="No decision yet — this row still needs your review." className="inline-flex max-w-full items-center gap-1.5 text-[12px] leading-4 font-medium text-foreground/70">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
        <span className="truncate">{pendingLabelFor()}</span>
      </span>
    );
  }
  const meta = DECISION_META[kind];
  const Icon = kind === "investigate" || kind === "inbox" ? meta.icon : CheckCircle2;
  return (
    <span data-testid="decision-chip" data-pending="false" title={meta.label} className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 text-[12px] leading-4 font-medium", TONE_TEXT[meta.tone === "primary" ? "primary" : meta.tone])}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{decisionShort(kind, keepBoth)}</span>
    </span>
  );
}

/**
 * The row's single status — Ready · Possible duplicate · Fix required · Skipped (see lib/row-status.ts). Quiet text
 * with a small mark, like the rest of the sheet. `data-pending` stays true for the two states that still need the user.
 */
const STATUS_STYLE: Record<RowStatusKind, { tone: Tone; icon: LucideIcon }> = {
  ready: { tone: "success", icon: CheckCircle2 },
  duplicate: { tone: "primary", icon: Copy },
  fix: { tone: "warning", icon: TriangleAlert },
  skipped: { tone: "muted", icon: EyeOff },
};

export function StatusChip({ status }: { status: RowStatus | null }) {
  if (!status) {
    return (
      <span data-testid="decision-chip" data-pending="true" data-status="checking" title="Matching isn't finished yet — no status is shown until it is." className="inline-flex items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50" />
        <span className="truncate">Checking…</span>
      </span>
    );
  }
  const { tone, icon: Icon } = STATUS_STYLE[status.kind];
  return (
    <span data-testid="decision-chip" data-pending={status.kind === "duplicate" || status.kind === "fix" ? "true" : "false"} data-status={status.kind} title={status.reason} className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 text-[12px] leading-4 font-medium", TONE_TEXT[tone])}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{status.label}</span>
    </span>
  );
}

export function Money({ amount, direction, className }: { amount: number | null; direction: ReconRow["direction"]; className?: string }) {
  if (amount == null) return <span className={cn("text-sm text-warning", className)}>No amount</span>;
  return (
    <span className={cn("font-mono text-sm font-semibold tabular-nums", direction === "credit" ? "text-success" : "text-foreground", className)}>
      {direction === "credit" ? "+" : direction === "debit" ? "−" : ""}
      {formatCurrencyPrecise(amount)}
      {/* Fixed-width Dr/Cr so right-aligned amounts line up on the decimal point down a column. */}
      <span className="ml-1 inline-block w-[1.1rem] text-left font-sans text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{direction === "credit" ? "Cr" : direction === "debit" ? "Dr" : "?"}</span>
    </span>
  );
}

/** A captured row's statement date (a calendar date). */
export function formatRowDate(date: Date | null, withYear = false): string {
  if (!date) return "No date";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

/** An existing record's moment, in IST. */
export function formatExistingDate(date: Date): string {
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

/** The parts of an account's identity the account picker shows — name, kind and masked last four only. */
export interface AccountIdentity {
  id: string;
  name: string;
  /** "Credit card", "Bank account", "Wallet", "Cash"… */
  kind: string;
  isCard: boolean;
  last4: string | null;
}

const ACCOUNT_KIND: Record<Account["type"], string> = { card: "Credit card", bank: "Bank account", wallet: "Wallet", cash: "Cash", business: "Business account", other: "Account" };

export function accountIdentity(account: Account, creditCards: CreditCardProfile[]): AccountIdentity {
  const card = creditCards.find((c) => c.accountId === account.id && c.deletedAt == null);
  const last4 = card?.lastFourDigits?.trim() || account.accountNumberLast4?.trim() || null;
  return { id: account.id, name: account.name, kind: ACCOUNT_KIND[account.type] ?? "Account", isCard: account.type === "card", last4 };
}

/** "HDFC Millennia •••• 4821" — masked last-4 only. */
export function accountLabel(accountId: string, accounts: Account[], creditCards: CreditCardProfile[]): string {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return "Unknown account";
  const card = creditCards.find((c) => c.accountId === accountId);
  const last4 = card?.lastFourDigits?.trim() || account.accountNumberLast4?.trim() || null;
  return last4 ? `${account.name} •••• ${last4}` : account.name;
}
