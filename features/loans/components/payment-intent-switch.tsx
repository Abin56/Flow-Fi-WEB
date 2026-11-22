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
  disabled = false,
}: {
  value: PaymentIntent;
  onChange: (v: PaymentIntent) => void;
  lent: boolean;
  isLoan: boolean;
  disabled?: boolean;
}) {
  const options: { value: PaymentIntent; icon: LucideIcon; label: string; hint: string }[] = [
    { value: "now", icon: Wallet, label: lent ? "Receive now" : "Pay now", hint: "Moves money" },
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
              "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[6px] px-2 text-center outline-none transition-[background-color,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              on ? "bg-primary text-primary-foreground shadow-e1 ring-1 ring-primary-accent-text" : "text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
            <span className="truncate text-[12.5px] font-semibold">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
