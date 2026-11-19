"use client";

/**
 * Add money to / withdraw money from one goal — inline inside the goal panel (no dialog). Same rules as before:
 *  - Set aside: money already in an account is reserved. No transaction, no balance change.
 *  - Move money: a real own-account transfer through the existing atomic transfer pair (not income / expense).
 *  - Withdraw: release a reservation, or transfer out. A LOCKED goal needs an explicit Emergency release (an app-level
 *    lock — the entry is marked so the history shows it).
 * One user action = one entry id, kept across retries, so a lost response can never record the money twice.
 */

import { ArrowRight, Info, Lock, PiggyBank, ShieldAlert, Siren } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountLabel, AccountSelect } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/format";
import { freeInAccount, fromDateKey, isSavingsAccount, round2, toDateKey, UNLINKED, validateMoneyEntry, type GoalView } from "@/lib/engines/savings-goals";
import { lockState } from "@/lib/engines/savings-plan";
import { cn } from "@/lib/utils";
import type { Account } from "@/lib/models/account";
import type { SavingsEntryDirection, SavingsEntryMode } from "@/lib/models/savings-contribution";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { isInsufficientFundsError } from "@/lib/engines/payment-funding";
import { generateId } from "@/lib/utils/id-generator";
import type { MoneyEntryInput } from "@/features/savings/hooks/use-savings-data";
import { AmountInput, ChoiceCards, FIELD, FieldLabel, InlineNote } from "@/features/savings/components/savings-ui";
import { formatShortDate } from "@/features/savings/lib/goal-style";

export interface MoneyComposerProps {
  direction: SavingsEntryDirection;
  view: GoalView;
  accounts: Account[];
  reservedByAccount: ReadonlyMap<string, number>;
  /** Prefill (e.g. this month's remaining plan amount). */
  suggestedAmount?: number | null;
  onSubmit: (view: GoalView, input: MoneyEntryInput) => Promise<void>;
  onDone: () => void;
}

function Composer({ direction, view, accounts, reservedByAccount, suggestedAmount, onSubmit, onDone }: MoneyComposerProps) {
  const isIn = direction === "in";
  const usable = useMemo(() => accounts.filter(isSavingsAccount), [accounts]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const buckets = useMemo(() => Array.from(view.heldByAccount.entries()), [view]);
  const lock = lockState(view, new Date());

  const [mode, setMode] = useState<SavingsEntryMode>("earmark");
  const [amountText, setAmountText] = useState(() => (isIn && suggestedAmount && suggestedAmount > 0 ? String(round2(suggestedAmount)) : ""));
  const [accountId, setAccountId] = useState(() => {
    if (isIn) {
      // The goal's own usual account first (the user chose it), then where its money already is, then the most free.
      const planned = view.goal.planAccountId && usable.some((a) => a.id === view.goal.planAccountId) ? view.goal.planAccountId : null;
      const held = buckets.find(([k]) => k !== UNLINKED && byId.has(k))?.[0];
      const richest = usable.slice().sort((a, b) => freeInAccount(b, reservedByAccount.get(b.id) ?? 0) - freeInAccount(a, reservedByAccount.get(a.id) ?? 0))[0]?.id ?? "";
      return planned ?? held ?? richest;
    }
    return buckets.find(([k]) => k !== UNLINKED)?.[0] ?? UNLINKED;
  });
  const [counterId, setCounterId] = useState("");
  const [dateKey, setDateKey] = useState(() => toDateKey(new Date()));
  const [note, setNote] = useState("");
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryId] = useState(() => `sav_${generateId().replace(/-/g, "")}`);

  const amount = Number(amountText);
  const amountValid = amountText.trim() !== "" && Number.isFinite(amount);
  const account = byId.get(accountId);
  const counter = byId.get(counterId);
  const accountFree = account ? freeInAccount(account, reservedByAccount.get(account.id) ?? 0) : 0;
  const counterFree = counter ? freeInAccount(counter, reservedByAccount.get(counter.id) ?? 0) : 0;
  const heldHere = view.heldByAccount.get(accountId) ?? 0;
  const unlinked = !isIn && accountId === UNLINKED;
  const effectiveMode: SavingsEntryMode = unlinked ? "earmark" : mode;
  const lockedOut = !isIn && lock.active;

  let problem: string | null = null;
  if (amountValid) {
    if (isIn && effectiveMode === "earmark") problem = validateMoneyEntry(amount, { direction: "in", mode: "earmark", accountFree });
    else if (isIn) problem = validateMoneyEntry(amount, { direction: "in", mode: "transfer", sourceFree: counterFree, sameAccount: accountId === counterId });
    else problem = validateMoneyEntry(amount, { direction: "out", mode: effectiveMode, heldAtAccount: heldHere, saved: view.saved, locked: lock.active, emergency });
  }
  const missingAccount = isIn ? (effectiveMode === "earmark" ? !account : !account || !counter) : effectiveMode === "transfer" ? !counter : false;
  const canSubmit = amountValid && amount > 0 && !problem && !missingAccount && !busy && (!lockedOut || emergency);

  async function submit() {
    if (!canSubmit) {
      setError(problem ?? (lockedOut && !emergency ? "This goal is locked — turn on Emergency release first." : amountValid ? "Choose the account(s) first." : "Enter an amount."));
      return;
    }
    const date = fromDateKey(dateKey);
    if (!date) return setError("Enter a valid date.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(view, {
        id: entryId,
        direction,
        mode: effectiveMode,
        amount: round2(amount),
        date,
        accountId: unlinked ? null : accountId,
        counterAccountId: effectiveMode === "transfer" ? counterId : null,
        note: note.trim() || (emergency ? "Emergency release" : ""),
        emergency: lockedOut && emergency,
      });
      onDone();
    } catch (e) {
      setError(isInsufficientFundsError(e) ? e.message : (userFacingMessage(e) ?? "Couldn't save this — please try again."));
    } finally {
      setBusy(false);
    }
  }

  const goalName = view.goal.name;
  const preview = (() => {
    if (!amountValid || amount <= 0) return null;
    const amt = formatCurrency(round2(amount));
    if (isIn && effectiveMode === "earmark") return `No money moves. ${amt} of ${account?.name ?? "this account"} is set aside for ${goalName} — your balances and net worth stay exactly as they are.`;
    if (isIn) return `${amt} moves from ${counter?.name ?? "…"} to ${account?.name ?? "…"} as a transfer. It is not an expense, and net worth doesn't change.`;
    if (effectiveMode === "earmark") return `No money moves. ${amt} is released from ${goalName}${account ? ` and becomes free money in ${account.name}` : ""}.`;
    return `${amt} moves from ${account?.name ?? "…"} to ${counter?.name ?? "…"} as a transfer. It is not income, and net worth doesn't change.`;
  })();

  const quick = isIn
    ? [suggestedAmount && suggestedAmount > 0 && suggestedAmount < view.remaining ? { label: `This month ${formatCurrency(suggestedAmount)}`, v: suggestedAmount } : null, view.remaining > 0 ? { label: `All remaining ${formatCurrency(view.remaining)}`, v: view.remaining } : null]
    : [heldHere > 0 ? { label: `All here ${formatCurrency(heldHere)}`, v: heldHere } : null];

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="savings-money-panel" data-direction={direction}>
      {lockedOut && (
        <div className={cn("flex flex-col gap-2 rounded-2xl border p-3", emergency ? "border-expense/40 bg-expense/6" : "border-border/60 bg-muted/30")} data-testid="savings-lock-gate">
          <div className="flex items-start gap-2.5">
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", emergency ? "bg-expense/15 text-expense" : "bg-purple/15 text-purple")}>
              {emergency ? <Siren className="size-4" /> : <Lock className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">Locked{lock.until ? ` until ${formatShortDate(lock.until)}` : ""}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">A FlowFi reservation — your bank account is not frozen. Withdrawing now is an emergency release and is marked in the history.</p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <span>Emergency release</span>
              <Switch checked={emergency} onCheckedChange={setEmergency} aria-label="Emergency release" data-testid="savings-emergency" />
            </label>
          </div>
        </div>
      )}

      <fieldset disabled={lockedOut && !emergency} className="flex flex-col gap-3 disabled:opacity-55">
        {isIn ? (
          <ChoiceCards
            label="How is this money added"
            value={mode}
            onChange={(next) => {
              setMode(next);
              // A real transfer needs both accounts chosen on purpose — never a silently pre-picked one.
              if (next === "transfer") {
                setAccountId("");
                setCounterId("");
              } else if (!accountId) {
                setAccountId(view.goal.planAccountId ?? buckets.find(([k]) => k !== UNLINKED && byId.has(k))?.[0] ?? usable[0]?.id ?? "");
              }
            }}
            options={[
              { value: "earmark", title: "Set aside", hint: "Money already in an account — nothing moves", icon: <PiggyBank className="size-4" /> },
              { value: "transfer", title: "Move money", hint: "Transfer into a savings account", icon: <ArrowRight className="size-4" /> },
            ]}
          />
        ) : (
          !unlinked && (
            <ChoiceCards
              label="How is this money withdrawn"
              value={mode}
              onChange={setMode}
              options={[
                { value: "earmark", title: "Release", hint: "Stays in the account, no longer set aside" },
                { value: "transfer", title: "Move to account", hint: "Transfer out to another account" },
              ]}
            />
          )
        )}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <label className="flex flex-col gap-1">
            <FieldLabel>Amount</FieldLabel>
            <AmountInput value={amountText} onChange={setAmountText} ariaLabel="Amount" testId="savings-amount" autoFocus size="lg" />
            <div className="flex flex-wrap gap-1.5">
              {quick.filter((q): q is { label: string; v: number } => q != null).map((q) => (
                <button key={q.label} type="button" className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground" onClick={() => setAmountText(String(round2(q.v)))}>
                  {q.label}
                </button>
              ))}
            </div>
          </label>

          <div className="flex min-w-0 flex-col gap-1">
            {isIn && effectiveMode === "earmark" && (
              <>
                <FieldLabel hint={account ? `Free ${formatCurrency(accountFree)}` : undefined}>Money is in</FieldLabel>
                <AccountSelect accounts={usable.map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={accountId} onChange={setAccountId} showBalance ariaLabel="Account the money is in" />
                {account && <p className="text-[11px] text-muted-foreground">{formatCurrency(accountFree)} free of {formatCurrency(account.currentBalance)} — the rest is already set aside.</p>}
              </>
            )}
            {isIn && effectiveMode === "transfer" && (
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <FieldLabel>From</FieldLabel>
                  <AccountSelect accounts={usable.filter((a) => a.id !== accountId).map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={counterId} onChange={setCounterId} showBalance ariaLabel="Move from account" />
                </div>
                <ArrowRight className="mb-3 size-4 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-1">
                  <FieldLabel>Into</FieldLabel>
                  <AccountSelect accounts={usable.filter((a) => a.id !== counterId)} value={accountId} onChange={setAccountId} ariaLabel="Savings account" />
                </div>
              </div>
            )}
            {!isIn && (
              <>
                <FieldLabel>Take from</FieldLabel>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Take from">
                  {buckets.map(([key, amt]) => {
                    const acc = byId.get(key);
                    const on = key === accountId;
                    return (
                      <button
                        key={key || "opening"}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setAccountId(key)}
                        className={cn("inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs transition-colors", on ? "border-primary bg-primary/12" : "border-border/60 bg-muted/20 hover:border-border")}
                      >
                        {key === UNLINKED ? <span>Opening balance</span> : acc ? <AccountLabel account={acc} size={14} showKind={false} /> : <span>Removed account</span>}
                        <span className="font-mono text-muted-foreground">{formatCurrency(amt)}</span>
                      </button>
                    );
                  })}
                </div>
                {unlinked && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="size-3" /> This starting amount isn&apos;t tied to an account, so it can only be released.
                  </p>
                )}
                {effectiveMode === "transfer" && (
                  <div className="mt-1 flex flex-col gap-1">
                    <FieldLabel>Send to</FieldLabel>
                    <AccountSelect accounts={usable.filter((a) => a.id !== accountId)} value={counterId} onChange={setCounterId} ariaLabel="Send to account" />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <label className="flex flex-col gap-1">
            <FieldLabel>Date</FieldLabel>
            <DateInput className={FIELD} value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Note (optional)</FieldLabel>
            <input type="text" className={FIELD} maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isIn ? "e.g. Salary day" : emergency ? "What was it for? e.g. Hospital bill" : "e.g. Bought it!"} />
          </label>
        </div>
      </fieldset>

      {preview && !problem && (
        <InlineNote testId="savings-preview" icon={effectiveMode === "earmark" ? <PiggyBank className="size-3.5" /> : <Info className="size-3.5" />}>
          {preview}
        </InlineNote>
      )}
      {lockedOut && emergency && amountValid && amount > 0 && !problem && (
        <InlineNote tone="warn" icon={<ShieldAlert className="size-3.5" />}>
          This is recorded as an <strong>emergency withdrawal</strong>. The goal stays locked for the rest of its money.
        </InlineNote>
      )}
      {(problem || error) && (
        <InlineNote tone="error" role="alert" testId="savings-error">
          {problem ?? error}
        </InlineNote>
      )}

      <div className="flex items-center justify-end gap-2">
        <ClayButton variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </ClayButton>
        <ClayButton size="sm" className={cn("h-9 px-4", !isIn && emergency && "bg-expense text-expense-foreground")} onClick={submit} disabled={busy || !!problem} data-testid="savings-money-submit">
          {busy ? "Saving…" : isIn ? "Add money" : emergency ? "Withdraw (emergency)" : "Withdraw"}
        </ClayButton>
      </div>
    </div>
  );
}

/** Remounts per goal + direction so no value carries over. */
export function MoneyComposer(props: MoneyComposerProps) {
  return <Composer key={`${props.view.goal.id}:${props.direction}`} {...props} />;
}
