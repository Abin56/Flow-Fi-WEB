"use client";

import { Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { DateInput } from "@/components/forms/date-input";
import { useHistoricalReimbursement, type ReimbursementTarget } from "@/features/loans/hooks/use-historical-reimbursement";
import {
  planReimbursements,
  reimbursementLineKey,
  type BalanceTreatment,
  type ReceivedChoice,
  type ReimbursementDraft,
  type ReimbursementItem,
  type ReimbursementLine,
  type ReimbursementPlan,
  type ReimbursementResult,
} from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { generateId } from "@/lib/utils/id-generator";
import { cn } from "@/lib/utils";

/**
 * "Have the people sharing this EMI already paid you?" — the People side of marking old Loan / EMI
 * installments as paid (`historical-reimbursement.ts`). Each person × installment is answered separately
 * (nothing is assumed received); what People already recorded is shown as such and never offered again.
 * Every received row says when it was received (blank = not known) and whether that money is already in the
 * account balance — per row, because one batch can hold both kinds.
 */

export interface HistoricalReconcileState {
  lines: ReimbursementLine[];
  loading: boolean;
  draft: Record<string, ReimbursementDraft>;
  setLine: (key: string, patch: Partial<ReimbursementDraft>) => void;
  setPerson: (personId: string, choice: ReceivedChoice) => void;
  /** Sets the account treatment on every received row. */
  setAllTreatments: (t: BalanceTreatment) => void;
  /** Sets the received date and/or treatment on every received row of one person (a shortcut — rows stay editable). */
  setPersonReceived: (personId: string, patch: { date?: string; treatment?: BalanceTreatment }) => void;
  accountId: string;
  setAccountId: (id: string) => void;
  plan: ReimbursementPlan;
  /** Why the save can't go on yet (null = fine). */
  blocker: string | null;
  results: Record<string, ReimbursementResult>;
  failed: ReimbursementItem[];
  /** Records the given items (a first run, or a retry of the failed ones). */
  run: (items: readonly ReimbursementItem[]) => Promise<Record<string, ReimbursementResult>>;
}

const received = (d: ReimbursementDraft | undefined) => d != null && d.choice !== "none";

export function useHistoricalReconcile(params: { target: ReimbursementTarget | null; defaultAccountId: string }): HistoricalReconcileState {
  const { lines, isLoading, record } = useHistoricalReimbursement(params.target);
  const [batchId] = useState(generateId);
  const [draft, setDraft] = useState<Record<string, ReimbursementDraft>>({});
  const [pickedAccount, setAccountId] = useState("");
  const [results, setResults] = useState<Record<string, ReimbursementResult>>({});
  const [ranItems, setRanItems] = useState<ReimbursementItem[]>([]);
  const accountId = pickedAccount || params.defaultAccountId;

  const plan = planReimbursements({ lines, draft, batchId });
  const total = plan.ok ? plan.summary.total : 0;
  const blocker = !plan.ok ? "Check the people's rows." : total > PAYMENT_EPSILON && accountId === "" ? "Choose the account it was received into." : null;
  const failed = useMemo(() => ranItems.filter((i) => results[i.key]?.status === "failed"), [ranItems, results]);
  const blank: ReimbursementDraft = { choice: "none", amount: "" };

  return {
    lines,
    loading: isLoading,
    draft,
    setLine: (key, patch) => setDraft((prev) => ({ ...prev, [key]: { ...blank, ...prev[key], ...patch } })),
    setPerson: (personId, choice) =>
      setDraft((prev) => {
        const next = { ...prev };
        for (const l of lines) if (l.personId === personId && l.remaining > PAYMENT_EPSILON) next[reimbursementLineKey(l)] = { ...blank, ...prev[reimbursementLineKey(l)], choice, amount: "" };
        return next;
      }),
    setAllTreatments: (treatment) =>
      setDraft((prev) => Object.fromEntries(Object.entries(prev).map(([k, d]) => [k, received(d) ? { ...d, treatment } : d]))),
    setPersonReceived: (personId, patch) =>
      setDraft((prev) => {
        const next = { ...prev };
        for (const l of lines) {
          const key = reimbursementLineKey(l);
          if (l.personId === personId && received(prev[key])) next[key] = { ...prev[key]!, ...patch };
        }
        return next;
      }),
    accountId,
    setAccountId,
    plan,
    blocker,
    results,
    failed,
    run: async (items) => {
      setRanItems((prev) => [...prev.filter((p) => !items.some((i) => i.key === p.key)), ...items]);
      const r = await record(items, accountId, results);
      setResults(r);
      return r;
    },
  };
}

/** A person's per-installment rows fold away beyond this many (a 24-month history stays readable). */
const COLLAPSE_AFTER = 6;

/** The date every row shares, or "" when they differ (a mixed answer shows as not set). */
function sharedDate(values: readonly string[]): string {
  return values.every((v) => v === values[0]) ? (values[0] ?? "") : "";
}

/** The treatment every row shares, or null when they differ or some are unanswered. */
function sharedTreatment(values: readonly (BalanceTreatment | null | undefined)[]): BalanceTreatment | null {
  return values.every((v) => v === values[0]) ? (values[0] ?? null) : null;
}

const CHOICES: { value: ReceivedChoice; label: string }[] = [
  { value: "full", label: "Received in full" },
  { value: "some", label: "Received some" },
  { value: "none", label: "Not received yet" },
];

const TREATMENTS: { value: BalanceTreatment; label: string; short: string }[] = [
  { value: "included", label: "Already included in my account", short: "Already in my account" },
  { value: "addToAccount", label: "Add money to my account", short: "Add to my account" },
];

export function HistoricalPeopleReconcile({
  state,
  accounts,
  showInstallment,
  locked,
}: {
  state: HistoricalReconcileState;
  accounts: readonly Account[];
  /** Several installments: label each line with its installment number. */
  showInstallment: boolean;
  /** After saving: read-only. */
  locked?: boolean;
}) {
  const { lines, loading, draft, plan } = state;
  const [expandedPeople, setExpandedPeople] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (personId: string) =>
    setExpandedPeople((s) => {
      const next = new Set(s);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  if (lines.length === 0) {
    if (!loading) return null;
    return (
      <p role="status" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this…
      </p>
    );
  }
  const people = [...new Map(lines.map((l) => [l.personId, l.personName])).entries()];
  const errors = plan.ok ? {} : plan.errors;
  const summary = plan.ok ? plan.summary : null;
  const receivedCount = lines.filter((l) => l.remaining > PAYMENT_EPSILON && received(draft[reimbursementLineKey(l)])).length;
  const anyAdded = lines.some((l) => draft[reimbursementLineKey(l)]?.treatment === "addToAccount" && received(draft[reimbursementLineKey(l)]));

  return (
    <section aria-label="People sharing it" className="flex flex-col gap-2.5 rounded-[6px] border border-border p-3">
      <h3 className="text-sm font-semibold text-foreground">Have the people sharing this already paid you?</h3>
      <ul className="flex flex-col divide-y divide-border">
        {people.map(([personId, personName]) => {
          const own = lines.filter((l) => l.personId === personId);
          const open = own.filter((l) => l.remaining > PAYMENT_EPSILON);
          const ownReceived = open.filter((l) => received(draft[reimbursementLineKey(l)]));
          const ownUnanswered = own.filter((l) => errors[reimbursementLineKey(l)] != null).length;
          const ownFailed = own.some((l) => state.failed.some((f) => f.personId === l.personId && f.obligationKey === l.obligationKey));
          // Long histories (e.g. 24 months) fold into a one-line summary per person. A row whose save failed always
          // shows; rows still needing an answer are counted (the person's shortcut above usually answers them all).
          const foldable = own.length > COLLAPSE_AFTER;
          const expanded = !foldable || ownFailed || expandedPeople.has(personId);
          return (
            <li key={personId} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0" data-testid={`reconcile-person-${personId}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{personName}</span>
                {showInstallment && open.length > 1 && !locked && (
                  <span className="flex gap-2 text-[11px] font-medium">
                    <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => state.setPerson(personId, "full")}>
                      All received
                    </button>
                    <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => state.setPerson(personId, "none")}>
                      None
                    </button>
                  </span>
                )}
              </div>
              {showInstallment && open.length > 1 && (
                <p className="text-[11.5px] text-muted-foreground" data-testid={`reconcile-count-${personId}`}>
                  {ownReceived.length} of {open.length} marked received
                  {own.length > open.length ? ` · ${own.length - open.length} already received in People` : ""}
                </p>
              )}
              {/* One answer for all of this person's received rows — each row can still be changed below. */}
              {ownReceived.length > 1 && !locked && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-[6px] bg-secondary/60 px-2 py-1.5 text-[11px]" aria-label={`All of ${personName}'s received shares`}>
                  <span className="font-medium text-foreground">For all {ownReceived.length} received:</span>
                  <DateInput
                    aria-label={`Date ${personName} paid you, for all received`}
                    title="Leave blank if you don't know the date"
                    className="h-7 w-32 rounded-[6px] border border-border bg-card px-2 text-[11px]"
                    value={sharedDate(ownReceived.map((l) => draft[reimbursementLineKey(l)]?.date ?? ""))}
                    onChange={(e) => state.setPersonReceived(personId, { date: e.target.value })}
                  />
                  <Segmented
                    name={`Where is ${personName}'s money, for all received`}
                    value={sharedTreatment(ownReceived.map((l) => draft[reimbursementLineKey(l)]?.treatment))}
                    options={TREATMENTS.map((t) => ({ value: t.value, label: t.short }))}
                    onChange={(v) => state.setPersonReceived(personId, { treatment: v })}
                  />
                </div>
              )}
              {foldable && !ownFailed && (
                <span className="flex flex-wrap items-center gap-x-2 text-[11px]">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(personId)}
                    className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {expanded ? "Hide each installment" : `Show each installment (${own.length})`}
                  </button>
                  {!expanded && ownUnanswered > 0 && (
                    <span className="font-semibold text-expense" data-testid={`reconcile-unanswered-${personId}`}>
                      {ownUnanswered} still need an answer
                    </span>
                  )}
                </span>
              )}
              {expanded && own.map((l) => (
                <ShareLineRow
                  key={reimbursementLineKey(l)}
                  line={l}
                  draft={draft[reimbursementLineKey(l)]}
                  error={errors[reimbursementLineKey(l)]}
                  failed={state.failed.some((f) => f.personId === l.personId && f.obligationKey === l.obligationKey)}
                  showInstallment={showInstallment}
                  locked={locked}
                  onChange={(patch) => state.setLine(reimbursementLineKey(l), patch)}
                />
              ))}
            </li>
          );
        })}
      </ul>

      {receivedCount > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
          {receivedCount > 1 && !locked && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              Set all received:
              {TREATMENTS.map((t) => (
                <button key={t.value} type="button" className="font-semibold text-foreground underline-offset-2 hover:underline" onClick={() => state.setAllTreatments(t.value)}>
                  {t.short}
                </button>
              ))}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{anyAdded ? "Received into" : "Received into · for your records"}</span>
            <AccountSelect className="h-9 rounded-[6px] border border-border bg-card px-2 text-sm" accounts={accounts as Account[]} value={state.accountId} onChange={state.setAccountId} ariaLabel="Received into account" />
          </label>
        </div>
      )}

      {summary && (
        <p className="text-[11.5px] text-foreground/80" data-testid="reconcile-summary">
          {summary.people
            .map((p) => `${p.personName}: ${p.remainingAfter > PAYMENT_EPSILON ? `${formatCurrency(p.remainingAfter)} still to receive` : "fully received"}`)
            .join(" · ")}
          {summary.total > PAYMENT_EPSILON && (
            <> · {summary.balanceChange > PAYMENT_EPSILON ? `Account balance +${formatCurrency(summary.balanceChange)}` : "Account balance won't change"}</>
          )}
        </p>
      )}
    </section>
  );
}

function ShareLineRow({
  line,
  draft,
  error,
  failed,
  showInstallment,
  locked,
  onChange,
}: {
  line: ReimbursementLine;
  draft: ReimbursementDraft | undefined;
  error: string | undefined;
  failed: boolean;
  showInstallment: boolean;
  locked?: boolean;
  onChange: (patch: Partial<ReimbursementDraft>) => void;
}) {
  const label = `${showInstallment ? `#${line.sequenceNumber} · ` : ""}Share ${formatCurrency(line.share)}`;
  const name = `${line.personName}${showInstallment ? ` #${line.sequenceNumber}` : ""}`;
  if (line.remaining <= PAYMENT_EPSILON) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="inline-flex items-center gap-1 font-medium text-success">
          <Check className="size-3" aria-hidden /> Received earlier
        </span>
      </div>
    );
  }
  const choice = draft?.choice ?? "none";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          {label}
          {line.received > PAYMENT_EPSILON && <> · got {formatCurrency(line.received)}, {formatCurrency(line.remaining)} left</>}
        </span>
        <Segmented
          name={name}
          value={choice}
          disabled={locked}
          options={CHOICES.map((c) => ({ value: c.value, label: c.value === "full" && line.received > PAYMENT_EPSILON ? "Received the rest" : c.label }))}
          onChange={(v) => onChange({ choice: v })}
        />
      </div>
      {choice !== "none" && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {choice === "some" && (
            <input
              type="number"
              inputMode="decimal"
              aria-label={`Amount received from ${line.personName}`}
              placeholder={`Up to ${formatCurrency(line.remaining)}`}
              disabled={locked}
              className="h-8 w-32 rounded-[6px] border border-border bg-card px-2 text-right text-xs tabular-nums"
              value={draft?.amount ?? ""}
              onChange={(e) => onChange({ amount: e.target.value })}
            />
          )}
          <DateInput
            aria-label={`Date received from ${name}`}
            title="Leave blank if you don't know the date"
            className="h-8 w-36 rounded-[6px] border border-border bg-card px-2 text-xs"
            value={draft?.date ?? ""}
            disabled={locked}
            onChange={(e) => onChange({ date: e.target.value })}
          />
          <Segmented
            name={`Where is ${name}'s money`}
            value={draft?.treatment ?? null}
            disabled={locked}
            options={TREATMENTS.map((t) => ({ value: t.value, label: t.short }))}
            onChange={(v) => onChange({ treatment: v })}
          />
        </div>
      )}
      {choice !== "none" && !(draft?.date ?? "") && <p className="text-right text-[11px] text-muted-foreground">Date not known — saved as such</p>}
      {error && (
        <p role="alert" className="text-right text-[11px] font-semibold text-expense">
          {error}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-right text-[11px] font-semibold text-expense">
          Not saved yet — retry below.
        </p>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  value: T | null;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <span role="radiogroup" aria-label={name} className="inline-flex overflow-hidden rounded-[6px] border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn("px-2 py-1 text-[11px] font-medium whitespace-nowrap", value === o.value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
