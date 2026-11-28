"use client";

import { useRef, useState } from "react";
import { usePeopleActions, usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import type { AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrencyExact } from "@/lib/format";
import type { LedgerEntry } from "@/lib/models/person";
import type { PaymentLineInput } from "@/lib/repositories/person-payment-repository";
import { cn } from "@/lib/utils";

const isGeneral = (entry: LedgerEntry) => entry.obligationRef == null && (entry.sourceKind == null || entry.sourceKind === "manual");
const isInstallment = (key?: string | null) => key != null && /^(loan|emi)-inst:.+/.test(key);

function installmentReceiptLine(key: string, amount: number): PaymentLineInput {
  return { key, amount, route: { kind: "derived", obligationRef: key, sourceKind: key.startsWith("loan-inst:") ? "loanInstallment" : "emiInstallment" } };
}

/** Move only the selected amount from the general line, preserving allocations from earlier edits. */
function reallocateReceipt(entries: readonly LedgerEntry[], key: string, amount: number): PaymentLineInput[] {
  const amounts = new Map<string, number>();
  let general = 0;
  for (const entry of entries) {
    if (isGeneral(entry)) general = round2(general + entry.amount);
    else if (entry.obligationRef) amounts.set(entry.obligationRef, round2((amounts.get(entry.obligationRef) ?? 0) + entry.amount));
  }
  amounts.set(key, round2((amounts.get(key) ?? 0) + amount));
  const lines = [...amounts].map(([key, amount]) => installmentReceiptLine(key, amount));
  const rest = round2(general - amount);
  if (rest > PAYMENT_EPSILON) lines.push({ key: "general", amount: rest, route: { kind: "general" } });
  return lines;
}

export const PEOPLE_ROW_BUTTON = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border-strong bg-card px-2.5 text-xs font-semibold whitespace-nowrap outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const PEOPLE_ROW_FIELD = "h-8 max-w-full rounded-md border border-border-strong bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AgreementPeopleReceipt({ line, onClose }: { line: AgreementPeopleLine; onClose: () => void }) {
  const { data: people = [] } = usePeople();
  const { entriesByPersonId, isLoading: ledgerLoading } = usePeopleLedgerEntries();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const actions = usePeopleActions();
  const [pickedId, setPickedId] = useState("");
  const [amount, setAmount] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const person = people.find((p) => p.id === line.personId);
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entriesByPersonId[line.personId] ?? []) {
    if (entry.deletedAt != null || !entry.paymentId) continue;
    const group = groups.get(entry.paymentId) ?? [];
    group.push(entry);
    groups.set(entry.paymentId, group);
  }
  const receipts = [...groups].flatMap(([id, entries]) => {
    const available = round2(entries.filter(isGeneral).reduce((sum, entry) => sum + entry.amount, 0));
    if (available <= PAYMENT_EPSILON || entries.some((e) => e.type !== "receivedBack" || e.parentEntryId || e.installmentPaymentRef || e.incomeTransactionRef || isPaidDirectlyEntry(e) || (!isGeneral(e) && !isInstallment(e.obligationRef)))) return [];
    const receipt = transactions.find((t) => t.id === entries[0].transactionRef && t.deletedAt == null && t.isPersonLedgerMovement && t.linkedPersonId === line.personId && t.type === "income");
    if (!receipt || entries.some((e) => e.transactionRef !== receipt.id) || Math.abs(receipt.amount - entries.reduce((sum, entry) => sum + entry.amount, 0)) > PAYMENT_EPSILON) return [];
    return [{ id, entries, receipt, available }];
  }).sort((a, b) => b.receipt.dateTime.getTime() - a.receipt.dateTime.getTime());
  const picked = receipts.find((r) => r.id === pickedId) ?? (pickedId === "" ? receipts[0] : undefined);
  const max = picked ? Math.min(line.remaining, picked.available) : 0;
  const value = amount == null ? max : round2(Number(amount));
  const valid = Number.isFinite(value) && value > PAYMENT_EPSILON && value <= max + PAYMENT_EPSILON;

  async function save() {
    if (!person || !actions || !picked || !valid || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await actions.editPersonPayment(person, picked.id, {
        direction: "theyPaid",
        amount: picked.receipt.amount,
        date: picked.receipt.dateTime,
        accountId: picked.receipt.accountId,
        note: picked.entries[0].note,
        lines: reallocateReceipt(picked.entries, line.key, value),
        extra: null,
      }, { keepReceiptTransactionId: picked.receipt.id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply the receipt. Please try again.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      {ledgerLoading || transactionsLoading ? <p role="status">Loading People receipts…</p> : receipts.length === 0 ? (
        <p className="basis-full text-muted-foreground">No eligible unassigned receipt was found. Check the original entry in People Ledger.</p>
      ) : (
        <>
          <label className="grid min-w-0 gap-1 font-medium text-foreground">People receipt
            <select autoFocus className={PEOPLE_ROW_FIELD} value={picked?.id ?? ""} disabled={saving} onChange={(e) => { setPickedId(e.target.value); setAmount(null); }}>
              {!picked && <option value="">Choose a receipt</option>}
              {receipts.map(({ id, receipt, available }) => <option key={id} value={id}>{receipt.dateTime.toLocaleDateString("en-IN")} · {formatCurrencyExact(available)} available</option>)}
            </select>
          </label>
          <label className="grid gap-1 font-medium text-foreground">Amount to apply (₹)
            <input className={`${PEOPLE_ROW_FIELD} w-28`} inputMode="decimal" type="number" step="0.01" min="0.01" max={max} value={amount ?? (picked ? String(max) : "")} disabled={saving || !picked} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button type="button" className={cn(PEOPLE_ROW_BUTTON, "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85")} disabled={!valid || saving || !actions || !person} onClick={() => void save()}>{saving ? "Applying…" : "Apply receipt"}</button>
          <p className="order-last basis-full text-[11px] leading-snug text-muted-foreground">Uses the original receipt and account transaction. Any remainder stays available in People Ledger.</p>
        </>
      )}
      <button type="button" className={PEOPLE_ROW_BUTTON} disabled={saving} onClick={onClose}>Close</button>
      {error && <p role="alert" className="basis-full text-expense">{error}</p>}
    </div>
  );
}
