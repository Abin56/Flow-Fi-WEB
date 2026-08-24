"use client";

import { useCallback, useMemo, useState } from "react";

interface UseSelectionResult {
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  isSelected: (id: string) => boolean;
  clear: () => void;
  selectedCount: number;
}

/** Generic row-selection-by-id hook — shared by any table/list that needs checkbox selection + bulk actions. */
export function useSelection(): UseSelectionResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(ids);
    });
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const selectedCount = useMemo(() => selectedIds.size, [selectedIds]);

  return { selectedIds, toggle, toggleAll, isSelected, clear, selectedCount };
}
