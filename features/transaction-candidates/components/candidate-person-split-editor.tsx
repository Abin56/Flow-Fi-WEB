"use client";

/**
 * "Assign to a person" / "Split this expense" editor for an SMS candidate import draft — extracted
 * from `CandidateDetailsModal` so `BulkImportDialog` (importing a whole selection of candidates at
 * once) can offer the exact same person/split controls without a second copy of this ~150-line
 * markup drifting out of sync. Purely a controlled view over `CandidateImportDraft`'s person/split
 * fields (see `candidate-details-view.ts`) — the caller owns the draft and passes `onChange`; this
 * component never talks to a repository directly except via `onCreatePerson`.
 *
 * Never rendered for a credit (income) candidate/selection — callers gate that themselves (same rule
 * `resolvePersonAssignment` enforces at import time), since the "why" differs slightly between a
 * single candidate (`currentCandidate.direction`) and a locked bulk selection (`direction` prop).
 */

import { useState } from "react";
import { Check, Plus, SplitSquareHorizontal, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/finance/transaction-details-shell";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import type { SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import type { CandidateImportDraft } from "../lib/candidate-details-view";

const FIELD_BORDER = "border-foreground/15";

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

export function CandidatePersonSplitEditor({
  draft,
  onChange,
  people,
  onCreatePerson,
}: {
  draft: Pick<CandidateImportDraft, "personId" | "owesPersonToggle" | "splitOpen" | "splitType" | "participants">;
  onChange: (patch: Partial<CandidateImportDraft>) => void;
  people: Person[];
  onCreatePerson: (name: string) => Promise<Person>;
}) {
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [addingPersonBusy, setAddingPersonBusy] = useState(false);

  async function handleAddPerson() {
    if (!newPersonName.trim()) return;
    setAddingPersonBusy(true);
    try {
      const person = await onCreatePerson(newPersonName.trim());
      onChange({ personId: person.id });
      setAddingPerson(false);
      setNewPersonName("");
    } catch (e) {
      toast.error("Couldn't add person", e instanceof Error ? e.message : undefined);
    } finally {
      setAddingPersonBusy(false);
    }
  }

  function updateParticipant(index: number, patch: Partial<CandidateImportDraft["participants"][number]>) {
    onChange({ participants: draft.participants.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  }
  function addParticipantRow() {
    onChange({ participants: [...draft.participants, { personId: null, name: "", value: "" }] });
  }
  function removeParticipantRow(index: number) {
    onChange({ participants: draft.participants.filter((_, i) => i !== index) });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Assign to a person">
        {!addingPerson ? (
          <Select
            value={draft.personId ?? "none"}
            onValueChange={(v) => {
              if (v === "add-new") {
                setAddingPerson(true);
                return;
              }
              onChange({ personId: v === "none" ? null : v, owesPersonToggle: v === "none" ? false : draft.owesPersonToggle });
            }}
          >
            <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
              <SelectValue placeholder="No one" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No one</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              <SelectItem value="add-new">
                <span className="flex items-center gap-1.5">
                  <UserPlus className="size-3.5" /> Add new person
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder="Person's name"
              value={newPersonName}
              className={FIELD_BORDER}
              onChange={(e) => setNewPersonName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAddPerson()}
            />
            <Button size="icon-sm" onClick={() => void handleAddPerson()} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
              <Check className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
              <X className="size-4" />
            </Button>
          </div>
        )}
      </Field>

      {!draft.splitOpen && (
        <button
          type="button"
          onClick={() => onChange({ splitOpen: true })}
          className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-primary hover:underline"
        >
          <SplitSquareHorizontal className="size-3.5" />
          Split with more people instead
        </button>
      )}

      {draft.personId && !draft.splitOpen && (
        <label className="flex items-start gap-2 border-t border-foreground/10 pt-3 text-sm">
          <Switch checked={draft.owesPersonToggle} onCheckedChange={(checked) => onChange({ owesPersonToggle: checked })} className="mt-0.5" />
          <span>
            <span className="block text-foreground">This person owes me this expense</span>
            <span className="block text-xs text-muted-foreground">Adds this amount to what they owe you.</span>
          </span>
        </label>
      )}

      {draft.splitOpen && (
        <div className="flex flex-col gap-3 border-t border-foreground/10 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Split this expense</p>
            <button type="button" onClick={() => onChange({ splitOpen: false })} className="text-xs text-muted-foreground hover:underline">
              Hide split editor
            </button>
          </div>
          <Select value={draft.splitType} onValueChange={(v) => onChange({ splitType: v as SplitType })}>
            <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
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

          <div className="flex flex-col gap-2">
            {draft.participants.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={p.personId ?? "custom"}
                  onValueChange={(v) => {
                    if (v === "custom") {
                      updateParticipant(i, { personId: null });
                      return;
                    }
                    const person = people.find((person) => person.id === v);
                    updateParticipant(i, { personId: v, name: person?.name ?? p.name });
                  }}
                >
                  <SelectTrigger className={cn("h-9 w-32 shrink-0", FIELD_BORDER)}>
                    <SelectValue placeholder="Person" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">Custom name</SelectItem>
                    {people.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {p.personId == null && (
                  <Input placeholder="Name" value={p.name} className={cn("h-9", FIELD_BORDER)} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                )}
                {draft.splitType !== "equal" && (
                  <Input
                    type="number"
                    placeholder={draft.splitType === "percentage" ? "%" : "Amount"}
                    value={p.value}
                    className={cn("h-9 w-24 shrink-0", FIELD_BORDER)}
                    onChange={(e) => updateParticipant(i, { value: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  onClick={() => removeParticipantRow(i)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-expense"
                  aria-label="Remove participant"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={addParticipantRow} className="w-fit gap-1.5">
              <Plus className="size-3.5" />
              Add person
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
