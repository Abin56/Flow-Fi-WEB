"use client";

import { History, Layers, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type PaymentIntent = "now" | "past" | "many";

/**
 * What is being recorded: a payment now, a past payment (paid before FlowFi — no balance change) or several installments
 * now. It is pinned under the sheet's header (one compact line — the hint is its tooltip) and shared by all three pages of the flow, so switching is a tab change in
 * the same sheet — never a new window — and "Pay now" is always one tap back.
 */
export function PaymentIntentSwitch({
  value,
  onChange,
  lent,
  isLoan,
  singlePaymentLabel = false,
  disabled = false,
}: {
  value: PaymentIntent;
  onChange: (v: PaymentIntent) => void;
  lent: boolean;
  isLoan: boolean;
  singlePaymentLabel?: boolean;
  disabled?: boolean;
}) {
  const options: { value: PaymentIntent; icon: LucideIcon; label: string; hint: string }[] = [
    { value: "now", icon: Wallet, label: singlePaymentLabel ? "Single payment" : lent ? "Receive now" : "Pay now", hint: singlePaymentLabel ? "Pay from your account or record a direct lender payment" : "Moves money" },
    { value: "past", icon: History, label: lent ? "Past repayment" : "Past payment", hint: "Paid before FlowFi" },
    { value: "many", icon: Layers, label: lent ? "Several now" : "Pay several", hint: `Pick ${isLoan ? "installments" : "EMIs"}` },
  ];
  return (
    <div role="radiogroup" aria-label="What are you recording?" className="grid grid-cols-3 gap-0.5 rounded-[8px] border border-border bg-secondary p-0.5" data-testid="payment-intent">
      {options.map(({ value: v, icon: Icon, label, hint }) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(v)}
            title={hint}
            className={cn(
              "flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 py-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:px-2",
              on ? "bg-primary text-primary-foreground ring-1 ring-inset ring-primary-accent-text" : "text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            <Icon className="hidden size-3.5 shrink-0 sm:block" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
            <span className="text-xs leading-tight font-semibold [overflow-wrap:anywhere]">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
