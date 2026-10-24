"use client";

/**
 * Advanced filters in a right-side sheet (full-width on a phone). Edits a DRAFT — nothing narrows the list until Apply —
 * and the Apply button shows how many rows the draft would list, so nothing is applied blind. "Clear all" resets the draft
 * to the defaults; Escape / the close button discard it. Every category here is ANDed with the others by `filters.ts`.
 *
 * Presentation only: it produces a `CandidateFilters` + sort key and hands them to the workspace, which owns the state, the
 * URL and the selection reset. Nothing here reads or writes Firestore.
 */

import { Search, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { SmsCandidateConfidenceLevel } from "@/lib/models/sms-transaction-candidate";
import { formatMonthKey } from "../lib/candidate-month-groups";
import {
  CANDIDATE_SORT_LABELS,
  CANDIDATE_SORT_ORDER,
  countActiveCandidateFilters,
  DEFAULT_CANDIDATE_FILTERS,
  UNMATCHED_ACCOUNT_KEY,
  type CandidateFilters,
  type CandidateSortKey,
  type CandidateViewFilter,
} from "../lib/filters";
import { FOCUS_RING } from "./candidate-row-parts";

export interface FilterSheetOptions {
  months: string[];
  /** Accounts / cards at least one candidate resolved to. */
  accounts: { key: string; label: string }[];
}

const STATUS_OPTIONS: { value: CandidateViewFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Attention needed" },
  { value: "needsAccount", label: "Needs account" },
  { value: "needsReview", label: "Needs review" },
  { value: "duplicate", label: "Possible duplicate" },
  { value: "noIssues", label: "No issues flagged" },
];

const CONFIDENCE_OPTIONS: { value: SmsCandidateConfidenceLevel; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/** `""` → no bound; otherwise a finite number ≥ 0, or `undefined` for text that isn't one. */
function parseAmount(text: string): number | null | undefined {
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const amountText = (n: number | null) => (n == null ? "" : String(n));

function Group({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/60 p-3.5 sm:p-4" aria-labelledby={id}>
      <legend id={id} className="px-0.5 text-xs font-bold tracking-wider text-muted-foreground uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-all motion-reduce:transition-none",
        FOCUS_RING,
        on
          ? "border-foreground bg-foreground text-background shadow-sm"
          : "border-border-strong bg-card text-foreground hover:border-foreground/40 hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

function SheetBody({
  applied,
  appliedSort,
  options,
  previewCount,
  onApply,
  onClose,
}: {
  applied: CandidateFilters;
  appliedSort: CandidateSortKey;
  options: FilterSheetOptions;
  previewCount: (filters: CandidateFilters) => number;
  onApply: (filters: CandidateFilters, sortKey: CandidateSortKey) => void;
  onClose: () => void;
}) {
  const ids = { status: useId(), dir: useId(), month: useId(), dates: useId(), amount: useId(), accounts: useId(), conf: useId(), sort: useId() };
  const [draft, setDraft] = useState<CandidateFilters>(applied);
  const [sortKey, setSortKey] = useState<CandidateSortKey>(appliedSort);
  const [minText, setMinText] = useState(amountText(applied.minAmount));
  const [maxText, setMaxText] = useState(amountText(applied.maxAmount));
  const [accountSearch, setAccountSearch] = useState("");

  const min = parseAmount(minText);
  const max = parseAmount(maxText);
  const amountError =
    min === undefined || max === undefined ? "Enter amounts as plain numbers, like 250 or 1999.50." : min != null && max != null && min > max ? "Minimum can't be more than the maximum." : null;
  const dateError = draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo ? "“From” can't be after “To”." : null;
  const invalid = amountError != null || dateError != null;

  // The draft as it would be applied (amount text folded in), so the count and Apply agree.
  const effective: CandidateFilters = useMemo(
    () => ({ ...draft, minAmount: min === undefined ? null : min, maxAmount: max === undefined ? null : max }),
    [draft, min, max],
  );
  const count = invalid ? null : previewCount(effective);
  const activeCount = countActiveCandidateFilters(effective);
  const accountOptions = useMemo(
    () => [...options.accounts, { key: UNMATCHED_ACCOUNT_KEY, label: "Unmatched — no account found" }],
    [options.accounts],
  );
  const filteredAccountOptions = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    return q === "" ? accountOptions : accountOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [accountOptions, accountSearch]);

  const toggle = <T extends string>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const reset = () => {
    setDraft(DEFAULT_CANDIDATE_FILTERS);
    setMinText("");
    setMaxText("");
    setSortKey("newest");
  };

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-card px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <SheetTitle className="font-heading text-xl font-bold text-foreground">Filters</SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">Every filter below narrows the list together.</SheetDescription>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          className={cn("flex size-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-secondary", FOCUS_RING)}
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-secondary/30 px-5 py-5 sm:px-6"
        data-testid="candidate-filter-sheet-body"
      >
        <Group title="Review status" id={ids.status}>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTIONS.map((o) => (
              <Chip key={o.value} on={draft.lane === o.value} onClick={() => setDraft((d) => ({ ...d, lane: o.value }))}>
                {o.label}
              </Chip>
            ))}
          </div>
        </Group>

        {/* Paired up on a wide sheet so these six groups cost four rows of scroll instead of six. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Group title="Direction" id={ids.dir}>
            <div className="flex gap-1.5">
              {([null, "debit", "credit"] as const).map((dir) => (
                <Chip key={dir ?? "all"} on={draft.direction === dir} onClick={() => setDraft((d) => ({ ...d, direction: dir }))}>
                  {dir === null ? "All" : dir === "debit" ? "Debit" : "Credit"}
                </Chip>
              ))}
            </div>
          </Group>

          <Group title="Detection confidence" id={ids.conf}>
            <div className="flex gap-1.5">
              {CONFIDENCE_OPTIONS.map((o) => (
                <Chip key={o.value} on={draft.confidence.includes(o.value)} onClick={() => setDraft((d) => ({ ...d, confidence: toggle(d.confidence, o.value) }))}>
                  {o.label}
                </Chip>
              ))}
            </div>
          </Group>

          <Group title="Month" id={ids.month}>
            <Select value={draft.month ?? "all"} onValueChange={(v) => setDraft((d) => ({ ...d, month: v === "all" ? null : v }))}>
              <SelectTrigger className="h-11 w-full" aria-labelledby={ids.month}>
                <SelectValue placeholder="All months" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {options.months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {formatMonthKey(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Group>

          <Group title="Sort by" id={ids.sort}>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as CandidateSortKey)}>
              <SelectTrigger className="h-11 w-full" aria-labelledby={ids.sort}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CANDIDATE_SORT_ORDER.map((key) => (
                  <SelectItem key={key} value={key}>
                    {CANDIDATE_SORT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Group>

          <Group title="Date range" id={ids.dates}>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                From
                <Input type="date" className="h-11" value={draft.dateFrom ?? ""} max={draft.dateTo ?? undefined} onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value || null }))} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                To
                <Input type="date" className="h-11" value={draft.dateTo ?? ""} min={draft.dateFrom ?? undefined} onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value || null }))} />
              </label>
            </div>
            {dateError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {dateError}
              </p>
            )}
          </Group>

          <Group title="Amount" id={ids.amount}>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Minimum
                <Input inputMode="decimal" className="h-11 tabular-nums" placeholder="₹ 0" value={minText} onChange={(e) => setMinText(e.target.value)} aria-invalid={min === undefined} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Maximum
                <Input inputMode="decimal" className="h-11 tabular-nums" placeholder="No limit" value={maxText} onChange={(e) => setMaxText(e.target.value)} aria-invalid={max === undefined} />
              </label>
            </div>
            {amountError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {amountError}
              </p>
            )}
          </Group>
        </div>

        <Group title="Account or card" id={ids.accounts}>
          {accountOptions.length > 6 && (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                className="h-11 pl-9"
                placeholder="Search accounts or cards"
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                aria-label="Search accounts or cards"
              />
            </div>
          )}
          {filteredAccountOptions.length === 0 ? (
            <p className="px-0.5 py-2 text-sm text-muted-foreground">No account or card matches “{accountSearch}”.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {filteredAccountOptions.map((o) => {
                const checked = draft.accountKeys.includes(o.key);
                return (
                  <li key={o.key}>
                    <Chip on={checked} onClick={() => setDraft((d) => ({ ...d, accountKeys: toggle(d.accountKeys, o.key) }))}>
                      {o.label}
                    </Chip>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">Pick more than one to see candidates from any of them.</p>
        </Group>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-card px-5 py-3.5 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.08)] sm:px-6">
        <button
          type="button"
          onClick={reset}
          disabled={activeCount === 0 && sortKey === "newest"}
          className={cn(
            "inline-flex min-h-11 items-center rounded-full px-3.5 text-sm font-semibold text-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline",
            FOCUS_RING,
          )}
        >
          Clear all
        </button>
        <button
          type="button"
          disabled={invalid}
          onClick={() => onApply(effective, sortKey)}
          data-testid="apply-filters"
          className={cn(
            "inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          {count == null ? "Apply filters" : count === 0 ? "Apply — no matches" : `Show ${count} ${count === 1 ? "result" : "results"}`}
        </button>
      </div>
    </>
  );
}

export function CandidateFilterSheet({
  open,
  onOpenChange,
  ...body
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applied: CandidateFilters;
  appliedSort: CandidateSortKey;
  options: FilterSheetOptions;
  previewCount: (filters: CandidateFilters) => number;
  onApply: (filters: CandidateFilters, sortKey: CandidateSortKey) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[440px] data-[side=right]:lg:max-w-[600px]">
        {/* Mounted only while open, so every opening starts from the currently applied filters. */}
        {open && <SheetBody {...body} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}
