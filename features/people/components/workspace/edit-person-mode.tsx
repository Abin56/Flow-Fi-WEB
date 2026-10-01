"use client";

import { useState } from "react";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { ModeFooter, ModeHeader, WS_FIELD, WS_GHOST, WS_PAD, WS_PRIMARY, WsField } from "./person-workspace-ui";
import { handleEnterAdvance } from "@/components/finance/enter-advance";

export interface EditPersonPatch {
  name: string;
  phone: string | null;
  email: string | null;
  notes: string;
}

/** Edit mode — the same contact fields and `editPerson` payload the old Edit Person dialog sent. */
export function EditPersonMode({
  person,
  onBack,
  onSave,
}: {
  person: Person;
  onBack: () => void;
  onSave: (patch: EditPersonPatch) => Promise<void>;
}) {
  const [name, setName] = useState(person.name);
  const [phone, setPhone] = useState(person.phone ?? "");
  const [email, setEmail] = useState(person.email ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Name is required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ name: trimmed, phone: phone || null, email: email || null, notes: person.notes });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={handleEnterAdvance} className="flex min-h-full flex-col">
      <ModeHeader backLabel={person.name} onBack={onBack} title={`Edit ${person.name}`} subtitle="Contact details" />

      <div className={cn(WS_PAD, "mt-5 flex max-w-lg flex-1 flex-col gap-3.5")}>
        <WsField label="Name" error={nameError}>
          <input
            autoFocus
            aria-invalid={!!nameError || undefined}
            className={cn(WS_FIELD, "h-10 text-[15px] font-medium")}
            placeholder="e.g. Priya Sharma"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />
        </WsField>
        <div className="grid gap-3 sm:grid-cols-2">
          <WsField label="Phone (optional)">
            <input type="tel" className={WS_FIELD} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </WsField>
          <WsField label="Email (optional)">
            <input type="email" className={WS_FIELD} value={email} onChange={(e) => setEmail(e.target.value)} />
          </WsField>
        </div>
      </div>

      <ModeFooter>
        {saveError && <p className="mr-auto text-xs font-medium text-expense">{saveError}</p>}
        <button type="button" onClick={onBack} disabled={saving} className={WS_GHOST}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={WS_PRIMARY}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </ModeFooter>
    </form>
  );
}
