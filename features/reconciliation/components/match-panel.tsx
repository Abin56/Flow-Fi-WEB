"use client";

/**
 * The duplicate comparison for one statement row: the statement transaction side by side with each existing FlowFi
 * transaction it might be — source, description, amount and difference, date and difference, account, flags and
 * context — then the explicit decision. Every possible match is a suggestion, never a confirmed duplicate, and
 * nothing here links, imports or edits anything in FlowFi: choices only change this tab's draft.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarClock, Check, ChevronDown, ImageOff, Info, Link2, Maximize2, Search, ShieldCheck, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatCurrencyPrecise } from "@/lib/format";
import type { OcrCapture } from "@/features/smart-capture/components/capture-input";
import { RowZoom, ScreenshotDialog } from "@/features/smart-capture/components/ocr-source-view";
import { describeAmountDelta, describeDayGap } from "../lib/amounts-and-days";
import { decisionErrors, importBlockReasons, type RowGateContext } from "../lib/decisions";
import { manualLinkOptions } from "../lib/match-engine";
import type { ExistingRecord, MatchCandidate, ReconRow, RowDecision, RowMatch } from "../lib/types";
import { Chip, DECISION_META, Money, ORIGIN_LABEL, OWNER_LABEL, STRENGTH_LABEL, StateBadge, formatExistingDate, formatRowDate } from "./recon-ui";

export interface MatchPanelProps {
  row: ReconRow;
  rowNumber: number;
  match: RowMatch;
  decision: RowDecision;
  gate: RowGateContext;
  records: ExistingRecord[];
  recordsById: Map<string, ExistingRecord>;
  accountId: string;
  accountName: (accountId: string) => string;
  rowNumberOf: (rowId: string) => number;
  onDecide: (patch: Partial<RowDecision>) => void;
  onReject: (recordId: string) => void;
  /** The screenshot handed over from Smart Capture (in memory only) — null after a refresh or for pasted text. */
  screenshot: OcrCapture | null;
  captureSource: "text" | "ocr";
}

const TIER_LABEL: Record<MatchCandidate["tier"], string> = { exact: "Same amount & day", same_merchant_date: "Same merchant & day", near: "Near — amount or date differs" };

type Verdict = "same" | "diff" | "unknown";

/** One compared field: label · statement value · FlowFi value, with the difference underneath. */
function CompareRow({ label, statement, existing, verdict, tone }: { label: string; statement: React.ReactNode; existing: React.ReactNode; verdict?: string; tone?: Verdict }) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_minmax(0,1fr)] items-start border-t border-border/60 text-xs first:border-t-0" data-compare={label}>
      <span className="px-2.5 py-2 text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 border-l border-border/60 px-2.5 py-2 break-words text-foreground">{statement}</span>
      <span className="min-w-0 border-l border-border/60 px-2.5 py-2 break-words text-foreground">
        {existing}
        {verdict && (
          <span className={cn("mt-0.5 flex items-center gap-1 text-[11px] font-medium", tone === "same" ? "text-success" : tone === "diff" ? "text-warning" : "text-muted-foreground")}>
            {tone === "same" && <Check className="size-3" />}
            {verdict}
          </span>
        )}
      </span>
    </div>
  );
}

function flagsOf(record: ExistingRecord, candidate: MatchCandidate | null): React.ReactNode[] {
  const flags: React.ReactNode[] = [];
  if (record.owner) flags.push(<Chip key="owner" tone="purple">{OWNER_LABEL[record.owner]}</Chip>);
  if (record.isTransferLeg) flags.push(<Chip key="transfer">{record.direction === "credit" ? "Card payment / transfer in" : "Transfer out"}</Chip>);
  if (record.excludedFromCalculations) flags.push(<Chip key="excluded">Excluded from totals</Chip>);
  if (record.status !== "posted") flags.push(<Chip key="status" tone="warning">{record.status === "pending" ? "Pending" : "Reversed"}</Chip>);
  if (candidate?.referenceMatch) flags.push(<Chip key="ref" tone="success">Reference matches</Chip>);
  return flags;
}

function CandidateCard({
  row,
  candidate,
  record,
  position,
  linked,
  claimedRow,
  accountName,
  onLink,
  onUnlink,
  onReject,
  importedHere,
  statementAccount,
  captureSource,
}: {
  row: ReconRow;
  candidate: MatchCandidate | null;
  record: ExistingRecord;
  position: string | null;
  linked: boolean;
  claimedRow: number | null;
  accountName: (id: string) => string;
  onLink: () => void;
  onUnlink: () => void;
  onReject?: () => void;
  importedHere?: boolean;
  statementAccount: string;
  captureSource: "text" | "ocr";
}) {
  const flags = flagsOf(record, candidate);
  const notes = record.notes.trim();
  return (
    <article
      data-testid="match-candidate"
      data-record-id={record.id}
      className={cn("overflow-hidden rounded-xl border bg-card transition-colors", linked ? "border-success/60 ring-1 ring-success/30" : "border-border")}
    >
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/40 px-2.5 py-1.5">
        <span className="text-xs font-semibold text-foreground">{importedHere ? "Imported earlier from this row" : (position ?? "Possible match")}</span>
        {!importedHere && candidate && <Chip tone={candidate.tier === "exact" ? "primary" : "warning"}>{TIER_LABEL[candidate.tier]}</Chip>}
        {!importedHere && <span className="ml-auto text-[11px] text-muted-foreground">Suggestion — you decide</span>}
      </header>
      <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_minmax(0,1fr)] border-b border-border/60 bg-muted/20 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="px-2.5 py-1.5" />
        <span className="border-l border-border/60 px-2.5 py-1.5">Statement</span>
        <span className="border-l border-border/60 px-2.5 py-1.5">Existing in FlowFi</span>
      </div>
      <div>
        <CompareRow label="Source" statement={captureSource === "ocr" ? "Screenshot (Smart Capture)" : "Pasted statement"} existing={record.kind === "sms_pending" ? "SMS, waiting in Inbox" : ORIGIN_LABEL[record.origin]} />
        <CompareRow
          label="Merchant"
          statement={row.description || "—"}
          existing={record.description || "—"}
          verdict={candidate ? STRENGTH_LABEL[candidate.merchantStrength] : undefined}
          tone={candidate?.merchantStrength === "same" ? "same" : candidate?.merchantStrength === "unknown" ? "unknown" : "diff"}
        />
        <CompareRow
          label="Amount"
          statement={<span className="font-mono font-semibold tabular-nums">{formatCurrencyPrecise(row.amount ?? 0)}</span>}
          existing={<span className="font-mono font-semibold tabular-nums">{formatCurrencyPrecise(record.amount)}</span>}
          verdict={candidate ? (candidate.amountDeltaPaise === 0 ? "Same amount" : `Difference ${describeAmountDelta(candidate.amountDeltaPaise)}`) : undefined}
          tone={candidate ? (candidate.amountDeltaPaise === 0 ? "same" : "diff") : "unknown"}
        />
        <CompareRow
          label="Date"
          statement={formatRowDate(row.date, true)}
          existing={formatExistingDate(record.dateTime)}
          verdict={candidate ? describeDayGap(candidate.dayGap) : undefined}
          tone={candidate ? (candidate.dayGap === 0 ? "same" : "diff") : "unknown"}
        />
        <CompareRow label="Account" statement={statementAccount} existing={record.accountId ? accountName(record.accountId) : "Not matched to an account"} verdict={record.accountId ? "Same account" : undefined} tone="same" />
        <CompareRow label="Type" statement={row.direction === "credit" ? "Credit" : "Charge"} existing={record.direction === "credit" ? "Income / credit" : "Expense / charge"} />
        <CompareRow label="Flags" statement={<span className="text-muted-foreground">—</span>} existing={flags.length > 0 ? <span className="flex flex-wrap gap-1">{flags}</span> : <span className="text-muted-foreground">None — own expense, no split/EMI</span>} />
        <CompareRow label="Context" statement={row.referenceNumber ? `Ref ${row.referenceNumber}` : <span className="text-muted-foreground">—</span>} existing={notes ? <span className="line-clamp-2" title={notes}>{notes}</span> : <span className="text-muted-foreground">No notes</span>} />
      </div>
      {record.kind === "transaction" && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-2.5 py-2">
          {linked ? (
            <>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                <Check className="size-3.5" /> Already recorded — this row won&apos;t be imported
              </span>
              <ClayButton variant="ghost" size="sm" onClick={onUnlink}>
                <Undo2 className="size-3.5" /> Undo
              </ClayButton>
            </>
          ) : claimedRow != null ? (
            <span className="text-xs text-muted-foreground">Linked to row {claimedRow} — it is already that row&apos;s match</span>
          ) : (
            <ClayButton size="sm" onClick={onLink} aria-label="Already recorded — skip import">
              <Link2 className="size-3.5" /> Already recorded — skip import
            </ClayButton>
          )}
          {onReject && !linked && (
            <ClayButton variant="ghost" size="sm" onClick={onReject}>
              <X className="size-3.5" /> Not this match
            </ClayButton>
          )}
        </footer>
      )}
    </article>
  );
}

export function MatchPanel({ row, rowNumber, match, decision, gate, records, recordsById, accountId, accountName, rowNumberOf, onDecide, onReject, screenshot, captureSource }: MatchPanelProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const blockReasons = importBlockReasons(row, match, gate);
  const errors = decisionErrors(row, match, decision, gate);
  const hasPossibleMatches = match.candidates.length > 0 || match.pendingSms.length > 0;
  const manual = useMemo(() => {
    if (!searchOpen) return [];
    const candidateIds = new Set(match.candidates.map((c) => c.recordId));
    return manualLinkOptions(row, records, accountId, query)
      .filter((o) => !candidateIds.has(o.record.id))
      .slice(0, 12);
  }, [searchOpen, row, records, accountId, query, match.candidates]);
  const imported = match.alreadyImportedId ? recordsById.get(match.alreadyImportedId) : undefined;
  const statementAccount = accountName(accountId);
  const linkTo = (recordId: string) => onDecide({ kind: "link", linkedRecordId: recordId });
  const unlink = () => onDecide({ kind: null });
  const addLabel = hasPossibleMatches ? "Add as a separate transaction" : DECISION_META.import_new.label;

  return (
    <div className="flex flex-col gap-3" data-testid="match-panel" data-row-id={row.id}>
      <section className="rounded-xl border border-border bg-muted/40 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Statement row {rowNumber}</p>
            <p className="mt-0.5 text-sm font-semibold break-words text-foreground">{row.description || "No description"}</p>
            <p className="text-xs text-muted-foreground">
              {formatRowDate(row.date, true)} · {statementAccount}
              {row.referenceNumber && <> · Ref {row.referenceNumber}</>}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Money amount={row.amount} direction={row.direction} />
            <StateBadge state={match.state} />
          </div>
        </div>
      </section>

      {captureSource === "ocr" &&
        (screenshot ? (
          <section aria-label="Statement image" className="flex flex-col gap-1.5" data-testid="row-screenshot">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-foreground">On the screenshot</h3>
              <button type="button" onClick={() => setViewerOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                <Maximize2 className="size-3.5" /> Whole screenshot
              </button>
            </div>
            {row.ocr ? <RowZoom capture={screenshot} box={row.ocr.box} /> : <p className="text-xs text-muted-foreground">This row has no position on the screenshot — open the whole screenshot to check it.</p>}
            <ScreenshotDialog capture={screenshot} focused={row} open={viewerOpen} onOpenChange={setViewerOpen} />
          </section>
        ) : (
          <p className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="screenshot-unavailable">
            <ImageOff className="mt-px size-4 shrink-0" />
            <span>The screenshot isn&apos;t available here — it&apos;s never saved, so a refresh removes it. To compare against the image, go back to Smart Capture and read it again.</span>
          </p>
        ))}

      {gate.cycle && gate.cycle.status !== "open" && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
          <CalendarClock className="mt-px size-4 shrink-0 text-warning" />
          <span>
            This date is in the card bill for {formatRowDate(gate.cycle.periodStart)} – {formatRowDate(gate.cycle.periodEnd, true)}, which is {gate.cycle.status === "paid" ? "already paid" : "closed"}. Marking it already recorded
            is fine; adding it as new is blocked until it&apos;s reviewed separately.
          </span>
        </p>
      )}

      {match.conflicts.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-foreground">
          {match.conflicts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}

      {match.notes.length > 0 && (
        <ul className="space-y-1.5">
          {match.notes.map((n, i) => (
            <li key={`${n.kind}-${i}`} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              <span>{n.message}</span>
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Possible matches" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {imported ? "Imported earlier" : match.candidates.length === 0 ? "No possible match on this account" : `Possible match${match.candidates.length === 1 ? "" : "es"} in FlowFi (${match.candidates.length})`}
          </h3>
          {match.candidates.length > 0 && <span className="text-[11px] text-muted-foreground">Same account &amp; direction only</span>}
        </div>
        {imported && (
          <CandidateCard
            row={row}
            candidate={null}
            record={imported}
            position={null}
            importedHere
            linked={decision.kind === "link" && decision.linkedRecordId === imported.id}
            claimedRow={null}
            accountName={accountName}
            statementAccount={statementAccount}
            captureSource={captureSource}
            onLink={() => linkTo(imported.id)}
            onUnlink={unlink}
          />
        )}
        {match.candidates.map((c, i) => {
          const record = recordsById.get(c.recordId);
          if (!record) return null;
          const claimed = match.claimedBy[c.recordId];
          return (
            <CandidateCard
              key={c.recordId}
              row={row}
              candidate={c}
              record={record}
              position={match.candidates.length > 1 ? `Possible match ${i + 1} of ${match.candidates.length}` : "Possible match"}
              linked={decision.kind === "link" && decision.linkedRecordId === c.recordId}
              claimedRow={claimed ? rowNumberOf(claimed) : null}
              accountName={accountName}
              statementAccount={statementAccount}
              captureSource={captureSource}
              onLink={() => linkTo(c.recordId)}
              onUnlink={unlink}
              onReject={() => onReject(c.recordId)}
            />
          );
        })}
        {match.state !== "excluded" && (
          <div className="rounded-xl border border-dashed border-border">
            <button type="button" onClick={() => setSearchOpen((o) => !o)} aria-expanded={searchOpen} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
              <Search className="size-3.5" /> Find another transaction on this account
              <ChevronDown className={cn("ml-auto size-3.5 transition-transform", searchOpen && "rotate-180")} />
            </button>
            {searchOpen && (
              <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search description or amount" aria-label="Search this account" className="h-8 rounded-lg text-xs" />
                <p className="text-[11px] text-muted-foreground">Same account and direction, within ₹1.00 and 31 days.</p>
                {manual.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing else fits.</p>
                ) : (
                  manual.map(({ record, candidate }) => (
                    <div key={record.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">{record.description || "—"}</p>
                        <p className="text-muted-foreground">
                          {formatExistingDate(record.dateTime)} · {describeDayGap(candidate.dayGap)} · {describeAmountDelta(candidate.amountDeltaPaise)}
                        </p>
                      </div>
                      <span className="font-mono tabular-nums">{formatCurrencyPrecise(record.amount)}</span>
                      <ClayButton size="sm" variant="secondary" onClick={() => linkTo(record.id)} disabled={!!match.claimedBy[record.id]} aria-label={`Already recorded as ${record.description || "this transaction"}`}>
                        This one
                      </ClayButton>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {match.pendingSms.length > 0 && (
        <section aria-label="Waiting in Inbox" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Waiting in the Transaction Inbox ({match.pendingSms.length})</h3>
          {match.pendingSms.map((c) => {
            const record = recordsById.get(c.recordId);
            return record ? (
              <CandidateCard
                key={c.recordId}
                row={row}
                candidate={c}
                record={record}
                position="SMS waiting in Inbox"
                linked={false}
                claimedRow={null}
                accountName={accountName}
                statementAccount={statementAccount}
                captureSource={captureSource}
                onLink={() => undefined}
                onUnlink={() => undefined}
              />
            ) : null;
          })}
          <div className="flex flex-wrap items-center gap-2">
            <ClayButton size="sm" variant={decision.kind === "inbox" ? "primary" : "secondary"} onClick={() => onDecide({ kind: "inbox" })}>
              {DECISION_META.inbox.label}
            </ClayButton>
            <Link href="/transaction-candidates" className="inline-flex items-center gap-1 text-xs font-medium text-primary-accent-text underline-offset-4 hover:underline">
              Open Inbox <ArrowUpRight className="size-3" />
            </Link>
          </div>
          <p className="text-[11px] text-muted-foreground">Handling it in the Inbox keeps one import path per bank event — this row won&apos;t be imported here.</p>
        </section>
      )}

      {match.state !== "excluded" && (
        <section aria-label="Decision" className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
          <h3 className="text-xs font-semibold text-foreground">Your decision for this row</h3>
          {hasPossibleMatches && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="mt-px size-3.5 shrink-0" />
              Possible matches are only suggestions until you decide. Nothing in FlowFi is edited or linked by these choices.
            </p>
          )}
          {hasPossibleMatches && (
            <label className={cn("flex items-start gap-2 text-xs", blockReasons.length > 0 && "opacity-60")}>
              <Checkbox
                checked={decision.kind === "import_new" && decision.notSameAck}
                disabled={blockReasons.length > 0}
                onCheckedChange={(v) => onDecide({ kind: "import_new", notSameAck: v === true })}
                aria-label="This is a different transaction"
              />
              <span>I compared the possible matches — this is a different transaction.</span>
            </label>
          )}
          {row.direction === "credit" && (
            <div className="flex flex-col gap-1" role="group" aria-label="What is this credit?" data-testid="credit-kind">
              <span className="text-[11px] text-muted-foreground">If added, this credit is a… (never assumed — a credit on a card isn&apos;t always a refund)</span>
              <div className="flex gap-1.5">
                {(["refund", "income"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={decision.creditAs === kind}
                    disabled={blockReasons.length > 0}
                    onClick={() => onDecide({ kind: "import_new", creditAs: kind })}
                    className={cn("rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50", decision.creditAs === kind ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
                  >
                    {kind === "refund" ? "Refund" : "Income"}
                  </button>
                ))}
                {row.kind === "refund" && <span className="self-center text-[11px] text-muted-foreground">Statement text says refund</span>}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <ClayButton
              size="sm"
              variant={decision.kind === "import_new" ? "primary" : "secondary"}
              disabled={blockReasons.length > 0}
              onClick={() => onDecide({ kind: "import_new", notSameAck: decision.kind === "import_new" ? decision.notSameAck : false })}
              aria-pressed={decision.kind === "import_new"}
            >
              {addLabel}
            </ClayButton>
            <ClayButton size="sm" variant={decision.kind === "ignore" ? "primary" : "secondary"} onClick={() => onDecide({ kind: "ignore" })} aria-pressed={decision.kind === "ignore"}>
              {DECISION_META.ignore.label}
            </ClayButton>
            <ClayButton size="sm" variant={decision.kind === "investigate" ? "primary" : "secondary"} onClick={() => onDecide({ kind: "investigate" })} aria-pressed={decision.kind === "investigate"}>
              {DECISION_META.investigate.label}
            </ClayButton>
          </div>
          {blockReasons.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-muted-foreground" data-testid="import-blocked">
              {blockReasons.map((r) => (
                <li key={r}>Can&apos;t add as new: {r}</li>
              ))}
            </ul>
          )}
          {decision.kind && errors.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-warning" data-testid="decision-errors">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {decision.kind === "investigate" && <p className="text-[11px] text-muted-foreground">Review later keeps this row open — final approval waits until you decide.</p>}
        </section>
      )}
    </div>
  );
}
