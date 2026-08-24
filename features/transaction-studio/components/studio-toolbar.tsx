"use client";

import { Keyboard, Maximize2, Minimize2, MoreHorizontal, Redo2, Search, Settings2, Undo2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { Person } from "@/lib/models/person";
import { useTransactionStudioSessionStore } from "@/store/transaction-studio-session-store";
import { useTransactionStudioUiStore, type StudioRowDensity } from "@/store/transaction-studio-ui-store";
import type { StudioFilters } from "../lib/filters";

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "↑ ↓ ← →", description: "Move the focused cell" },
  { keys: "Tab / Shift+Tab", description: "Move focus right / left" },
  { keys: "Enter / F2", description: "Edit the focused cell" },
  { keys: "Escape", description: "Cancel the current edit or clear selection" },
  { keys: "Delete / Backspace", description: "Exclude the focused (or selected) rows from totals" },
  { keys: "Ctrl/⌘ Z", description: "Undo" },
  { keys: "Ctrl/⌘ Shift+Z or Y", description: "Redo" },
  { keys: "Ctrl/⌘ A", description: "Select all rows" },
  { keys: "Shift + ↑ / ↓", description: "Extend row selection" },
  { keys: "Ctrl/⌘ C / V", description: "Copy / paste a cell's value" },
  { keys: "/ or Ctrl/⌘ K", description: "Jump to search" },
];

export function StudioToolbar({
  people,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  searchInputRef,
  fullscreen,
  onToggleFullscreen,
}: {
  people: Person[];
  search: string;
  onSearchChange: (value: string) => void;
  filters: StudioFilters;
  onFiltersChange: (next: StudioFilters) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** "/" and Cmd/Ctrl+K jump focus here (§6's keyboard baseline). */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const reviewingWithPersonId = useTransactionStudioSessionStore((s) => s.reviewingWithPersonId);
  const setReviewingWith = useTransactionStudioSessionStore((s) => s.setReviewingWith);
  const reviewingWithPerson = people.find((p) => p.id === reviewingWithPersonId);
  const rowDensity = useTransactionStudioUiStore((s) => s.rowDensity);
  const setRowDensity = useTransactionStudioUiStore((s) => s.setRowDensity);

  return (
    <div className="surface-primary flex items-center gap-2 rounded-2xl px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <UserRound /> {reviewingWithPerson ? `Reviewing with ${reviewingWithPerson.name}` : "People Session"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem onSelect={() => setReviewingWith(null)} className={cn(!reviewingWithPersonId && "font-semibold")}>
            Just Me
          </DropdownMenuItem>
          {people.map((person) => (
            <DropdownMenuItem key={person.id} onSelect={() => setReviewingWith(person.id)} className={cn(reviewingWithPersonId === person.id && "font-semibold")}>
              {person.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="relative w-64">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search merchant, notes, reference… (/)"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More filters">
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48" align="start">
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox checked={filters.onlyIgnored} onCheckedChange={(v) => onFiltersChange({ ...filters, onlyIgnored: v === true })} />
            Ignored only
          </Label>
        </PopoverContent>
      </Popover>

      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <Undo2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          <Redo2 className="size-4" />
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
              <Keyboard className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="end">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Keyboard shortcuts</p>
            <div className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{s.description}</span>
                  <kbd className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Display settings">
              <Settings2 className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56" align="end">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Row density</p>
            <ToggleGroup type="single" value={rowDensity} onValueChange={(v) => v && setRowDensity(v as StudioRowDensity)} className="w-full">
              <ToggleGroupItem value="compact" className="flex-1">
                Compact
              </ToggleGroupItem>
              <ToggleGroupItem value="comfortable" className="flex-1">
                Comfortable
              </ToggleGroupItem>
            </ToggleGroup>
          </PopoverContent>
        </Popover>

        <Button variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullscreen} title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}>
          {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
