"use client";

import { History, Layers, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type PaymentIntent = "now" | "past" | "many";

/**
 * What is being recorded: a payment now, a past payment (paid before FlowFi — no balance change) or several installments
 * now. It is pinned under the sheet's header and shared by all three pages of the flow, so switching is a tab change in
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
    <div role="radiogroup" aria-label="What are you recording?" className="mx-auto grid max-w-[44rem] grid-cols-3 gap-1 rounded-xl border border-border bg-secondary p-1" data-testid="payment-intent">
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
              "flex min-w-0 flex-col items-center gap-0.5 rounded-[9px] px-1.5 py-1.5 text-center outline-none transition-[background-color,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:flex-row sm:justify-center sm:gap-2 sm:px-3 sm:text-left",
              on ? "bg-primary text-primary-foreground shadow-e1 ring-1 ring-primary-accent-text" : "text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] font-semibold">{label}</span>
              <span className={cn("hidden truncate text-[10.5px] font-medium sm:block", on ? "text-primary-foreground/70" : "text-muted-foreground")}>{hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
