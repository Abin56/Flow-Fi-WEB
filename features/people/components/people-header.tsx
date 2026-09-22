import { Plus } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";

export function PeopleHeader({ onAddPerson }: { onAddPerson?: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">People Ledger</h1>
        <p className="mt-1 text-sm text-muted-foreground">Track money you owe and money others owe you.</p>
      </div>
      {onAddPerson && (
        <ClayButton onClick={onAddPerson} className="gap-1.5">
          <Plus className="size-4" />
          Add Person
        </ClayButton>
      )}
    </div>
  );
}
