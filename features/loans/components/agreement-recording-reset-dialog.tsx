"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/lib/derived-query-prefixes";
import type { AgreementKind } from "@/lib/engines/agreement-deletion";
import { auth, db } from "@/lib/firebase/client";
import { formatCurrencyExact } from "@/lib/format";
import { previewAgreementRecordingReset, resetAgreementRecordings, type AgreementResetPreview } from "@/lib/repositories/agreement-recording-reset";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";

type Review = { preview: AgreementResetPreview; error?: never } | { preview?: never; error: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "The recordings could not be reset. Try again.";

export function AgreementRecordingResetDialog({ kind, id, name, onClose }: {
  kind: AgreementKind;
  id: string;
  name: string;
  onClose: () => void;
}) {
  const uid = useAuthStore((state) => state.user?.uid);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const agreement = kind === "loan" ? "loan" : "EMI";
  const confirmationName = name.trim() || "RESET";

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    void previewAgreementRecordingReset(db, uid, kind, id).then(
      (preview) => { if (!cancelled) setReview({ preview }); },
      (error: unknown) => { if (!cancelled) setReview({ error: errorText(error) }); },
    );
    return () => { cancelled = true; };
  }, [id, kind, reviewRequest, uid]);

  function refresh() {
    setConfirmation("");
    setReview(null);
    setReviewRequest((request) => request + 1);
  }

  const preview = review?.preview;
  const canReset = Boolean(uid && preview?.hasRecordings && confirmation.trim() === confirmationName && !saving);
  async function confirm() {
    if (!canReset || !uid || auth.currentUser?.uid !== uid || !preview || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await resetAgreementRecordings(db, uid, kind, id, preview.revision);
    } catch (error) {
      setReview({ error: errorText(error) });
      setSaving(false);
      savingRef.current = false;
      return;
    }
    void Promise.allSettled(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    toast.success("Transaction history reset", name);
    onClose();
  }

  const counts = preview ? [
    [preview.paymentCount, "Installment payment records"],
    [preview.transactionCount, "Transactions to remove"],
    [preview.installmentCount, "Installments to mark unpaid"],
    [preview.disbursementCount, "Additional amounts given or received"],
    [preview.lenderChargeCount, "Lender charge records"],
    [preview.receiptCount, "People repayments to remove"],
    [preview.releasedReceiptCount, "Shared receipts to unassign"],
    [preview.releasedExpenseCount, "Existing expenses to unlink"],
    [preview.advanceCount, "People advance allocations to release"],
    [preview.trackingCount, "Collection dates and reminders to clear"],
  ].filter(([count]) => Number(count) > 0) : [];
  const balanceGroups = preview ? [
    { label: "Account balance changes", rows: preview.accountEffects.map(({ accountName, delta }) => ({ name: accountName, delta })) },
    { label: "People balance changes", rows: preview.personEffects.map(({ personName, delta }) => ({ name: personName, delta })) },
  ].filter(({ rows }) => rows.length > 0) : [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !savingRef.current) onClose(); }}>
      <DialogContent className="gap-4 sm:max-w-xl" showCloseButton={!saving} data-testid="agreement-reset-dialog">
        <DialogHeader className="flex-row items-start gap-3 pr-8">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-danger/12 text-danger"><AlertTriangle className="size-4.5" aria-hidden /></span>
          <div className="grid min-w-0 gap-1 text-left">
            <DialogTitle>Delete all transactions?</DialogTitle>
            <DialogDescription className="break-words">
              Reset recordings for <strong className="font-semibold text-foreground">{name}</strong>. The {agreement}, its opening principal and original money movement stay. This reset is permanent.
            </DialogDescription>
          </div>
        </DialogHeader>

        {!uid || review?.error ? (
          <div role="alert" className="rounded-lg border border-danger/35 bg-danger/7 px-3 py-2 text-sm text-foreground">
            {review?.error ?? "Sign in again to review these recordings."}
          </div>
        ) : review == null ? (
          <p role="status" className="flex items-center gap-2 rounded-lg border border-border bg-secondary/35 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Checking linked records…
          </p>
        ) : preview?.hasRecordings ? (
          <>
            <div className="grid max-h-[min(46dvh,24rem)] gap-3 overflow-y-auto pr-1">
              <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-secondary/25 px-3 text-xs">
                {counts.map(([count, label]) => (
                  <div key={label} className="flex justify-between gap-3 py-2">
                    <dt>{label}</dt><dd className="font-semibold tabular-nums">{count}</dd>
                  </div>
                ))}
              </dl>
              {balanceGroups.map(({ label, rows }) => (
                <section key={label} className="rounded-lg border border-border px-3 py-2 text-xs">
                  <h3 className="mb-1 font-semibold">{label}</h3>
                  <ul className="grid gap-0.5">
                    {rows.map(({ name, delta }, index) => (
                      <li key={`${name}-${index}`} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{name}</span>
                        <span className="font-semibold tabular-nums">{delta > 0 ? "+" : "−"}{formatCurrencyExact(Math.abs(delta))}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <p className="text-xs leading-relaxed text-muted-foreground">Existing card purchases, independent bill payments and expenses keep their own transaction history. Shared receipts stay in People, with this {agreement}&apos;s share moved to the overall balance.</p>
            </div>
            <label className="grid gap-1.5 text-sm">
              <span>Type <strong className="font-semibold">{confirmationName}</strong> to confirm</span>
              <input className="h-9 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={saving} />
            </label>
          </>
        ) : (
          <p role="status" className="rounded-lg border border-border bg-secondary/35 p-3 text-sm text-muted-foreground">There are no recordings to reset for this {agreement}.</p>
        )}

        <DialogFooter>
          <ClayButton variant="ghost" onClick={onClose} disabled={saving}>{preview?.hasRecordings ? "Cancel" : "Close"}</ClayButton>
          {uid && review?.error ? (
            <ClayButton variant="secondary" onClick={refresh}><RotateCcw className="size-4" aria-hidden /> Refresh preview</ClayButton>
          ) : preview?.hasRecordings ? (
            <ClayButton className="bg-danger text-danger-foreground" onClick={() => void confirm()} disabled={!canReset}>
              {saving ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Resetting…</> : "Delete all transactions"}
            </ClayButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
