"use client";

import {
  Building2,
  CalendarClock,
  Check,
  CreditCard,
  FileText,
  HandCoins,
  Landmark,
  Percent,
  ShoppingBag,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EMI_TYPE_LABEL } from "@/features/emi/components/emi-card";
import { useEmiActions } from "@/features/emi/hooks/use-emi-data";
import {
  AmountInput,
  ChoiceChips,
  Field,
  FieldGroup,
  FormSection,
  LE_RADIUS,
  LOAN_EMI_INPUT,
  LoanEmiFormDialog,
  Money,
  MoreOptions,
  Reveal,
  SegmentedControl,
  choiceClass,
} from "@/features/loans/components/loan-emi-ui";
import { AddElsewhereLink, PersonPickerField } from "@/features/loans/components/loans-workspace";
import { LoanAllocationField } from "@/features/loans/components/loan-allocation-field";
import { useLoanActions } from "@/features/loans/hooks/use-loans-data";
import {
  addSections,
  buildLoanEmiCreateRequest,
  emptyLoanEmiAddForm,
  loanEmiAddError,
  previewInstallment,
  type AddKind,
  type CardEmiKind,
  type LoanEmiAddForm,
} from "@/features/loans/lib/loan-emi-add";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { useAccounts } from "@/hooks/use-accounts";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLoanPersons } from "@/hooks/use-loans";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { EmiLoanType } from "@/lib/models/emi";
import type { LoanCategory } from "@/lib/models/loan";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import { useOperation } from "@/components/feedback/operation-progress";
import { SUCCESS_HOLD_MS, errorDetail } from "@/lib/operation-progress/operation-progress";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { DateInput } from "@/components/forms/date-input";

const KIND_OPTIONS: { value: AddKind; label: string; fullLabel: string; hint: string; icon: LucideIcon }[] = [
  { value: "borrowed", label: "Loan I Took", fullLabel: "Loan I Took — I need to pay it back", hint: "I received money and need to pay it back", icon: Landmark },
  { value: "purchase", label: "Purchase", fullLabel: "Purchase / Finance", hint: "On installments", icon: ShoppingBag },
  { value: "creditCard", label: "Credit Card", fullLabel: "Credit Card", hint: "Card EMI or loan", icon: CreditCard },
  { value: "lent", label: "Loan I Gave", fullLabel: "Loan I Gave — they need to pay me back", hint: "I gave money and need to get it back", icon: HandCoins },
];

const INSTALLMENT_PRESETS = [3, 6, 12, 24];
const PURCHASE_TYPES: EmiLoanType[] = ["other", "vehicle", "home", "personal", "education", "gold", "business"];

/** "What is this?" — four compact option buttons; selected = lime fill, dark icon tile and a check. */
function KindPicker({ value, onChange }: { value: AddKind | null; onChange: (kind: AddKind) => void }) {
  return (
    <div role="radiogroup" aria-label="What is this?" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {KIND_OPTIONS.map(({ value: v, label, hint, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className={cn(
              LE_RADIUS.control,
              "group relative flex min-w-0 items-center gap-2.5 border px-2.5 py-2 text-left outline-none",
              "transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
              active ? choiceClass(true) : cn(choiceClass(false), "motion-safe:hover:-translate-y-px hover:shadow-e1"),
            )}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-[6px] border transition-colors duration-150",
                active ? "border-primary-foreground bg-primary-foreground text-primary" : "border-border bg-secondary text-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-tight font-semibold">{label}</span>
              <span className={cn("truncate text-[11px] leading-tight font-medium", active ? "text-primary-foreground" : "text-muted-foreground")}>{hint}</span>
            </span>
            {active && <Check aria-hidden className="absolute top-1 right-1 size-3.5" strokeWidth={2.5} />}
          </button>
        );
      })}
    </div>
  );
}

export interface LoanEmiAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects "What is this?" (e.g. a `?create=` handoff). */
  initialKind?: AddKind | null;
}

/**
 * The one Add flow for Loan & EMI. "What is this?" decides which sections appear; saving hands the
 * answers to the existing Loan or EMI create operation — see `features/loans/lib/loan-emi-add.ts`.
 * Mount with a fresh `key` per open so every Add starts clean (and gets a new idempotency key).
 */
export function LoanEmiAddDialog({ open, onOpenChange, initialKind = null }: LoanEmiAddDialogProps) {
  const loanActions = useLoanActions();
  const emiActions = useEmiActions();
  const { data: accounts = [] } = useAccounts();
  const { data: people = [] } = useLoanPersons();
  const { data: cards = [] } = useCreditCards();
  const [form, setForm] = useState<LoanEmiAddForm>(() => emptyLoanEmiAddForm(initialKind, crypto.randomUUID()));
  const [saving, setSaving] = useState(false);
  const operation = useOperation();
  // Synchronous double-submit guard — a second fast click can land before `saving` re-renders the button.
  const inFlight = useRef(false);
  const set = (patch: Partial<LoanEmiAddForm>) => setForm((f) => ({ ...f, ...patch }));

  const cardOptions = useMemo(
    () =>
      (cards as CreditCardProfile[])
        .filter((c) => c.status !== "closed" && c.status !== "cancelled")
        .map((c) => {
          const accountName = accounts.find((a) => a.id === c.accountId)?.name ?? "Credit Card";
          return { id: c.id, label: c.lastFourDigits ? `${accountName} ••${c.lastFourDigits}` : accountName };
        }),
    [cards, accounts],
  );
  const movementAccounts = accounts.filter((a) => a.type !== "card" && a.deletedAt == null);

  const s = addSections(form);
  const kind = form.kind;
  const isEmi = kind === "purchase" || kind === "creditCard";
  const cardLoan = kind === "creditCard" && form.cardEmiKind === "creditCardLoan";
  const preview = previewInstallment(form);
  const kindMeta = KIND_OPTIONS.find((k) => k.value === kind);

  async function handleSave() {
    if (inFlight.current) return;
    const error = loanEmiAddError(form);
    if (error) {
      toast.error(error);
      return;
    }
    const request = buildLoanEmiCreateRequest(form);
    const isLoan = request.path === "loan";
    inFlight.current = true;
    setSaving(true);
    const op = operation.start({
      label: isLoan ? "Creating loan" : "Creating EMI",
      successLabel: isLoan ? "Loan added" : "EMI added",
      errorLabel: isLoan ? "Couldn't create loan" : "Couldn't create EMI",
      detail: "Checking details",
    });
    try {
      // One call writes the record and its installment schedule together (plus any account movement).
      op.stage("submit", isLoan ? "Saving loan & installment schedule" : "Saving EMI & installment schedule");
      if (isLoan) {
        if (!loanActions) throw new Error("Not signed in");
        await loanActions.createLoan(request.params);
      } else {
        if (!emiActions) throw new Error("Not signed in");
        await emiActions.createEmi(request.params);
      }
      op.succeed({ toast: { title: isLoan ? "Loan added successfully" : "Installment plan added successfully" } });
      window.setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
    } catch (e) {
      // The form stays open with everything entered (and the same idempotency key for account-linked loans).
      op.fail({ detail: isLoan ? friendlyLoanError(e) : errorDetail(e), retry: handleSave });
      inFlight.current = false;
    } finally {
      setSaving(false);
    }
  }

  const amountField = (
    <Field label={isEmi ? "Amount financed" : kind === "lent" ? "Amount I gave" : "Amount I received"}>
      <AmountInput value={form.amount} onChange={(amount) => set({ amount })} />
    </Field>
  );

  return (
    <LoanEmiFormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={kindMeta?.icon ?? Wallet}
      title="Add to Loan & EMI"
      description={kindMeta ? kindMeta.fullLabel : "Choose what this is — only the fields you need will appear."}
      onConfirm={handleSave}
      confirmLabel={saving ? (isEmi ? "Saving EMI…" : "Saving loan…") : "Save"}
      loading={saving}
      success={operation.snapshot?.status === "success"}
      operation={operation.snapshot}
    >
      <FormSection title="What is this?">
        <KindPicker value={kind} onChange={(k) => set({ kind: k })} />
      </FormSection>

      {s.details && (
        // Keyed by kind so switching type re-plays the short reveal instead of swapping fields abruptly.
        <Reveal key={`basics-${kind}`}>
          <FormSection title="Basics" icon={FileText}>
            {kind === "borrowed" && (
              <FieldGroup label="Loan taken from">
                <SegmentedControl<LoanCategory>
                  ariaLabel="Loan taken from"
                  size="sm"
                  options={[
                    { value: "institutional", label: "Bank / Lender", icon: Building2 },
                    { value: "personal", label: "Person", icon: UserRound },
                  ]}
                  value={form.borrowedFrom}
                  onChange={(v) => set({ borrowedFrom: v })}
                />
              </FieldGroup>
            )}

            {s.card && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <CreditCard className="size-3.5" />
                      Credit card
                    </span>
                    <AddElsewhereLink href="/credit-cards" label={cardOptions.length === 0 ? "Go to Credit Cards" : "Add card"} />
                  </div>
                  {cardOptions.length === 0 ? (
                    <p className="flex h-10 items-center rounded-[6px] border border-dashed border-border bg-secondary px-3 text-xs text-muted-foreground">
                      No credit cards yet — add one in Credit Cards.
                    </p>
                  ) : (
                    <select className={LOAN_EMI_INPUT} value={form.cardId} onChange={(e) => set({ cardId: e.target.value })}>
                      <option value="">Select a card</option>
                      {cardOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <FieldGroup label="On this card">
                  <SegmentedControl<CardEmiKind>
                    ariaLabel="Card EMI kind"
                    size="sm"
                    fullWidth
                    options={[
                      { value: "productPurchase", label: "Purchase" },
                      { value: "creditCardLoan", label: "Card loan" },
                    ]}
                    value={form.cardEmiKind}
                    onChange={(v) => set({ cardEmiKind: v })}
                  />
                </FieldGroup>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {s.bankLender && (
                <Field label="Bank / lender">
                  <input className={LOAN_EMI_INPUT} placeholder="e.g. HDFC Bank" value={form.lenderName} onChange={(e) => set({ lenderName: e.target.value })} />
                </Field>
              )}
              {s.person && (
                <PersonPickerField
                  label={kind === "lent" ? "Loan given to" : "Loan taken from"}
                  people={people}
                  value={form.personId}
                  disabled={false}
                  onChange={(personId) => set({ personId })}
                  onCreatePerson={loanActions?.createPerson}
                />
              )}
              {(s.purchase || s.card) && (
                <Field label={cardLoan ? "Name" : "What did you buy?"} className={cn(s.card && "sm:col-span-2")}>
                  <input
                    className={LOAN_EMI_INPUT}
                    placeholder={cardLoan ? "e.g. Card loan – HDFC" : "e.g. iPhone 16"}
                    value={form.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </Field>
              )}
              {s.purchase && (
                <Field label="Store / provider">
                  <input className={LOAN_EMI_INPUT} placeholder="Optional" value={form.provider} onChange={(e) => set({ provider: e.target.value })} />
                </Field>
              )}
              {amountField}
              {!isEmi && (
                <Field label={kind === "lent" ? "Loan given on" : "Loan taken on"}>
                  <DateInput className={LOAN_EMI_INPUT} value={form.date} onChange={(e) => set({ date: e.target.value })} />
                </Field>
              )}
            </div>
          </FormSection>
        </Reveal>
      )}

      {s.repayment && (
        <Reveal key={`repayment-${kind}`}>
          <FormSection
            title="Repayment"
            icon={CalendarClock}
            aside={
              preview && (
                <span className="flex items-baseline gap-1 text-xs text-muted-foreground">
                  ≈ <Money amount={preview.perInstallment} className="text-sm text-foreground" /> / {form.frequency === "weekly" ? "week" : "month"}
                  {preview.interest > 0 && (
                    <>
                      <span aria-hidden>·</span> + <Money amount={preview.interest} className="text-xs text-foreground" /> interest
                    </>
                  )}
                </span>
              )
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldGroup label="Number of installments">
                <div className="flex flex-wrap items-center gap-1.5">
                  {INSTALLMENT_PRESETS.map((n) => {
                    const active = form.count === String(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={active}
                        onClick={() => set({ count: String(n) })}
                        className={cn(
                          LE_RADIUS.input,
                          "h-10 min-w-10 border px-2.5 text-sm tabular-nums transition-[background-color,border-color,color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          choiceClass(active),
                        )}
                      >
                        {n}
                      </button>
                    );
                  })}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    aria-label="Custom number of installments"
                    placeholder="Other"
                    className={cn(LOAN_EMI_INPUT, "w-20 text-center")}
                    value={INSTALLMENT_PRESETS.includes(Number(form.count)) ? "" : form.count}
                    onChange={(e) => set({ count: e.target.value })}
                  />
                </div>
              </FieldGroup>
              <FieldGroup label="Frequency">
                <SegmentedControl<ScheduleType>
                  ariaLabel="Frequency"
                  size="sm"
                  className="sm:w-full"
                  options={[
                    { value: "monthly", label: "Monthly" },
                    { value: "weekly", label: "Weekly" },
                  ]}
                  value={form.frequency}
                  onChange={(v) => set({ frequency: v })}
                />
              </FieldGroup>
              {s.firstPaymentDate && (
                <Field label="First EMI Date">
                  <DateInput className={LOAN_EMI_INPUT} value={form.firstEmiDate} onChange={(e) => set({ firstEmiDate: e.target.value })} />
                </Field>
              )}
              <FieldGroup label="Interest">
                <SegmentedControl<"none" | "yes">
                  ariaLabel="Interest"
                  size="sm"
                  className="sm:w-full"
                  options={[
                    { value: "none", label: "No interest" },
                    { value: "yes", label: "Has interest", icon: Percent },
                  ]}
                  value={form.hasInterest ? "yes" : "none"}
                  onChange={(v) => set({ hasInterest: v === "yes" })}
                />
              </FieldGroup>
            </div>
            {form.hasInterest && (
              <Reveal className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Interest rate (% per year)">
                  <input
                    type="number"
                    inputMode="decimal"
                    className={LOAN_EMI_INPUT}
                    placeholder="e.g. 10.5"
                    value={form.ratePercent}
                    onChange={(e) => set({ ratePercent: e.target.value })}
                  />
                </Field>
                <FieldGroup label="Interest type" hint="Most bank loans use reducing balance.">
                  <SegmentedControl<InterestType>
                    ariaLabel="Interest type"
                    size="sm"
                    className="sm:w-full"
                    options={[
                      { value: "reducingBalance", label: "Reducing" },
                      { value: "flat", label: "Flat" },
                    ]}
                    value={form.interestType}
                    onChange={(v) => set({ interestType: v })}
                  />
                </FieldGroup>
              </Reveal>
            )}
          </FormSection>
        </Reveal>
      )}

      {s.account && (
        <Reveal key={`account-${kind}`}>
          <FormSection title={kind === "lent" ? "Where did the money come from?" : "Where did the money go?"} icon={Wallet}>
            <SegmentedControl<"none" | "account">
              ariaLabel="Account"
              size="sm"
              options={[
                { value: "none", label: kind === "lent" ? "Not from an account" : "Not added to an account" },
                { value: "account", label: "FlowFi account", icon: Wallet },
              ]}
              value={form.useAccount ? "account" : "none"}
              onChange={(v) => set({ useAccount: v === "account" })}
            />
            {form.useAccount && (
              <Reveal className="flex max-w-md flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">{kind === "lent" ? "Paid from" : "Received into"}</span>
                  <AddElsewhereLink href="/accounts" label="Add account" />
                </div>
                {movementAccounts.length === 0 ? (
                  <p className="flex h-10 items-center rounded-[6px] border border-dashed border-border bg-secondary px-3 text-xs text-muted-foreground">
                    No accounts yet — add one in Accounts.
                  </p>
                ) : (
                  <select className={LOAN_EMI_INPUT} value={form.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                    <option value="">Choose account</option>
                    {movementAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-[11px] text-muted-foreground">Updates the account balance. It isn&apos;t counted as {kind === "lent" ? "spending" : "income"}.</p>
              </Reveal>
            )}
          </FormSection>
        </Reveal>
      )}

      {s.whoFor && (
        <Reveal key={`who-${kind}`}>
          <FormSection title="Who is this for?" icon={Users}>
            <LoanAllocationField form={form} people={people} onChange={set} />
          </FormSection>
        </Reveal>
      )}

      {kind != null && (
        <MoreOptions
          key={`more-${kind}`}
          summary={
            kind === "borrowed"
              ? s.bankReferences
                ? "Name, who pays, loan references, notes"
                : "Name, who pays, notes"
              : kind === "purchase"
                ? "Type, notes"
                : kind === "lent"
                  ? "Name, notes"
                  : "Notes"
          }
        >
          {(kind === "borrowed" || kind === "lent" || s.payer) && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(kind === "borrowed" || kind === "lent") && (
                <Field label="Name" hint="Defaults to the lender or person.">
                  <input className={LOAN_EMI_INPUT} placeholder="e.g. Home Loan" value={form.name} onChange={(e) => set({ name: e.target.value })} />
                </Field>
              )}
              {s.payer && (
                <Field label="Who pays the installments?" hint="Only if someone else pays it for you.">
                  <select className={LOAN_EMI_INPUT} value={form.payerPersonId} onChange={(e) => set({ payerPersonId: e.target.value })}>
                    <option value="">I pay it myself</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
          {s.bankReferences && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Type of loan">
                <input className={LOAN_EMI_INPUT} placeholder="e.g. Personal, Vehicle" value={form.loanType} onChange={(e) => set({ loanType: e.target.value })} />
              </Field>
              <Field label="Loan account number">
                <input className={LOAN_EMI_INPUT} value={form.loanNumber} onChange={(e) => set({ loanNumber: e.target.value })} />
              </Field>
              <Field label="Bank account number">
                <input className={LOAN_EMI_INPUT} value={form.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} />
              </Field>
              <Field label="Branch">
                <input className={LOAN_EMI_INPUT} value={form.branch} onChange={(e) => set({ branch: e.target.value })} />
              </Field>
            </div>
          )}
          {s.purchase && (
            <FieldGroup label="Type">
              <ChoiceChips
                ariaLabel="Purchase type"
                options={PURCHASE_TYPES.map((t) => ({ value: t, label: t === "other" ? "Purchase" : EMI_TYPE_LABEL[t] }))}
                value={form.emiType}
                onChange={(emiType) => set({ emiType })}
              />
            </FieldGroup>
          )}
          <Field label="Notes">
            <textarea
              className={cn(LOAN_EMI_INPUT, "h-auto min-h-16 resize-none py-2")}
              placeholder="Optional notes"
              rows={2}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </Field>
        </MoreOptions>
      )}
    </LoanEmiFormDialog>
  );
}
