"use client";

/**
 * Record Payment (sheet) → Remaining money.
 *
 * Two presentation pieces, both owned by Record Payment:
 *  - `RemainingMoneyNotice` — a small message-style card under the receipt card when extra money is detected: the
 *    amount, what it is for (one chip per use) and the coverage bar. The whole card opens the drawer.
 *  - `RemainingMoneyDrawer` — the Advance income / Set aside editor as a right-side drawer INSIDE the Record Payment
 *    sheet (rendered through TransactionSheet's `layer`). It slides in from the sheet's right edge and covers the whole
 *    sheet, with a content-sized editing panel on wide layouts.
 *
 * The open flag, the drafts, the plan and every validation belong to the parent / `ExtraAllocationEditor` /
 * `planExtraAllocation`; closing the drawer only hides it, so nothing is lost, reset or submitted.
 */

import { ArrowLeft, Check, ChevronRight, CircleAlert, Info, Wallet } from "lucide-react";
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
  wide?: boolean;
}

function Chips({ drafts, direction, firstName, linkOptions, wide }: Pick<RemainingProps, "drafts" | "direction" | "firstName" | "linkOptions" | "wide">) {
  const allocations = draftsToAllocations(drafts, linkOptions);
  const visible = wide ? drafts.slice(0, 3) : drafts;
  return (
    <ul className={cn("min-w-0", wide ? "divide-y divide-border/70" : "flex flex-wrap items-center gap-1.5")} aria-label="What the money left is for">
      {visible.map((d, i) => {
        const meta = KIND_META[d.kind];
        const Icon = meta.icon;
        const label = d.kind === "purpose" ? allocationName(allocations[i], direction, firstName) : meta.label;
        return (
          <li key={d.key} className={cn(
            "flex max-w-full min-w-0 items-center gap-1.5 py-1",
            wide ? "text-xs" : cn("rounded-full pr-2.5 pl-1.5 text-[12.5px] font-bold", meta.tint, meta.ink),
          )}>
            <span className={cn("shrink-0", wide && cn("grid size-5 place-items-center rounded-md", meta.tint, meta.ink))}>
              <Icon className={wide ? "size-3" : "size-3.5"} aria-hidden />
            </span>
            <span className={cn("truncate", wide && "font-medium text-foreground/85")}>{wide && d.kind === "purpose" && !d.title.trim() ? "Unnamed purpose" : label}</span>
            <span className={cn("shrink-0 tabular-nums", wide && "ml-auto font-bold")}>{money(Number(d.amount) || 0)}</span>
          </li>
        );
      })}
      {visible.length < drafts.length && (
        <li className="pt-1 text-[11px] font-semibold text-foreground/75">+{drafts.length - visible.length} more</li>
      )}
    </ul>
  );
}

export function RemainingMoneyNotice({ extra, direction, firstName, drafts, linkOptions, needsAttention, wide, open, onOpen, drawerId }: RemainingProps & { open: boolean; onOpen: () => void; drawerId: string }) {
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
        wide && "rounded-xl p-3",
        needsAttention
          ? wide ? "border-settle-emi-edge/45 bg-linear-to-br from-settle-emi-tint/45 to-card to-60%" : "border-warning/55 bg-warning/[0.07]"
          : wide
            ? "border-settle-advance-edge/30 bg-linear-to-br from-settle-advance-tint/65 to-card to-75% hover:border-settle-advance-edge/65"
            : "border-border-strong hover:border-muted-foreground",
      )}
    >
      <div className={cn("flex items-center gap-3", wide && "gap-2.5")}>
        <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-[11px] bg-settle-advance-tint text-settle-advance-text", wide && "size-8 rounded-lg ring-1 ring-settle-advance-edge/15")}>
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
          aria-expanded={open}
          aria-controls={drawerId}
          data-testid="rp-remaining-toggle"
          className={cn(
            "flex h-8 shrink-0 items-center gap-0.5 rounded-full border pr-2 pl-3 text-xs font-bold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
            "after:absolute after:inset-0 after:rounded-2xl after:content-['']",
            needsAttention ? "border-warning/60 bg-warning/20 text-foreground" : "border-border-strong bg-card text-foreground group-hover:bg-secondary",
            wide && "h-7 rounded-lg after:rounded-xl",
            wide && !needsAttention && "border-settle-advance-edge/25 text-settle-advance-text group-hover:bg-settle-advance-tint",
          )}
        >
          {needsAttention ? "Finish" : "Change"}
          <ChevronRight className={cn("size-3.5 transition-transform duration-200 group-hover:translate-x-0.5", EASE)} aria-hidden />
        </button>
      </div>

      <div className={cn("mt-2.5", wide && "mt-2")}>
        <Chips drafts={drafts} direction={direction} firstName={firstName} linkOptions={linkOptions} wide={wide} />
      </div>
      <div className={cn("mt-2.5", wide && "mt-1.5")}>
        <AllocationMeter extra={extra} drafts={drafts} allocations={allocations} className={wide ? "h-1.5" : undefined} />
      </div>
      {needsAttention && (
        <p className={cn("mt-2 flex items-center gap-1 text-[11.5px] font-medium text-foreground/80", wide && "text-settle-emi-text")}>
          <CircleAlert className={cn("size-3.5 shrink-0", !wide && "text-warning")} aria-hidden />
          {wide ? "Allocation needs attention" : "Not finished — tap to complete it."}
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
  const plan = planExtraAllocation({ extra: p.extra, direction: p.direction, allocations, money });
  const { wide } = p;
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

  return (
    <div
      id={id}
      role="region"
      aria-label="Remaining money"
      aria-hidden={!open}
      inert={!open}
      data-testid="rp-remaining-popup"
      data-state={open ? "open" : "closed"}
      className={cn(
        "absolute inset-0 z-30 flex flex-col text-foreground transition-[translate,visibility] duration-[380ms] motion-reduce:transition-none",
        wide ? "items-end bg-surface-hero/35 p-3" : "bg-card",
        EASE,
        open ? "visible translate-x-0" : "invisible translate-x-full",
      )}
    >
      <div className={cn(
        "flex min-h-0 w-full flex-col",
        wide ? "max-h-full max-w-[50rem] overflow-hidden rounded-2xl bg-card shadow-[0_20px_54px_-18px_rgb(0_0_0/0.55)] ring-1 ring-black/10 dark:ring-white/12" : "flex-1",
      )} data-testid="rp-remaining-editor">
        <header className="relative shrink-0 bg-surface-hero pt-[env(safe-area-inset-top)] text-hero-foreground">
          <div aria-hidden className={cn(
            "pointer-events-none absolute inset-0",
            wide
              ? "bg-[radial-gradient(68%_240%_at_100%_0%,oklch(0.40_0.08_132/0.75),transparent_75%),linear-gradient(105deg,oklch(0.225_0.035_140),transparent_65%)]"
              : "bg-[radial-gradient(70%_180%_at_0%_0%,oklch(0.34_0.07_126/0.5),transparent_62%)]",
          )} />
          <div className={cn("relative mx-auto flex w-full max-w-[1040px] items-center gap-3 px-4 py-3 sm:px-5", wide && "border-b border-primary/20")}>
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
              <p className="truncate text-[11px] font-semibold tracking-[0.08em] text-hero-foreground/65 uppercase">{wide ? "Record payment" : "Record Payment · Remaining money"}</p>
              <h3 className={cn("truncate font-heading text-[16px] font-semibold text-hero-foreground", wide && "text-[19px] leading-tight tracking-tight")}>{wide ? "Remaining money" : "Advance income / Set aside"}</h3>
            </div>
            <div className={cn("shrink-0 text-right", wide && "border-l border-white/15 pl-4")}>
              <p className="text-[11px] font-medium text-hero-foreground/75">{wide ? "Total to allocate" : "Left to use"}</p>
              <p className={cn("font-heading text-[20px] leading-tight font-bold text-primary tabular-nums", wide && "text-[26px] leading-none tracking-tight")}>{money(p.extra)}</p>
            </div>
          </div>
        </header>

        <div className={cn(
          "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-secondary/55",
          wide ? "grid grid-cols-[minmax(0,1fr)_12.75rem] items-start gap-3 p-4" : "flex-1 [scrollbar-gutter:stable]",
        )} data-testid="rp-remaining-editor-body">
          <div className={cn(
            "sticky z-10 border-border/70 bg-card",
            wide ? "top-0 col-start-2 row-start-1 rounded-xl border bg-linear-to-b from-settle-advance-tint/45 to-card to-80% shadow-e1" : "top-0 border-b",
          )} data-testid="rp-remaining-sheet-summary">
            <div className={cn("mx-auto flex w-full max-w-[1040px] flex-col gap-2 px-4 py-2.5 sm:px-5", wide && "gap-2.5 p-3 sm:px-3")}>
              {wide && <p className="text-[10px] font-bold tracking-[0.09em] text-foreground/65 uppercase">Allocation summary</p>}
              {!wide && (
                <div className="flex items-center justify-between gap-3">
                  <AllocationSummary plan={plan} />
                  <span className="shrink-0 text-xs font-semibold text-foreground/65 tabular-nums">
                    <span className="text-foreground">{money(Math.max(0, plan.assigned))}</span> of {money(p.extra)} assigned
                  </span>
                </div>
              )}
              {wide && (
                <div className="flex flex-col gap-0.5">
                  <span className="font-heading text-[23px] leading-none font-bold tracking-tight tabular-nums [overflow-wrap:anywhere]">{money(plan.assigned)}</span>
                  <span className="text-xs font-medium text-foreground/70">Assigned</span>
                </div>
              )}
              <AllocationMeter extra={p.extra} drafts={p.drafts} allocations={allocations} className={wide ? "h-1.5" : undefined} />
              {wide && <AllocationSummary plan={plan} showDetails />}
            </div>
          </div>

          <div className={cn("min-w-0", wide ? "col-start-1 row-start-1" : "mx-auto w-full max-w-[1040px] px-4 py-4 sm:px-5")}>
            <ExtraAllocationEditor
              extra={p.extra}
              direction={p.direction}
              firstName={p.firstName}
              drafts={p.drafts}
              onChange={onChange}
              linkOptions={p.linkOptions}
              incomeCategories={incomeCategories}
              hideSummary
              compact={wide}
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-card">
          <div className={cn("mx-auto flex w-full max-w-[1040px] items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5", wide && "py-2.5")}>
            <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-foreground/65">
              {wide ? (
                <span className="flex items-center gap-1.5">
                  <Info className="size-3.5 shrink-0 text-foreground/60" aria-hidden />
                  <span>Applies when you record the payment.</span>
                </span>
              ) : <>Kept as you type. Nothing is recorded until you press <span className="font-semibold text-foreground/80">Record</span>.</>}
            </p>
            <button
              type="button"
              onClick={onClose}
              data-testid="rp-remaining-done"
              className={cn(
                "flex h-10 min-w-28 shrink-0 items-center justify-center gap-1.5 rounded-full px-5 text-[13px] font-bold shadow-e2 transition-[background-color,transform] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]",
                wide && "h-9 min-w-24 rounded-lg",
                p.needsAttention ? "border border-border-strong bg-card text-foreground hover:bg-secondary" : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {p.needsAttention ? <ArrowLeft className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
              {p.needsAttention ? "Back" : "Done"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
