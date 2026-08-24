"use client";

import { useEffect, useState } from "react";
import { FormDialog } from "@/components/finance";
import { PasswordField } from "@/components/forms/password-field";
import { useAuthStore } from "@/store/auth-store";
import { db } from "@/lib/firebase/client";
import { hasSavedPassword } from "@/lib/repositories/pdf-analyzer-config-repository";
import type { FinancialDocument } from "@/lib/models/financial-document";
import { retryDocumentParsing, saveCardPassword } from "@/features/statement-review/lib/retry-document-parsing";

interface EnterPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: FinancialDocument;
}

/**
 * The manual/saved-retry path for a document at `status === "awaiting_password"`.
 * Never requires re-uploading the PDF — operates entirely against the
 * existing `documentId`. If the card has a saved password, this dialog
 * retries it silently on open; if that fails (or none is saved), the user
 * enters one manually, with an option to replace the saved password on
 * success. Password state is cleared on close or success and never sent
 * anywhere except the one `retryDocumentParsingCallable` call.
 */
export function EnterPasswordDialog({ open, onOpenChange, document }: EnterPasswordDialogProps) {
  const uid = useAuthStore((s) => s.user?.uid);
  const [hasSaved, setHasSaved] = useState<boolean | null>(null);
  const [manualPassword, setManualPassword] = useState("");
  const [useManual, setUseManual] = useState(false);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offerReplace, setOfferReplace] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    if (!open || !uid) return;
    let cancelled = false;
    hasSavedPassword(db, uid, document.accountId).then((saved) => {
      if (!cancelled) {
        setHasSaved(saved);
        setUseManual(!saved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, uid, document.accountId]);

  function reset() {
    setManualPassword("");
    setUseManual(false);
    setAttemptsRemaining(null);
    setError(null);
    setHasSaved(null);
    setOfferReplace(false);
    setUnlocked(false);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const credential = useManual ? ({ kind: "manual" as const, password: manualPassword }) : ({ kind: "saved" as const });

      const result = await retryDocumentParsing(document.id, credential);

      switch (result.outcome) {
        case "parsed":
        case "needs_review":
          // A successful MANUAL unlock right after a saved password failed — offer to replace it
          // instead of closing immediately.
          if (useManual && offerReplace) {
            setUnlocked(true);
            return;
          }
          onOpenChange(false);
          reset();
          return;
        case "failed":
          setError(result.message ?? "This document couldn't be processed after unlocking. Please contact support.");
          return;
        case "incorrect_password":
          setAttemptsRemaining(result.attemptsRemaining);
          if (result.usedSavedPassword) {
            setError("The saved password is incorrect.");
            setOfferReplace(true);
          } else {
            setError(
              result.attemptsRemaining > 0
                ? `Wrong password — ${result.attemptsRemaining} attempt${result.attemptsRemaining === 1 ? "" : "s"} left.`
                : "Wrong password.",
            );
          }
          if (!useManual) setUseManual(true); // saved-password attempt was wrong — fall back to manual entry
          return;
        case "rate_limited":
          setError("Too many attempts. Please try again later.");
          return;
        case "no_saved_password":
          setUseManual(true);
          setError("No saved password found — enter it manually.");
          return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReplaceChoice(replace: boolean) {
    if (replace) {
      setLoading(true);
      try {
        await saveCardPassword(document.accountId, manualPassword);
      } catch {
        // best-effort — the document already unlocked successfully either way
      } finally {
        setLoading(false);
      }
    }
    onOpenChange(false);
    reset();
  }

  if (unlocked) {
    return (
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          if (!next) reset();
        }}
        title="Replace saved password?"
        description="The stored password didn't work, but the one you just entered did. Replace the saved password with this new one?"
        onConfirm={() => handleReplaceChoice(true)}
        onCancel={() => handleReplaceChoice(false)}
        confirmLabel="Yes"
        cancelLabel="No"
        loading={loading}
        loadingLabel="Saving…"
      >
        <div />
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Enter Password"
      description="This statement is password protected — enter the password to continue."
      onConfirm={handleConfirm}
      confirmLabel="Continue"
      loading={loading}
      loadingLabel="Unlocking…"
    >
      <div className="flex flex-col gap-3 py-1 text-sm">
        {!useManual && hasSaved && (
          <p className="text-xs text-muted-foreground">We&apos;ll try the saved password for this card.</p>
        )}
        {useManual && (
          <PasswordField label="Password" value={manualPassword} onChange={(e) => setManualPassword(e.target.value)} />
        )}

        {error && <p className="text-xs text-expense">{error}</p>}
        {attemptsRemaining === 0 && (
          <p className="text-xs text-muted-foreground">Please wait before trying again.</p>
        )}
      </div>
    </FormDialog>
  );
}
