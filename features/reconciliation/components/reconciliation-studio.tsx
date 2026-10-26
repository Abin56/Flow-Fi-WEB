"use client";

import { useAuthStore } from "@/store/auth-store";
import { useReconciliationData } from "../hooks/use-reconciliation-data";
import { ReconciliationWorkspace } from "./reconciliation-workspace";

/** /reconciliation — wires the workspace to the app's existing read-only live data and its load state. */
export function ReconciliationStudio() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { sync, ...data } = useReconciliationData();
  return <ReconciliationWorkspace uid={uid} data={data} sync={sync} />;
}
