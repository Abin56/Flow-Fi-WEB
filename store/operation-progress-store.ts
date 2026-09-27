import { create } from "zustand";
import { createOperation, type OperationHandle, type OperationOptions, type OperationSnapshot } from "@/lib/operation-progress/operation-progress";
import { toast } from "@/store/toast-store";

interface OperationProgressState {
  operations: OperationSnapshot[];
  upsert: (snapshot: OperationSnapshot) => void;
  remove: (id: string) => void;
}

export const useOperationProgressStore = create<OperationProgressState>((set) => ({
  operations: [],
  upsert: (snapshot) =>
    set((state) => {
      const i = state.operations.findIndex((o) => o.id === snapshot.id);
      if (i === -1) return { operations: [...state.operations, snapshot] };
      const next = [...state.operations];
      next[i] = snapshot;
      return { operations: next };
    }),
  remove: (id) => set((state) => ({ operations: state.operations.filter((o) => o.id !== id) })),
}));

/**
 * Starts a page-level operation shown in the floating progress surface (`OperationProgressHost`, mounted
 * once in the app providers). For a write started from inside a form/dialog, prefer `useOperation()` so the
 * progress sits next to the action instead.
 *
 *   const op = startOperation({ label: "Deleting transaction", successLabel: "Transaction deleted" });
 *   try { op.stage("submit"); await remove(); op.succeed({ toast: { title: "Transaction deleted" } }); }
 *   catch (e) { op.fail({ detail: errorDetail(e) }); }
 */
export function startOperation(opts: OperationOptions): OperationHandle {
  const { upsert, remove } = useOperationProgressStore.getState();
  let id = "";
  const handle = createOperation(opts, {
    update: upsert,
    remove: () => remove(id),
    toast: (t) => toast.success(t.title, t.description, t.action),
  });
  id = handle.id;
  return handle;
}
