"use client";

import { Bell, Calendar, HandCoins, Mail, MoreHorizontal, Paperclip, Pencil, Phone, Plus, Share2, Split, StickyNote, Trash2, Users, X } from "lucide-react";
import { useRef, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { usePeople } from "@/hooks/use-people";
import { formatCurrency } from "@/lib/format";
import { cycleContaining, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { Person } from "@/lib/models/person";
import type { PersonActivityItem, PersonViewRow } from "@/features/people/hooks/use-people-data";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonUpcomingEmi } from "@/features/people/hooks/use-person-upcoming-emi";
import { PersonCycleStatementSection } from "@/features/people/components/cycle-statement/person-cycle-statement-section";
import { PersonActivityFeed } from "@/features/people/components/person-activity-feed";
import { AddEntryMode, type AddEntryParams, type AddEntryType } from "@/features/people/components/workspace/add-entry-mode";
import { EditPersonMode, type EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import { WsLabel } from "@/features/people/components/workspace/person-workspace-ui";
import { SettleEntryMode, type SettleEntryParams } from "@/features/people/components/workspace/settle-entry-mode";
import { SettleUpMode } from "@/features/people/components/workspace/settle-up-mode";
import { ShareStatementMode } from "@/features/people/components/workspace/share-statement-mode";
import { SplitExpenseMode } from "@/features/people/components/workspace/split-expense-mode";
import { cn } from "@/lib/utils";

/** The workspace's internal modes — the shell (header) stays put; only the content area changes. */
type Mode =
  | { kind: "overview" }
  | { kind: "add"; type?: AddEntryType }
  | { kind: "settle" }
  | { kind: "settleEntry"; entry: PersonActivityItem }
  | { kind: "split" }
  | { kind: "share" }
  | { kind: "edit" };

/** Complex modes get a wider shell; quick forms a narrower one. */
const WIDE: Mode["kind"][] = ["overview", "split", "share"];

const VIEWS = ["Activity", "Details"] as const;
type View = (typeof VIEWS)[number];

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary data-[state=open]:text-foreground";

const SECONDARY_ACTION =
  "flex h-9 items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground";

function DetailRow({ icon: Icon, label, children }: { icon: typeof Calendar; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
        {label}
      </span>
      <span className="min-w-0 text-right font-medium break-words text-foreground">{children}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon?: typeof Calendar; children: React.ReactNode }) {
  return (
    <WsLabel>
      <span className="inline-flex items-center gap-1.5">
        {Icon && <Icon className="size-3.5" strokeWidth={1.75} />}
        {children}
      </span>
    </WsLabel>
  );
}

/**
 * The Person Ledger workspace — one centered surface (full-height sheet on phones) that behaves like a
 * small app: the overview (position, actions, Activity/Details) plus Add, Settle, Split, Share and Edit
 * modes that slide in within the same shell — no second backdrop, no modal-on-modal. Same data, statement
 * engine and repository calls as before — layout and interaction only.
 */
export function PersonOverviewPanel({
  person,
  rawPerson,
  open,
  onClose,
  onAddEntry,
  onSettleEntry,
  onEditPerson,
  onDelete,
}: {
  person: PersonViewRow;
  /** The stored `Person` record — Settle, Split and Edit act on it. */
  rawPerson: Person | null;
  open: boolean;
  onClose: () => void;
  /** Records a "gave"/"borrowed" entry for this person (same payload as the old Add Transaction dialog). */
  onAddEntry?: (params: AddEntryParams) => Promise<void>;
  /** Settles one "gave"/"borrowed" entry (same payload as the old Settle Transaction dialog). */
  onSettleEntry?: (params: SettleEntryParams) => Promise<void>;
  onEditPerson?: (patch: EditPersonPatch) => Promise<void>;
  onDelete?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "overview" });
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [view, setView] = useState<View>("Activity");
  const [cycle, setCycle] = useState<StatementCycle>(() => cycleContaining(new Date()));
  const scrollRef = useRef<HTMLDivElement>(null);
  const { statement, isLoading, linkedEmis, setRepays } = usePersonCycleStatement(person.id, cycle);
  const { items: upcomingEmi } = usePersonUpcomingEmi(person.id);
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: people = [] } = usePeople();
  const net = person.youAreOwed - person.youOwe;
  const contact = [person.phone, person.email].filter(Boolean).join(" · ");
  const subline = [`${person.transactionsCount} ${person.transactionsCount === 1 ? "transaction" : "transactions"}`, contact]
    .filter(Boolean)
    .join(" · ");

  const go = (next: Mode) => {
    setDirection(next.kind === "overview" ? "back" : "forward");
    setMode(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const back = () => go({ kind: "overview" });

  const actions = (
    <div className="flex flex-wrap items-center gap-y-2">
      <button
        type="button"
        onClick={() => go({ kind: "add" })}
        disabled={!onAddEntry}
        className="flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary pr-4 pl-3 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Plus className="size-4" strokeWidth={2.25} />
        Add
      </button>
      <span className="mx-2.5 h-5 w-px bg-border-strong/60" aria-hidden />
      <div className="-ml-1 flex items-center">
        <button type="button" onClick={() => go({ kind: "settle" })} disabled={!rawPerson} className={SECONDARY_ACTION}>
          <HandCoins className="size-4" strokeWidth={1.75} />
          Settle
        </button>
        <button type="button" onClick={() => go({ kind: "split" })} disabled={!rawPerson} className={SECONDARY_ACTION}>
          <Split className="size-4" strokeWidth={1.75} />
          Split
        </button>
        <button type="button" onClick={() => go({ kind: "share" })} disabled={statement == null} className={SECONDARY_ACTION}>
          <Share2 className="size-4" strokeWidth={1.75} />
          Share
        </button>
      </div>
    </div>
  );

  const loansNote = (person.loanReceivable > 0 || person.loanPayable > 0) && (
    <p className="mt-4 max-w-md text-xs leading-relaxed text-muted-foreground">
      Loans are settled from the Loan, outside this statement. Overall incl. loans {formatCurrency(Math.abs(net))}
      {net > 0 ? " owed to you" : net < 0 ? " you owe" : ""}
      {" · "}Direct balance {formatCurrency(Math.abs(person.directBalance))}
      {person.directBalance > 0 ? " owed to you" : person.directBalance < 0 ? " you owe" : ""}
      {person.loanReceivable > 0 && ` · Loans owed to you ${formatCurrency(person.loanReceivable)}`}
      {person.loanPayable > 0 && ` · Loans you owe ${formatCurrency(person.loanPayable)}`}
    </p>
  );

  const overview = (
    <>
      <div className="shrink-0 px-4 pt-5 pb-6 sm:px-7 sm:pt-6">
        <PersonCycleStatementSection
          statement={statement}
          isLoading={isLoading}
          cycle={cycle}
          onCycleChange={setCycle}
          linkedEmis={linkedEmis}
          setRepays={setRepays}
          actions={actions}
          footnote={loansNote}
        />
      </div>

      <div role="tablist" aria-label="Person workspace" className="sticky top-0 z-10 flex shrink-0 gap-6 border-y border-border bg-card px-4 sm:px-7">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              "-mb-px border-b-2 py-3 text-sm transition-colors outline-none focus-visible:text-foreground",
              view === v ? "border-primary-accent-text font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      <div
        key={view}
        className={cn(
          "px-4 pt-4 animate-in duration-200 fade-in-0 sm:px-7",
          // Activity: the feed takes the remaining height and scrolls its own list (sm+); Details scrolls with the page.
          view === "Activity" ? "flex flex-col pb-4 sm:min-h-0 sm:flex-1" : "pb-7",
        )}
      >
        {view === "Activity" ? (
          <PersonActivityFeed
            person={person}
            statement={statement}
            isLoading={isLoading}
            onSettleEntry={onSettleEntry ? (entry) => go({ kind: "settleEntry", entry }) : undefined}
            onAdd={onAddEntry ? () => go({ kind: "add" }) : undefined}
          />
        ) : (
          <div className="grid gap-x-10 gap-y-7 md:grid-cols-2">
            <div>
              <SectionTitle>Overview</SectionTitle>
              <div className="mt-1 divide-y divide-border">
                <DetailRow icon={Calendar} label="First transaction">
                  {person.firstTransaction || "—"}
                </DetailRow>
                <DetailRow icon={Users} label="Relationship">
                  {person.relationship || "—"}
                </DetailRow>
                {person.phone && (
                  <DetailRow icon={Phone} label="Phone">
                    {person.phone}
                  </DetailRow>
                )}
                {person.email && (
                  <DetailRow icon={Mail} label="Email">
                    {person.email}
                  </DetailRow>
                )}
              </div>
            </div>

            <div>
              <SectionTitle icon={Bell}>Upcoming EMI</SectionTitle>
              {upcomingEmi.length === 0 ? (
                <p className="mt-2.5 text-sm text-muted-foreground">No upcoming EMI</p>
              ) : (
                <div className="mt-1 divide-y divide-border">
                  {upcomingEmi.slice(0, 5).map((item) => (
                    <div key={item.loanId} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-foreground">{item.label}</span>
                        <span className="text-xs text-muted-foreground">
                          Due {item.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          {item.isPayerOnly && " · Pays this for you"}
                        </span>
                      </div>
                      <span className="font-semibold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <SectionTitle icon={StickyNote}>Notes</SectionTitle>
              {person.notes ? (
                <p className="mt-2.5 text-sm whitespace-pre-wrap text-foreground">{person.notes}</p>
              ) : (
                <p className="mt-2.5 text-sm text-muted-foreground">No notes yet.</p>
              )}
            </div>

            <div>
              <SectionTitle icon={Paperclip}>Attachments</SectionTitle>
              <p className="mt-2.5 text-sm text-muted-foreground">No attachments yet.</p>
            </div>
          </div>
        )}
      </div>
    </>
  );

  let content: React.ReactNode = overview;
  if (mode.kind === "add" && onAddEntry) {
    content = (
      <AddEntryMode
        personName={person.name}
        initialType={mode.type}
        onBack={back}
        onSave={async (params) => {
          await onAddEntry(params);
          back();
        }}
      />
    );
  } else if (mode.kind === "settle" && rawPerson) {
    content = <SettleUpMode person={rawPerson} onBack={back} onDone={back} />;
  } else if (mode.kind === "settleEntry" && onSettleEntry) {
    content = (
      <SettleEntryMode
        personName={person.name}
        entry={mode.entry}
        onBack={back}
        onSettle={async (params) => {
          await onSettleEntry(params);
          back();
        }}
      />
    );
  } else if (mode.kind === "split" && rawPerson) {
    content = <SplitExpenseMode person={rawPerson} accounts={accounts} categories={categories} people={people} onBack={back} onDone={back} />;
  } else if (mode.kind === "share" && statement) {
    content = <ShareStatementMode statement={statement} phone={person.phone} onBack={back} />;
  } else if (mode.kind === "edit" && rawPerson && onEditPerson) {
    content = (
      <EditPersonMode
        person={rawPerson}
        onBack={back}
        onSave={async (patch) => {
          await onEditPerson(patch);
          back();
        }}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          // Escape steps back out of a mode first; only closes from the overview.
          if (mode.kind !== "overview") {
            e.preventDefault();
            back();
          }
        }}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0",
          // Phone: full-height sheet. Desktop: centered workspace that widens for complex modes.
          "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
          "sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[min(92vh,60rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px]",
          "transition-[max-width] duration-200 ease-out",
          WIDE.includes(mode.kind) ? "sm:max-w-3xl" : "sm:max-w-xl",
        )}
      >
        {/* Shell header — who, always visible */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-7">
          <ClayAvatar name={person.name} size={36} />
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate font-heading text-base leading-tight font-semibold tracking-tight sm:text-lg">{person.name}</DialogTitle>
            <DialogDescription className="truncate text-xs text-muted-foreground">{subline}</DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {onEditPerson && rawPerson && (
              <button
                type="button"
                aria-label="Edit person"
                aria-pressed={mode.kind === "edit"}
                onClick={() => go({ kind: "edit" })}
                className={cn(ICON_BUTTON, mode.kind === "edit" && "bg-secondary text-foreground")}
              >
                <Pencil className="size-4" strokeWidth={1.75} />
              </button>
            )}
            {onDelete && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More actions" className={ICON_BUTTON}>
                    <MoreHorizontal className="size-4" strokeWidth={1.75} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40 rounded-[8px]">
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2 strokeWidth={1.75} />
                    Delete person
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <button type="button" aria-label="Close person view" onClick={onClose} className={ICON_BUTTON}>
              <X className="size-[18px]" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Mode content — slides in from the right going deeper, from the left coming back */}
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <div
            key={mode.kind === "settleEntry" ? `settleEntry:${mode.entry.id}` : mode.kind}
            className={cn(
              "animate-in duration-200 ease-out fade-in-0",
              // The overview's Activity view fits the workspace height so only its transaction list scrolls.
              mode.kind === "overview" ? cn("flex flex-1 flex-col", view === "Activity" && "sm:min-h-0") : "min-h-full shrink-0",
              direction === "forward" ? "slide-in-from-right-6" : "slide-in-from-left-6",
            )}
          >
            {content}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
