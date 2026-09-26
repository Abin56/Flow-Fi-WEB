"use client";

import { ArrowUpRight, Building2, CreditCard, Lock, ShoppingBag, Trash2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ChipRow,
  ConfirmDialog,
  CurrencyCell,
  DetailDrawer,
  EmptyState,
  FLAT_INPUT,
  FormDialog,
  SectionedFormDialog,
  SectionLabel,
} from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { EMI_TYPE_LABEL, EmiCard, emiBadges, emiCardLabel } from "@/features/emi/components/emi-card";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import {
  AmountInput,
  DetailHero,
  DetailSectionTitle,
  FactGrid,
  Field,
  FieldGroup,
  LinkedList,
  LinkedRow,
  MoreOptions,
  RevealToggle,
  daysUntil,
  dueLabel,
} from "@/features/loans/components/loan-emi-ui";
import { formatCurrency } from "@/lib/format";
import { installmentStatus, remainingAmount, type ScheduleType } from "@/lib/models/payment-schedule";
import type { EmiLoanType } from "@/lib/models/emi";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { AddElsewhereLink } from "@/features/loans/components/loans-workspace";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanPersons } from "@/hooks/use-loans";
import {
  WhoIsThisForField,
  beneficiaryFromChoice,
  ownershipError,
  type OwnershipChoice,
} from "@/features/loans/components/who-is-this-for-field";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const LOAN_TYPE_OPTIONS: EmiLoanType[] = ["other", "personal", "vehicle", "home", "education", "gold", "business", "creditCard"];
const FREQUENCY_OPTIONS: ScheduleType[] = ["monthly", "weekly"];
const FREQUENCY_LABEL: Record<ScheduleType, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  custom: "Custom",
  oneTime: "One-time",
};

/** How a card-linked EMI came about — picks the form wording; both lock the principal against the card. */
type CardEmiKind = "creditCardLoan" | "productPurchase";

interface EmiFormState {
  name: string;
  lenderName: string;
  loanType: EmiLoanType;
  principalAmount: string;
  startDate: string;
  installmentFrequency: ScheduleType;
  installmentCount: string;
  hasInterest: boolean;
  interestType: InterestType;
  ratePercent: string;
  notes: string;
  linkToCard: boolean;
  linkedCreditCardId: string;
  cardEmiKind: CardEmiKind;
  /** "Who is this for?" — see `Emi.beneficiaryPersonId`. */
  ownership: OwnershipChoice;
  beneficiaryPersonId: string;
}

function emptyForm(): EmiFormState {
  return {
    name: "",
    lenderName: "",
    loanType: "other",
    principalAmount: "",
    startDate: new Date().toISOString().slice(0, 10),
    installmentFrequency: "monthly",
    installmentCount: "12",
    hasInterest: false,
    interestType: "reducingBalance",
    ratePercent: "",
    notes: "",
    linkToCard: false,
    linkedCreditCardId: "",
    cardEmiKind: "productPurchase",
    ownership: "me",
    beneficiaryPersonId: "",
  };
}

interface PaymentFormState {
  amount: string;
  date: string;
  note: string;
  gst: string;
  processingFee: string;
}

function emptyPaymentForm(amount: number): PaymentFormState {
  return {
    amount: amount > 0 ? String(amount) : "",
    date: new Date().toISOString().slice(0, 10),
    note: "",
    gst: "",
    processingFee: "",
  };
}

const INSTALLMENT_STATUS_BADGE = {
  paid: { label: "Paid", tone: "success" },
  partiallyPaid: { label: "Partial", tone: "warning" },
  overdue: { label: "Overdue", tone: "expense" },
  skipped: { label: "Skipped", tone: "neutral" },
  upcoming: null,
} as const;

function GoTo({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUpRight className="size-4" />
    </Link>
  );
}

export interface EmiWorkspaceProps {
  /** Incremented by the unified Loan & EMI chooser to open the Add EMI form. */
  addSignal?: number;
}

export function EmiWorkspace({ addSignal = 0 }: EmiWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const createHandoff = searchParams.get("create");
  const { rows, isLoading } = useEmiRows();
  const actions = useEmiActions();
  const { data: cards = [] } = useCreditCards();
  const { data: accounts = [] } = useAccounts();
  const { data: people = [] } = useLoanPersons();
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

  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [handoffDetailId, setHandoffDetailId] = useState<string | null>(() => searchParams.get("agreement"));
  const [addOpen, setAddOpen] = useState(() => createHandoff === "installmentPurchase");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [form, setForm] = useState<EmiFormState>(emptyForm);
  const [paymentForm, setPaymentForm] = useState<PaymentFormState>(() => emptyPaymentForm(0));
  const [saving, setSaving] = useState(false);

  const activeRowFresh = useMemo(() => {
    const id = activeRow?.emi.id ?? handoffDetailId;
    if (!id) return null;
    return rows.find((row) => row.emi.id === id) ?? activeRow;
  }, [rows, activeRow, handoffDetailId]);

  function openAdd() {
    setForm(emptyForm());
    setAddOpen(true);
  }

  const [seenAddSignal, setSeenAddSignal] = useState(addSignal);
  if (addSignal !== seenAddSignal) {
    setSeenAddSignal(addSignal);
    openAdd();
  }

  function openPay(row: EmiRow) {
    setPaymentForm(emptyPaymentForm(row.nextInstallment?.amountDue ?? 0));
    setPayOpen(true);
  }

  async function handleCreate() {
    if (!actions) return;
    if (form.linkToCard && !form.linkedCreditCardId) {
      toast.error("Select a credit card", "Choose the card this EMI is on, or turn off the credit card option.");
      return;
    }
    const forError = ownershipError(form.ownership, form.beneficiaryPersonId);
    if (forError) {
      toast.error(forError, "Pick the person this EMI is for, or switch to For me.");
      return;
    }
    setSaving(true);
    try {
      await actions.createEmi({
        name: form.name,
        lenderName: form.lenderName || null,
        loanType: form.linkToCard ? "creditCard" : form.loanType,
        // No purchaseTransactionId: the EMI's remaining principal is what locks the card's limit.
        linkedCreditCardId: form.linkToCard ? form.linkedCreditCardId : null,
        // Association only — a card-linked EMI still locks the card's credit exactly as before.
        beneficiaryPersonId: beneficiaryFromChoice(form.ownership, form.beneficiaryPersonId),
        principalAmount: Number(form.principalAmount),
        startDate: new Date(form.startDate),
        installmentFrequency: form.installmentFrequency,
        installmentCount: Number(form.installmentCount),
        interest: form.hasInterest
          ? { type: form.interestType, ratePercent: Number(form.ratePercent), period: "yearly" }
          : null,
        notes: form.notes,
      });
      setAddOpen(false);
    } catch (e) {
      toast.error("Couldn't add EMI", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.deleteEmi(activeRowFresh.emi);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleRecordPayment() {
    if (!actions || !activeRowFresh?.nextInstallment) return;
    setSaving(true);
    try {
      await actions.recordPayment(activeRowFresh.emi, activeRowFresh.nextInstallment, {
        amount: Number(paymentForm.amount),
        date: new Date(paymentForm.date),
        note: paymentForm.note,
        gst: paymentForm.gst ? Number(paymentForm.gst) : undefined,
        processingFee: paymentForm.processingFee ? Number(paymentForm.processingFee) : undefined,
      });
      setPayOpen(false);
    } catch (e) {
      toast.error("Couldn't record payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClose() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.closeEmi(activeRowFresh.emi);
    } catch (e) {
      toast.error("Couldn't close EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-48 rounded-2xl" />
        ))}
      </div>
    );
  }

  const detail = activeRowFresh;
  const detailDone = detail != null && (detail.status === "closed" || detail.status === "completed");
  const detailPaid = detail ? detail.installments.reduce((sum, i) => sum + i.amountPaid, 0) : 0;
  const detailInstallment = detail ? (detail.nextInstallment?.amountDue ?? detail.installments[0]?.amountDue ?? 0) : 0;
  const detailCard = detail ? emiCardLabel(detail) : null;
  const detailOverdue = detail?.nextInstallment != null && daysUntil(detail.nextInstallment.dueDate) < 0;
  const isProductPurchase = !form.linkToCard || form.cardEmiKind === "productPurchase";

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="No EMIs yet"
          description="An EMI is a purchase or Credit Card EMI you pay back in fixed installments. Add one to see what's due and what's left."
          actionLabel="Add an EMI"
          onAction={openAdd}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <EmiCard key={row.emi.id} row={row} onClick={() => setActiveRow(row)} />
          ))}
        </Stagger>
      )}

      <DetailDrawer
        open={detail != null && !deleteOpen && !payOpen}
        onOpenChange={(open) => {
          if (!open) {
            setActiveRow(null);
            setHandoffDetailId(null);
          }
        }}
        className="sm:max-w-lg"
        title={detail?.emi.name ?? ""}
        description={
          detail
            ? `EMI · ${detail.emi.lenderName ?? EMI_TYPE_LABEL[detail.emi.loanType]}${
                detail.emi.interest ? ` · ${detail.emi.interest.ratePercent}% p.a.` : " · No interest"
              }`
            : undefined
        }
        footer={
          detail && (
            <>
              <ClayButton className="w-full gap-1.5" disabled={!detail.nextInstallment} onClick={() => openPay(detail)}>
                <Wallet className="size-4" />
                Record Payment
              </ClayButton>
              <div className="flex gap-2">
                <ClayButton variant="ghost" size="sm" className="flex-1 gap-1.5 text-foreground/75" disabled={detail.status === "closed"} onClick={handleClose}>
                  <Lock className="size-3.5" />
                  Close EMI
                </ClayButton>
                <ClayButton variant="ghost" size="sm" className="flex-1 gap-1.5 text-expense hover:text-expense" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </ClayButton>
              </div>
            </>
          )
        }
      >
        {detail && (
          <div className="flex flex-col gap-5 text-sm">
            <DetailHero
              label="Outstanding"
              amount={detail.remainingBalance}
              paid={detail.installmentsPaid}
              total={detail.emi.installmentCount}
              badges={emiBadges(detail)}
            />

            {!detailDone && detail.nextInstallment && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3">
                <div className="flex flex-col">
                  <span className={cn("text-xs", detailOverdue ? "font-semibold text-expense" : "font-medium text-muted-foreground")}>
                    Next installment · {dueLabel(detail.nextInstallment.dueDate)}
                  </span>
                  <span className="font-heading text-lg font-semibold text-foreground tabular-nums">
                    {formatCurrency(remainingAmount(detail.nextInstallment))}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  #{detail.nextInstallment.sequenceNumber} of {detail.emi.installmentCount}
                </span>
              </div>
            )}

            <FactGrid
              className="sm:grid-cols-2"
              facts={[
                { label: "Original amount", value: formatCurrency(detail.emi.principalAmount) },
                { label: "Installment", value: formatCurrency(detailInstallment), strong: true },
                { label: "Paid so far", value: formatCurrency(detailPaid) },
                {
                  label: "Interest",
                  value: detail.emi.interest
                    ? `${detail.emi.interest.ratePercent}% ${detail.emi.interest.type === "flat" ? "flat" : "reducing"}`
                    : "No interest",
                },
                detail.emi.isAutoDebitEnabled ? { label: "Auto-debit", value: detail.emi.autoDebitAccount ?? "On" } : null,
              ]}
            />

            {(detailCard || detail.emi.beneficiaryPersonId || detail.emi.lenderName) && (
              <section>
                <DetailSectionTitle>Linked</DetailSectionTitle>
                <LinkedList>
                  {detailCard && (
                    <LinkedRow icon={CreditCard} label="Credit card" value={detailCard} action={<GoTo href="/credit-cards" label="Open Credit Cards" />} />
                  )}
                  {detail.emi.lenderName && <LinkedRow icon={Building2} label="Lender" value={detail.emi.lenderName} />}
                  {detail.emi.beneficiaryPersonId && (
                    <LinkedRow
                      icon={UserRound}
                      label="For"
                      value={detail.beneficiaryName ?? "Someone else"}
                      action={<GoTo href="/people" label="Open People" />}
                    />
                  )}
                </LinkedList>
              </section>
            )}

            <section>
              <DetailSectionTitle aside={<span className="text-xs text-muted-foreground tabular-nums">{detail.installments.length} total</span>}>
                Installments
              </DetailSectionTitle>
              <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
                {detail.installments.map((installment) => {
                  const status = installmentStatus(installment);
                  const badge = INSTALLMENT_STATUS_BADGE[status];
                  const isNext = installment.id === detail.nextInstallment?.id;
                  return (
                    <div
                      key={installment.id}
                      className={cn("flex items-center justify-between gap-3 px-3.5 py-2.5", isNext ? "bg-muted/60" : "bg-card", status === "paid" && "text-muted-foreground")}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{installment.sequenceNumber}</span>
                        <div className="flex min-w-0 flex-col">
                          <span className={cn("text-sm font-medium", status === "paid" ? "text-foreground/70" : "text-foreground")}>
                            {installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          </span>
                          {isNext && <span className="text-[11px] font-semibold text-foreground/80">Next due</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {badge && <ClayBadge tone={badge.tone} className="px-2 py-0.5 text-[11px]">{badge.label}</ClayBadge>}
                        <CurrencyCell amount={installment.amountDue} signed={false} className="text-sm font-semibold" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </DetailDrawer>

      <SectionedFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add an EMI"
        description="Installments for a purchase, Credit Card EMI or store finance. Only the basics are needed — the schedule is built for you."
        onConfirm={handleCreate}
        confirmLabel={saving ? "Saving…" : "Add EMI"}
        loading={saving}
        contentClassName="sm:max-w-2xl"
      >
        <div className="flex flex-col gap-5">
          <Field label="What's this EMI for?">
            <input
              className={FLAT_INPUT}
              placeholder={isProductPurchase ? "e.g. iPhone 16, Sofa, Car" : "e.g. Card loan"}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Amount on EMI" hint="The amount being paid off in installments.">
              <AmountInput value={form.principalAmount} onChange={(v) => setForm((f) => ({ ...f, principalAmount: v }))} />
            </Field>
            <Field label="Number of installments">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                className={FLAT_INPUT}
                value={form.installmentCount}
                onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First EMI date">
              <input
                type="date"
                className={FLAT_INPUT}
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </Field>
            <FieldGroup label="Paid">
              <ChipRow
                options={FREQUENCY_OPTIONS.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
                value={form.installmentFrequency}
                onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
              />
            </FieldGroup>
          </div>

          {/* Credit card controls stay hidden until the user says it's on a card. */}
          <RevealToggle
            checked={form.linkToCard}
            onChange={(checked) => setForm((f) => ({ ...f, linkToCard: checked }))}
            title="It's on a credit card"
            description="Credit Card EMI — the amount is held against the card's limit and released as you pay."
          >
            {cardOptions.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">No credit cards yet — add one, then come back.</p>
                <AddElsewhereLink href="/credit-cards" label="Go to Credit Cards" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground/85">Which card?</span>
                    <AddElsewhereLink href="/credit-cards" label="Add Credit Card" />
                  </div>
                  <select
                    className={FLAT_INPUT}
                    value={form.linkedCreditCardId}
                    onChange={(e) => setForm((f) => ({ ...f, linkedCreditCardId: e.target.value }))}
                  >
                    <option value="">Select a card</option>
                    {cardOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <FieldGroup label="What kind?">
                  <ChipRow
                    options={[
                      { value: "productPurchase" as CardEmiKind, label: "Purchase on EMI" },
                      { value: "creditCardLoan" as CardEmiKind, label: "Loan on card" },
                    ]}
                    value={form.cardEmiKind}
                    onChange={(v) => setForm((f) => ({ ...f, cardEmiKind: v }))}
                  />
                </FieldGroup>
              </>
            )}
          </RevealToggle>

          <RevealToggle
            checked={form.hasInterest}
            onChange={(checked) => setForm((f) => ({ ...f, hasInterest: checked }))}
            title="It has interest"
            description="Leave off for a no-cost EMI."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Interest rate (% per year)">
                <input
                  type="number"
                  inputMode="decimal"
                  className={FLAT_INPUT}
                  placeholder="e.g. 14"
                  value={form.ratePercent}
                  onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
                />
              </Field>
              <FieldGroup label="Interest type">
                <ChipRow
                  options={[
                    { value: "reducingBalance" as InterestType, label: "Reducing Balance" },
                    { value: "flat" as InterestType, label: "Flat" },
                  ]}
                  value={form.interestType}
                  onChange={(v) => setForm((f) => ({ ...f, interestType: v }))}
                />
              </FieldGroup>
            </div>
          </RevealToggle>

          <MoreOptions summary={form.linkToCard ? "Lender, who it's for, notes" : "Lender, type, who it's for, notes"}>
            <Field label="Lender / store">
              <input
                className={FLAT_INPUT}
                placeholder="e.g. Bajaj Finance, HDFC Bank"
                value={form.lenderName}
                onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
              />
            </Field>
            {!form.linkToCard && (
              <FieldGroup label="Type">
                <ChipRow
                  options={LOAN_TYPE_OPTIONS.map((t) => ({ value: t, label: EMI_TYPE_LABEL[t] }))}
                  value={form.loanType}
                  onChange={(v) => setForm((f) => ({ ...f, loanType: v }))}
                />
              </FieldGroup>
            )}
            <WhoIsThisForField
              bare
              labelClassName="text-xs font-semibold text-foreground/85"
              people={people}
              choice={form.ownership}
              personId={form.beneficiaryPersonId}
              onChange={({ choice, personId }) => setForm((f) => ({ ...f, ownership: choice, beneficiaryPersonId: personId }))}
            />
            <Field label="Notes">
              <textarea
                className={cn(FLAT_INPUT, "min-h-20 resize-none py-2")}
                placeholder="Optional notes"
                rows={3}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>
          </MoreOptions>
        </div>
      </SectionedFormDialog>

      <FormDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title={`Record Payment — ${detail?.emi.name ?? "EMI"}`}
        description="Records against the next-due installment. GST/processing fee are tracked for your records only."
        onConfirm={handleRecordPayment}
        confirmLabel={saving ? "Saving…" : "Record"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Amount">
              <AmountInput value={paymentForm.amount} onChange={(v) => setPaymentForm((f) => ({ ...f, amount: v }))} autoFocus />
            </Field>
            <Field label="Date">
              <input
                type="date"
                className={cn(FLAT_INPUT, "h-12")}
                value={paymentForm.date}
                onChange={(e) => setPaymentForm((f) => ({ ...f, date: e.target.value }))}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <SectionLabel>Optional</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="GST">
                <input
                  type="number"
                  inputMode="decimal"
                  className={FLAT_INPUT}
                  value={paymentForm.gst}
                  onChange={(e) => setPaymentForm((f) => ({ ...f, gst: e.target.value }))}
                />
              </Field>
              <Field label="Processing fee">
                <input
                  type="number"
                  inputMode="decimal"
                  className={FLAT_INPUT}
                  value={paymentForm.processingFee}
                  onChange={(e) => setPaymentForm((f) => ({ ...f, processingFee: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Note">
              <input
                className={FLAT_INPUT}
                placeholder="Optional note"
                value={paymentForm.note}
                onChange={(e) => setPaymentForm((f) => ({ ...f, note: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${detail?.emi.name ?? "EMI"}?`}
        description="This permanently removes the EMI, its schedule, installments, and payment breakdowns. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
