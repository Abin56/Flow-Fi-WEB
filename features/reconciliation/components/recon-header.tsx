"use client";

/**
 * The statement account bar: which card or account this statement belongs to — required, never pre-selected, and
 * shown with its name, kind and masked last four digits. Every possible match comes from this one account only.
 * Also carries the review period and the draft privacy notice.
 */

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, CreditCard, Landmark, Loader2, Lock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatRowDate, type AccountIdentity } from "./recon-ui";

export type AccountOption = AccountIdentity;

export function ReconAccountBar({
  options,
  accountId,
  onChange,
  status,
  onRetry,
  period,
  expiresAt,
  storageFailed,
}: {
  options: AccountOption[];
  accountId: string | null;
  onChange: (id: string) => void;
  /** Whether the account list itself has loaded. */
  status: "loading" | "error" | "ready";
  onRetry: () => void;
  period: { from: Date; to: Date } | null;
  expiresAt: number | null;
  storageFailed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === accountId) ?? null;
  const missing = accountId != null && selected == null && status === "ready";
  const Icon = selected?.isCard ? CreditCard : Landmark;

  return (
    <section
      aria-label="Statement account"
      data-testid="account-bar"
      data-selected={selected ? "true" : "false"}
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-3 py-2.5 sm:px-4 lg:min-h-10 lg:flex-nowrap lg:gap-x-3 lg:rounded-xl lg:py-1", selected ? "border-border bg-card" : "border-warning/50 bg-warning/5")}
    >
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-3 lg:flex-initial lg:shrink-0 lg:basis-auto lg:gap-2.5">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl lg:size-7 lg:rounded-lg", selected ? "bg-primary/12 text-primary-accent-text" : "bg-warning/15 text-warning")}>
          {selected ? <Icon className="size-4.5 lg:size-4" /> : <AlertTriangle className="size-4.5 lg:size-4" />}
        </span>
        <div className="min-w-0 lg:flex lg:items-baseline lg:gap-x-2.5">
          <p className="shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase lg:text-[10.5px]">Statement account</p>
          {status === "loading" && !selected ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="accounts-loading">
              <Loader2 className="size-3.5 animate-spin" /> Loading your accounts…
            </p>
          ) : status === "error" && !selected ? (
            <p className="text-sm text-danger" role="alert" data-testid="accounts-error">
              Couldn&apos;t load your accounts, so none can be chosen yet.
            </p>
          ) : selected ? (
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 lg:flex-nowrap" data-testid="selected-account">
              <span className="truncate text-sm font-semibold text-foreground lg:max-w-[18rem]">{selected.name}</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground">{selected.kind}</span>
              {selected.last4 && <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">•••• {selected.last4}</span>}
            </p>
          ) : (
            <p className="text-sm text-foreground lg:truncate" data-testid="choose-account">
              <span className="font-semibold">No account selected.</span>{" "}
              <span className="text-muted-foreground">{missing ? "The account chosen earlier no longer exists — choose another." : "Choose the card or account this statement belongs to. Nothing is pre-selected."}</span>
            </p>
          )}
          {selected && <p className="text-[11px] text-muted-foreground lg:hidden">Matches are checked against this account only.</p>}
        </div>
      </div>

      {status === "error" ? (
        <ClayButton size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </ClayButton>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <ClayButton size="sm" variant={selected ? "secondary" : "primary"} disabled={status === "loading" && options.length === 0} aria-label={selected ? "Change statement account" : "Choose statement account"} data-testid="account-picker">
              {selected ? "Change" : "Choose account"}
              <ChevronDown className="size-3.5" />
            </ClayButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-1.5">
            {options.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No active accounts. Add one in Accounts first.</p>
            ) : (
              <ul role="listbox" aria-label="Accounts" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
                {options.map((o) => {
                  const active = o.id === accountId;
                  const OptionIcon = o.isCard ? CreditCard : Landmark;
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        aria-label={`${o.name}${o.last4 ? ` •••• ${o.last4}` : ""} · ${o.kind}`}
                        data-testid="account-option"
                        onClick={() => {
                          setOpen(false);
                          if (!active) onChange(o.id);
                        }}
                        className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none", active && "bg-primary/10")}
                      >
                        <OptionIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{o.name}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {o.kind}
                            {o.last4 ? ` · •••• ${o.last4}` : ""}
                          </span>
                        </span>
                        {active && <Check className="size-4 shrink-0 text-primary-accent-text" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      )}

      {/* Desktop: one quiet line (period · draft scope); the full privacy sentence stays readable on hover and for screen readers. */}
      <div className="flex w-full min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground lg:ml-auto lg:w-auto lg:min-w-0 lg:flex-row lg:items-center lg:gap-3 lg:whitespace-nowrap">
        {period && (
          <p className="tabular-nums">
            <span className="lg:hidden">Statement rows </span>
            {formatRowDate(period.from)} – {formatRowDate(period.to, true)}
          </p>
        )}
        <p className="flex min-w-0 items-start gap-1.5 lg:items-center" data-testid="privacy-notice" title={storageFailed ? undefined : "Draft kept in this tab for 12 hours at most. Screenshots and raw text are never saved."}>
          <Lock className="mt-px size-3 shrink-0 lg:mt-0" />
          {storageFailed ? (
            <span className="lg:truncate">This browser isn&apos;t keeping a draft — your review lasts until you leave or refresh.</span>
          ) : (
            // relative: the screen-reader-only tail is clipped here instead of widening <main>'s scroll area.
            <span className="lg:relative lg:truncate">
              Draft kept in this tab for 12 hours at most{expiresAt ? ` (until ${new Date(expiresAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}
              <span className="lg:sr-only">. Screenshots and raw text are never saved.</span>
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
