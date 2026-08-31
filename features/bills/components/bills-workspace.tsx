"use client";

import { CalendarClock, Plus, StickyNote, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { formatCurrency } from "@/lib/format";
import { billOccurrenceStatus, billOccurrenceRemainingAmount, type Bill, type BillRecurrence } from "@/lib/models/bill";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import { Receipt } from "lucide-react";
import { BillCard, RECURRENCE_LABEL } from "@/features/bills/components/bill-card";
import { useBillActions, useBillRows, type BillRow } from "@/features/bills/hooks/use-bills-data";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

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
    dueDate: new Date().toISOString().slice(0, 10),
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
    dueDate: bill.nextDueDate.toISOString().slice(0, 10),
    recurrence: bill.recurrence,
    customIntervalDays: String(bill.customIntervalDays ?? 30),
    accountId: bill.accountId ?? "",
    categoryId: bill.categoryId ?? "",
    notes: bill.notes,
  };
}

export function BillsWorkspace() {
  const { rows, isLoading } = useBillRows();
  const actions = useBillActions();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();

  const [activeRow, setActiveRow] = useState<BillRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<BillFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const stats = useMemo(() => {
    let dueThisMonth = 0;
    let overdueCount = 0;
    let paidCount = 0;
    let upcomingCount = 0;
    const now = new Date();
    for (const { occurrence } of rows) {
      if (!occurrence) continue;
      const status = billOccurrenceStatus(occurrence, now);
      if (status === "overdue") overdueCount += 1;
      if (status === "paid") paidCount += 1;
      if (status === "upcoming" || status === "dueToday") upcomingCount += 1;
      if (
        occurrence.dueDate.getFullYear() === now.getFullYear() &&
        occurrence.dueDate.getMonth() === now.getMonth() &&
        status !== "paid" &&
        status !== "skipped"
      ) {
        dueThisMonth += billOccurrenceRemainingAmount(occurrence);
      }
    }
    return { dueThisMonth, overdueCount, paidCount, upcomingCount };
  }, [rows]);

  function openAdd() {
    setActiveRow(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openEdit(row: BillRow) {
    setActiveRow(row);
    setForm(formFromBill(row.bill));
    setEditOpen(true);
  }

  async function handleSave(isEdit: boolean) {
    if (!actions) return;
    setSaving(true);
    try {
      const amount = Number(form.amount);
      const dueDate = new Date(form.dueDate);
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
        await actions.editBill(activeRow.bill, params);
        setEditOpen(false);
      } else {
        await actions.createBill(params);
        setAddOpen(false);
      }
      setActiveRow(null);
    } catch (e) {
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

  async function handleMarkPaid(row: BillRow) {
    if (!actions || !row.occurrence) return;
    try {
      await actions.markPaid(row.bill, row.occurrence);
    } catch (e) {
      toast.error("Couldn't mark bill as paid", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleSkip(row: BillRow) {
    if (!actions || !row.occurrence) return;
    try {
      await actions.skipOccurrence(row.bill, row.occurrence);
    } catch (e) {
      toast.error("Couldn't skip this bill", e instanceof Error ? e.message : "Please try again.");
    }
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
          <ClayButton size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="size-3.5" />
            Add Bill
          </ClayButton>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="flex flex-col gap-2 rounded-3xl border border-border/50 bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Due This Month</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{formatCurrency(stats.dueThisMonth)}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-expense/20 bg-expense/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Overdue</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-expense">{stats.overdueCount}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-success/20 bg-success/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Paid</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-success">{stats.paidCount}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-3xl border border-primary/20 bg-primary/8 p-4">
          <p className="text-xs font-medium text-muted-foreground">Upcoming</p>
          <p className="font-mono text-xl font-semibold tabular-nums text-primary">{stats.upcomingCount}</p>
        </div>
      </div>

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
            <BillCard key={row.bill.id} row={row} onClick={() => setActiveRow(row)} />
          ))}
        </Stagger>
      )}

      <DetailDrawer
        open={activeRow != null && !editOpen && !deleteOpen}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRow?.bill.name ?? ""}
        description={activeRow ? RECURRENCE_LABEL[activeRow.bill.recurrence] : undefined}
        footer={
          activeRow && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <ClayButton variant="secondary" className="flex-1" onClick={() => handleMarkPaid(activeRow)}>
                  Mark Paid
                </ClayButton>
                <ClayButton variant="secondary" className="flex-1" onClick={() => handleSkip(activeRow)}>
                  Skip
                </ClayButton>
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
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
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
            <input
              type="date"
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
                    {a.name}
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
