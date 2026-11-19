"use client";

import { ArrowRight, Info, Lock, PiggyBank } from "lucide-react";
import { useMemo, useState } from "react";
import { AccountLabel, AccountSelect, FormDialog } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { formatCurrency } from "@/lib/format";
import { freeInAccount, fromDateKey, isSavingsAccount, round2, toDateKey, UNLINKED, validateMoneyEntry, type GoalView } from "@/lib/engines/savings-goals";
import { cn } from "@/lib/utils";
import type { Account } from "@/lib/models/account";
import type { SavingsEntryDirection, SavingsEntryMode } from "@/lib/models/savings-contribution";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { isInsufficientFundsError } from "@/lib/engines/payment-funding";
import { generateId } from "@/lib/utils/id-generator";
import type { MoneyEntryInput } from "@/features/savings/hooks/use-savings-data";

const FIELD = "clay-pressed h-10 w-full rounded-xl px-3 text-sm outline-none";

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; title: string; hint: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors",
              on ? "border-primary bg-primary/12" : "border-border/60 bg-muted/20 hover:border-border",
            )}
          >
            <span className="text-sm font-semibold text-foreground">{o.title}</span>
            <span className="text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

function MoneyEntryInner({
  open,
  onOpenChange,
  direction,
  view,
  accounts,
  reservedByAccount,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  direction: SavingsEntryDirection;
  view: GoalView | null;
  accounts: Account[];
  reservedByAccount: ReadonlyMap<string, number>;
  onSubmit: (view: GoalView, input: MoneyEntryInput) => Promise<void>;
}) {
  const isIn = direction === "in";
  const usable = useMemo(() => accounts.filter(isSavingsAccount), [accounts]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Holding buckets of this goal (for withdrawals): accounts the goal's money sits in.
  const buckets = useMemo(() => (view ? Array.from(view.heldByAccount.entries()) : []), [view]);

  const [mode, setMode] = useState<SavingsEntryMode>("earmark");
  const [amountText, setAmountText] = useState("");
  const [accountId, setAccountId] = useState(() => {
    if (isIn) {
      // Prefer an account this goal already lives in; else the account with the most free money.
      const held = buckets.find(([k]) => k !== UNLINKED && byId.has(k))?.[0];
      const richest = usable.slice().sort((a, b) => freeInAccount(b, reservedByAccount.get(b.id) ?? 0) - freeInAccount(a, reservedByAccount.get(a.id) ?? 0))[0]?.id ?? "";
      return held ?? richest;
    }
    return buckets.find(([k]) => k !== UNLINKED)?.[0] ?? UNLINKED;
  });
  const [counterId, setCounterId] = useState("");
  const [dateKey, setDateKey] = useState(() => toDateKey(new Date()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One user action = one id, kept across retries so a lost response can never record the money twice.
  const [entryId] = useState(() => `sav_${generateId().replace(/-/g, "")}`);

  if (!view) return null;

  const amount = Number(amountText);
  const amountValid = amountText.trim() !== "" && Number.isFinite(amount);
  const account = byId.get(accountId);
  const counter = byId.get(counterId);
  const accountFree = account ? freeInAccount(account, reservedByAccount.get(account.id) ?? 0) : 0;
  const counterFree = counter ? freeInAccount(counter, reservedByAccount.get(counter.id) ?? 0) : 0;
  const heldHere = view.heldByAccount.get(accountId) ?? 0;
  const unlinked = !isIn && accountId === UNLINKED;
  const effectiveMode: SavingsEntryMode = unlinked ? "earmark" : mode;

  let problem: string | null = null;
  if (amountValid) {
    if (isIn && effectiveMode === "earmark") problem = validateMoneyEntry(amount, { direction: "in", mode: "earmark", accountFree });
    else if (isIn) problem = validateMoneyEntry(amount, { direction: "in", mode: "transfer", sourceFree: counterFree, sameAccount: accountId === counterId });
    else problem = validateMoneyEntry(amount, { direction: "out", mode: effectiveMode, heldAtAccount: heldHere, saved: view.saved });
  }
  const missingAccount = isIn ? (effectiveMode === "earmark" ? !account : !account || !counter) : effectiveMode === "transfer" ? !counter : false;
  const canSubmit = amountValid && amount > 0 && !problem && !missingAccount && !busy;

  async function submit() {
    if (!view || !canSubmit) {
      setError(problem ?? (amountValid ? "Choose the account(s) first." : "Enter an amount."));
      return;
    }
    const date = fromDateKey(dateKey);
    if (!date) {
      setError("Enter a valid date.");
      return;
    }
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
        note: note.trim(),
      });
      onOpenChange(false);
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

  const title = isIn ? `Add to ${goalName}` : `Withdraw from ${goalName}`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={isIn ? "Set money aside, or move it into a savings account." : "Take money out of this goal."}
      onConfirm={submit}
      confirmLabel={isIn ? "Add money" : "Withdraw"}
      loading={busy}
      confirmDisabled={!!problem}
      contentClassName="sm:max-w-md"
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="savings-money-dialog">
        {isIn ? (
          <Choice
            label="How is this money added"
            value={mode}
            onChange={(next) => {
              setMode(next);
              // A real transfer needs both accounts chosen on purpose — never a silently pre-picked one.
              if (next === "transfer") {
                setAccountId("");
                setCounterId("");
              } else if (!accountId) {
                setAccountId(buckets.find(([k]) => k !== UNLINKED && byId.has(k))?.[0] ?? usable[0]?.id ?? "");
              }
            }}
            options={[
              { value: "earmark", title: "Set aside", hint: "Money already in an account — nothing moves" },
              { value: "transfer", title: "Move money", hint: "Transfer into a savings account" },
            ]}
          />
        ) : (
          !unlinked && (
            <Choice
              label="How is this money withdrawn"
              value={mode}
              onChange={setMode}
              options={[
                { value: "earmark", title: "Release", hint: "Stays in the account, just no longer set aside" },
                { value: "transfer", title: "Move to account", hint: "Transfer out to another account" },
              ]}
            />
          )
        )}

        <label className="flex flex-col gap-1">
          <Label>Amount</Label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-label="Amount"
              data-testid="savings-amount"
              className={cn(FIELD, "border border-primary/20 bg-primary/5 pl-7 font-mono font-semibold")}
              placeholder="0.00"
              value={amountText}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d*\.?\d{0,2}$/.test(v)) setAmountText(v);
              }}
              autoFocus
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(isIn ? [view.remaining] : [heldHere || 0]).filter((n) => n > 0).map((n) => (
              <button key={n} type="button" className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setAmountText(String(round2(n)))}>
                {isIn ? `Remaining ${formatCurrency(n)}` : `All ${formatCurrency(n)}`}
              </button>
            ))}
          </div>
        </label>

        {isIn && effectiveMode === "earmark" && (
          <div className="flex flex-col gap-1">
            <Label>Money is in</Label>
            <AccountSelect accounts={usable.map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={accountId} onChange={setAccountId} showBalance ariaLabel="Account the money is in" />
            {account && <p className="text-[11px] text-muted-foreground">Free to set aside: {formatCurrency(accountFree)} of {formatCurrency(account.currentBalance)}</p>}
          </div>
        )}

        {isIn && effectiveMode === "transfer" && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Label>From</Label>
              <AccountSelect accounts={usable.filter((a) => a.id !== accountId).map((a) => ({ ...a, currentBalance: freeInAccount(a, reservedByAccount.get(a.id) ?? 0) }))} value={counterId} onChange={setCounterId} showBalance ariaLabel="Move from account" />
            </div>
            <ArrowRight className="mb-2.5 size-4 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Into savings account</Label>
              <AccountSelect accounts={usable.filter((a) => a.id !== counterId)} value={accountId} onChange={setAccountId} ariaLabel="Savings account" />
            </div>
          </div>
        )}

        {!isIn && (
          <div className="flex flex-col gap-1">
            <Label>Take from</Label>
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
                    className={cn("inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs", on ? "border-primary bg-primary/12" : "border-border/60 bg-muted/20 hover:border-border")}
                  >
                    {key === UNLINKED ? <span>Opening balance</span> : acc ? <AccountLabel account={acc} size={14} showKind={false} /> : <span>Removed account</span>}
                    <span className="font-mono text-muted-foreground">{formatCurrency(amt)}</span>
                  </button>
                );
              })}
            </div>
            {unlinked && <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Lock className="size-3" /> This starting amount isn&apos;t tied to an account, so it can only be released.</p>}
          </div>
        )}

        {!isIn && effectiveMode === "transfer" && (
          <div className="flex flex-col gap-1">
            <Label>Send to</Label>
            <AccountSelect accounts={usable.filter((a) => a.id !== accountId)} value={counterId} onChange={setCounterId} ariaLabel="Send to account" />
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <Label>Date</Label>
            <DateInput className={FIELD} value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <Label>Note (optional)</Label>
            <input type="text" className={FIELD} maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Diwali bonus" />
          </label>
        </div>

        {preview && !problem && (
          <div className="flex items-start gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="savings-preview">
            {effectiveMode === "earmark" ? <PiggyBank className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
            <span>{preview}</span>
          </div>
        )}
        {(problem || error) && (
          <p role="alert" data-testid="savings-error" className="rounded-xl bg-expense/10 px-3 py-2 text-xs font-medium text-expense">
            {problem ?? error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}

export function MoneyEntryDialog(props: Parameters<typeof MoneyEntryInner>[0]) {
  return props.open && props.view ? <MoneyEntryInner key={`${props.view.goal.id}:${props.direction}`} {...props} /> : null;
}
