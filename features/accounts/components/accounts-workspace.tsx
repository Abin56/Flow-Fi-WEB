"use client";

import { Banknote, Briefcase, Check, CreditCard, FileText, Landmark, Layers, Plus, User, Wallet, X as XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { DestructiveDeleteDialog, SectionLabel, type DestructiveDeleteImpactRow } from "@/components/finance";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountOverviewPanel } from "@/features/accounts/components/account-overview-panel";
import { AccountsHeader } from "@/features/accounts/components/accounts-header";
import { AccountsStats } from "@/features/accounts/components/accounts-stats";
import { AccountsToolbar } from "@/features/accounts/components/accounts-toolbar";
import { AccountTile } from "@/features/accounts/components/account-tile";
import { RecentAccountTransactions } from "@/features/accounts/components/recent-account-transactions";
import { ACCOUNT_COLOR } from "@/features/accounts/lib/account-colors";
import {
  ACCOUNT_COLOR_CYCLE,
  accountColorForColorValue,
  colorValueForAccountColor,
  useAccountActions,
  useAccountsOverview,
  type AccountDeletionImpact,
} from "@/features/accounts/hooks/use-accounts-data";
import { useAccounts } from "@/hooks/use-accounts";
import type { Account, AccountType } from "@/lib/models/account";
import type { AccountColor } from "@/lib/mock/accounts-overview-data";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string; icon: LucideIcon }[] = [
  { value: "bank", label: "Bank", icon: Landmark },
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "wallet", label: "Wallet", icon: Wallet },
  { value: "card", label: "Card", icon: CreditCard },
  { value: "business", label: "Business", icon: Briefcase },
  { value: "other", label: "Other", icon: Layers },
];

interface AccountFormState {
  name: string;
  type: AccountType;
  openingBalance: string;
  accountHolderName: string;
  accountNumberLast4: string;
  notes: string;
  color: AccountColor;
}

function emptyAccountForm(color: AccountColor): AccountFormState {
  return { name: "", type: "bank", openingBalance: "", accountHolderName: "", accountNumberLast4: "", notes: "", color };
}

function accountFormFromAccount(account: Account): AccountFormState {
  return {
    name: account.name,
    type: account.type,
    openingBalance: String(account.openingBalance),
    accountHolderName: account.accountHolderName ?? "",
    accountNumberLast4: account.accountNumberLast4 ?? "",
    notes: account.notes ?? "",
    color: accountColorForColorValue(account.colorValue),
  };
}

export function AccountsWorkspace() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("All Types");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [overviewOpen, setOverviewOpen] = useState(true);

  const { items: accountsOverviewList, isLoading } = useAccountsOverview();
  const { data: rawAccounts = [] } = useAccounts();
  const actions = useAccountActions();

  const [addOpen, setAddOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<AccountDeletionImpact | null>(null);
  const [form, setForm] = useState<AccountFormState>(() => emptyAccountForm("blue"));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function openAdd() {
    // Defaults to the next unused color in the cycle, same idea as the credit card tiles'
    // accent — just a sensible starting point, not a lock-in; the picker below lets it be changed.
    setForm(emptyAccountForm(ACCOUNT_COLOR_CYCLE[accountsOverviewList.length % ACCOUNT_COLOR_CYCLE.length]!));
    setFormError(null);
    setAddOpen(true);
  }

  function openEdit(account: Account) {
    setEditingAccount(account);
    setForm(accountFormFromAccount(account));
    setFormError(null);
  }

  async function handleSave() {
    if (!actions) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("Account name is required.");
      return;
    }
    if (form.accountNumberLast4 && !/^\d{4}$/.test(form.accountNumberLast4)) {
      setFormError("Account number must be exactly 4 digits.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editingAccount) {
        await actions.editAccount(editingAccount, {
          name,
          type: form.type,
          colorValue: colorValueForAccountColor(form.color),
          accountHolderName: form.accountHolderName || null,
          accountNumberLast4: form.accountNumberLast4 || null,
          notes: form.notes || null,
        });
        setEditingAccount(null);
      } else {
        const openingBalance = Number(form.openingBalance);
        if (!Number.isFinite(openingBalance)) {
          setFormError("Opening balance must be a number.");
          setSaving(false);
          return;
        }
        await actions.createAccount({
          name,
          type: form.type,
          openingBalance,
          colorValue: colorValueForAccountColor(form.color),
          accountHolderName: form.accountHolderName || null,
          accountNumberLast4: form.accountNumberLast4 || null,
          notes: form.notes || null,
        });
        setAddOpen(false);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!actions || !deletingAccount) return;
    let cancelled = false;
    actions.previewAccountDeletion(deletingAccount).then((impact) => {
      if (!cancelled) setDeletionImpact(impact);
    });
    return () => {
      cancelled = true;
    };
  }, [actions, deletingAccount]);

  const deletionImpactRows: DestructiveDeleteImpactRow[] | null = deletionImpact && [
    { label: `${deletionImpact.transactionCount} transaction${deletionImpact.transactionCount === 1 ? "" : "s"}`, count: deletionImpact.transactionCount },
    { label: `${deletionImpact.transferSiblingCount} linked transfer${deletionImpact.transferSiblingCount === 1 ? "" : "s"} on other accounts`, count: deletionImpact.transferSiblingCount },
    { label: `${deletionImpact.expenseCount} shared/assigned expense${deletionImpact.expenseCount === 1 ? "" : "s"}`, count: deletionImpact.expenseCount },
    { label: `${deletionImpact.affectedPersonCount} person${deletionImpact.affectedPersonCount === 1 ? "'s" : "s'"} balance will be recalculated`, count: deletionImpact.affectedPersonCount },
    { label: `${deletionImpact.billCount} bill${deletionImpact.billCount === 1 ? "" : "s"} paying from this account`, count: deletionImpact.billCount },
  ];

  async function handleDelete() {
    if (!actions || !deletingAccount) return;
    setDeleting(true);
    try {
      await actions.deleteAccount(deletingAccount);
      if (selectedId === deletingAccount.id) setSelectedId(undefined);
      setDeletingAccount(null);
    } catch {
      // Failed — the toast from useAccountActions already explains why; keep the
      // dialog open so the user isn't left guessing whether the delete "did nothing".
    } finally {
      setDeleting(false);
    }
  }

  function closeAccountDialog() {
    setAddOpen(false);
    setEditingAccount(null);
  }

  const selectedType = ACCOUNT_TYPE_OPTIONS.find((o) => o.value === form.type) ?? ACCOUNT_TYPE_OPTIONS[0];
  const SelectedTypeIcon = selectedType.icon;

  const filtered = useMemo(() => {
    return accountsOverviewList.filter((account) => {
      const matchesSearch = account.name.toLowerCase().includes(search.toLowerCase());
      const matchesType = type === "All Types" || account.typeLabel === type;
      return matchesSearch && matchesType;
    });
  }, [accountsOverviewList, search, type]);

  // Default the selected account once the live list arrives (mirrors the
  // mock's "primary account, else first" default) without fighting the
  // user's own selection on later re-renders.
  const defaultId = accountsOverviewList.find((a) => a.isPrimary)?.id ?? accountsOverviewList[0]?.id;
  const effectiveId = selectedId ?? defaultId;
  const selected = accountsOverviewList.find((a) => a.id === effectiveId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <AccountsHeader />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <AccountsHeader />
        <AccountsStats />

        <div className="flex flex-col gap-4">
          <AccountsToolbar
            count={accountsOverviewList.length}
            search={search}
            onSearchChange={setSearch}
            type={type}
            onTypeChange={setType}
            view={view}
            onViewChange={setView}
          />

          {accountsOverviewList.length === 0 ? (
            <div className="surface-flat flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-12 text-center text-muted-foreground">
              <p className="text-sm font-medium text-foreground">No accounts yet</p>
              <p className="text-xs">Add your first bank, wallet, or cash account to get started.</p>
              <button
                type="button"
                onClick={openAdd}
                className="mt-2 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="size-4" />
                Add New Account
              </button>
            </div>
          ) : (
            <div className={view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-3"}>
              {filtered.map((account) => (
                <AccountTile
                  key={account.id}
                  account={account}
                  active={account.id === effectiveId}
                  onSelect={() => {
                    setSelectedId(account.id);
                    setOverviewOpen(true);
                  }}
                />
              ))}

              <button
                type="button"
                onClick={openAdd}
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-8 text-center text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-current">
                  <Plus className="size-4" />
                </span>
                <span className="text-sm font-medium">Add New Account</span>
                <span className="text-xs">Bank, Wallet, Cash, or UPI</span>
              </button>
            </div>
          )}
        </div>

        <RecentAccountTransactions />
      </div>

      {overviewOpen && selected && (
        <AccountOverviewPanel
          account={selected}
          onClose={() => setOverviewOpen(false)}
          onEdit={() => {
            const raw = (rawAccounts as Account[]).find((a) => a.id === selected.id);
            if (raw) openEdit(raw);
          }}
          onDelete={() => {
            const raw = (rawAccounts as Account[]).find((a) => a.id === selected.id);
            if (raw) {
              setDeletionImpact(null);
              setDeletingAccount(raw);
            }
          }}
        />
      )}

      <Dialog open={addOpen || editingAccount != null} onOpenChange={(open) => !open && closeAccountDialog()}>
        <DialogContent showCloseButton={false} className="gap-0 overflow-hidden rounded-none border border-border p-0 shadow-lg ring-0 sm:max-w-xl">
          <div className="h-1 w-full bg-primary" />

          <button
            type="button"
            onClick={closeAccountDialog}
            aria-label="Close"
            className="absolute top-4 right-4 flex size-7 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>

          <DialogHeader className="gap-1 border-b border-border bg-muted/40 px-6 py-5 text-left">
            <DialogTitle className="font-heading text-lg font-semibold">
              {editingAccount ? `Edit ${editingAccount.name}` : "Add an Account"}
            </DialogTitle>
            {!editingAccount && (
              <DialogDescription>A few details to start tracking balances and transactions.</DialogDescription>
            )}
          </DialogHeader>

          <div className="flex flex-col gap-6 px-6 py-5 text-sm">
            <div className="flex items-center gap-3 border border-border bg-muted/30 p-4">
              <span
                className={cn("flex size-11 shrink-0 items-center justify-center border border-border shadow-sm", ACCOUNT_COLOR[form.color].onGradient)}
                style={{ background: ACCOUNT_COLOR[form.color].gradient }}
              >
                <SelectedTypeIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{form.name.trim() || "Account Name"}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedType.label}
                  {form.accountNumberLast4 ? ` • •••• ${form.accountNumberLast4}` : ""}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 bg-muted/30 p-4">
              <SectionLabel icon={Wallet}>Account Details</SectionLabel>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Account Name</span>
                <div className="relative">
                  <SelectedTypeIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className="h-10 w-full rounded-none border border-border bg-background pr-3 pl-9 text-sm outline-none transition-colors focus:border-primary"
                    placeholder="e.g. HDFC Savings"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Account Type</span>
                <div className="flex flex-wrap gap-2">
                  {ACCOUNT_TYPE_OPTIONS.map((o) => {
                    const selected = form.type === o.value;
                    const Icon = o.icon;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, type: o.value }))}
                        className={cn(
                          "flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <Icon className="size-3.5" />
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Color</span>
                <div className="flex flex-wrap gap-2">
                  {ACCOUNT_COLOR_CYCLE.map((c) => {
                    const selected = form.color === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        onClick={() => setForm((f) => ({ ...f, color: c }))}
                        className={cn(
                          "flex size-8 items-center justify-center border transition-colors",
                          selected ? "border-foreground" : "border-transparent hover:border-border",
                        )}
                        style={{ background: ACCOUNT_COLOR[c].gradient }}
                      >
                        {selected && <Check className={cn("size-4", ACCOUNT_COLOR[c].onGradient)} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {!editingAccount && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Opening Balance</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                    <input
                      type="number"
                      className="h-10 w-full rounded-none border border-primary/30 bg-primary/5 pr-3 pl-7 text-base font-semibold outline-none transition-colors focus:border-primary"
                      placeholder="0.00"
                      value={form.openingBalance}
                      onChange={(e) => setForm((f) => ({ ...f, openingBalance: e.target.value }))}
                    />
                  </div>
                </label>
              )}
            </div>

            <div className="flex flex-col gap-3 bg-muted/30 p-4">
              <SectionLabel icon={FileText}>Additional Info (optional)</SectionLabel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Account Holder</span>
                  <div className="relative">
                    <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      className="h-10 w-full rounded-none border border-border bg-background pr-3 pl-9 text-sm outline-none transition-colors focus:border-primary"
                      value={form.accountHolderName}
                      onChange={(e) => setForm((f) => ({ ...f, accountHolderName: e.target.value }))}
                    />
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Last 4 Digits</span>
                  <input
                    className="h-10 rounded-none border border-border bg-background px-3 font-mono text-sm tracking-widest outline-none transition-colors focus:border-primary"
                    placeholder="4021"
                    maxLength={4}
                    value={form.accountNumberLast4}
                    onChange={(e) => setForm((f) => ({ ...f, accountNumberLast4: e.target.value.replace(/\D/g, "") }))}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Notes</span>
                <textarea
                  className="min-h-20 resize-none rounded-none border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </label>
            </div>

            {formError && (
              <p className="flex items-center gap-1.5 border border-expense/30 bg-expense/8 px-3 py-2 text-xs font-medium text-expense">
                {formError}
              </p>
            )}
          </div>

          <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4">
            <ClayButton variant="ghost" className="rounded-none" onClick={closeAccountDialog} disabled={saving}>
              Cancel
            </ClayButton>
            <ClayButton variant="primary" className="rounded-none" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : editingAccount ? "Save Changes" : "Save"}
            </ClayButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveDeleteDialog
        open={deletingAccount != null}
        onOpenChange={(open) => !open && setDeletingAccount(null)}
        entityLabel="account"
        entityName={deletingAccount?.name ?? "this account"}
        impact={deletionImpactRows}
        onConfirm={handleDelete}
        confirming={deleting}
      />
    </div>
  );
}
