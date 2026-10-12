"use client";

/**
 * One person's payment deferrals (`people/{personId}/paymentDeferrals`), LIVE, plus Postpone / Undo. A
 * deferral never moves money: its status is derived from the obligation's live remaining
 * (`deferralView`), and every write goes through `PaymentDeferralRepository`'s single transaction.
 */

import { onSnapshot } from "firebase/firestore";
import { useMemo } from "react";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { db } from "@/lib/firebase/client";
import type { DeferralRequest } from "@/lib/engines/person-payment-deferral";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import { PaymentDeferralRepository } from "@/lib/repositories/payment-deferral-repository";
import { createPaymentDeferralsCollection } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export function usePersonPaymentDeferrals(personId: string) {
  const uid = useAuthStore((s) => s.user?.uid);
  const query = useFirestoreWatch<PersonPaymentDeferral[]>({
    queryKey: ["people-payment-deferrals", uid, personId] as const,
    enabled: !!uid && !!personId,
    hookName: "usePersonPaymentDeferrals",
    emptyValue: [],
    deps: [uid, personId],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return onSnapshot(createPaymentDeferralsCollection(uid, personId), (snapshot) => onData(snapshot.docs.map((d) => d.data())), onError);
    },
  });
  return { deferrals: query.data ?? [], isLoading: query.data === undefined };
}

export function usePaymentDeferralActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  return useMemo(
    () => ({
      async apply(request: DeferralRequest) {
        if (!uid) throw new Error("Not signed in.");
        return new PaymentDeferralRepository(db, uid).apply(request);
      },
    }),
    [uid],
  );
}
