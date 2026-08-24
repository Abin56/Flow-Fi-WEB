"use client";

import { useState } from "react";
import { FormDialog } from "@/components/finance";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/hooks/use-accounts";
import { db } from "@/lib/firebase/client";
import { hasSavedPassword } from "@/lib/repositories/pdf-analyzer-config-repository";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { describeUploadError, uploadStatement } from "@/features/statement-review/lib/upload-statement";
import { retryDocumentParsing } from "@/features/statement-review/lib/retry-document-parsing";
import { UploadDropzone } from "@/features/statement-review/components/upload-dropzone";

interface UploadStatementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uid: string;
  creditCards: CreditCardProfile[];
  onUploaded: (documentId: string, fileName: string) => void;
}

/**
 * Real upload flow only — see `features/statement-review/lib/upload-statement.ts`.
 * A card must be selected because `FinancialDocument.accountId` (for
 * `credit_card_statement`) is the `creditCards/{cardId}` this statement
 * belongs to — there is no sensible default to guess.
 *
 * If the selected card has a saved PDF password, this dialog attempts it
 * automatically — once the upload lands and the document reaches
 * "parsing" — before ever closing. No user interaction needed if it
 * unlocks. Falls through to the normal async flow (eventual
 * `awaiting_password`) if no password is saved or it's wrong.
 */
export function UploadStatementDialog({ open, onOpenChange, uid, creditCards, onUploaded }: UploadStatementDialogProps) {
  const { data: accounts = [] } = useAccounts();
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
  const [cardId, setCardId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCardId("");
    setFile(null);
    setError(null);
  }

  async function handleConfirm() {
    if (!cardId || !file) {
      setError("Select a credit card and a PDF file.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await uploadStatement({ uid, accountId: cardId, file });
      if (result.outcome === "rejected") {
        setError(result.message);
        return;
      }

      if (result.outcome === "uploaded" && (await hasSavedPassword(db, uid, cardId))) {
        // Best-effort — if the saved password is wrong, the document just
        // proceeds through the normal async flow (eventual
        // awaiting_password), so any failure here is non-fatal. Logged
        // (non-sensitive) so this isn't a silent, undiagnosable failure.
        await retryDocumentParsing(result.documentId, { kind: "saved" }).catch(() =>
          console.info("[pdf-analyzer] upload-time saved-password attempt failed, falling back to awaiting_password", {
            documentId: result.documentId,
          }),
        );
      }

      onUploaded(result.documentId, file.name);
      onOpenChange(false);
      reset();
    } catch (e) {
      setError(describeUploadError(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Upload Credit Card Statement"
      description="We'll check your file, hash it, and hand it off to the processing pipeline."
      onConfirm={handleConfirm}
      confirmLabel="Upload"
      loading={uploading}
      loadingLabel="Uploading…"
    >
      <div className="flex flex-col gap-3 py-1 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Credit Card</span>
          <Select value={cardId} onValueChange={setCardId}>
            <SelectTrigger className="h-10 w-full rounded-xl">
              <SelectValue placeholder="Select a card" />
            </SelectTrigger>
            <SelectContent>
              {creditCards.map((c) => {
                const name = accountNameById.get(c.accountId) ?? `Card ${c.id.slice(0, 8)}`;
                return (
                  <SelectItem key={c.id} value={c.id}>
                    {c.lastFourDigits ? `${name} •••• ${c.lastFourDigits}` : name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Statement PDF</span>
          <UploadDropzone file={file} onFileChange={setFile} disabled={uploading} />
        </div>
        {creditCards.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add a credit card first — statements are uploaded against a specific card.
          </p>
        )}
        {error && <p className="text-xs text-expense">{error}</p>}
      </div>
    </FormDialog>
  );
}
