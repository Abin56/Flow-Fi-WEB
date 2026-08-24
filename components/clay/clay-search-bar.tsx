import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClaySearchBarProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  placeholder?: string;
  shortcut?: string;
}

/** Pressed/inset clay well — reads as "type here" purely from the shadow direction, no border trick needed.
 *  Renders as a button (opens the command palette) rather than a real input, since it's a trigger, not a field. */
export function ClaySearchBar({ placeholder = "Search...", shortcut = "Ctrl K", className, ...props }: ClaySearchBarProps) {
  return (
    <button
      type="button"
      className={cn(
        "clay-pressed flex h-10 max-w-sm flex-1 items-center gap-2 rounded-2xl px-3.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      <Search className="size-4 shrink-0" />
      <span className="truncate">{placeholder}</span>
      {shortcut && (
        <kbd className="ml-auto shrink-0 rounded-lg border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}