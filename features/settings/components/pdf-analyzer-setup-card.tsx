"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsDivider } from "@/components/settings/settings-divider";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsLabel } from "@/components/settings/settings-label";
import { ClayButton } from "@/components/clay/clay-button";
import { PasswordField } from "@/components/forms/password-field";
import { db } from "@/lib/firebase/client";
import { hasSavedPassword } from "@/lib/repositories/pdf-analyzer-config-repository";
import { saveCardPassword } from "@/features/statement-review/lib/retry-document-parsing";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Account } from "@/lib/models/account";
import { toast } from "@/store/toast-store";

/**
 * The saved-password panel — write-only, per this feature's security
 * design: opening Settings never fetches or decrypts the existing stored
 * password. A masked placeholder shows only whether one exists; Show/Hide
 * (built into `PasswordField`) only ever reveals what's currently being
 * typed to replace it.
 */
function SavedPasswordPanel({ uid, cardId }: { uid: string; cardId: string }) {
  const [hasSaved, setHasSaved] = useState<boolean | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    hasSavedPassword(db, uid, cardId).then(setHasSaved);
  }, [uid, cardId]);

  const touched = newPassword.length > 0 || confirmPassword.length > 0;
  const mismatch = touched && newPassword !== confirmPassword;
  const canSave = newPassword.length > 0 && newPassword === confirmPassword;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveCardPassword(cardId, newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setReplacing(false);
      setHasSaved(true);
      toast.success("Password saved");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Please try again.";
      toast.error("Couldn't save the password", message);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setNewPassword("");
    setConfirmPassword("");
    setReplacing(false);
  }

  if (hasSaved === null) return null;

  if (hasSaved && !replacing) {
    return (
      <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/40 p-3">
        <SettingsLabel>PDF Password</SettingsLabel>
        <p className="font-mono text-sm tracking-widest text-muted-foreground">•••••••••••• (Saved)</p>
        <ClayButton size="sm" variant="secondary" className="mt-1 self-start" onClick={() => setReplacing(true)}>
          Replace Password
        </ClayButton>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/40 p-3">
      <PasswordField label="PDF Password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      {hasSaved && (
        <PasswordField
          label="Confirm Password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={mismatch ? "Passwords don't match" : undefined}
        />
      )}
      <div className="flex items-center gap-3">
        <ClayButton size="sm" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save"}
        </ClayButton>
        {hasSaved && (
          <button type="button" onClick={handleCancel} className="text-xs text-muted-foreground underline">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function CardPasswordRow({ uid, card, accountName }: { uid: string; card: CreditCardProfile; accountName: string }) {
  return (
    <div>
      <SettingsRow
        icon={<Lock className="size-4.5" />}
        label={accountName}
        description={`•••• ${card.lastFourDigits ?? "----"}`}
      />
      <div className="px-1 pb-3">
        <SavedPasswordPanel uid={uid} cardId={card.id} />
      </div>
    </div>
  );
}

/**
 * PDF Analyzer Setup — save one PDF password per card. The user already
 * knows their bank's statement password; the app only remembers it
 * (encrypted server-side) and applies it automatically on upload. No
 * templates, no generation logic — just a password field and Save.
 */
export function PdfAnalyzerSetupCard({
  uid,
  creditCards,
  accounts,
}: {
  uid: string;
  creditCards: CreditCardProfile[];
  accounts: Account[];
}) {
  if (creditCards.length === 0) return null;

  return (
    <SettingsCard noPadding>
      <div className="px-5 pt-4 pb-1">
        <h2 className="text-sm font-semibold text-foreground">PDF Analyzer — Statement Password</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Save each card&apos;s statement PDF password so future uploads unlock automatically.
        </p>
      </div>
      {creditCards.map((c, i) => {
        const accountName = accounts.find((a) => a.id === c.accountId)?.name ?? "Credit Card";
        return (
          <div key={c.id}>
            {i > 0 && <SettingsDivider />}
            <CardPasswordRow uid={uid} card={c} accountName={accountName} />
          </div>
        );
      })}
    </SettingsCard>
  );
}
