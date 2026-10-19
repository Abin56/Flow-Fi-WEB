"use client";

import { useMemo, useRef, useState } from "react";
import { ReversalConfirmDialog } from "@/components/finance/reversal-confirm-dialog";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllCreditCardStatements, useCreditCards, useSharedCreditLimits } from "@/hooks/use-credit-cards";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import { useExpenses } from "@/hooks/use-expenses";
import { useTransactions } from "@/hooks/use-transactions";
import { cardPaymentCancellationLines, cardPaymentCancellationPreview } from "@/features/credit-cards/lib/card-payment-cancellation";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { toast } from "@/store/toast-store";

/**
 * "Cancel recorded payment" for a card bill payment — the Credit Cards and Transactions entry points both mount
 * this. The preview (read-only preflight, `cardPaymentCancellationPreview`) is derived from the live linked
 * records; confirming runs the SAME `deleteTransferPair` every other delete uses, which re-reads both legs inside
 * a Firestore transaction (stale → refused, already cancelled → no-op). Mount it only while it is open.
 */
export function CardPaymentCancelDialog({ transactionId, onClose, onCancelled }: { transactionId: string; onClose: () => void; onCancelled?: () => void }) {
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { data: cards = [] } = useCreditCards();
  const { data: sharedLimits = [] } = useSharedCreditLimits();
  const { data: statements = [] } = useAllCreditCardStatements();
  const { utilizationEmis } = useCardUtilizationEmis();
  const { data: expenses = [] } = useExpenses();
  const actions = useTransactionActions();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const preview = useMemo(
    () =>
      cardPaymentCancellationPreview({
        transactionId,
        transactions: transactions as Transaction[],
        accounts: accounts as Account[],
        cards: cards as CreditCardProfile[],
        sharedLimits: sharedLimits as SharedCreditLimit[],
        statements: statements as Statement[],
        utilizationEmis,
        splitOwnedTransactionIds: new Set(expenses.filter((e) => e.deletedAt == null).map((e) => e.transactionId)),
      }),
    [transactionId, transactions, accounts, cards, sharedLimits, statements, utilizationEmis, expenses],
  );

  async function confirm() {
    if (inFlight.current || preview.state !== "ready" || preview.cardLegId == null || actions == null) return;
    const leg = (transactions as Transaction[]).find((t) => t.id === preview.cardLegId);
    if (!leg) {
      setError("This payment was already cancelled.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await actions.deleteTransactionWithLinkedEffects(leg);
      toast.success(
        "Recorded payment cancelled",
        preview.outstanding ? `${preview.cardName} · outstanding now ${formatCurrency(preview.outstanding.after)}` : undefined,
      );
      onCancelled?.();
      onClose();
    } catch (e) {
      setError(userFacingMessage(e) ?? "Couldn't cancel the payment. Nothing was changed — please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const blockedReason =
    preview.state === "ready" ? null : (preview.blockedReason ?? (preview.state === "notCardPayment" ? "This isn't a card bill payment." : "This payment was already cancelled."));
  return (
    <ReversalConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      amountLabel={formatCurrency(preview.amount)}
      subtitle={preview.cardName ?? undefined}
      effects={cardPaymentCancellationLines(preview, formatCurrency)}
      blockedReason={blockedReason}
      error={error}
      busy={busy}
      onConfirm={confirm}
    />
  );
}
