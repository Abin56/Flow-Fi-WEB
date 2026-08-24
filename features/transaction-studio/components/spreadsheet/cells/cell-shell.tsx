"use client";

import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Shared focus/edit chrome for every grid cell — the Excel-like "focused
 * cell has a highlighted border, double-click or Enter/F2 opens the
 * editor" affordance. `Spreadsheet` owns which cell is focused/editing
 * (architecture §4c, local component state); this just renders that state
 * consistently so every cell type looks and behaves the same way.
 *
 * A26 — every cell that renders through here is, by construction, editable
 * (the cells that aren't — Status/Confidence/AI — don't use `CellShell` at
 * all), so a hover-only ring + pencil glyph gives a free, correct "this is
 * editable" signal without a per-column flag to keep in sync.
 */
export function CellShell({
  isFocused,
  isEditing,
  onFocus,
  onStartEdit,
  align = "start",
  className,
  children,
}: {
  isFocused: boolean;
  isEditing: boolean;
  onFocus: () => void;
  onStartEdit: () => void;
  align?: "start" | "end" | "center";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        // Deliberately square (no rounding) — an Excel/Sheets active-cell selection is a sharp
        // rectangle sitting flush against the grid lines, not a rounded chip floating over them.
        "group/cell relative flex h-full w-full items-center px-2.5 outline-none transition-[box-shadow,background-color] duration-fast ease-spring",
        align === "end" && "justify-end",
        align === "center" && "justify-center",
        !isFocused && !isEditing && "hover:ring-1 hover:ring-inset hover:ring-primary/25",
        isFocused && !isEditing && "z-10 ring-2 ring-inset ring-primary",
        isEditing && "z-10 bg-surface-elevated ring-2 ring-inset ring-primary shadow-[0_0_0_1px_var(--surface)]",
        className,
      )}
      onClick={onFocus}
      onDoubleClick={onStartEdit}
      data-focused={isFocused || undefined}
      data-editing={isEditing || undefined}
    >
      {children}
      {!isEditing && (
        <Pencil className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/cell:opacity-60" />
      )}
    </div>
  );
}
