"use client";

import { ArrowUpRight, User, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { ChipRow, FLAT_INPUT, SectionLabel } from "@/components/finance";
import { FormSection, LOAN_EMI_INPUT, SegmentedControl } from "@/features/loans/components/loan-emi-ui";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";

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
  labelClassName,
  variant = "default",
}: {
  people: Person[];
  choice: OwnershipChoice;
  personId: string;
  onChange: (next: { choice: OwnershipChoice; personId: string }) => void;
  /** Render without the section wrapper/heading (for dialogs with their own layout). */
  bare?: boolean;
  /** Bare mode only — style the heading to match the host form's field labels. */
  labelClassName?: string;
  /** "section" — the Loan & EMI form pattern: its own titled section with a segmented For me | For someone else.
   *  "segmented" — the same controls without the section heading, for a host that titles it itself. */
  variant?: "default" | "section" | "segmented";
}) {
  const section = variant === "section" || variant === "segmented";
  const body = (
    <>
      {section ? (
        <SegmentedControl
          ariaLabel="Who is this for?"
          options={OWNERSHIP_OPTIONS.map((o) => ({ ...o, icon: o.value === "me" ? User : Users }))}
          value={choice}
          onChange={(v) => onChange({ choice: v, personId: v === "me" ? "" : personId })}
        />
      ) : (
        <ChipRow options={OWNERSHIP_OPTIONS} value={choice} onChange={(v) => onChange({ choice: v, personId: v === "me" ? "" : personId })} />
      )}
      {choice === "someoneElse" &&
        (people.length === 0 ? (
          <div className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-2.5", section ? "rounded-[6px] border border-dashed border-border-strong bg-secondary" : "rounded-xl border border-border bg-card")}>
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
          <label className={cn("flex flex-col gap-1.5", section && "max-w-md animate-in fade-in-0 slide-in-from-top-1 duration-200")}>
            <span className={section ? "text-xs font-semibold text-foreground" : "text-xs font-medium text-muted-foreground"}>Person</span>
            <select className={section ? LOAN_EMI_INPUT : FLAT_INPUT} value={personId} onChange={(e) => onChange({ choice, personId: e.target.value })}>
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
      <p className={cn("text-xs text-muted-foreground", section && choice === "me" && "hidden")}>
        {choice === "someoneElse"
          ? "It's still tracked as your liability — the person is linked so you know who it was for."
          : "A normal Loan/EMI of your own."}
      </p>
    </>
  );

  if (variant === "segmented") return <div className="flex flex-col gap-3">{body}</div>;

  if (section) {
    return (
      <FormSection title="Who is this for?">
        <div className="flex flex-col gap-3">{body}</div>
      </FormSection>
    );
  }

  if (bare) {
    return (
      <div className="grid gap-2 text-sm">
        <span className={labelClassName}>Who is this for?</span>
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
