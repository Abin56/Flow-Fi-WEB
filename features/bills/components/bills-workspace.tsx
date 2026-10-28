"use client";

import { AccountLabel } from "@/components/finance/account-label";
import { CalendarClock, Plus, StickyNote, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ConfirmDialog,
  CurrencyCell,
  DateCell,
  DetailDrawer,
  EmptyState,
  FormDialog,
  SectionLabel,
  SmartToolbar,
} from "@/components/finance";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { formatCurrency } from "@/lib/format";
import { billObligationStats, outstandingBillOccurrences } from "@/lib/engines/bill-obligations";
import { billOccurrenceStatus, billOccurrenceRemainingAmount, type Bill, type BillOccurrence, type BillRecurrence, type PaymentRecord } from "@/lib/models/bill";
import { BillPaymentDialog } from "@/features/bills/components/bill-payment-dialog";
import { BillPaymentCancelDialog, type CancelTarget } from "@/features/bills/components/bill-payment-cancel-dialog";
import { BillPaymentHistory } from "@/features/bills/components/bill-payment-history";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import { Receipt } from "lucide-react";
import { BillCard, RECURRENCE_LABEL } from "@/features/bills/components/bill-card";
import { UpcomingDuesSection } from "@/features/bills/components/upcoming-dues-section";
import { useBillActions, useBillRows, type BillRow } from "@/features/bills/hooks/use-bills-data";
import { Banner } from "@/components/feedback/banner";
import { dayToDate, toDay } from "@/features/bills/lib/bill-form-date";
import { BillEditConflictError, billSkipBlockedReason } from "@/lib/repositories/bill-repository";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";
import { DateInput } from "@/components/forms/date-input";
import { findDuplicateBillCycles } from "@/lib/engines/bill-duplicate-cycles";
import { BillDuplicateReviewPanel } from "@/features/bills/components/bill-duplicate-review-panel";
import { AlertTriangle } from "lucide-react";

const RECURRENCE_OPTIONS: BillRecurrence[] = ["oneTime", "daily", "weekly", "monthly", "yearly", "custom"];

interface BillFormState {
  name: string;
  amount: string;
  dueDate: string;
  recurrence: BillRecurrence;
  customIntervalDays: string;
  accountId: string;
  categoryId: string;
  notes: string;
}

function emptyForm(): BillFormState {
  return {
    name: "",
    amount: "",
    dueDate: toDay(new Date()),
    recurrence: "monthly",
    customIntervalDays: "30",
    accountId: "",
    categoryId: "",
    notes: "",
  };
}

function formFromBill(bill: Bill): BillFormState {
  return {
    name: bill.name,
    amount: String(bill.amount),
    dueDate: toDay(bill.nextDueDate),
    recurrence: bill.recurrence,
    customIntervalDays: String(bill.customIntervalDays ?? 30),
    accountId: bill.accountId ?? "",
    categoryId: bill.categoryId ?? "",
    notes: bill.notes,
  };
}

export function BillsWorkspace() {
  const { rows, cycles, isLoading, refreshOccurrences } = useBillRows();
  const actions = useBillActions();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();

  const [activeSnapshot, setActiveRow] = useState<BillRow | null>(null);
  // The open bill follows the LIVE list, so a change made in another tab shows up (and Edit seeds from current values).
  // Falls back to the row as clicked if the bill has left the list.
  const activeRow = useMemo(() => (activeSnapshot ? (rows.find((r) => r.bill.id === activeSnapshot.bill.id) ?? activeSnapshot) : null), [rows, activeSnapshot]);
  // The bill the open edit form was SEEDED from. Conflict detection compares the form against this, never against the live
  // copy — otherwise untouched-but-stale fields would look like edits and silently overwrite another tab.
  const [editBase, setEditBase] = useState<Bill | null>(null);
  const [editConflict, setEditConflict] = useState<string[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<BillFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentRecord | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [occurrences, setOccurrences] = useState<BillOccurrence[]>([]);
  const [paymentsVersion, setPaymentsVersion] = useState(0);
  // The cycle a pay / edit dialog acts on — always the payment's own cycle, never "whatever the page shows".
  const [payOccurrence, setPayOccurrence] = useState<BillOccurrence | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);

  // The open bill's live payments (every cycle) and its cycles — what the Payment history can edit / cancel.
  const activeBillId = activeRow?.bill.id;
  const activeOccurrenceId = activeRow?.occurrence?.id;
  const activePaid = activeRow?.occurrence?.amountPaid;
  useEffect(() => {
    let cancelled = false;
    if (!actions || !activeBillId) return;
    void Promise.all([actions.listPayments(activeBillId), actions.listOccurrences(activeBillId)])
      .then(([all, occs]) => {
        if (cancelled) return;
        setPayments(all.filter((p) => p.deletedAt == null));
        setOccurrences(occs);
      })
      .catch(() => {
        if (cancelled) return;
        setPayments([]);
        setOccurrences([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBillId, activeOccurrenceId, activePaid, paymentsVersion]);

  const shownPayments = activeBillId ? payments : [];
  const shownOccurrences = activeBillId ? occurrences : [];
  const accountName = useCallback((id: string | null | undefined) => (id ? (accounts as Account[]).find((a) => a.id === id)?.name : undefined), [accounts]);

  const cancelPayment = useCallback(async () => {
    if (!actions || !activeBillId || !cancelTarget || cancelling) return;
    setCancelling(true);
    try {
      const { alreadyReversed } = await actions.cancelBillPayment({ billId: activeBillId, paymentId: cancelTarget.payment.id });
      setPaymentsVersion((v) => v + 1);
      setCancelTarget(null);
      setActiveRow(null);
      if (alreadyReversed) toast.info("Already cancelled", "This payment was cancelled already — nothing was refunded twice.");
      else toast.success("Payment cancelled", cancelTarget.payment.transactionId ? "The debit was refunded and that billing cycle is unpaid again." : "That billing cycle is unpaid again.");
    } catch (e) {
      setPaymentsVersion((v) => v + 1);
      toast.error("Couldn't cancel the payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setCancelling(false);
    }
  }, [actions, activeBillId, cancelTarget, cancelling]);

  // Occurrence-level: every unpaid / part-paid cycle counts once, including an older cycle reopened by a cancelled
  // payment — the same figures Month Cycle uses (`lib/engines/bill-obligations.ts`). "Paid" is still per bill (its current cycle).
  const stats = useMemo(() => {
    const now = new Date();
    const obligations = billObligationStats(outstandingBillOccurrences(cycles, now), now);
    const paidCount = rows.filter(({ occurrence }) => occurrence && billOccurrenceStatus(occurrence, now) === "paid").length;
    return { ...obligations, paidCount };
  }, [rows, cycles]);

  // Read-only duplicate-cycle detection (`lib/engines/bill-duplicate-cycles.ts`) — same "same bill, same due calendar
  // day" grouping `BillPaymentRepository` uses to BLOCK a payment. Payments aren't loaded here (every payment of
  // every bill would be an extra read on every page visit); the review panel loads them only once opened.
  const occurrencesByBillId = useMemo(() => {
    const m = new Map<string, BillOccurrence[]>();
    for (const { billId, occurrence } of cycles) m.set(billId, [...(m.get(billId) ?? []), occurrence]);
    return m;
  }, [cycles]);
  const currentOccurrenceIdByBillId = useMemo(() => new Map(rows.map((r) => [r.bill.id, r.occurrence?.id ?? null])), [rows]);
  const duplicateGroups = useMemo(
    () => findDuplicateBillCycles(rows.map((r) => r.bill), occurrencesByBillId, new Map(), currentOccurrenceIdByBillId),
    [rows, occurrencesByBillId, currentOccurrenceIdByBillId],
  );

  function openAdd() {
    setActiveRow(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openEdit(row: BillRow) {
    setActiveRow(row);
    setForm(formFromBill(row.bill));
    setEditBase(row.bill);
    setEditConflict(null);
    setEditOpen(true);
  }

  /** After a conflict: replace the form (and its base) with the CURRENT stored values — only on the user's explicit choice. */
  function reloadLatest() {
    if (!activeRow) return;
    setForm(formFromBill(activeRow.bill));
    setEditBase(activeRow.bill);
    setEditConflict(null);
  }

  async function handleSave(isEdit: boolean) {
    if (!actions) return;
    setSaving(true);
    try {
      const amount = Number(form.amount);
      const dueDate = dayToDate(form.dueDate);
      const params = {
        name: form.name,
        amount,
        dueDate,
        nextDueDate: dueDate,
        recurrence: form.recurrence,
        accountId: form.accountId || null,
        categoryId: form.categoryId || null,
        customIntervalDays: form.recurrence === "custom" ? Number(form.customIntervalDays) : null,
        notes: form.notes,
      };
      if (isEdit && activeRow) {
        await actions.editBill(editBase ?? activeRow.bill, params);
        setEditConflict(null);
        setEditOpen(false);
      } else {
        await actions.createBill(params);
        setAddOpen(false);
      }
      setActiveRow(null);
    } catch (e) {
      if (isEdit && e instanceof BillEditConflictError) setEditConflict(e.fields);
      toast.error(isEdit ? "Couldn't save changes" : "Couldn't add bill", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actions || !activeRow) return;
    try {
      await actions.deleteBill(activeRow.bill);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete bill", e instanceof Error ? e.message : "Please try again.");
    }
  }

  function openPay(payment: PaymentRecord | null, occurrence: BillOccurrence | null = null) {
    setEditingPayment(payment);
    setPayOccurrence(occurrence);
    setPayOpen(true);
  }

  async function handleSkip(row: BillRow) {
    if (!actions || !row.occurrence || skipping) return;
    setSkipping(true);
    try {
      await actions.skipOccurrence(row.bill, row.occurrence);
    } catch (e) {
      toast.error("Couldn't skip this bill", e instanceof Error ? e.message : "Please try again.");
      await refreshOccurrences(); // the refusal may mean the panel was stale (e.g. paid in another tab) — show the real state
    } finally {
      setSkipping(false);
    }
  }

  async function handleUnskip(row: BillRow) {
    if (!actions || !row.occurrence || skipping) return;
    setSkipping(true);
    try {
      await actions.unskipOccurrence(row.bill, row.occurrence);
      toast.success("Bill un-skipped", "It's due again and counted in your totals.");
    } catch (e) {
      toast.error("Couldn't un-skip this bill", e instanceof Error ? e.message : "Please try again.");
      await refreshOccurrences();
    } finally {
      setSkipping(false);
    }
  }

  /** Opening a bill reads occurrences fresh from the server (point-in-time, not a new listener) so Pay/Skip/Unskip reflect the latest write another tab made. */
  function openRow(row: BillRow) {
    setActiveRow(row);
    void refreshOccurrences();
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Bills</h1>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-3xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1">
      <SmartToolbar
        left={
          <div className="flex items-baseline gap-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Bills</h1>
            <span className="text-sm text-muted-foreground">{rows.length} bills</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {duplicateGroups.length > 0 && (
              <ClayButton size="sm" variant="secondary" onClick={() => setDuplicatesOpen(true)} className="gap-1.5 text-warning-foreground">
                <AlertTriangle className="size-3.5" />
                {duplicateGroups.length} duplicate cycle{duplicateGroups.length > 1 ? "s" : ""}
              </ClayButton>
            )}
            <ClayButton size="sm" onClick={openAdd} className="gap-1.5">
              <Plus className="size-3.5" />
              Add Bill
            </ClayButton>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="flex flex-col gap-2 rounded-3xl border border-border/50 bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Bills Due This Month</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{formatCurrency(stats.dueThisMonth)}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-expense/20 bg-expense/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Overdue</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-expense">{stats.overdueCount}</p>
          {stats.overdueCount > 0 && <p className="font-mono text-xs tabular-nums text-expense">{formatCurrency(stats.overdueAmount)} outstanding</p>}
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-success/20 bg-success/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Paid</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-success">{stats.paidCount}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-primary/20 bg-primary/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Upcoming</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-primary-accent-text">{stats.upcomingCount}</p>
        </div>
      </div>

      <UpcomingDuesSection />

      {rows.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No bills yet"
          description="Add a recurring or one-time bill to start tracking due dates and payments."
          actionLabel="Add Bill"
          onAction={openAdd}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <BillCard key={row.bill.id} row={row} onClick={() => openRow(row)} />
          ))}
        </Stagger>
      )}

      <DetailDrawer
        open={activeRow != null && !editOpen && !deleteOpen && !payOpen && cancelTarget == null}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRow?.bill.name ?? ""}
        description={activeRow ? RECURRENCE_LABEL[activeRow.bill.recurrence] : undefined}
        footer={
          activeRow && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <ClayButton variant="secondary" className="flex-1" disabled={!activeRow.occurrence || billOccurrenceRemainingAmount(activeRow.occurrence) <= 0 || activeRow.occurrence.isSkipped || skipping} onClick={() => openPay(null)}>
                  Pay…
                </ClayButton>
                {activeRow.occurrence?.isSkipped ? (
                  <ClayButton variant="secondary" className="flex-1" disabled={skipping} onClick={() => handleUnskip(activeRow)}>
                    {skipping ? "Un-skipping…" : "Un-skip"}
                  </ClayButton>
                ) : (
                  <ClayButton
                    variant="secondary"
                    className="flex-1"
                    disabled={!activeRow.occurrence || skipping || billSkipBlockedReason(activeRow.occurrence) != null}
                    title={activeRow.occurrence ? (billSkipBlockedReason(activeRow.occurrence) ?? undefined) : undefined}
                    onClick={() => handleSkip(activeRow)}
                  >
                    {skipping ? "Skipping…" : "Skip"}
                  </ClayButton>
                )}
              </div>
              <div className="flex gap-2">
                <ClayButton variant="secondary" className="flex-1" onClick={() => openEdit(activeRow)}>
                  Edit
                </ClayButton>
                <ClayButton variant="secondary" className={cn("flex-1 text-expense")} onClick={() => setDeleteOpen(true)}>
                  Delete
                </ClayButton>
              </div>
            </div>
          )
        }
      >
        {activeRow &&
          (() => {
            const { bill, occurrence, account, category } = activeRow;
            const status = occurrence ? billOccurrenceStatus(occurrence) : "upcoming";
            return (
              <div className="flex flex-col gap-5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Amount</span>
                  <CurrencyCell amount={-(occurrence?.amount ?? bill.amount)} className="text-base font-semibold" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <ClayBadge tone={status === "overdue" ? "expense" : status === "paid" ? "success" : "neutral"}>{status}</ClayBadge>
                </div>
                {occurrence && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Remaining</span>
                    <CurrencyCell amount={-billOccurrenceRemainingAmount(occurrence)} />
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Due Date</span>
                  <DateCell date={occurrence?.dueDate ?? bill.nextDueDate} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Recurrence</span>
                  <span className="font-medium text-foreground">{RECURRENCE_LABEL[bill.recurrence]}</span>
                </div>
                {account && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Account</span>
                    <span className="font-medium text-foreground">{account.name}</span>
                  </div>
                )}
                {category && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Category</span>
                    <span className="font-medium text-foreground">{category.name}</span>
                  </div>
                )}
                <BillPaymentHistory
                  currentOccurrenceId={occurrence?.id ?? null}
                  occurrences={shownOccurrences}
                  payments={shownPayments}
                  accountName={accountName}
                  onEdit={(p, occ) => openPay(p, occ)}
                  onCancel={(p, occ) => setCancelTarget({ payment: p, occurrence: occ })}
                  onPay={(occ) => openPay(null, occ)}
                />
                {occurrence && occurrence.amountPaid > 0 && !shownPayments.some((p) => p.occurrenceId === occurrence.id) && (
                  <p className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
                    Marked paid before payments tracked money — treated as already in your balance. No account was changed.
                  </p>
                )}
                {bill.notes && (
                  <div className="flex flex-col gap-1 border-t border-border/60 pt-4">
                    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Notes</span>
                    <p className="text-sm text-foreground">{bill.notes}</p>
                  </div>
                )}
              </div>
            );
          })()}
      </DetailDrawer>

      {activeRow?.occurrence && (
        <BillPaymentDialog
          open={payOpen}
          onOpenChange={(o) => {
            setPayOpen(o);
            if (!o) {
              setPayOccurrence(null);
              setPaymentsVersion((v) => v + 1);
              setActiveRow(null);
            }
          }}
          bill={activeRow.bill}
          occurrence={payOccurrence ?? activeRow.occurrence}
          editing={editingPayment}
        />
      )}

      {activeRow && (
        <BillPaymentCancelDialog
          bill={activeRow.bill}
          target={cancelTarget}
          accountName={accountName(cancelTarget?.payment.accountId)}
          loading={cancelling}
          onOpenChange={(o) => !o && setCancelTarget(null)}
          onConfirm={() => void cancelPayment()}
        />
      )}

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add Bill"
        description="Track a recurring or one-time bill and stay ahead of its due date."
        onConfirm={() => handleSave(false)}
        confirmLabel={saving ? "Saving…" : "Save"}
        contentClassName="sm:max-w-xl"
      >
        <BillFormFields form={form} setForm={setForm} accounts={accounts} categories={categories} />
      </FormDialog>

      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${activeRow?.bill.name ?? "Bill"}`}
        onConfirm={() => handleSave(true)}
        confirmLabel={saving ? "Saving…" : "Save Changes"}
        contentClassName="sm:max-w-xl"
      >
        {editConflict && (
          <Banner
            tone="warning"
            title="This bill changed in another tab"
            description={`Nothing was saved. What you typed is still here. The ${editConflict.join(", ")} changed since you opened this form — load the latest values to see them, then apply your change again.`}
            action={
              <ClayButton size="sm" variant="secondary" onClick={reloadLatest}>
                Discard my edits and load the latest
              </ClayButton>
            }
          />
        )}
        <BillFormFields form={form} setForm={setForm} accounts={accounts} categories={categories} />
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${activeRow?.bill.name ?? "bill"}?`}
        description="This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
      <BillDuplicateReviewPanel
        open={duplicatesOpen}
        onOpenChange={setDuplicatesOpen}
        bills={rows.map((r) => r.bill)}
        occurrencesByBillId={occurrencesByBillId}
        currentOccurrenceIdByBillId={currentOccurrenceIdByBillId}
        listPayments={actions?.listPayments ?? null}
      />
      <ScrollNav />
    </div>
  );
}

function BillFormFields({
  form,
  setForm,
  accounts,
  categories,
}: {
  form: BillFormState;
  setForm: React.Dispatch<React.SetStateAction<BillFormState>>;
  accounts: Account[];
  categories: Category[];
}) {
  return (
    <div className="flex flex-col gap-5 py-1 text-sm">
      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
        <SectionLabel icon={Receipt}>Bill Details</SectionLabel>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Bill Name</span>
          <input
            className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
            placeholder="e.g. Electricity"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
              <input
                type="number"
                className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Next Due Date</span>
            <DateInput
              className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
        <SectionLabel icon={CalendarClock}>Recurrence</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Repeats</span>
            <Select value={form.recurrence} onValueChange={(v) => setForm((f) => ({ ...f, recurrence: v as BillRecurrence }))}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECURRENCE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RECURRENCE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {form.recurrence === "custom" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Repeat Every (days)</span>
              <input
                type="number"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={form.customIntervalDays}
                onChange={(e) => setForm((f) => ({ ...f, customIntervalDays: e.target.value }))}
              />
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
        <SectionLabel icon={Wallet}>Linked To (optional)</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Account</span>
            <Select value={form.accountId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, accountId: v === "none" ? "" : v }))}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue placeholder="No account" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No account</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <AccountLabel account={a} suffix={a.accountNumberLast4 ? `•••• ${a.accountNumberLast4}` : undefined} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <Select value={form.categoryId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, categoryId: v === "none" ? "" : v }))}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue placeholder="No category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No category</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl bg-muted/30 p-4">
        <SectionLabel icon={StickyNote}>Notes</SectionLabel>
        <textarea
          className="clay-pressed min-h-20 resize-none rounded-xl px-3 py-2 text-sm outline-none"
          placeholder="Optional notes"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>
    </div>
  );
}
