"use client";

import { CalendarClock, ChevronRight, Landmark } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { cn } from "@/lib/utils";

export type LoanEmiTab = "loan" | "emi";

const TABS: { value: LoanEmiTab; label: string; icon: typeof Landmark }[] = [
  { value: "loan", label: "Loans", icon: Landmark },
  { value: "emi", label: "EMIs", icon: CalendarClock },
];

const ADD_CHOICES: { value: LoanEmiTab; label: string; description: string; examples: string[]; icon: typeof Landmark }[] = [
  {
    value: "loan",
    label: "Loan",
    description: "Money borrowed from a bank or a person.",
    examples: ["Bank loan", "Personal"],
    icon: Landmark,
  },
  {
    value: "emi",
    label: "EMI",
    description: "Fixed monthly installments for a purchase or card.",
    examples: ["Store finance", "Credit card"],
    icon: CalendarClock,
  },
];

/** The single Loan & EMI section: one Add flow that asks Loan or EMI, then hands off to the existing workspace's form. */
export function LoanEmiWorkspace({ initialTab = "loan" }: { initialTab?: LoanEmiTab }) {
  const [tab, setTab] = useState<LoanEmiTab>(initialTab);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [addSignals, setAddSignals] = useState({ loan: 0, emi: 0 });

  function choose(kind: LoanEmiTab) {
    setChooserOpen(false);
    setTab(kind);
    setAddSignals((s) => ({ ...s, [kind]: s[kind] + 1 }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Loan & EMI"
        className="mx-1 inline-flex w-full gap-1 self-start rounded-2xl border border-border bg-muted p-1 sm:w-auto"
      >
        {TABS.map(({ value, label, icon: Icon }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none",
                active
                  ? "bg-card text-foreground shadow-e1 ring-1 ring-border"
                  : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", active ? "text-primary-accent-text" : "text-muted-foreground")} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Both stay mounted so a chooser pick reaches the target workspace's add signal. */}
      <div hidden={tab !== "loan"}>
        <LoansWorkspace onAddRequest={() => setChooserOpen(true)} addSignal={addSignals.loan} />
      </div>
      <div hidden={tab !== "emi"}>
        <EmiWorkspace onAddRequest={() => setChooserOpen(true)} addSignal={addSignals.emi} />
      </div>

      <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] gap-5 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-semibold">What are you adding?</DialogTitle>
            <DialogDescription>Choose one — you can add the details next.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ADD_CHOICES.map(({ value, label, description, examples, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => choose(value)}
                className="group flex items-center gap-4 rounded-2xl border-2 border-border bg-card p-4 text-left shadow-e1 transition-all outline-none hover:-translate-y-0.5 hover:border-primary hover:bg-primary/10 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0 sm:flex-col sm:items-start sm:gap-3 sm:p-5"
              >
                <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-e1">
                  <Icon className="size-6" strokeWidth={2.25} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-heading text-lg leading-tight font-semibold text-foreground">{label}</span>
                  <span className="text-sm text-muted-foreground">{description}</span>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {examples.map((ex) => (
                      <span
                        key={ex}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/80"
                      >
                        {ex}
                      </span>
                    ))}
                  </span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:hidden" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
