"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  WS_FIELD,
  WS_GHOST,
  WS_PRIMARY,
  WsField,
} from "@/features/people/components/workspace/person-workspace-ui";
import { cn } from "@/lib/utils";
import { handleEnterAdvance } from "@/components/finance/enter-advance";

export interface AddPersonValues {
  name: string;
  phone: string | null;
  email: string | null;
  /** FlowFi sign: positive = they owe you. */
  openingBalance: number;
}

/**
 * Add Person, expanded in place under the page header — no dialog. Name first; contact details and an
 * opening balance (the fields `createPerson` already supports) sit behind "More details". The panel
 * collapses with a 200ms row/opacity transition and is remounted (`formKey`) on every open so it
 * always starts empty.
 */
export function AddPersonInline({
  open,
  formKey,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  formKey: number;
  onCancel: () => void;
  onSubmit: (values: AddPersonValues) => Promise<void>;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <AddPersonForm key={formKey} open={open} onCancel={onCancel} onSubmit={onSubmit} />
      </div>
    </div>
  );
}

function AddPersonForm({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (values: AddPersonValues) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [opening, setOpening] = useState("");
  const [openingSide, setOpeningSide] = useState<"theyOwe" | "iOwe">("theyOwe");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) nameRef.current?.focus({ preventScroll: true });
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a name.");
    const amount = opening.trim() ? Number(opening) : 0;
    if (!Number.isFinite(amount) || amount < 0)
      return setError("Opening balance must be a positive amount.");
    setError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: trimmed,
        phone: phone.trim() || null,
        email: email.trim() || null,
        openingBalance: openingSide === "iOwe" ? -amount : amount,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't add this person. Please try again.",
      );
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) onCancel();
        handleEnterAdvance(e);
      }}
      className="mt-3 flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-e1"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-[15px] font-semibold text-foreground">
          Add a person
        </h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Track money between you and someone.
        </span>
      </div>

      {/* Name + actions on one line — the common case is a name and Enter */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          ref={nameRef}
          className={cn(WS_FIELD, "sm:flex-1")}
          placeholder="Name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error != null && !name.trim()}
          maxLength={80}
        />
        <div className="flex shrink-0 items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className={WS_GHOST}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className={WS_PRIMARY}
          >
            {saving ? "Adding…" : "Add Person"}
          </button>
        </div>
      </div>

      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
        className="-my-1 flex h-6 w-fit items-center gap-1 rounded-[6px] text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", more && "rotate-180")}
          strokeWidth={2}
        />
        {more ? "Fewer details" : "Phone, email, opening balance (optional)"}
      </button>

      {more && (
        <div className="grid animate-in gap-3 fade-in slide-in-from-top-1 duration-200 sm:grid-cols-2">
          <WsField label="Phone">
            <input
              className={WS_FIELD}
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </WsField>
          <WsField label="Email">
            <input
              className={WS_FIELD}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </WsField>
          <WsField
            label="Opening balance"
            hint="Anything already pending before you start tracking."
            className="sm:col-span-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-36">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
                  ₹
                </span>
                <input
                  className={cn(WS_FIELD, "pl-7 tabular-nums")}
                  inputMode="decimal"
                  placeholder="0"
                  value={opening}
                  onChange={(e) =>
                    setOpening(e.target.value.replace(/[^\d.]/g, ""))
                  }
                />
              </div>
              <div
                role="radiogroup"
                aria-label="Who owes whom"
                className="inline-flex h-9 items-center gap-0.5 rounded-[7px] border border-border bg-secondary p-0.5"
              >
                {(
                  [
                    { value: "theyOwe", label: "You need to receive" },
                    { value: "iOwe", label: "You need to give" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={openingSide === o.value}
                    onClick={() => setOpeningSide(o.value)}
                    className={cn(
                      "h-full rounded-[5px] border px-2.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      openingSide === o.value
                        ? "border-primary-accent-text bg-primary font-semibold text-primary-foreground"
                        : "border-transparent font-medium text-muted-foreground hover:bg-card hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </WsField>
        </div>
      )}

      {error && (
        <p className="text-xs font-medium text-expense" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
