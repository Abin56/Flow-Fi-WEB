"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, CreditCard as CreditCardIcon, Link2, Plus, Wallet } from "lucide-react";
import { BankCombobox, BankLogo } from "@/components/finance";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { bankById } from "@/lib/data/bank-registry";
import type { CardNetwork, SharedCreditLimit } from "@/lib/models/credit-card";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Field, FieldGroup, FormSection, LE_RADIUS, LOAN_EMI_INPUT, choiceClass } from "@/features/loans/components/loan-emi-ui";
import { defaultSharedLimitName } from "@/features/credit-cards/lib/shared-limit-save";
import { CARD_ACCENTS, type CardAccent, type CreditCardViewItem } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { CARD_GRADIENT } from "@/features/credit-cards/components/credit-card-tile";
import type { CardFormState } from "@/features/credit-cards/components/credit-cards-workspace";

const NETWORKS: CardNetwork[] = ["visa", "mastercard", "rupay", "amex"];
const INPUT = cn(LOAN_EMI_INPUT, "h-9");
const CHOICE = "flex h-8 items-center gap-1 rounded-[6px] border px-2.5 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring";
const COMBOBOX =
  "h-9 rounded-[6px] border-border-strong bg-card transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground focus:border-primary-accent-text focus:ring-2 focus:ring-ring dark:bg-input";

/** One of the two top-level answers — a quiet tinted card when selected, not a lime slab. */
function ModeOption({ selected, onSelect, icon: Icon, title, subtitle }: {
  selected: boolean;
  onSelect: () => void;
  icon: typeof Wallet;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        LE_RADIUS.card,
        "flex min-w-0 items-start gap-2.5 border px-3 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary-accent-text bg-primary/10" : "border-border-strong bg-card hover:border-muted-foreground",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary-accent-text bg-primary text-primary-foreground" : "border-border-strong",
        )}
      >
        {selected && <Check className="size-2.5" strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Icon className="size-3.5 text-muted-foreground" strokeWidth={2} />
          {title}
        </span>
        <span className="text-[11px] leading-snug text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}

function AmountInput({ value, onChange, placeholder = "0" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground">₹</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        className={cn(INPUT, "pl-7 font-semibold tabular-nums")}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className={cn(LE_RADIUS.card, "flex items-start gap-2 bg-warning/10 px-3 py-2 text-[11.5px] leading-snug text-foreground")}>
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" strokeWidth={2} />
      <span>{children}</span>
    </p>
  );
}

const cardLabel = (c: CreditCardViewItem) => `${c.name} •••• ${c.last4}`;

/**
 * Add/Edit Card → Credit limit. Two plain answers — "its own limit" or "shares a limit with another card"
 * (e.g. a Visa + RuPay companion pair on one ₹38,000 line). For shared, the user picks the OTHER CARD —
 * one already in FlowFi, or a new one added now — never a "group". Writes nothing: the workspace's save
 * turns `form` into a `LimitPlan` (`features/credit-cards/lib/shared-limit-save.ts`):
 *  - other card already on a shared limit → this card joins that limit (`existingShared`);
 *  - other card on its own limit → one new limit, both cards linked to it (`newShared` + `linkCardId`);
 *  - a new card → one new limit (or this card's current one), the new card created on it (`addPairCard`).
 */
export function CardLimitSection({
  form,
  setForm,
  sharedLimits,
  creditCards,
  editingCard,
  pairAccent,
  bankIdOf,
}: {
  form: CardFormState;
  setForm: Dispatch<SetStateAction<CardFormState>>;
  sharedLimits: SharedCreditLimit[];
  creditCards: CreditCardViewItem[];
  editingCard: CreditCardViewItem | null;
  /** The second card's colour as previewed (picked, or automatic). */
  pairAccent: CardAccent;
  /** A card's issuing bank, for its logo. */
  bankIdOf: (c: CreditCardViewItem) => string | null;
}) {
  const shared = form.limitSource !== "own";
  const otherCards = creditCards.filter((c) => c.id !== editingCard?.id);
  const membersOf = (groupId: string | null) => (groupId == null ? [] : otherCards.filter((c) => c.card.sharedLimitId === groupId));
  const groupOf = (id: string | null) => sharedLimits.find((sl) => sl.id === id) ?? null;

  // Edit only: the limit this card shares right now, and who with.
  const currentGroup = groupOf(editingCard?.card.sharedLimitId ?? null);
  const currentGroupOthers = membersOf(currentGroup?.id ?? null);
  const onCurrentGroup = currentGroup != null && form.limitSource === "existingShared" && form.selectedSharedLimitId === currentGroup.id;

  // An already-linked card opens on its relationship, not on offers to add or relink.
  const [changing, setChanging] = useState(false);
  const showRelationship = onCurrentGroup && currentGroupOthers.length > 0 && !changing && !form.addPairCard && form.linkCardId == null;
  const [partner, setPartner] = useState<"existing" | "new">(() => (form.addPairCard || otherCards.length === 0 ? "new" : "existing"));

  const targetGroup = form.limitSource === "existingShared" ? groupOf(form.selectedSharedLimitId) : null;
  const linkedCard = otherCards.find((c) => c.id === form.linkCardId) ?? null;
  const combinedText = Number(form.sharedLimitAmount) > 0 ? formatCurrency(Number(form.sharedLimitAmount)) : "one";
  const combinedChanged =
    targetGroup != null && form.sharedLimitAmount.trim() !== "" && Number(form.sharedLimitAmount) !== targetGroup.creditLimit;
  const leavesCurrentGroup = currentGroup != null && !onCurrentGroup;

  const joinGroup = (group: SharedCreditLimit, patch: Partial<CardFormState> = {}) =>
    setForm((f) => ({ ...f, limitSource: "existingShared", selectedSharedLimitId: group.id, sharedLimitAmount: String(group.creditLimit), ...patch }));

  /** The other card is one already in FlowFi. */
  const pickCard = (cardId: string) => {
    const other = otherCards.find((c) => c.id === cardId);
    if (!other) return;
    const otherGroup = groupOf(other.card.sharedLimitId);
    const clearPair = { addPairCard: false, pairName: "", pairLastFourDigits: "", pairCardNetwork: "" as const };
    if (otherGroup) {
      // Already on a shared limit → this card joins it; the other card is untouched.
      joinGroup(otherGroup, { linkCardId: other.id, ...clearPair });
    } else if (currentGroup) {
      // This card already has a shared limit → the other card joins it.
      joinGroup(currentGroup, { linkCardId: other.id, ...clearPair });
    } else {
      // Neither shares yet → one new limit for both, starting from the other card's limit.
      setForm((f) => ({
        ...f,
        limitSource: "newShared",
        selectedSharedLimitId: null,
        linkCardId: other.id,
        sharedLimitAmount: f.sharedLimitAmount || (other.card.creditLimit > 0 ? String(other.card.creditLimit) : ""),
        ...clearPair,
      }));
    }
  };

  /** The other card is a new one, added now. */
  const chooseNewCard = () => {
    setPartner("new");
    if (currentGroup) joinGroup(currentGroup, { linkCardId: null, addPairCard: true });
    else setForm((f) => ({ ...f, limitSource: "newShared", selectedSharedLimitId: null, linkCardId: null, addPairCard: true }));
  };
  const chooseExistingCard = () => {
    setPartner("existing");
    setForm((f) => ({ ...f, addPairCard: false, linkCardId: null }));
  };

  const chooseShared = () => {
    if (shared) return;
    if (currentGroup) joinGroup(currentGroup);
    else if (otherCards.length === 0) chooseNewCard();
    else setForm((f) => ({ ...f, limitSource: "newShared", selectedSharedLimitId: null, linkCardId: null, addPairCard: false }));
  };

  const amountField = (
    <Field
      label={targetGroup ? "Shared credit limit" : "Shared credit limit *"}
      className="gap-1"
      hint={
        combinedChanged
          ? `Changes it for every card on this limit (${membersOf(targetGroup!.id).length + 1} cards).`
          : "Counted once — not once per card."
      }
    >
      <AmountInput value={form.sharedLimitAmount} onChange={(v) => setForm((f) => ({ ...f, sharedLimitAmount: v }))} />
    </Field>
  );

  return (
    <FormSection title="Credit limit" icon={Wallet} className="gap-3">
      <div role="radiogroup" aria-label="Credit limit" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ModeOption
          selected={!shared}
          onSelect={() => setForm((f) => ({ ...f, limitSource: "own", addPairCard: false, linkCardId: null }))}
          icon={CreditCardIcon}
          title="Its own limit"
          subtitle="This card has a credit limit of its own."
        />
        <ModeOption
          selected={shared}
          onSelect={chooseShared}
          icon={Link2}
          title="Shares a limit"
          subtitle="Same limit as another card, e.g. a Visa + RuPay pair."
        />
      </div>

      {!shared && (
        <>
          <Field label="Card credit limit *" className="gap-1">
            <AmountInput value={form.creditLimit} onChange={(v) => setForm((f) => ({ ...f, creditLimit: v }))} />
          </Field>
          {currentGroup && (
            <Notice>
              This card will stop sharing {formatCurrency(currentGroup.creditLimit)}
              {currentGroupOthers.length > 0 ? ` with ${currentGroupOthers.map(cardLabel).join(", ")} — which keep${currentGroupOthers.length === 1 ? "s" : ""} it unchanged.` : "."}
            </Notice>
          )}
        </>
      )}

      {shared && (
        <>
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            This card and another card use the same {combinedText} credit limit. Each card has its own number, transactions and bill.
          </p>

          {showRelationship && currentGroup ? (
            <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1 text-xs">
                <span className="font-medium text-foreground">Shares its limit with</span>
                <CardChips cards={currentGroupOthers} bankIdOf={bankIdOf} />
                <button
                  type="button"
                  onClick={() => setChanging(true)}
                  className="mt-0.5 self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Link or add another card
                </button>
              </div>
              {amountField}
            </div>
          ) : (
            <>
              {otherCards.length > 0 && (
                <div role="radiogroup" aria-label="The other card" className="flex flex-wrap gap-1.5">
                  <button type="button" role="radio" aria-checked={partner === "existing"} onClick={chooseExistingCard} className={cn(CHOICE, choiceClass(partner === "existing"))}>
                    A card already in FlowFi
                  </button>
                  <button type="button" role="radio" aria-checked={partner === "new"} onClick={chooseNewCard} className={cn(CHOICE, choiceClass(partner === "new"))}>
                    <Plus className="size-3" strokeWidth={2.25} />A new card
                  </button>
                </div>
              )}

              {partner === "existing" && otherCards.length > 0 && (
                <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                  <Field label="Other card *" className="gap-1">
                    <Select value={form.linkCardId ?? (onCurrentGroup && currentGroupOthers[0] ? currentGroupOthers[0].id : undefined)} onValueChange={pickCard}>
                      <SelectTrigger className={cn(COMBOBOX, "w-full")}>
                        <SelectValue placeholder="Choose the other card" />
                      </SelectTrigger>
                      <SelectContent>
                        {otherCards.map((c) => {
                          const g = groupOf(c.card.sharedLimitId);
                          return (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="inline-flex items-center gap-2">
                                <BankLogo bankId={bankIdOf(c)} size={16} />
                                {cardLabel(c)}
                              </span>
                              {c.network !== "—" ? ` · ${c.network.toUpperCase()}` : ""}
                              {g ? ` · shares ${formatCurrency(g.creditLimit)}` : ""}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </Field>
                  {(targetGroup || linkedCard) && amountField}
                  {targetGroup && linkedCard && linkedCard.card.sharedLimitId === targetGroup.id && membersOf(targetGroup.id).length > 1 && (
                    <div className="flex flex-col gap-1 text-xs sm:col-span-2">
                      <span className="text-muted-foreground">Everyone on this limit</span>
                      <CardChips cards={membersOf(targetGroup.id)} bankIdOf={bankIdOf} />
                    </div>
                  )}
                </div>
              )}

              {partner === "new" && (
                <>
                  {!targetGroup && (
                    <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                      {amountField}
                      <Field label="Label (optional)" className="gap-1">
                        <input
                          className={INPUT}
                          placeholder={defaultSharedLimitName(bankById(form.bankId))}
                          value={form.sharedLimitName}
                          onChange={(e) => setForm((f) => ({ ...f, sharedLimitName: e.target.value }))}
                        />
                      </Field>
                    </div>
                  )}
                  {targetGroup && amountField}
                  <PairCardFields form={form} setForm={setForm} pairAccent={pairAccent} />
                </>
              )}
            </>
          )}

          {leavesCurrentGroup && currentGroup && (
            <Notice>
              This card will move off its current {formatCurrency(currentGroup.creditLimit)} shared limit
              {currentGroupOthers.length > 0 ? ` — ${currentGroupOthers.map(cardLabel).join(", ")} keep${currentGroupOthers.length === 1 ? "s" : ""} it unchanged.` : "."}
            </Notice>
          )}
        </>
      )}
    </FormSection>
  );
}

function CardChips({ cards, bankIdOf }: { cards: CreditCardViewItem[]; bankIdOf: (c: CreditCardViewItem) => string | null }) {
  if (cards.length === 0) return <span className="text-muted-foreground">No other card yet</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {cards.map((m) => (
        <li key={m.id} className={cn(LE_RADIUS.control, "flex items-center gap-1.5 bg-secondary px-2 py-1 font-medium text-foreground")}>
          <BankLogo bankId={bankIdOf(m)} size={16} />
          {m.name} <span className="font-mono tracking-widest text-muted-foreground">•••• {m.last4}</span>
          {m.network !== "—" && <span className="text-[10px] text-muted-foreground uppercase">{m.network}</span>}
        </li>
      ))}
    </ul>
  );
}

/** "Add another card now" — optional; skipping it creates nothing, and a card can join the limit later. */
function PairCardFields({
  form,
  setForm,
  pairAccent,
}: {
  form: CardFormState;
  setForm: Dispatch<SetStateAction<CardFormState>>;
  pairAccent: CardAccent;
}) {
  if (!form.addPairCard) {
    return (
      <button
        type="button"
        onClick={() => setForm((f) => ({ ...f, addPairCard: true }))}
        className={cn(
          LE_RADIUS.card,
          "flex h-9 items-center justify-center gap-1.5 border border-dashed border-border-strong text-xs font-semibold text-foreground outline-none transition-colors hover:border-muted-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Plus className="size-3.5" strokeWidth={2.25} />
        Add another card now
        <span className="font-normal text-muted-foreground">· optional</span>
      </button>
    );
  }
  const set = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={cn(LE_RADIUS.card, "flex flex-col gap-2.5 bg-secondary/60 px-3 py-3")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-foreground">Other card on this limit</span>
        <button
          type="button"
          onClick={() =>
            setForm((f) => ({
              ...f,
              addPairCard: false,
              pairName: "",
              pairLastFourDigits: "",
              pairCardNetwork: "",
              pairStatementDay: "",
              pairPaymentDueDay: "",
              pairBankId: null,
              pairCardHolderName: "",
              pairColor: null,
            }))
          }
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Add it later
        </button>
      </div>
      <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2 md:grid-cols-3">
        <Field label="Card name" className="gap-1">
          <input className={INPUT} placeholder="e.g. HDFC Millennia" value={form.pairName} onChange={(e) => set("pairName", e.target.value)} />
        </Field>
        <Field label="Last 4 digits *" className="gap-1">
          <input
            className={cn(INPUT, "font-mono tracking-widest")}
            placeholder="5678"
            maxLength={4}
            inputMode="numeric"
            value={form.pairLastFourDigits}
            onChange={(e) => set("pairLastFourDigits", e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Field label="Bank" className="gap-1">
          <BankCombobox
            value={form.pairBankId ?? form.bankId}
            onChange={(bankId) => set("pairBankId", bankId === form.bankId ? null : bankId)}
            placeholder="Same as this card"
            className={COMBOBOX}
          />
        </Field>
        <Field label="Card holder" className="gap-1">
          <input
            className={INPUT}
            placeholder={form.cardHolderName.trim() || "Same as this card"}
            value={form.pairCardHolderName}
            onChange={(e) => set("pairCardHolderName", e.target.value)}
          />
        </Field>
        <Field label="Statement day" className="gap-1">
          <input
            type="number"
            min={1}
            max={31}
            className={INPUT}
            placeholder={`Same (${form.statementDay || "—"})`}
            value={form.pairStatementDay}
            onChange={(e) => set("pairStatementDay", e.target.value)}
          />
        </Field>
        <Field label="Due day" className="gap-1">
          <input
            type="number"
            min={1}
            max={31}
            className={INPUT}
            placeholder={`Same (${form.paymentDueDay || "—"})`}
            value={form.pairPaymentDueDay}
            onChange={(e) => set("pairPaymentDueDay", e.target.value)}
          />
        </Field>
      </div>
      <FieldGroup label="Network" className="gap-1">
        <div className="flex flex-wrap gap-1.5">
          {NETWORKS.map((n) => {
            const selected = form.pairCardNetwork === n;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={selected}
                onClick={() => set("pairCardNetwork", selected ? "" : n)}
                className={cn(CHOICE, choiceClass(selected))}
              >
                {selected && <Check className="size-3.5" strokeWidth={2.5} />}
                {n.toUpperCase()}
              </button>
            );
          })}
        </div>
      </FieldGroup>
      <FieldGroup label="Colour" className="gap-1">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Other card colour">
          {CARD_ACCENTS.map((accent) => {
            const selected = pairAccent === accent;
            return (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={accent}
                title={accent}
                onClick={() => set("pairColor", accent)}
                style={{ background: CARD_GRADIENT[accent] }}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-white shadow-e1 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "ring-2 ring-primary-accent-text ring-offset-2 ring-offset-secondary",
                )}
              >
                {selected && <Check className="size-3" strokeWidth={2.5} />}
              </button>
            );
          })}
        </div>
      </FieldGroup>
    </motion.div>
  );
}
