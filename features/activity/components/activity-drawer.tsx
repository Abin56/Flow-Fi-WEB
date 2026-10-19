"use client";

/**
 * One lightweight panel per activity: what happened, which records it touched, whether it can be undone and
 * why — then, on Undo, the short confirmation in the SAME panel (no nested dialogs). Facts are read fresh when
 * the panel opens and again right before writing (`useActivityUndo.execute`); the write itself is the module's
 * own reversal handler.
 */

import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailDrawer } from "@/components/finance/detail-drawer";
import { StatusChip } from "@/components/finance/status-chip";
import { Button } from "@/components/ui/button";
import { useActivityUndo } from "@/features/activity/hooks/use-activity-undo";
import { ActivityIcon } from "@/features/activity/components/activity-icon";
import { activityContext, activityHref, activityKindLabel, activityTitle, type ActivityItem, type ActivityNames } from "@/features/activity/lib/activity-classify";
import { decideUndo, type EffectContext, type UndoDecision, type UndoFacts } from "@/features/activity/lib/undo-eligibility";
import { cardPaymentCancellationPreview, type CardPaymentCancellationPreview } from "@/features/credit-cards/lib/card-payment-cancellation";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";
import { useAccounts } from "@/hooks/use-accounts";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import { useAllCreditCardStatements, useCreditCards, useSharedCreditLimits } from "@/hooks/use-credit-cards";
import { useExpenses } from "@/hooks/use-expenses";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

export function formatWhen(date: Date, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const label = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return `${label} · ${time}`;
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Credit Cards' own preview, from the same live inputs its cancel dialog uses — mounted only for a card payment. */
function CardPreviewBridge({ transactionId, onPreview }: { transactionId: string; onPreview: (p: CardPaymentCancellationPreview) => void }) {
  const { data: transactions = [], isLoading: tl } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { data: cards = [] } = useCreditCards();
  const { data: sharedLimits = [] } = useSharedCreditLimits();
  const { data: statements = [], isLoading: sl } = useAllCreditCardStatements();
  const { utilizationEmis } = useCardUtilizationEmis();
  const { data: expenses = [] } = useExpenses();
  const preview = useMemo(
    () =>
      tl || sl
        ? null
        : cardPaymentCancellationPreview({
            transactionId,
            transactions: transactions as Transaction[],
            accounts: accounts as Account[],
            cards: cards as CreditCardProfile[],
            sharedLimits: sharedLimits as SharedCreditLimit[],
            statements: statements as Statement[],
            utilizationEmis,
            splitOwnedTransactionIds: new Set(expenses.filter((e) => e.deletedAt == null).map((e) => e.transactionId)),
          }),
    [tl, sl, transactionId, transactions, accounts, cards, sharedLimits, statements, utilizationEmis, expenses],
  );
  useEffect(() => {
    if (preview) onPreview(preview);
  }, [preview, onPreview]);
  return null;
}

type View = { step: "details" } | { step: "confirm" };

interface DrawerProps {
  names: ActivityNames;
  accounts: readonly Account[];
  onClose: () => void;
}

export function ActivityDrawer({ item, ...props }: DrawerProps & { item: ActivityItem | null }) {
  // Keyed by the action: opening another one starts from a clean state and a fresh resolve.
  return item ? <ActivityDrawerBody key={item.id} item={item} {...props} /> : null;
}

function ActivityDrawerBody({ item, names, accounts, onClose }: DrawerProps & { item: ActivityItem }) {
  const undo = useActivityUndo();
  const [facts, setFacts] = useState<UndoFacts | null>(null);
  const [cardPreview, setCardPreview] = useState<CardPaymentCancellationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ step: "details" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const ctx: EffectContext = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return {
      money: formatCurrency,
      accountName: (id) => byId.get(id)?.name ?? null,
      accountBalance: (id) => byId.get(id)?.currentBalance ?? null,
      personName: names.person,
    };
  }, [accounts, names]);

  // Resolved once per opened action (the body is keyed by it); the feed refreshing underneath doesn't re-run it.
  const resolve = undo.resolve;
  const opened = useRef(item);
  useEffect(() => {
    let cancelled = false;
    resolve(opened.current)
      .then((f) => !cancelled && setFacts(f))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Couldn't check this action."));
    return () => {
      cancelled = true;
    };
  }, [resolve]);

  const withCard = useCallback((f: UndoFacts): UndoFacts => (f.kind === "transfer" ? { ...f, card: cardPreview } : f), [cardPreview]);
  const decision: UndoDecision | null = facts ? decideUndo(item, withCard(facts), ctx) : null;

  async function confirmUndo() {
    if (!decision || decision.kind !== "eligible" || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await undo.execute(item, ctx, withCard, decision);
      if (result.outcome === "blocked") {
        setError(`Nothing was changed. ${result.reason}`);
        setView({ step: "details" });
        setFacts(await undo.resolve(item).catch(() => facts));
        return;
      }
      if (result.outcome === "alreadyUndone") {
        toast.success("Already undone", "This was already reversed — nothing changed again.");
      } else if (result.warning) {
        toast.warning("Undone — schedule not restored", result.warning);
      } else {
        toast.success("Undone", activityTitle(item, names));
      }
      onClose();
    } catch (e) {
      setError(`Nothing was changed. ${userFacingMessage(e) ?? (e instanceof Error ? e.message : "Please try again.")}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const title = activityTitle(item, names);
  const context = activityContext(item, names);
  const sameDay = item.eventDate.toDateString() === item.recordedAt.toDateString();
  const accountLabels = item.direction === "move" && item.accountIds.length === 2 ? ["From", "To"] : ["Account", "Account"];
  const records: [string, string][] = [
    ...item.accountIds.map((id, i): [string, string] => [accountLabels[i] ?? "Account", names.account(id) ?? "Account"]),
    ...(item.personId ? [["Person", names.person(item.personId) ?? "Person"] as [string, string]] : []),
    ...(item.loanId ? [["Loan", names.loan(item.loanId) ?? "Loan"] as [string, string]] : []),
    ...(item.emiId ? [["EMI", names.emi(item.emiId) ?? "EMI"] as [string, string]] : []),
  ];
  const confirming = view.step === "confirm" && decision?.kind === "eligible";
  const signed = `${item.direction === "in" ? "+" : item.direction === "out" ? "−" : ""}${formatCurrency(item.amount)}`;

  const footer = (
    <div className="flex flex-col gap-2 sm:flex-row-reverse">
      {confirming ? (
        <>
          <Button size="lg" onClick={() => void confirmUndo()} disabled={busy} className="h-11 sm:h-10 sm:flex-1">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            {busy ? "Undoing…" : "Undo now"}
          </Button>
          <Button size="lg" variant="outline" onClick={() => setView({ step: "details" })} disabled={busy} className="h-11 sm:h-10 sm:flex-1">
            Keep it
          </Button>
        </>
      ) : (
        <>
          {decision?.kind === "eligible" && (
            <Button size="lg" onClick={() => setView({ step: "confirm" })} disabled={!undo.ready} className="h-11 sm:h-10 sm:flex-1">
              <RotateCcw className="size-4" />
              Undo
            </Button>
          )}
          <Button size="lg" variant="outline" asChild className="h-11 sm:h-10 sm:flex-1">
            <Link href={activityHref(item)}>
              <ExternalLink className="size-4" />
              Open original
            </Link>
          </Button>
        </>
      )}
    </div>
  );

  return (
    <DetailDrawer
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={confirming ? "Undo this action?" : activityKindLabel(item.kind)}
      description={confirming ? "Review what changes. Nothing happens until you confirm." : undefined}
      footer={footer}
      // Full width on a phone (the base sheet is ¾ width), a comfortable panel from `sm` up.
      className="data-[side=right]:w-full data-[side=right]:sm:max-w-md"
    >
      {item.kind === "cardPayment" && item.state === "active" && <CardPreviewBridge transactionId={item.anchor.id} onPreview={setCardPreview} />}
      <div className="flex flex-col gap-5">
        {/* Summary: what it was, how much, and its current state. */}
        <div className="flex items-start gap-3">
          <ActivityIcon item={item} className="size-11" />
          <div className="min-w-0 flex-1">
            <p className="text-base leading-snug font-semibold text-foreground">{title}</p>
            {context && <p className="mt-0.5 truncate text-sm text-muted-foreground">{context}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={cn("text-2xl font-semibold tracking-tight tabular-nums", item.state !== "active" && "text-muted-foreground line-through decoration-1")}>{signed}</span>
              {item.state !== "active" ? (
                <StatusChip label={item.state === "reversedOrReplaced" ? "Reversed or replaced" : "Needs review"} tone={item.state === "inconsistent" ? "warning" : "neutral"} />
              ) : item.historical ? (
                <StatusChip label="Recorded earlier" tone="neutral" />
              ) : null}
            </div>
          </div>
        </div>

        {confirming && decision?.kind === "eligible" ? (
          <section aria-label="What will change" className="flex flex-col gap-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">What will change</p>
              <ul className="flex flex-col gap-2 text-sm text-foreground/90">
                {decision.effects.map((line) => (
                  <li key={line} className="flex gap-2.5">
                    <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
            {decision.warning && (
              <p className="flex gap-2 rounded-xl bg-warning/12 p-3 text-xs text-warning-foreground dark:text-warning">
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{decision.warning}</span>
              </p>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
              Checked again against your latest records when you confirm.
            </p>
          </section>
        ) : (
          <>
            <StatusCard loadError={loadError} decision={decision} />

            <dl className="divide-y divide-border/50 rounded-xl border border-border/60 text-sm">
              <DetailRow label={sameDay ? "When" : "Dated"} value={sameDay ? formatWhen(item.recordedAt) : formatDay(item.eventDate)} />
              {!sameDay && <DetailRow label="Recorded" value={formatWhen(item.recordedAt)} />}
              {records.map(([label, value], i) => (
                <DetailRow key={`${label}-${i}`} label={label} value={value} />
              ))}
            </dl>
          </>
        )}

        {error && (
          <p role="alert" className="flex gap-2 rounded-xl bg-expense/10 p-3 text-sm text-expense">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </DetailDrawer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** Whether this can be undone, at a glance: tinted card + icon + one plain sentence. */
function StatusCard({ loadError, decision }: { loadError: string | null; decision: UndoDecision | null }) {
  const base = "flex gap-3 rounded-xl p-3.5 text-sm";
  if (loadError) {
    return (
      <section aria-label="Undo" className={cn(base, "bg-expense/10 text-expense")}>
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{loadError}</p>
      </section>
    );
  }
  if (decision == null) {
    return (
      <section aria-label="Undo" aria-busy className={cn(base, "bg-muted/50 text-muted-foreground")}>
        <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />
        <p>Checking whether this can be undone…</p>
      </section>
    );
  }
  const [Icon, tone, heading, body] =
    decision.kind === "eligible"
      ? [CheckCircle2, "bg-success/12 text-foreground [&>svg]:text-success", "This can be undone", "You'll see exactly what changes before anything happens."]
      : decision.kind === "alreadyUndone"
        ? [RotateCcw, "bg-muted/50 text-foreground [&>svg]:text-muted-foreground", "Already reversed", "This was reversed or replaced by a correction. Open the original to see the current version."]
        : [Lock, "bg-muted/50 text-foreground [&>svg]:text-muted-foreground", "Can't be undone here", decision.reason];
  return (
    <section aria-label="Undo" className={cn(base, tone)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-semibold">{heading}</p>
        <p className="mt-0.5 text-foreground/75">{body}</p>
      </div>
    </section>
  );
}
