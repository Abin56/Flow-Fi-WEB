"use client";

import { Archive, ArrowDownLeft, ArrowUpRight, CalendarDays, ChevronDown, Clock3, Loader2, RotateCcw, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/components/finance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { smsCandidateEventTypeLabel } from "@/lib/models/sms-transaction-candidate";
import {
  DISMISSED_CANDIDATE_RETENTION_MS,
  type DismissedSmsCandidate,
  type SmsTransactionCandidateRepository,
} from "@/lib/repositories/sms-transaction-candidate-repository";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";
import { buildDayIndex } from "../lib/candidate-day-nav";
import { formatDayHeading } from "../lib/candidate-month-groups";
import { matchesSearch } from "../lib/filters";
import { candidateTitle, signedAmountText } from "./candidate-row-parts";

const dateLabel = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function DismissedCandidates({
  repository,
  onRestore,
}: {
  repository: SmsTransactionCandidateRepository;
  onRestore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="h-9 shrink-0 gap-2 px-3">
          <Archive aria-hidden="true" className="size-4" />
          Dismissed
        </Button>
      </SheetTrigger>
      <SheetContent showCloseButton={false} className="w-full gap-0 overflow-hidden bg-background data-[side=right]:w-full data-[side=right]:sm:max-w-[30rem]">
        <SheetHeader className="relative isolate gap-1.5 overflow-hidden border-b border-primary/20 bg-surface-hero px-3 pt-4 pb-5 text-hero-foreground sm:px-4">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,var(--primary)_0%,transparent_62%)] opacity-15" />
          <div aria-hidden="true" className="pointer-events-none absolute -right-8 -bottom-14 -z-10 grid size-38 place-items-center rounded-full border border-primary/20 sm:-right-5 sm:size-44">
            <div className="grid size-[76%] place-items-center rounded-full border border-primary/25">
              <div className="grid size-[70%] place-items-center rounded-full border border-primary/25 bg-primary/5">
                <Archive className="size-8 text-primary/45 sm:size-9" strokeWidth={1.25} />
              </div>
            </div>
          </div>
          <SheetClose asChild>
            <Button aria-label="Close" variant="ghost" size="icon-sm" className="absolute top-2 right-2 rounded-full border border-hero-foreground/25 bg-hero-foreground/10 text-hero-foreground hover:bg-hero-foreground/20 hover:text-hero-foreground sm:right-3">
              <X aria-hidden="true" className="size-4" />
            </Button>
          </SheetClose>
          <SheetTitle className="pr-9 text-xl leading-tight font-semibold tracking-tight text-hero-foreground">Dismissed candidates</SheetTitle>
          <SheetDescription className="flex w-fit max-w-[85%] items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs leading-snug text-hero-foreground">
            <Clock3 aria-hidden="true" className="size-3 shrink-0 text-primary" />
            Restore to your inbox within 30 days
          </SheetDescription>
        </SheetHeader>
        {open && <DismissedList repository={repository} onRestore={onRestore} />}
      </SheetContent>
    </Sheet>
  );
}

function DismissedList({
  repository,
  onRestore,
}: {
  repository: SmsTransactionCandidateRepository;
  onRestore: (id: string) => void;
}) {
  const [entries, setEntries] = useState<DismissedSmsCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [clearSelection, setClearSelection] = useState<DismissedSmsCandidate[] | null>(null);
  const [search, setSearch] = useState("");
  const [amountOpen, setAmountOpen] = useState(false);
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const amountPanelId = useId();
  const amountErrorId = useId();

  useEffect(() => repository.watchDismissed((next) => {
    setEntries(next);
    setNow(Date.now());
    setFailed(false);
  }, () => setFailed(true)), [repository, retry]);

  const visible = entries?.filter(({ dismissedAt }) => dismissedAt.toMillis() + DISMISSED_CANDIDATE_RETENTION_MS > now) ?? [];
  const needle = search.trim().toLowerCase();
  const hasAmountFilter = minimum !== "" || maximum !== "";
  const min = minimum === "" ? 0 : Number(minimum);
  const max = maximum === "" ? Infinity : Number(maximum);
  const amountError = (minimum !== "" && (!Number.isFinite(min) || min < 0)) || (maximum !== "" && (!Number.isFinite(max) || max < 0))
    ? "Enter amounts of ₹0 or more."
    : min > max ? "Minimum must be less than or equal to maximum." : null;
  const filtered = visible.filter(({ candidate }) => {
    if (!candidate) return !needle && !hasAmountFilter;
    const amount = Math.abs(candidate.amount);
    const matchesAmount = !hasAmountFilter || (!amountError && amount >= min && amount <= max);
    return matchesAmount && (!needle || matchesSearch(candidate, needle) || candidate.originalMessage?.toLowerCase().includes(needle));
  });
  const { byDay } = buildDayIndex(filtered, ({ dismissedAt }) => dismissedAt.toDate());
  const nextExpiry = visible.at(-1)?.dismissedAt.toMillis();
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const delay = Math.max(0, nextExpiry + DISMISSED_CANDIDATE_RETENTION_MS - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [nextExpiry, now]);

  function resetFilters() {
    setSearch("");
    setMinimum("");
    setMaximum("");
  }

  async function restore(entry: DismissedSmsCandidate) {
    setBusy(entry.id);
    try {
      if (await repository.restoreDismissed(entry)) {
        onRestore(entry.id);
        toast.success("Candidate restored", "It’s back in the Transaction Inbox for review.");
      } else {
        toast.info("Candidate unavailable", "It may have expired or been handled on another device.");
      }
    } catch {
      toast.error("Couldn’t restore candidate", "Try again.");
    } finally {
      setNow(Date.now());
      setBusy(null);
    }
  }

  async function clear() {
    if (!clearSelection) return;
    setBusy("clear");
    try {
      await repository.clearDismissed(clearSelection);
      toast.success("Dismissed candidates cleared");
    } catch {
      toast.error("Couldn’t clear every candidate", "Try again to clear any items still listed.");
    } finally {
      setBusy(null);
      setClearSelection(null);
    }
  }

  return (
    <>
      {!failed && entries && visible.length > 0 && (
        <div className="relative z-10 mx-3 -mt-2 shrink-0 space-y-1 rounded-xl border border-border bg-card p-1.5 shadow-e1 sm:mx-4 sm:p-2">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search dismissed candidates"
                placeholder="Search archive…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className={cn("h-8 rounded-lg border-transparent bg-secondary/65 pl-8 shadow-none [&::-webkit-search-cancel-button]:hidden", search && "pr-9")}
              />
              {search && (
                <Button aria-label="Clear search" variant="ghost" size="icon-xs" onClick={() => setSearch("")} className="absolute top-1/2 right-2 -translate-y-1/2">
                  <X aria-hidden="true" className="size-3.5" />
                </Button>
              )}
            </div>
            <Button variant="outline" size="sm" className={cn("rounded-lg bg-card px-2 shadow-none", (amountOpen || hasAmountFilter) && "border-primary-accent-text/35 bg-accent text-accent-foreground aria-expanded:bg-accent")} aria-expanded={amountOpen} aria-controls={amountPanelId} onClick={() => setAmountOpen(!amountOpen)}>
              <SlidersHorizontal aria-hidden="true" className="size-3.5" /> Amount
              {hasAmountFilter && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary-accent-text" />}
            </Button>
          </div>
          <div id={amountPanelId} hidden={!amountOpen}>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-secondary/35 p-2">
              <label className="min-w-0 space-y-1 text-xs font-medium text-muted-foreground">
                <span>Min amount (₹)</span>
                <Input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0" value={minimum} onChange={(event) => setMinimum(event.target.value)} aria-invalid={amountError ? true : undefined} aria-describedby={amountError ? amountErrorId : undefined} className="h-8 bg-card" />
              </label>
              <label className="min-w-0 space-y-1 text-xs font-medium text-muted-foreground">
                <span>Max amount (₹)</span>
                <Input type="number" inputMode="decimal" min="0" step="0.01" placeholder="No limit" value={maximum} onChange={(event) => setMaximum(event.target.value)} aria-invalid={amountError ? true : undefined} aria-describedby={amountError ? amountErrorId : undefined} className="h-8 bg-card" />
              </label>
              {amountError && <p id={amountErrorId} role="alert" className="col-span-2 text-xs text-danger">{amountError}</p>}
            </div>
          </div>
          <div className="flex min-h-5 items-center justify-between gap-2 px-1 text-xs">
            <p role="status" className="font-medium text-muted-foreground">
              {needle || hasAmountFilter ? `${filtered.length} of ${visible.length} shown` : `${visible.length} ${visible.length === 1 ? "candidate" : "candidates"}`}
            </p>
            {(needle || hasAmountFilter) && <Button variant="ghost" size="xs" onClick={resetFilters}>Reset filters</Button>}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
        {failed ? (
          <div role="alert" className="rounded-xl border border-border bg-card p-5">
            <p className="font-semibold">Couldn’t load dismissed candidates</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => { setFailed(false); setEntries(null); setRetry(retry + 1); }}>Retry</Button>
          </div>
        ) : !entries ? (
          <p role="status" className="flex items-center gap-2 py-4 text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" /> Loading dismissed candidates…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-3 py-5 text-center shadow-e1">
            <span className="mx-auto mb-2 grid size-8 place-items-center rounded-lg bg-accent text-primary-accent-text">
              <Archive aria-hidden="true" className="size-5" />
            </span>
            <p className="font-semibold">No dismissed candidates</p>
            <p className="mt-1 text-sm text-muted-foreground">Dismissed suggestions appear here after the Undo window ends.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-3 py-5 text-center shadow-e1">
            <span className="mx-auto mb-2 grid size-8 place-items-center rounded-lg bg-accent text-primary-accent-text">
              <Search aria-hidden="true" className="size-5" />
            </span>
            <p className="font-semibold">No matching candidates</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a different search or amount range.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {[...byDay].map(([day, dayEntries]) => {
              const { label, dateText } = formatDayHeading(day, new Date(now));
              return (
                <section key={day} aria-label={`Dismissed ${dateText ?? label}`}>
                  <h3 className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-xs">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-primary-accent-text">
                      <CalendarDays aria-hidden="true" className="size-3" />
                    </span>
                    <span className="text-[13px] font-semibold text-foreground">{label}</span>
                    {dateText && <span className="text-muted-foreground">{dateText}</span>}
                    <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-border" />
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-secondary px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums" aria-label={`${dayEntries.length} ${dayEntries.length === 1 ? "candidate" : "candidates"}`}>{dayEntries.length}</span>
                  </h3>
                  <ul className="overflow-hidden divide-y divide-border rounded-xl border border-border bg-card shadow-e1">
                    {dayEntries.map((entry) => <DismissedRow key={entry.id} entry={entry} busy={busy} onRestore={restore} />)}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {!failed && visible.length > 0 && (
        <div className="flex shrink-0 items-center justify-end border-t border-border bg-card px-3 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:px-4">
          <Button variant="ghost" size="sm" className="rounded-lg text-danger hover:bg-danger/10 hover:text-danger" disabled={busy !== null} onClick={() => setClearSelection(visible)}>
            <Trash2 aria-hidden="true" className="size-4" /> Clear all
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={clearSelection !== null}
        onOpenChange={(next) => { if (!next && busy !== "clear") setClearSelection(null); }}
        title="Clear dismissed candidates?"
        description={`Permanently delete all ${clearSelection?.length ?? 0} dismissed ${clearSelection?.length === 1 ? "candidate" : "candidates"} across every date, including items hidden by filters.`}
        variant="destructive"
        confirmLabel="Clear all"
        loading={busy === "clear"}
        onConfirm={clear}
      />
    </>
  );
}

function DismissedRow({ entry, busy, onRestore }: {
  entry: DismissedSmsCandidate;
  busy: string | null;
  onRestore: (entry: DismissedSmsCandidate) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { candidate, dismissedAt } = entry;
  const title = candidate ? candidateTitle(candidate) : "SMS candidate";
  const isCredit = candidate?.direction === "credit";
  const Direction = isCredit ? ArrowDownLeft : ArrowUpRight;
  const summary = candidate && [
    candidate.bankName !== title ? candidate.bankName : null,
    candidate.rawLastFour ? `••${candidate.rawLastFour}` : null,
    smsCandidateEventTypeLabel(candidate.eventType),
  ].filter(Boolean).join(" · ");
  return (
    <li>
      <div className="flex items-center gap-1 px-1 py-0.5 sm:gap-1.5 sm:px-1.5">
        <button
          type="button"
          aria-label={`${expanded ? "Hide" : "Show"} details for ${title}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
          className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none transition-colors hover:bg-secondary/65 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-2", expanded && "bg-secondary/65")}
        >
          <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-secondary/75 text-foreground", isCredit && "border-primary-accent-text/15 bg-accent text-primary-accent-text")}>
            <Direction aria-hidden="true" className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-4 font-semibold text-foreground">{title}</span>
            {summary && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
          </span>
          <span className="shrink-0 text-right">
            {candidate && <span className={cn("block text-sm leading-4 font-semibold tracking-tight tabular-nums", isCredit && "text-primary-accent-text")}>{signedAmountText(candidate)}</span>}
            <span className="block whitespace-nowrap text-[11px] text-muted-foreground">Expires {dateLabel.format(dismissedAt.toMillis() + DISMISSED_CANDIDATE_RETENTION_MS)}</span>
          </span>
          <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
        <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={`Restore ${title}`} title="Restore to inbox" onClick={() => onRestore(entry)} className="size-8 rounded-lg border-primary-accent-text/15 bg-accent px-0 text-xs text-primary-accent-text hover:border-primary-accent-text/40 hover:bg-primary/25 sm:w-auto sm:px-2">
          {busy === entry.id ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <RotateCcw aria-hidden="true" className="size-3.5" />}
          <span className="hidden sm:inline">Restore</span>
        </Button>
      </div>
      <div id={detailsId} hidden={!expanded}>
        {expanded && (
          <div className="space-y-1.5 border-t border-border/70 bg-secondary/35 px-2.5 py-2 text-xs sm:px-3">
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
              {candidate && <div className="flex gap-1.5"><dt className="font-medium text-foreground">Transaction date</dt><dd>{dateLabel.format(candidate.transactionDate)}</dd></div>}
              <div className="flex gap-1.5"><dt className="font-medium text-foreground">Dismissed</dt><dd>{dateLabel.format(dismissedAt.toMillis())}</dd></div>
              {candidate?.bankName && candidate.bankName !== title && <div className="flex min-w-0 gap-1.5"><dt className="font-medium text-foreground">Bank</dt><dd className="wrap-anywhere">{candidate.bankName}</dd></div>}
              {candidate?.referenceNumber && <div className="flex min-w-0 gap-1.5"><dt className="font-medium text-foreground">Reference</dt><dd className="wrap-anywhere">{candidate.referenceNumber}</dd></div>}
            </dl>
            {candidate?.originalMessage && (
              <div className="rounded-lg border border-border border-l-2 border-l-primary-accent-text/50 bg-card px-2.5 py-2">
                <p className="font-semibold text-foreground">Original SMS</p>
                <p className="mt-0.5 whitespace-pre-wrap wrap-anywhere leading-relaxed text-muted-foreground">{candidate.originalMessage}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
