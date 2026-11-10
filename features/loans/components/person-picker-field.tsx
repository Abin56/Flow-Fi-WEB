"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { LOAN_EMI_INPUT } from "@/features/loans/components/loan-emi-ui";
import type { Person } from "@/lib/models/person";

/** Small "go create it there" link — sends the user to the page that owns that record instead of an inline form. */
export function AddElsewhereLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowUpRight className="size-3.5" />
    </Link>
  );
}

const ADD_NEW_PERSON_VALUE = "__add_new_person__";

/**
 * Person picker for a personal loan's lender/borrower — a native `<select>` (matching the People
 * picker pattern already used elsewhere on this form, e.g. "Who actually pays the EMIs?") plus an
 * inline "+ Add new person" option that reveals a name field and creates the Person on confirm, so
 * choosing a lender never requires leaving the loan form first.
 */
export function PersonPickerField({
  label,
  people,
  value,
  disabled,
  onChange,
  onCreatePerson,
  lockedHint,
}: {
  label: string;
  people: Person[];
  value: string;
  disabled: boolean;
  onChange: (personId: string) => void;
  onCreatePerson?: (name: string) => Promise<Person>;
  lockedHint?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!onCreatePerson) return;
    const name = newName.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const person = await onCreatePerson(name);
      onChange(person.id);
      setAdding(false);
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add person.");
    } finally {
      setCreating(false);
    }
  }

  if (adding) {
    return (
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-semibold text-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className={LOAN_EMI_INPUT}
            placeholder="Person's name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <ClayButton type="button" size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Adding…" : "Add"}
          </ClayButton>
          <ClayButton
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setNewName("");
              setError(null);
            }}
          >
            Cancel
          </ClayButton>
        </div>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </label>
    );
  }

  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <select
        className={LOAN_EMI_INPUT}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === ADD_NEW_PERSON_VALUE) {
            setAdding(true);
            return;
          }
          onChange(e.target.value);
        }}
      >
        <option value="" disabled>
          Choose a person
        </option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {onCreatePerson && <option value={ADD_NEW_PERSON_VALUE}>+ Add new person</option>}
      </select>
      {lockedHint && <span className="text-xs text-muted-foreground">{lockedHint}</span>}
    </label>
  );
}
