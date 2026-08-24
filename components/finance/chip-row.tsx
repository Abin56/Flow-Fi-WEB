import { cn } from "@/lib/utils";

/** Shared flat, square-cornered, bordered text/number/date input class — the input half of the
 *  flat "sectioned" dialog language (pair with `SectionLabel`/`ChipRow`/`SectionedFormDialog`). */
export const FLAT_INPUT =
  "h-10 w-full rounded-none border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-primary";

/** A row of selectable chip buttons — the flat-dialog replacement for a `Select` dropdown when the
 *  option set is short enough to show all at once (network, account type, interest type, …). */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "border px-3 py-1.5 text-xs font-semibold transition-colors",
            value === o.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
