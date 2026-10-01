"use client";

import { Plus, User, UserPlus, Users, X } from "lucide-react";
import { SegmentedControl, LOAN_EMI_INPUT } from "@/features/loans/components/loan-emi-ui";
import { allocationOf, type AddOwnership, type AllocationFormRow, type LoanEmiAddForm } from "@/features/loans/lib/loan-emi-add";
import type { AllocationMode } from "@/lib/engines/debt-ownership";
import { formatCurrency } from "@/lib/format";
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

type Patch = Partial<Pick<LoanEmiAddForm, "ownership" | "beneficiaryPersonId" | "beneficiaryRepays" | "allocationMode" | "allocationRows">>;

export function LoanAllocationField({ form, people, onChange }: { form: LoanEmiAddForm; people: Person[]; onChange: (patch: Patch) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        ariaLabel="Who is this for?"
        options={CHOICES}
        value={form.ownership}
        onChange={(v) => onChange({ ownership: v, ...(v !== "someoneElse" ? { beneficiaryPersonId: "", beneficiaryRepays: false } : {}) })}
      />
      {form.ownership === "someoneElse" && (
        <SinglePerson form={form} people={people} onChange={onChange} />
      )}
      {form.ownership === "shared" && <AllocationTable form={form} people={people} onChange={onChange} />}
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
  const hasMe = rows.some((r) => r.personId === null);
  const used = new Set(rows.map((r) => r.personId).filter((id): id is string => !!id));
  const setRow = (i: number, patch: Partial<AllocationFormRow>) => onChange({ allocationRows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const removeRow = (i: number) => onChange({ allocationRows: rows.filter((_, j) => j !== i) });
  const principal = Number(form.amount) > 0 ? Number(form.amount) : 0;
  const balanced = result.remaining === 0 && principal > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <SegmentedControl ariaLabel="How to split" size="sm" options={MODES} value={form.allocationMode} onChange={(v) => onChange({ allocationMode: v, allocationRows: rows.map((r) => ({ ...r, value: "" })) })} />

      <div className="overflow-hidden rounded-[6px] border border-border-strong bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_8rem_7rem_2rem] items-center gap-0 border-b border-border-strong bg-secondary px-0 text-[11px] font-bold tracking-wide text-foreground uppercase">
          <span className="px-3 py-1.5">Person</span>
          <span className="border-l border-border px-3 py-1.5">{form.allocationMode === "percentage" ? "Share %" : form.allocationMode === "custom" ? "Share ₹" : "Split"}</span>
          <span className="border-l border-border px-3 py-1.5 text-right">Amount</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_8rem_7rem_2rem] items-center border-b border-border last:border-b-0">
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
                  step={form.allocationMode === "percentage" ? "0.01" : "1"}
                  aria-label={`${r.personId === null ? "My" : "Person " + (i + 1)} share`}
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  className={cn(LOAN_EMI_INPUT, "h-9 tabular-nums")}
                />
              )}
            </div>
            <span className="border-l border-border px-3 py-1.5 text-right text-sm font-semibold text-foreground tabular-nums">{formatCurrency(result.shares[i]?.amount ?? 0)}</span>
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
          onClick={() => onChange({ allocationRows: [...rows, { personId: "", value: "" }] })}
          disabled={people.length === 0 || used.size >= people.length}
          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add person
        </button>
        {!hasMe && (
          <button
            type="button"
            onClick={() => onChange({ allocationRows: [{ personId: null, value: "" }, ...rows] })}
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
        <Line label="Remaining to allocate" amount={result.remaining} tone={result.remaining !== 0 ? "expense" : undefined} strong />
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

function Line({ label, amount, tone, strong }: { label: string; amount: number; tone?: "expense"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-1 last:border-b-0">
      <dt className={cn("text-foreground", strong && "font-semibold")}>{label}</dt>
      <dd className={cn("font-semibold tabular-nums", tone === "expense" ? "text-expense" : "text-foreground")}>{formatCurrency(amount)}</dd>
    </div>
  );
}
