"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus } from "lucide-react";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { Person } from "@/lib/models/person";
import type { SplitType } from "@/lib/models/expense";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

interface ExtraParticipant {
  name: string;
  value: string;
}

/**
 * Web port of Flutter's `AddExpenseChooser` -> `SplitExpenseFormSheet`/
 * `AssignExpenseSheet`, entered from a Person's own panel with them already
 * filled in as a participant (mirrors `forPerson` prefill). "Assign fully"
 * mirrors `AssignExpenseSheet`/`ExpenseRepository.assignToPerson` — the
 * degenerate one-participant-owes-it-all case. Multi-person splits reuse the
 * same `ExpenseRepository.createExpense`/`resolveShares` engine the
 * Transactions page's split dialog calls.
 */
export function ShareExpenseDialog({
  open,
  onOpenChange,
  person,
  accounts,
  categories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: Person;
  accounts: Account[];
  categories: Category[];
}) {
  const actions = useTransactionActions();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [includeMe, setIncludeMe] = useState(true);
  const [assignFully, setAssignFully] = useState(false);
  const [personShare, setPersonShare] = useState("");
  const [extraParticipants, setExtraParticipants] = useState<ExtraParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the form when the dialog transitions from closed to open — an
  // in-render adjustment (not a useEffect) so it happens in the same commit
  // instead of triggering an extra render. See https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDescription("");
      setAmount("");
      const firstExpenseCategory = categories.find((c) => c.type !== "income");
      setAccountId(accounts[0]?.id ?? "");
      setCategoryId(firstExpenseCategory?.id ?? "");
      setDate(new Date().toISOString().slice(0, 10));
      setNotes("");
      setSplitType("equal");
      setIncludeMe(true);
      setAssignFully(false);
      setPersonShare("");
      setExtraParticipants([]);
      setError(null);
    }
  }

  function addExtraParticipant() {
    setExtraParticipants((p) => [...p, { name: "", value: "" }]);
  }

  function updateExtraParticipant(index: number, patch: Partial<ExtraParticipant>) {
    setExtraParticipants((p) => p.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeExtraParticipant(index: number) {
    setExtraParticipants((p) => p.filter((_, i) => i !== index));
  }

  function validate(): string | null {
    if (!description.trim()) return "Description is required.";
    const total = Number(amount);
    if (!amount.trim() || Number.isNaN(total) || total <= 0) return "Enter an amount greater than 0.";
    if (!accountId) return "Select an account.";
    if (!categoryId) return "Select a category.";
    if (!date) return "Select a date.";
    if (assignFully) return null;
    if (splitType !== "equal") {
      const share = Number(personShare);
      if (personShare.trim() === "" || Number.isNaN(share) || share < 0) {
        return `Enter a valid ${splitType === "percentage" ? "percentage" : "amount"} for ${person.name}.`;
      }
      for (const p of extraParticipants) {
        if (p.name.trim() === "") continue;
        const v = Number(p.value);
        if (p.value.trim() === "" || Number.isNaN(v) || v < 0) {
          return `Enter a valid ${splitType === "percentage" ? "percentage" : "amount"} for ${p.name}.`;
        }
      }
    }
    return null;
  }

  async function handleSave() {
    if (!actions) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const totalAmount = Number(amount);

      let participantInputs: ExpenseParticipantInput[];
      let effectiveSplitType: SplitType;

      if (assignFully) {
        effectiveSplitType = "custom";
        participantInputs = [{ personId: person.id, name: person.name, value: totalAmount }];
      } else {
        effectiveSplitType = splitType;
        const others = extraParticipants
          .filter((p) => p.name.trim() !== "")
          .map((p) => ({ personId: null, name: p.name.trim(), value: splitType === "equal" ? null : Number(p.value) }));
        const personInput = {
          personId: person.id,
          name: person.name,
          value: splitType === "equal" ? null : Number(personShare),
        };
        participantInputs = includeMe
          ? [
              {
                name: "Me",
                isMe: true,
                value:
                  splitType === "equal"
                    ? null
                    : totalAmount - (personInput.value ?? 0) - others.reduce((sum, p) => sum + (p.value ?? 0), 0),
              },
              personInput,
              ...others,
            ]
          : [personInput, ...others];
      }

      await actions.createSplitTransaction({
        description: description.trim(),
        totalAmount,
        date: new Date(date),
        categoryId,
        accountId,
        splitType: effectiveSplitType,
        participantInputs,
        notes,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this expense");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Share Expense — {person.name}</DialogTitle>
          <DialogDescription>Split an expense with {person.name}, tracked against their balance.</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <div className="flex flex-col gap-3 py-1 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              <input
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                placeholder="e.g. Dinner at Cafe"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Total Amount</span>
              <input
                type="number"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Account</span>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="h-10 w-full rounded-xl">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
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
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger className="h-10 w-full rounded-xl">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Date</span>
              <input
                type="date"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-border/60"
                checked={assignFully}
                onChange={(e) => setAssignFully(e.target.checked)}
              />
              Assign fully to {person.name} (they pay the whole thing)
            </label>

            {!assignFully && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Split Type</span>
                  <Select value={splitType} onValueChange={(v) => setSplitType(v as SplitType)}>
                    <SelectTrigger className="h-10 w-full rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SPLIT_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-border/60"
                    checked={includeMe}
                    onChange={(e) => setIncludeMe(e.target.checked)}
                  />
                  Include my own share
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Split With</span>
                  <div className="flex items-center gap-2">
                    <div className="clay-pressed flex h-10 flex-1 items-center rounded-xl px-3 text-sm">{person.name}</div>
                    {splitType !== "equal" && (
                      <input
                        type="number"
                        className="clay-pressed h-10 w-24 rounded-xl px-3 text-sm outline-none"
                        placeholder={splitType === "percentage" ? "%" : "Amount"}
                        value={personShare}
                        onChange={(e) => setPersonShare(e.target.value)}
                      />
                    )}
                  </div>
                  {extraParticipants.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className="clay-pressed h-10 flex-1 rounded-xl px-3 text-sm outline-none"
                        placeholder="Name"
                        value={p.name}
                        onChange={(e) => updateExtraParticipant(i, { name: e.target.value })}
                      />
                      {splitType !== "equal" && (
                        <input
                          type="number"
                          className="clay-pressed h-10 w-24 rounded-xl px-3 text-sm outline-none"
                          placeholder={splitType === "percentage" ? "%" : "Amount"}
                          value={p.value}
                          onChange={(e) => updateExtraParticipant(i, { value: e.target.value })}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeExtraParticipant(i)}
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-expense"
                        aria-label="Remove participant"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <ClayButton type="button" variant="ghost" size="sm" onClick={addExtraParticipant} className="self-start gap-1.5">
                    <Plus className="size-3.5" />
                    Add another person
                  </ClayButton>
                </div>
              </>
            )}

            {error && <p className="text-xs text-expense">{error}</p>}
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <ClayButton variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </ClayButton>
          <ClayButton variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save Split"}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
