"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { FLAT_INPUT } from "@/components/finance";
import { PersonPickerField } from "@/features/loans/components/loans-workspace";
import { useLoanActions } from "@/features/loans/hooks/use-loans-data";
import {
  EMPTY_UNIFIED_CREATE_FORM,
  buildUnifiedCreateRequest,
  fundingLabel,
  movementChoiceLabel,
  unifiedCreateError,
  unifiedCreateFigures,
  type UnifiedCreateForm,
  type UnifiedCreateKind,
} from "@/features/agreements/lib/unified-create-request";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanPersons } from "@/hooks/use-loans";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useTransactions } from "@/hooks/use-transactions";
import type { LoanFundingSource } from "@/lib/models/loan";
import { generateId } from "@/lib/utils/id-generator";
import { toast } from "@/store/toast-store";

const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`;

export function UnifiedAgreementCreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const actions = useLoanActions();
  const { data: people = [] } = useLoanPersons();
  const { data: cards = [] } = useCreditCards();
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<UnifiedCreateForm>(EMPTY_UNIFIED_CREATE_FORM);
  // One idempotency key per wizard session: a retry after a failure or timeout reuses it, so the
  // repository can never create the agreement (or move the money) twice. Renewed only after success.
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateId());
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<UnifiedCreateForm>) => setForm((current) => ({ ...current, ...patch }));

  const { kind, funding } = form;
  const selectedCard = cards.find((card) => card.id === form.cardId);
  const eligiblePurchases = useMemo(
    () => (selectedCard == null ? [] : transactions.filter((item) => item.accountId === selectedCard.accountId && item.type === "expense" && item.deletedAt == null)),
    [selectedCard, transactions],
  );
  const movementAccounts = accounts.filter((account) => account.type !== "card" && account.deletedAt == null);
  const figures = unifiedCreateFigures(form);
  const error = unifiedCreateError(form);
  const movementLabel = movementChoiceLabel(form);
  const oneTime = kind !== "installmentPurchase" && form.repayment === "oneTime";
  const movementAccount = accounts.find((account) => account.id === form.movementAccountId);

  function reset() {
    setStep(0);
    setForm(EMPTY_UNIFIED_CREATE_FORM);
  }

  async function create() {
    if (!actions || error != null || saving) return;
    setSaving(true);
    try {
      const result = await actions.createAgreement(buildUnifiedCreateRequest(form, idempotencyKey, new Date()));
      toast.success(result.alreadyCreated ? "Agreement was already added" : "Agreement added");
      setIdempotencyKey(generateId());
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't add agreement", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const fundingOptions: LoanFundingSource[] = (["bank", "financeCompany", "creditCard", "person", "other"] as LoanFundingSource[]).filter(
    (value) => kind !== "lent" || value === "person",
  );

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !saving) reset(); onOpenChange(value); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add Loan / Installment</DialogTitle>
          <DialogDescription>Step {step + 1} of 3 · {step === 0 ? "Choose an agreement" : step === 1 ? "Enter the terms" : "Review before creating"}</DialogDescription>
        </DialogHeader>

        {step === 0 && (
          <div className="grid gap-3" role="radiogroup" aria-label="Agreement type">
            {(["borrowed", "lent", "installmentPurchase"] as UnifiedCreateKind[]).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => set({ kind: value, funding: value === "lent" ? "person" : "bank", repayment: "scheduled", recordMovement: false, movementAccountId: "" })}
                className={`rounded-2xl border p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${kind === value ? "border-primary bg-primary/10" : "border-border"}`}
              >
                <b>{value === "borrowed" ? "Money I Borrowed" : value === "lent" ? "Money I Lent" : "Purchase on Installments"}</b>
              </button>
            ))}
          </div>
        )}

        {step === 1 && kind && (
          <div className="grid gap-4">
            <label className="grid gap-1 text-sm">
              {kind === "installmentPurchase" ? "How was it financed?" : "Funding source"}
              <select className={FLAT_INPUT} value={funding} onChange={(e) => set({ funding: e.target.value as LoanFundingSource, personId: "", cardId: "", purchaseId: "" })}>
                {fundingOptions.map((value) => <option key={value} value={value}>{fundingLabel(value)}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              {kind === "installmentPurchase" ? "What did you buy?" : "Name / purpose"}
              <input className={FLAT_INPUT} value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </label>

            {funding === "person" ? (
              <PersonPickerField label="Person" people={people} value={form.personId} disabled={false} onChange={(personId) => set({ personId })} onCreatePerson={actions?.createPerson} />
            ) : funding === "creditCard" ? (
              <>
                <label className="grid gap-1 text-sm">
                  FlowFi credit card
                  <select className={FLAT_INPUT} value={form.cardId} onChange={(e) => set({ cardId: e.target.value, purchaseId: "" })}>
                    <option value="">Choose card</option>
                    {cards.map((c) => <option key={c.id} value={c.id}>{c.issuer ?? "Credit card"} · {c.lastFourDigits ?? "••••"}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Original card purchase (optional)
                  <select className={FLAT_INPUT} value={form.purchaseId} onChange={(e) => set({ purchaseId: e.target.value })}>
                    <option value="">Purchase not recorded / link later</option>
                    {eligiblePurchases.map((t) => <option key={t.id} value={t.id}>{t.description || t.notes || "Purchase"} · {rupees(t.amount)}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <label className="grid gap-1 text-sm">
                Provider
                <input className={FLAT_INPUT} value={form.provider} onChange={(e) => set({ provider: e.target.value })} />
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                {kind === "installmentPurchase" ? "Purchase amount" : "Principal"}
                <input className={FLAT_INPUT} inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
              </label>
              {kind === "installmentPurchase" && (
                <label className="grid gap-1 text-sm">
                  Down payment
                  <input className={FLAT_INPUT} inputMode="decimal" value={form.downPayment} onChange={(e) => set({ downPayment: e.target.value })} />
                </label>
              )}
            </div>

            {kind !== "installmentPurchase" && (
              <fieldset className="grid gap-2 text-sm">
                <legend className="mb-1">How will it be repaid?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(["scheduled", "oneTime"] as const).map((value) => (
                    <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-ring ${form.repayment === value ? "border-primary bg-primary/10" : "border-border"}`}>
                      <input type="radio" name="repayment" value={value} checked={form.repayment === value} onChange={() => set({ repayment: value })} />
                      {value === "scheduled" ? "Scheduled installments" : "One-time repayment"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="grid grid-cols-2 gap-3">
              {oneTime ? (
                <label className="grid gap-1 text-sm">
                  Repay by
                  <input type="date" className={FLAT_INPUT} value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
                </label>
              ) : (
                <label className="grid gap-1 text-sm">
                  Monthly payments
                  <input className={FLAT_INPUT} inputMode="numeric" value={form.count} onChange={(e) => set({ count: e.target.value })} />
                </label>
              )}
              <label className="grid gap-1 text-sm">
                Interest % (optional)
                <input className={FLAT_INPUT} inputMode="decimal" value={form.rate} onChange={(e) => set({ rate: e.target.value })} />
              </label>
            </div>
            {form.rate && (
              <label className="grid gap-1 text-sm">
                Interest type
                <select className={FLAT_INPUT} value={form.interestType} onChange={(e) => set({ interestType: e.target.value as UnifiedCreateForm["interestType"] })}>
                  <option value="reducingBalance">Reducing balance</option>
                  <option value="flat">Flat</option>
                </select>
              </label>
            )}

            {movementLabel != null ? (
              <div className="grid gap-3 rounded-xl border border-border p-3 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.recordMovement} onChange={(e) => set({ recordMovement: e.target.checked })} />
                  {movementLabel}
                </label>
                {form.recordMovement ? (
                  <label className="grid gap-1">
                    Account
                    <select className={FLAT_INPUT} value={form.movementAccountId} onChange={(e) => set({ movementAccountId: e.target.value })}>
                      <option value="">Choose account</option>
                      {movementAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                    </select>
                  </label>
                ) : (
                  <p className="text-muted-foreground">Agreement already exists — no account will change.</p>
                )}
              </div>
            ) : (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">No account will change.</p>
            )}
            {error != null && <p className="text-sm text-muted-foreground" aria-live="polite">{error}</p>}
          </div>
        )}

        {step === 2 && kind && (
          <div className="space-y-3 rounded-2xl border border-border p-4 text-sm">
            <h3 className="text-lg font-semibold">{form.name}</h3>
            <p>Principal {kind === "installmentPurchase" ? "financed" : kind === "lent" ? "lent" : "borrowed"}: <b>{rupees(figures.principal)}</b></p>
            {kind === "installmentPurchase" && <><p>Purchase: {rupees(figures.purchase)}</p><p>Down payment: {rupees(figures.down)}</p></>}
            <p>Repayment: {oneTime ? `one-time, by ${form.dueDate}` : `${form.count} monthly payments`}</p>
            <p>Funding: {fundingLabel(funding)}</p>
            <p>
              Account movement:{" "}
              {figures.movesMoney
                ? <b>{movementAccount?.name ?? "Account"} {figures.movementDelta >= 0 ? "+" : "−"}{rupees(Math.abs(figures.movementDelta))}</b>
                : "none"}
            </p>
          </div>
        )}

        <div className="flex justify-between gap-3">
          <ClayButton variant="secondary" disabled={saving} onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}>{step === 0 ? "Cancel" : "Back"}</ClayButton>
          {step < 2 ? (
            <ClayButton disabled={step === 0 ? kind == null : error != null} onClick={() => setStep(step + 1)}>Continue</ClayButton>
          ) : (
            <ClayButton disabled={error != null || saving} onClick={create}>{saving ? "Creating…" : "Create agreement"}</ClayButton>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
