import { Plus } from "lucide-react";

export function PeopleHeader({ onAddPerson }: { onAddPerson?: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">People Ledger</h1>
        <p className="mt-1 text-sm text-muted-foreground">Track money you owe and money others owe you.</p>
      </div>
      {onAddPerson && (
        <button
          type="button"
          onClick={onAddPerson}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="size-4" />
          Add Person
        </button>
      )}
    </div>
  );
}
