"use client";

/**
 * LOCAL DESIGN/QA ONLY (the route 404s outside a development server). Synthetic data; nothing is read or written.
 * Shows the three ways the contextual panel is used: a compact single choice, a repeating split, and an advanced
 * filter with expandable sections.
 */

import { useState } from "react";
import { ChevronDown, Landmark, ListFilter, Split, Tag, Utensils, Car, ShoppingBag, HeartPulse, Home, Plane } from "lucide-react";
import { ContextPanel, PanelOptionList, PanelSection, StackedRows, type PanelOption } from "@/components/finance/context-panel";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const CATEGORIES: PanelOption[] = [
  { value: "food", label: "Food & dining", hint: "Restaurants, groceries", icon: <Utensils className="size-4" /> },
  { value: "transport", label: "Transport", icon: <Car className="size-4" /> },
  { value: "shopping", label: "Shopping", icon: <ShoppingBag className="size-4" /> },
  { value: "health", label: "Health", icon: <HeartPulse className="size-4" /> },
  { value: "home", label: "Home & rent", icon: <Home className="size-4" /> },
  { value: "travel", label: "Travel", icon: <Plane className="size-4" /> },
];
const ACCOUNTS: PanelOption[] = Array.from({ length: 12 }, (_, i) => ({ value: `acc${i}`, label: `Demo Account ${i + 1}`, hint: `•••• ${1000 + i * 37}` }));
const PEOPLE = ["Asha", "Ben", "Chitra", "Dev", "Esha", "Farid"];

let seq = 0;
const nextId = () => `r${++seq}`;
interface SplitRow {
  id: string;
  person: string;
  amount: string;
}

const triggerCls =
  "inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-sm font-medium outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring";

export function PanelShowcase() {
  const [category, setCategory] = useState<string | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [account, setAccount] = useState<string | null>("acc2");

  const TOTAL = 1200;
  const [rows, setRows] = useState<SplitRow[]>([{ id: nextId(), person: "Asha", amount: "600" }]);
  const [saved, setSaved] = useState<SplitRow[]>([]);
  const [splitOpen, setSplitOpen] = useState(false);
  const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const left = TOTAL - sum;
  const splitError = rows.some((r) => !r.person || !(Number(r.amount) > 0)) ? "Each row needs a person and an amount." : left !== 0 ? (left > 0 ? `₹${left} left to assign` : `₹${-left} over`) : null;

  const [status, setStatus] = useState("any");
  const [notes, setNotes] = useState("");
  const [applied, setApplied] = useState("No filters");
  const [flash, setFlash] = useState<string | null>(null);
  const toast = (m: string) => {
    setFlash(m);
    window.setTimeout(() => setFlash(null), 2200);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 px-4 py-10">
      <header>
        <h1 className="font-heading text-xl font-semibold">Contextual panels</h1>
        <p className="text-sm text-muted-foreground">Floating panels that open beside the trigger. On a phone they become a bottom sheet.</p>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">1 · Single choice (compact)</h2>
        <div className="flex flex-wrap gap-3">
          <ContextPanel
            testId="panel-category"
            open={categoryOpen}
            onOpenChange={setCategoryOpen}
            width="sm"
            title="Category"
            description="Pick one"
            trigger={
              <button type="button" className={triggerCls} data-testid="trigger-category">
                <Tag className="size-4 text-muted-foreground" />
                {CATEGORIES.find((c) => c.value === category)?.label ?? "Choose category"}
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            }
          >
            <PanelOptionList
              ariaLabel="Categories"
              options={CATEGORIES}
              value={category}
              onChange={(v) => {
                setCategory(v);
                setCategoryOpen(false);
              }}
            />
          </ContextPanel>

          <ContextPanel
            testId="panel-account"
            width="sm"
            title="Account"
            description="12 accounts"
            trigger={
              <button type="button" className={triggerCls} data-testid="trigger-account">
                <Landmark className="size-4 text-muted-foreground" />
                {ACCOUNTS.find((a) => a.value === account)?.label}
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            }
          >
            <PanelOptionList ariaLabel="Accounts" options={ACCOUNTS} value={account} onChange={setAccount} />
          </ContextPanel>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">2 · Split an expense (add / remove rows)</h2>
        <div className="flex flex-wrap items-center gap-3">
          <ContextPanel
            testId="panel-split"
            open={splitOpen}
            onOpenChange={setSplitOpen}
            width="md"
            align="start"
            title="Split ₹1,200"
            description="Divide this expense between people"
            applyLabel="Save split"
            applyDisabled={splitError != null}
            footerNote={<span className={cn(splitError ? "text-expense" : "text-success")}>{splitError ?? "Fully assigned"}</span>}
            onApply={() => {
              setSaved(rows);
              toast(`Split saved · ${rows.length} ${rows.length === 1 ? "person" : "people"}`);
            }}
            trigger={
              <button type="button" className={triggerCls} data-testid="trigger-split">
                <Split className="size-4 text-muted-foreground" />
                {saved.length ? `Split · ${saved.length}` : "Split expense"}
              </button>
            }
          >
            <StackedRows<SplitRow>
              rows={rows}
              onChange={setRows}
              createRow={() => ({ id: nextId(), person: "", amount: left > 0 ? String(left) : "" })}
              minRows={1}
              maxRows={30}
              addLabel="Add person"
              rowLabel={(i) => `person ${i + 1}`}
              renderRow={(row, i, update) => (
                <>
                  <Select value={row.person || undefined} onValueChange={(v) => update({ person: v })}>
                    <SelectTrigger aria-label={`Person ${i + 1}`} className="w-full">
                      <SelectValue placeholder="Who?" />
                    </SelectTrigger>
                    <SelectContent>
                      {PEOPLE.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input inputMode="decimal" aria-label={`Amount ${i + 1}`} placeholder="₹ 0" value={row.amount} onChange={(e) => update({ amount: e.target.value.replace(/[^\d.]/g, "") })} />
                </>
              )}
            />
          </ContextPanel>
          {saved.length > 0 && (
            <span className="text-xs text-muted-foreground" data-testid="split-saved">
              {saved.map((r) => `${r.person} ₹${r.amount}`).join(" · ")}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">3 · Filters with expandable sections</h2>
        <div className="flex flex-wrap items-center gap-3">
          <ContextPanel
            testId="panel-filters"
            width="md"
            align="start"
            title="Filters"
            description="Narrow the list"
            applyLabel="Apply"
            onApply={() => {
              setApplied(status === "any" && !notes ? "No filters" : `${status === "any" ? "" : `Status: ${status}`}${notes ? " · note" : ""}`);
              toast("Filters applied");
            }}
            trigger={
              <button type="button" className={triggerCls} data-testid="trigger-filters">
                <ListFilter className="size-4 text-muted-foreground" />
                Filters
              </button>
            }
          >
            <div className="flex flex-col gap-2">
              <PanelSection title="Status" summary={status === "any" ? "Any" : status} defaultOpen>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger aria-label="Status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                  </SelectContent>
                </Select>
              </PanelSection>
              <PanelSection title="Notes" summary={notes ? notes.slice(0, 24) : "None"}>
                <Textarea aria-label="Notes contain" placeholder="Contains…" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </PanelSection>
              <PanelSection title="Advanced" summary="Defaults">
                <p className="text-xs text-muted-foreground">More options appear only when you ask for them.</p>
              </PanelSection>
            </div>
          </ContextPanel>
          <span className="text-xs text-muted-foreground" data-testid="filters-applied">
            {applied}
          </span>
        </div>
      </section>

      <div aria-live="polite" className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2">
        {flash && (
          <div data-testid="flash" className="animate-in fade-in-0 slide-in-from-bottom-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg">
            {flash}
          </div>
        )}
      </div>
    </main>
  );
}
