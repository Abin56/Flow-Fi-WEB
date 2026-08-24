"use client";

/**
 * The right-sidebar editor for Action = Shared Expense (architecture §5).
 * Calls the exact same `ExpenseRepository.resolveShares` static logic
 * mobile's real split-commit path uses — live, on every keystroke — so
 * validation and rounding (remainder pushed onto the last participant) is
 * byte-identical to what happens for real at commit time, not a
 * reimplementation that could drift.
 */

import { useMemo, useState } from "react";
import { AlertCircle, Plus, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Person } from "@/lib/models/person";
import { ExpenseRepository, type ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import type { SplitParticipantDraft } from "@/lib/models/document-import";
import type { GridRow } from "../../lib/grid-types";
import { InspectorShell } from "./inspector-shell";

type SplitMode = "equal" | "percentage" | "custom";

interface DraftParticipant {
  personId: string | null;
  name: string;
  isMe: boolean;
  /** Raw text the user typed for percentage/custom modes — kept as a string so "12." mid-typing doesn't get clobbered by re-formatting. */
  rawValue: string;
}

function toDrafts(existing: SplitParticipantDraft[] | undefined, total: number): DraftParticipant[] {
  if (existing && existing.length > 0) {
    return existing.map((p) => ({ personId: p.personId, name: p.name, isMe: p.isMe, rawValue: String(p.share) }));
  }
  return [{ personId: null, name: "Me", isMe: true, rawValue: String(total) }];
}

export function SharedExpenseInspector({
  row,
  people,
  onCommit,
  onClose,
  hideClose,
  embedded,
}: {
  row: GridRow;
  people: Person[];
  onCommit: (participants: SplitParticipantDraft[], splitType: SplitMode) => void;
  onClose: () => void;
  hideClose?: boolean;
  embedded?: boolean;
}) {
  const existingDetail = row.actionDetail?.kind === "shared_expense" ? row.actionDetail : null;
  const [mode, setMode] = useState<SplitMode>((existingDetail?.splitType as SplitMode) ?? "equal");
  const [participants, setParticipants] = useState<DraftParticipant[]>(() => toDrafts(existingDetail?.participants, row.amount));

  const { resolved, error } = useMemo(() => {
    try {
      const inputs: ExpenseParticipantInput[] = participants.map((p) => ({
        personId: p.personId,
        name: p.name,
        value: mode === "equal" ? null : Number(p.rawValue) || 0,
        isMe: p.isMe,
      }));
      const shares = ExpenseRepository.resolveShares({ type: mode, total: row.amount, inputs });
      return { resolved: shares, error: null as string | null };
    } catch (e) {
      return { resolved: null, error: e instanceof Error ? e.message : "Invalid split" };
    }
  }, [participants, mode, row.amount]);

  function commitIfValid(nextParticipants: DraftParticipant[], nextMode: SplitMode) {
    try {
      const inputs: ExpenseParticipantInput[] = nextParticipants.map((p) => ({
        personId: p.personId,
        name: p.name,
        value: nextMode === "equal" ? null : Number(p.rawValue) || 0,
        isMe: p.isMe,
      }));
      const shares = ExpenseRepository.resolveShares({ type: nextMode, total: row.amount, inputs });
      onCommit(
        shares.map((s) => ({ personId: s.personId, name: s.name, share: s.share, isMe: s.isMe })),
        nextMode,
      );
    } catch {
      // Invalid mid-edit state (e.g. percentages don't sum to 100 yet) — don't commit, just let the preview show the error.
    }
  }

  function addParticipant(person?: Person) {
    const next = [...participants, { personId: person?.id ?? null, name: person?.name ?? "", isMe: false, rawValue: "0" }];
    setParticipants(next);
    commitIfValid(next, mode);
  }

  function removeParticipant(index: number) {
    const next = participants.filter((_, i) => i !== index);
    setParticipants(next);
    commitIfValid(next, mode);
  }

  function updateParticipant(index: number, patch: Partial<DraftParticipant>) {
    const next = participants.map((p, i) => (i === index ? { ...p, ...patch } : p));
    setParticipants(next);
    commitIfValid(next, mode);
  }

  function changeMode(next: SplitMode) {
    setMode(next);
    commitIfValid(participants, next);
  }

  const availablePeople = people.filter((p) => !participants.some((d) => d.personId === p.id));

  return (
    <InspectorShell title="Shared Expense" subtitle={`Total ${formatCurrencyPrecise(row.amount)}`} onClose={onClose} hideClose={hideClose} embedded={embedded}>
      <div className="flex flex-col gap-4">
        <div>
          <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Split method</Label>
          <RadioGroup value={mode} onValueChange={(v) => changeMode(v as SplitMode)} className="grid grid-cols-3 gap-1.5">
            {(["equal", "percentage", "custom"] as const).map((m) => (
              <Label
                key={m}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs capitalize has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={m} className="sr-only" />
                {m === "custom" ? "Exact Amount" : m}
              </Label>
            ))}
          </RadioGroup>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Participants</Label>
          {participants.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                value={p.name}
                placeholder="Name"
                disabled={p.isMe}
                onChange={(e) => updateParticipant(i, { name: e.target.value })}
                className="h-8 flex-1 text-sm"
              />
              {mode === "equal" ? (
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {resolved ? formatCurrencyPrecise(resolved.find((r) => (p.personId ? r.personId === p.personId : r.name === p.name))?.share ?? 0) : "—"}
                </span>
              ) : (
                <Input
                  value={p.rawValue}
                  onChange={(e) => updateParticipant(i, { rawValue: e.target.value })}
                  className="h-8 w-20 shrink-0 text-right text-sm tabular-nums"
                  inputMode="decimal"
                />
              )}
              {!p.isMe && (
                <Button variant="ghost" size="icon-xs" aria-label={`Remove ${p.name}`} onClick={() => removeParticipant(i)}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}

          {availablePeople.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {availablePeople.slice(0, 6).map((person) => (
                <Button key={person.id} variant="outline" size="xs" onClick={() => addParticipant(person)}>
                  <Plus className="size-3" /> {person.name}
                </Button>
              ))}
            </div>
          )}
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => addParticipant()}>
            <Plus className="size-3.5" /> Add person
          </Button>
        </div>

        {error ? (
          <div className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2 text-xs text-danger">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </div>
        ) : (
          resolved && (
            <div className="flex items-center justify-between rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-xs text-success">
              <span>Total {formatCurrencyPrecise(resolved.reduce((sum, s) => sum + s.share, 0))}</span>
              <span>✓ Balanced</span>
            </div>
          )
        )}
      </div>
    </InspectorShell>
  );
}
