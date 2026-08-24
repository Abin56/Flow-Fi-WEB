import { ClayAvatar } from "@/components/clay/clay-avatar";
import { formatCurrency } from "@/lib/format";
import type { PersonStatus, PersonViewRow } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<PersonStatus, string> = {
  active: "bg-success/16 text-success",
  overdue: "bg-warning/25 text-warning-foreground",
  settled: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<PersonStatus, string> = {
  active: "Active",
  overdue: "Overdue",
  settled: "Settled",
};

export function PeopleGrid({
  people,
  selectedId,
  onSelect,
}: {
  people: PersonViewRow[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((person) => {
        const net = person.youAreOwed - person.youOwe;
        return (
          <button
            key={person.id}
            type="button"
            onClick={() => onSelect(person.id)}
            className={cn(
              "surface-flat flex flex-col gap-3 rounded-2xl border p-5 text-left transition-colors",
              selectedId === person.id ? "border-primary/50" : "border-border/50 hover:border-border",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <ClayAvatar name={person.name} size={40} />
                <div>
                  <p className="text-sm font-semibold text-foreground">{person.name}</p>
                  <p className="text-xs text-muted-foreground">{person.relationship}</p>
                </div>
              </div>
              <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", STATUS_CLASS[person.status])}>
                {STATUS_LABEL[person.status]}
              </span>
            </div>

            <div>
              <p className={cn("text-xl font-bold tabular-nums", net >= 0 ? "text-success" : "text-expense")}>
                {net >= 0 ? "+" : "-"}
                {formatCurrency(Math.abs(net))}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{net >= 0 ? "Owes you" : "You owe"}</p>
            </div>

            <p className="text-xs text-muted-foreground">Last activity: {person.lastActivity}</p>
          </button>
        );
      })}
    </div>
  );
}
