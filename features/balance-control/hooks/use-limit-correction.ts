"use client";

/**
 * Write-capable actions for Balance Control's credit-limit correction sheet. The ONLY write path Balance
 * Control exposes so far — see `lib/repositories/credit-limit-correction-repository.ts` for the safety
 * invariants (idempotent, conflict-checked, never overwrites a derived figure).
 */

import { useMemo } from "react";
import { createCreditLimitCorrectionRepository } from "@/lib/repositories/repository-factory";
import type { LimitCorrectionTarget, RecordLimitCorrectionParams } from "@/lib/repositories/credit-limit-correction-repository";
import type { CreditLimitCorrection } from "@/lib/models/credit-limit-correction";
import { generateId } from "@/lib/utils/id-generator";
import { useAuthStore } from "@/store/auth-store";

export function useLimitCorrection() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const repository = createCreditLimitCorrectionRepository(uid);
    return {
      recordCorrection: (params: Omit<RecordLimitCorrectionParams, "id"> & { id?: string }) =>
        repository.record({ id: params.id ?? generateId(), ...params }),
      reverseCorrection: (target: LimitCorrectionTarget, correction: CreditLimitCorrection) =>
        repository.reverse(target, correction, generateId()),
      historyFor: (target: LimitCorrectionTarget) => repository.historyFor(target),
    };
  }, [uid]);
}
