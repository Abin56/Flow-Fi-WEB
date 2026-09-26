"use client";

import { ArrowUpRight, UserRound } from "lucide-react";
import Link from "next/link";
import { ChipRow, FLAT_INPUT, SectionLabel } from "@/components/finance";
import type { Person } from "@/lib/models/person";

export type OwnershipChoice = "me" | "someoneElse";

const OWNERSHIP_OPTIONS: { value: OwnershipChoice; label: string }[] = [
  { value: "me", label: "For me" },
  { value: "someoneElse", label: "For someone else" },
];

/** The value to persist as `beneficiaryPersonId` — null for "For me". */
export function beneficiaryFromChoice(choice: OwnershipChoice, personId: string): string | null {
  return choice === "someoneElse" && personId !== "" ? personId : null;
}

/** Why the ownership choice can't be saved yet, or null when it can. */
export function ownershipError(choice: OwnershipChoice, personId: string): string | null {
  return choice === "someoneElse" && personId === "" ? "Choose who this is for" : null;
}

/**
 * "Who is this for?" — For me (default) / For someone else + an existing Person from People. Only
 * picks existing People (no inline create) so the same person is never added twice. Purely an
 * association: the Loan/EMI stays the user's own liability either way — see `Loan.beneficiaryPersonId`.
 */
export function WhoIsThisForField({
  people,
  choice,
  personId,
  onChange,
  bare = false,
}: {
  people: Person[];
  choice: OwnershipChoice;
  personId: string;
  onChange: (next: { choice: OwnershipChoice; personId: string }) => void;
  /** Render without the section wrapper/heading (for dialogs with their own layout). */
  bare?: boolean;
}) {
  const body = (
    <>
      <ChipRow options={OWNERSHIP_OPTIONS} value={choice} onChange={(v) => onChange({ choice: v, personId: v === "me" ? "" : personId })} />
      {choice === "someoneElse" &&
        (people.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
            <p className="text-xs text-muted-foreground">No people yet — add them in People, then come back.</p>
            <Link
              href="/people"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Go to People
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Person</span>
            <select className={FLAT_INPUT} value={personId} onChange={(e) => onChange({ choice, personId: e.target.value })}>
              <option value="" disabled>
                Choose a person
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      <p className="text-xs text-muted-foreground">
        {choice === "someoneElse"
          ? "It's still tracked as your liability — the person is linked so you know who it was for."
          : "A normal Loan/EMI of your own."}
      </p>
    </>
  );

  if (bare) {
    return (
      <div className="grid gap-2 text-sm">
        <span>Who is this for?</span>
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 bg-muted/30 p-4">
      <SectionLabel icon={UserRound}>Who is this for?</SectionLabel>
      {body}
    </div>
  );
}
