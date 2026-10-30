"use client";

/**
 * Every live lender charge across all loans and EMIs — READ-ONLY. One listener per agreement's `lenderCharges`
 * subcollection (a collection-group query would need a rules entry, and rules are out of scope), aggregated into
 * one list. Empty — and costing only the idle listeners — while no charge has been recorded, which is the case until
 * the write path is enabled. Nothing here writes.
 */

import { useEffect, useMemo, useState } from "react";
import type { LenderCharge, LenderChargeAgreementKind } from "@/lib/models/lender-charge";
import { createLenderChargeReader } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useEmis } from "./use-credit-cards";
import { useLoans } from "./use-loans";

export function useLenderCharges(): { charges: LenderCharge[]; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const { data: emis = [], isLoading: emisLoading } = useEmis();

  const agreements = useMemo(
    () => [
      ...loans.filter((l) => l.deletedAt == null).map((l) => ({ kind: "loan" as LenderChargeAgreementKind, id: l.id })),
      ...emis.filter((e) => e.deletedAt == null).map((e) => ({ kind: "emi" as LenderChargeAgreementKind, id: e.id })),
    ],
    [loans, emis],
  );
  // Stable key: re-subscribe only when the SET of agreements changes, not on every unrelated loan/EMI edit.
  const key = useMemo(() => agreements.map((a) => `${a.kind}:${a.id}`).sort().join(","), [agreements]);

  const [byAgreement, setByAgreement] = useState<{ key: string; charges: Record<string, LenderCharge[]> }>({ key: "", charges: {} });

  useEffect(() => {
    if (!uid || key === "") return;
    const unsubscribers = agreements.map((a) =>
      createLenderChargeReader(uid, a.kind, a.id).watchAll(
        (items) => setByAgreement((prev) => ({ key, charges: { ...(prev.key === key ? prev.charges : {}), [`${a.kind}:${a.id}`]: items } })),
        (error) => console.error(`[FlowFi] lender charges listener failed for ${a.kind}:${a.id}`, error),
      ),
    );
    return () => unsubscribers.forEach((u) => u());
    // `agreements` is derived from `key`; re-subscribing on `key` alone is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, key]);

  const charges = useMemo(() => (byAgreement.key === key ? Object.values(byAgreement.charges).flat() : []), [byAgreement, key]);
  const received = byAgreement.key === key ? Object.keys(byAgreement.charges).length : 0;
  const isLoading = loansLoading || emisLoading || (!!uid && agreements.length > 0 && received < agreements.length);
  return { charges, isLoading };
}
