"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { StagedSuggestion } from "@/lib/models/document-import";
import { isTagsSuggestionPending, SUGGESTED_CLASS } from "../../../lib/suggestion-tokens";
import { CellShell } from "./cell-shell";

/**
 * A23 — same "suggested vs confirmed" pre-fill CategoryCell already does for
 * `suggestedCategory` (A22/A33), extended to the tags column: with no
 * confirmed tags yet and no edit on this row, show the pipeline's suggested
 * tags in the dashed "suggested" chrome rather than a blank "—". Picking
 * any real edit (add/remove a tag) replaces `value`, which immediately ends
 * the suggested state — there's nothing to "accept" separately.
 */
export function TagsCell({
  value,
  suggestedTags,
  userEdited,
  isFocused,
  isEditing,
  onFocus,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: string[];
  suggestedTags: StagedSuggestion<string>[];
  userEdited: boolean;
  isFocused: boolean;
  isEditing: boolean;
  onFocus: () => void;
  onStartEdit: () => void;
  onCommit: (value: string[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");

  const pending = isTagsSuggestionPending({ userEdited }, value, suggestedTags);
  const displayTags = pending ? suggestedTags.map((s) => s.value) : value;

  function addTag() {
    const trimmed = draft.trim();
    if (trimmed && !value.includes(trimmed)) onCommit([...value, trimmed]);
    setDraft("");
  }

  function removeTag(tag: string) {
    onCommit(value.filter((t) => t !== tag));
  }

  return (
    <CellShell isFocused={isFocused} isEditing={isEditing} onFocus={onFocus} onStartEdit={onStartEdit}>
      <Popover open={isEditing} onOpenChange={(open) => !open && onCancel()}>
        <PopoverTrigger asChild>
          <button type="button" className="flex w-full flex-wrap items-center gap-1 overflow-hidden text-left" onClick={onStartEdit}>
            {displayTags.length === 0 ? (
              <span className="text-sm text-muted-foreground">—</span>
            ) : (
              displayTags.map((tag) => (
                <Badge key={tag} variant="outline" className={cn("text-[11px]", pending && SUGGESTED_CLASS)}>
                  {tag}
                </Badge>
              ))
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="start">
          <div className="flex flex-wrap gap-1.5">
            {value.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 text-[11px]">
                {tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          {pending && (
            <button
              type="button"
              className="mt-2 flex w-full flex-wrap items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-primary/5"
              onClick={() => onCommit(displayTags)}
            >
              Use suggested: {displayTags.join(", ")}
            </button>
          )}
          <Input
            autoFocus
            value={draft}
            placeholder="Add a tag…"
            className="mt-2 h-8 text-sm"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
              if (e.key === "Escape") onCancel();
            }}
            onBlur={addTag}
          />
        </PopoverContent>
      </Popover>
    </CellShell>
  );
}
