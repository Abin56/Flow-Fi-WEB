"use client";

import { Plus, User, UserPlus, Users, X } from "lucide-react";
import { useState } from "react";
import { SegmentedControl, LOAN_EMI_INPUT } from "@/features/loans/components/loan-emi-ui";
import { allocationOf, installmentSharesOf, totalInstallmentOf, usesCustomEmis, type AddOwnership, type AllocationFormRow, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";
import { fromPaise, splitPaise, toPaise, type AllocationMode, type OwnershipShare } from "@/lib/engines/debt-ownership";
import { formatCurrencyExact } from "@/lib/format";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";

/**
 * "Who is this loan for?" on the Add form. Just me / For someone else (one person, the existing
 * association + optional "they repay me") / Shared (ONE loan, principal allocated between me and/or
 * several people). The allocation must reconcile exactly to the loan amount — the form's save is blocked
 * by `loanEmiAddError` until it does. Every number here comes from `allocationOf` (the engine).
 */

const CHOICES: { value: AddOwnership; label: string; icon: typeof User }[] = [
  { value: "me", label: "Just me", icon: User },
  { value: "someoneElse", label: "For someone else", icon: UserPlus },
  { value: "shared", label: "Shared", icon: Users },
];

const MODES: { value: AllocationMode; label: string }[] = [
  { value: "equal", label: "Equal" },
  { value: "custom", label: "Custom amount" },
  { value: "percentage", label: "Percentage" },
];

type EmiSplit = "auto" | "manual";

const EMI_SPLITS: { value: EmiSplit; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
];

type Patch = Partial<Pick<LoanEmiAddForm, "ownership" | "beneficiaryPersonId" | "beneficiaryRepays" | "allocationMode" | "allocationRows">>;

export function LoanAllocationField({
  form,
  people,
  onChange,
  allowShared = true,
  savedShares,
}: {
  form: LoanEmiAddForm;
  people: Person[];
  onChange: (patch: Patch) => void;
  /** Off when editing a saved loan — a shared split is set at creation and isn't edited afterwards. */
  allowShared?: boolean;
  savedShares?: readonly OwnershipShare[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        ariaLabel="Who is this for?"
        options={allowShared ? CHOICES : CHOICES.map((choice) => ({
          ...choice,
          disabled: savedShares != null || choice.value === "shared",
        }))}
        value={savedShares ? "shared" : form.ownership}
        onChange={(v) => onChange({ ownership: v, ...(v !== "someoneElse" ? { beneficiaryPersonId: "", beneficiaryRepays: false } : {}) })}
      />
      {savedShares ? (
        <SavedAllocation shares={savedShares} people={people} />
      ) : (
        <>
          {form.ownership === "someoneElse" && <SinglePerson form={form} people={people} onChange={onChange} />}
          {form.ownership === "shared" && <AllocationTable form={form} people={people} onChange={onChange} />}
        </>
      )}
    </div>
  );
}

function SavedAllocation({ shares, people }: { shares: readonly OwnershipShare[]; people: Person[] }) {
  const showEmi = shares.some((share) => share.installmentAmount != null);
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-[6px] border border-border-strong bg-card">
        <table aria-label="Saved loan shares" className="w-full text-sm">
          <thead className="border-b border-border-strong bg-secondary text-left text-xs">
            <tr>
              <th scope="col" className="px-3 py-2">Person</th>
              <th scope="col" className="px-3 py-2 text-right">Principal share</th>
              {showEmi && <th scope="col" className="px-3 py-2 text-right">Configured EMI</th>}
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => (
              <tr key={share.personId ?? "me"} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {share.personId === null ? "Me" : people.find((person) => person.id === share.personId)?.name ?? "Person unavailable"}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyExact(share.amount)}</td>
                {showEmi && (
                  <td className="px-3 py-2 text-right tabular-nums">
                    {share.installmentAmount == null ? "—" : formatCurrencyExact(share.installmentAmount)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Shared allocations are locked after the loan is created.</p>
    </div>
  );
}

function SinglePerson({ form, people, onChange }: { form: LoanEmiAddForm; people: Person[]; onChange: (patch: Patch) => void }) {
  const name = people.find((p) => p.id === form.beneficiaryPersonId)?.name ?? "They";
  return (
    <>
      <label className="flex max-w-md flex-col gap-1.5">
        <span className="text-xs font-semibold text-foreground">Person</span>
        <select className={LOAN_EMI_INPUT} value={form.beneficiaryPersonId} onChange={(e) => onChange({ beneficiaryPersonId: e.target.value })}>
          <option value="" disabled>
            Choose a person
          </option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {form.beneficiaryPersonId !== "" && (
        // The explicit opt-in — without it the person is only "who this was for" and owes nothing.
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[6px] border border-border-strong bg-card px-3 py-2.5">
          <input
            type="checkbox"
            checked={form.beneficiaryRepays}
            onChange={(e) => onChange({ beneficiaryRepays: e.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary-accent-text)]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{name} repay me each installment</span>
            <span className="block text-xs text-foreground/80">Each installment is added to their People Ledger on its due date — never the full amount at once.</span>
          </span>
        </label>
      )}
      {form.beneficiaryPersonId !== "" && !form.beneficiaryRepays && (
        <p className="text-xs text-foreground/80">It stays your own debt — the person is linked so you know who it was for.</p>
      )}
    </>
  );
}

function AllocationTable({ form, people, onChange }: { form: LoanEmiAddForm; people: Person[]; onChange: (patch: Patch) => void }) {
  const result = allocationOf(form);
  const rows = form.allocationRows;
  const [balanceRows, setBalanceRows] = useState(() => ({
    value: Math.max(0, rows.findIndex((row) => row.value === "")),
    emi: Math.max(0, rows.findIndex((row) => !row.emi)),
  }));
  const hasMe = rows.some((r) => r.personId === null);
  const used = new Set(rows.map((r) => r.personId).filter((id): id is string => !!id));
  const setRow = (i: number, patch: Partial<AllocationFormRow>) => onChange({ allocationRows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const removeRow = (i: number) => {
    const remaining = rows.filter((_, j) => j !== i);
    const nextIndex = (index: number) => index === i ? Math.min(i, remaining.length - 1) : index - Number(i < index);
    const next = { value: nextIndex(balanceRows.value), emi: nextIndex(balanceRows.emi) };
    setBalanceRows(next);
    onChange({ allocationRows: remaining.map((r, j) => ({
      ...r,
      ...(j === next.value && balanceRows.value === i ? { value: "" } : {}),
      ...(j === next.emi && balanceRows.emi === i ? { emi: "" } : {}),
    })) });
  };
  const principal = Number(form.amount) > 0 ? Number(form.amount) : 0;
  const balanced = result.error == null && principal > 0;
  const custom = form.allocationMode === "custom";
  const customEmis = usesCustomEmis(form);
  const [emiSplit, setEmiSplit] = useState<EmiSplit>(() => (customEmis ? "manual" : "auto"));
  const manualEmi = custom && emiSplit === "manual";
  const perUnit = form.frequency === "weekly" ? "wk" : "mo";
  const totalInstallment = totalInstallmentOf(form);
  const installmentShares = installmentSharesOf(form, result.shares);
  const emiValues = customEmis ? result.shares.map((share) => share.installmentAmount ?? 0) : installmentShares;
  const allocatedEmi = emiValues.reduce((sum, emi) => sum + toPaise(emi), 0);
  const emiRemaining = fromPaise(toPaise(totalInstallment) - allocatedEmi);
  const shareValues = form.allocationMode === "percentage" ? percentageValues(rows) : result.shares.map((share) => share.amount);

  function changeBalance(field: "value" | "emi", index: number) {
    const previousIndex = balanceRows[field];
    const previousValue = (field === "value" ? shareValues : emiValues)[previousIndex];
    setBalanceRows((current) => ({ ...current, [field]: index }));
    onChange({ allocationRows: rows.map((row, i) => {
      if (i === index) return { ...row, [field]: "" };
      if (i === previousIndex && previousValue > 0) return { ...row, [field]: String(previousValue) };
      return row;
    }) });
  }

  const balancePicker = (field: "value" | "emi", label: string) => (
    <label className="flex flex-wrap items-center gap-2 text-xs font-semibold">
      {label}
      <select className={cn(LOAN_EMI_INPUT, "h-8 w-auto")} value={balanceRows[field]} onChange={(e) => changeBalance(field, Number(e.target.value))}>
        {rows.map((row, i) => (
          <option key={i} value={i}>
            {row.personId === null ? "Me" : people.find((person) => person.id === row.personId)?.name ?? `Person ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  const changeEmiSplit = (v: EmiSplit) => {
    if (v === emiSplit) return;
    setEmiSplit(v);
    if (v === "auto") onChange({ allocationRows: rows.map((r) => ({ ...r, emi: "" })) });
  };
  const cols = "min-w-[31rem] grid-cols-[minmax(8rem,1fr)_7rem_6.5rem_7rem_2rem]";

  return (
    <div className="flex flex-col gap-2.5">
      <SegmentedControl ariaLabel="How to split" size="sm" options={MODES} value={form.allocationMode} onChange={(v) => {
          if (v === form.allocationMode) return;
          setEmiSplit("auto");
          onChange({ allocationMode: v, allocationRows: rows.map((r) => ({ ...r, value: "", emi: "" })) });
        }}
      />

      {form.allocationMode !== "equal" && (
        <div className="flex flex-wrap items-center gap-2.5">
          {balancePicker("value", "Balance remaining share on")}
          <span className="text-xs text-muted-foreground">Blank shares split the remainder evenly.</span>
        </div>
      )}

      {custom && (
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-xs font-semibold text-foreground">EMI split</span>
          <SegmentedControl ariaLabel="EMI split" size="sm" options={EMI_SPLITS} value={emiSplit} onChange={changeEmiSplit} />
          <span className="text-xs text-foreground/80">
            {emiSplit === "auto" ? "Each person's EMI follows their share." : "Enter specific EMIs. Blank rows share the remainder based on their loan shares."}
          </span>
        </div>
      )}

      {manualEmi && balancePicker("emi", "Balance remaining EMI on")}

      <div className="overflow-x-auto rounded-[6px] border border-border-strong bg-card">
        <div className={cn("grid items-center gap-0 border-b border-border-strong bg-secondary px-0 text-[11px] font-bold tracking-wide text-foreground uppercase", cols)}>
          <span className="px-3 py-1.5">Person</span>
          <span className="border-l border-border px-3 py-1.5">
            {form.allocationMode === "percentage" ? "Share %" : custom ? "Share ₹" : "Split"}
          </span>
          <span className="border-l border-border px-3 py-1.5 text-right">Amount</span>
          <span className={cn("border-l border-border px-3 py-1.5", !manualEmi && "text-right")}>EMI ₹ / {perUnit}</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className={cn("grid items-center border-b border-border last:border-b-0", cols)}>
            <div className="px-2 py-1.5">
              {r.personId === null ? (
                <span className="flex h-9 items-center px-1 text-sm font-semibold text-foreground">Me</span>
              ) : (
                <select
                  aria-label={`Person ${i + 1}`}
                  className={cn(LOAN_EMI_INPUT, "h-9")}
                  value={r.personId}
                  onChange={(e) => setRow(i, { personId: e.target.value })}
                >
                  <option value="" disabled>
                    Choose a person
                  </option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id} disabled={used.has(p.id) && p.id !== r.personId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="border-l border-border px-2 py-1.5">
              {form.allocationMode === "equal" ? (
                <span className="flex h-9 items-center px-1 text-sm text-foreground/85">Equal</span>
              ) : (
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  aria-label={`${r.personId === null ? "My" : "Person " + (i + 1)} share`}
                  readOnly={i === balanceRows.value}
                  placeholder={shareValues[i] > 0 ? String(shareValues[i]) : "Auto"}
                  value={i === balanceRows.value ? String(shareValues[i] ?? 0) : r.value}
                  onChange={(e) => {
                    if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) setRow(i, { value: e.target.value });
                  }}
                  className={cn(LOAN_EMI_INPUT, "h-9 tabular-nums read-only:bg-secondary")}
                />
              )}
            </div>
            <span className="border-l border-border px-3 py-1.5 text-right text-sm font-semibold text-foreground tabular-nums">{formatCurrencyExact(result.shares[i]?.amount ?? 0)}</span>
            {manualEmi ? (
              // Their own EMI, independent of the share. A blank box takes what's left (the placeholder).
              <div className="border-l border-border px-2 py-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  aria-label={`${r.personId === null ? "My" : "Person " + (i + 1)} EMI`}
                  readOnly={i === balanceRows.emi}
                  placeholder={emiValues[i] > 0 ? String(emiValues[i]) : "Auto"}
                  value={i === balanceRows.emi ? String(emiValues[i] ?? 0) : r.emi ?? ""}
                  onChange={(e) => {
                    if (/^\d*(?:\.\d{0,2})?$/.test(e.target.value)) setRow(i, { emi: e.target.value });
                  }}
                  className={cn(LOAN_EMI_INPUT, "h-9 tabular-nums read-only:bg-secondary")}
                />
              </div>
            ) : (
              <span className="border-l border-border px-3 py-1.5 text-right text-sm font-medium text-foreground/85 tabular-nums">
                {installmentShares[i] ? formatCurrencyExact(installmentShares[i]) : "—"}
              </span>
            )}
            <button
              type="button"
              aria-label="Remove row"
              disabled={rows.length <= 1}
              onClick={() => removeRow(i)}
              className="flex size-8 items-center justify-center text-foreground/80 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange({ allocationRows: [...rows, { personId: "", value: "", emi: "" }] })}
          disabled={people.length === 0 || used.size >= people.length}
          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add person
        </button>
        {!hasMe && (
          <button
            type="button"
            onClick={() => {
              setBalanceRows((current) => ({ value: current.value + 1, emi: current.emi + 1 }));
              onChange({ allocationRows: [{ personId: null, value: "", emi: "" }, ...rows] });
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
            Include me
          </button>
        )}
      </div>

      <dl className={cn("max-w-sm rounded-[6px] border px-3 py-1 text-[13px]", balanced ? "border-border-strong" : "border-expense/70")}>
        <Line label="Loan amount" amount={principal} />
        <Line label="Allocated" amount={result.allocated} />
        <Line label={result.remaining < 0 ? "Over allocated" : "Remaining to allocate"} amount={Math.abs(result.remaining)} tone={result.remaining !== 0 ? "expense" : undefined} strong />
        {manualEmi && (
          <>
            <Line label={`Loan EMI / ${perUnit === "wk" ? "week" : "month"}`} amount={totalInstallment} />
            <Line label="EMIs allocated" amount={fromPaise(allocatedEmi)} />
            <Line
              label={emiRemaining < 0 ? "EMI over by" : "EMI remaining"}
              amount={Math.abs(emiRemaining)}
              tone={emiRemaining !== 0 ? "expense" : undefined}
              strong
            />
          </>
        )}
      </dl>
      {result.error && principal > 0 && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {result.error}
        </p>
      )}
      <p className="text-xs text-foreground/80">
        Still ONE loan with one lender schedule. Each person&apos;s share of every installment goes to their People Ledger; paying the lender never marks them paid, and their payments never pay the lender.
      </p>
    </div>
  );
}

// Display percentages before they are apportioned into rupees.
function percentageValues(rows: readonly AllocationFormRow[]): number[] {
  const entered = rows.map((row) => toPaise(Number(row.value)));
  const remaining = 10000 - entered.reduce((sum, percent) => sum + percent, 0);
  const automatic = splitPaise(Math.max(0, remaining), rows.filter((row) => row.value === "").map(() => 1));
  let next = 0;
  return rows.map((row, i) => fromPaise(row.value === "" ? automatic[next++] : entered[i]));
}

function Line({ label, amount, tone, strong }: { label: string; amount: number; tone?: "expense"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-1 last:border-b-0">
      <dt className={cn("text-foreground", strong && "font-semibold")}>{label}</dt>
      <dd className={cn("font-semibold tabular-nums", tone === "expense" ? "text-expense" : "text-foreground")}>{formatCurrencyExact(amount)}</dd>
    </div>
  );
}
