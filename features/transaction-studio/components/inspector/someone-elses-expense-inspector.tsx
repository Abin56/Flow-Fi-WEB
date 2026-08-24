"use client";

import { useState } from "react";
import { UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Person } from "@/lib/models/person";
import type { GridRow } from "../../lib/grid-types";
import { InspectorShell } from "./inspector-shell";

/** Action = Someone Else's Expense — a single-person degenerate case of the split flow, matching `ExpenseRepository.assignToPerson` (architecture §5). */
export function SomeoneElsesExpenseInspector({
  row,
  people,
  onCommit,
  onClose,
  hideClose,
  embedded,
}: {
  row: GridRow;
  people: Person[];
  onCommit: (personId: string | null, personName: string) => void;
  onClose: () => void;
  hideClose?: boolean;
  embedded?: boolean;
}) {
  const existing = row.actionDetail?.kind === "someone_elses_expense" ? row.actionDetail : null;
  const [freeText, setFreeText] = useState(existing?.personId ? "" : (existing?.personName ?? ""));

  return (
    <InspectorShell
      title="Someone Else's Expense"
      subtitle={formatCurrencyPrecise(row.amount)}
      onClose={onClose}
      hideClose={hideClose}
      embedded={embedded}
    >
      <div className="flex flex-col gap-3">
        <Label className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Paid for</Label>
        <div className="flex flex-col gap-1">
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => onCommit(person.id, person.name)}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left text-sm hover:border-primary hover:bg-primary/5 data-[active=true]:border-primary data-[active=true]:bg-primary/5"
              data-active={existing?.personId === person.id}
            >
              <UserRound className="size-3.5 shrink-0 text-purple" />
              {person.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={freeText}
            placeholder="Or type a name…"
            onChange={(e) => setFreeText(e.target.value)}
            onBlur={() => freeText.trim() && onCommit(null, freeText.trim())}
            className="h-9 text-sm"
          />
        </div>
      </div>
    </InspectorShell>
  );
}
