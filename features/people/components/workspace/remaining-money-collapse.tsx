"use client";

/**
 * Record Payment (sheet) → Remaining money.
 *
 * Two presentation pieces, both owned by Record Payment:
 *  - `RemainingMoneyNotice` — a small message-style card under the receipt card when extra money is detected: the
 *    amount, what it is for (one chip per use) and the coverage bar. The whole card opens the drawer.
 *  - `RemainingMoneyDrawer` — the Advance income / Set aside editor as a right-side drawer INSIDE the Record Payment
 *    sheet (rendered through TransactionSheet's `layer`). It slides in from the sheet's right edge and covers the whole
 *    sheet; it is not another dialog, adds no history entry and no extra blur.
 *
 * Layout of the drawer, top to bottom — each fact shown once:
 *  header (back · what this is · the amount) → sticky overview (status + assigned/total + bar) → the rows → Done.
 *
 * The open flag, the drafts, the plan and every validation belong to the parent / `ExtraAllocationEditor` /
 * `planExtraAllocation`; closing the drawer only hides it, so nothing is lost, reset or submitted.
 */

import { ArrowLeft, Check, ChevronRight, CircleAlert, Wallet } from "lucide-react";
import { useEffect, useRef } from "react";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { planExtraAllocation } from "@/lib/engines/extra-allocation";
import type { PaymentDirection } from "@/lib/engines/person-payment";
import type { PurposeLink } from "@/lib/models/purpose-fund";
import { cn } from "@/lib/utils";
import { AllocationMeter, AllocationSummary, ExtraAllocationEditor, KIND_META, allocationName, draftsToAllocations, type AllocationDraft } from "./extra-allocation-editor";

const EASE = "ease-[cubic-bezier(0.22,1,0.36,1)]";

interface RemainingProps {
  extra: number;
  direction: PaymentDirection;
  firstName: string;
  drafts: AllocationDraft[];
  linkOptions: readonly PurposeLink[];
  /** The split is not valid yet (money unassigned or over-assigned, a name or category missing). */
  needsAttention: boolean;
}

function Chips({ drafts, direction, firstName, linkOptions }: Pick<RemainingProps, "drafts" | "direction" | "firstName" | "linkOptions">) {
  const allocations = draftsToAllocations(drafts, linkOptions);
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="What the money left is for">
      {drafts.map((d, i) => {
        const meta = KIND_META[d.kind];
        const Icon = meta.icon;
        const label = d.kind === "purpose" ? allocationName(allocations[i], direction, firstName) : meta.label;
        return (
          <li key={d.key} className={cn("flex max-w-full min-w-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1.5 text-[12.5px] font-bold", meta.tint, meta.ink)}>
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
            <span className="shrink-0 tabular-nums">{money(Number(d.amount) || 0)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function RemainingMoneyNotice({ extra, direction, firstName, drafts, linkOptions, needsAttention, open, onOpen, drawerId }: RemainingProps & { open: boolean; onOpen: () => void; drawerId: string }) {
  const allocations = draftsToAllocations(drafts, linkOptions);
  return (
    <section
      aria-labelledby="rp-remaining-heading"
      data-testid="rp-remaining-collapse"
      data-open={open || undefined}
      className={cn(
        // The whole card is the target (the button's ::after stretches over it); hover lifts it a touch.
        "group relative overflow-hidden rounded-2xl border bg-card p-3.5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:shadow-e2 active:scale-[0.99]",
        "duration-300 animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none motion-reduce:active:scale-100",
        EASE,
        needsAttention ? "border-warning/55 bg-warning/[0.07]" : "border-border-strong hover:border-muted-foreground",
      )}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-settle-advance-tint text-settle-advance-text">
          <Wallet className="size-4" strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 id="rp-remaining-heading" className="text-[11px] font-bold tracking-[0.1em] text-foreground/65 uppercase">
            Remaining money
          </h4>
          <p className="flex items-baseline gap-1.5">
            <span className="font-heading text-[22px] leading-tight font-bold tracking-tight text-settle-advance-text tabular-nums" data-testid="rp-left-over">
              {money(extra)}
            </span>
            <span className="text-xs font-medium text-foreground/60">left to use</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={drawerId}
          data-testid="rp-remaining-toggle"
          className={cn(
            "flex h-8 shrink-0 items-center gap-0.5 rounded-full border pr-2 pl-3 text-xs font-bold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
            "after:absolute after:inset-0 after:rounded-2xl after:content-['']",
            needsAttention ? "border-warning/60 bg-warning/20 text-foreground" : "border-border-strong bg-card text-foreground group-hover:bg-secondary",
          )}
        >
          {needsAttention ? "Finish" : "Change"}
          <ChevronRight className={cn("size-3.5 transition-transform duration-200 group-hover:translate-x-0.5", EASE)} aria-hidden />
        </button>
      </div>

      <div className="mt-2.5">
        <Chips drafts={drafts} direction={direction} firstName={firstName} linkOptions={linkOptions} />
      </div>
      <div className="mt-2.5">
        <AllocationMeter extra={extra} drafts={drafts} allocations={allocations} />
      </div>
      {needsAttention && (
        <p className="mt-2 flex items-center gap-1 text-[11.5px] font-medium text-foreground/80">
          <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
          Not finished — tap to complete it.
        </p>
      )}
    </section>
  );
}

/**
 * The drawer layer. It is absolutely positioned over the whole Record Payment sheet (the sheet is `fixed` +
 * `overflow-hidden`, so it clips and anchors this) and slides in from the right. Kept mounted so the editor's local state
 * survives; hidden + inert while closed. Focus moves to Back on open and returns to the card's button on close.
 */
export function RemainingMoneyDrawer({
  id,
  open,
  onClose,
  onChange,
  incomeCategories,
  ...p
}: RemainingProps & {
  id: string;
  open: boolean;
  onClose: () => void;
  onChange: (next: AllocationDraft[]) => void;
  incomeCategories: readonly { id: string; name: string }[];
}) {
  const allocations = draftsToAllocations(p.drafts, p.linkOptions);
  // Read-only: the same plan the editor computes, so the overview can live above the scroll.
  const plan = planExtraAllocation({ extra: p.extra, direction: p.direction, allocations, money });
  const backRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      // After the slide has started, so the browser doesn't scroll the off-screen panel into view.
      const t = setTimeout(() => backRef.current?.focus({ preventScroll: true }), 60);
      wasOpen.current = true;
      return () => clearTimeout(t);
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    }
  }, [open, id]);

  const reveal = (delay: string) =>
    cn("transition-[opacity,transform] duration-300 motion-reduce:transition-none", EASE, open ? cn("translate-x-0 opacity-100", delay) : "translate-x-4 opacity-0");

  return (
    <div
      id={id}
      role="region"
      aria-label="Remaining money — Advance income / Set aside"
      aria-hidden={!open}
      inert={!open}
      data-testid="rp-remaining-popup"
      data-state={open ? "open" : "closed"}
      className={cn(
        "absolute inset-0 z-30 flex flex-col bg-card text-foreground transition-[transform,visibility,box-shadow] duration-[380ms] motion-reduce:transition-none",
        EASE,
        open ? "visible translate-x-0 shadow-[-16px_0_40px_-20px_rgba(10,12,8,0.5)]" : "invisible translate-x-full shadow-none",
      )}
    >
      {/* Header — same near-black hero surface as Record Payment, so it reads as the same sheet, one level in. */}
      <header className="relative shrink-0 bg-surface-hero pt-[env(safe-area-inset-top)] text-hero-foreground">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]" />
        <div className="relative mx-auto flex w-full max-w-[1040px] items-center gap-3 px-4 py-3 sm:px-5">
          <button
            ref={backRef}
            type="button"
            onClick={onClose}
            aria-label="Back to Record Payment"
            data-testid="rp-remaining-back"
            className="group/back grid size-9 shrink-0 place-items-center rounded-[11px] bg-white/[0.07] text-hero-foreground ring-1 ring-white/10 transition-colors hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:outline-none"
          >
            <ArrowLeft className={cn("size-4 transition-transform duration-200 group-hover/back:-translate-x-0.5", EASE)} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold tracking-[0.08em] text-hero-foreground/60 uppercase">Record Payment · Remaining money</p>
            <p className="truncate font-heading text-[16px] font-semibold text-hero-foreground">Advance income / Set aside</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-medium text-hero-foreground/60">Left to use</p>
            <p className="font-heading text-[20px] leading-tight font-bold text-primary tabular-nums">{money(p.extra)}</p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-secondary/55 [scrollbar-gutter:stable]">
        {/* Sticky overview: the one place the status, the progress and the bar are shown. */}
        <div className="sticky top-0 z-10 border-b border-border/70 bg-card" data-testid="rp-remaining-sheet-summary">
          <div className={cn("mx-auto flex w-full max-w-[1040px] flex-col gap-2 px-4 py-2.5 sm:px-5", reveal("delay-75"))}>
            <div className="flex items-center justify-between gap-3">
              <AllocationSummary plan={plan} />
              <span className="shrink-0 text-xs font-semibold text-foreground/65 tabular-nums">
                <span className="text-foreground">{money(Math.max(0, plan.assigned))}</span> of {money(p.extra)} assigned
              </span>
            </div>
            <AllocationMeter extra={p.extra} drafts={p.drafts} allocations={allocations} />
          </div>
        </div>

        <div className={cn("mx-auto w-full max-w-[1040px] px-4 py-4 sm:px-5", reveal("delay-150"))}>
          <ExtraAllocationEditor
            extra={p.extra}
            direction={p.direction}
            firstName={p.firstName}
            drafts={p.drafts}
            onChange={onChange}
            linkOptions={p.linkOptions}
            incomeCategories={incomeCategories}
            hideSummary
          />
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-[1040px] items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-foreground/65">
            Kept as you type. Nothing is recorded until you press <span className="font-semibold text-foreground/80">Record</span>.
          </p>
          <button
            type="button"
            onClick={onClose}
            data-testid="rp-remaining-done"
            className={cn(
              "flex h-10 min-w-28 shrink-0 items-center justify-center gap-1.5 rounded-full px-5 text-[13px] font-bold shadow-e2 transition-[background-color,transform] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]",
              p.needsAttention ? "border border-border-strong bg-card text-foreground hover:bg-secondary" : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {p.needsAttention ? <ArrowLeft className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
            {p.needsAttention ? "Back" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
