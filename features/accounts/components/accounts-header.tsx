import { MoreHorizontal, RefreshCw, Users } from "lucide-react";

export function AccountsHeader() {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Accounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">View and manage all your accounts in one place</p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="surface-flat flex items-center gap-2 rounded-xl border border-border/50 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          <RefreshCw className="size-4" />
          <span className="hidden sm:inline">Refresh</span>
        </button>
        <button
          type="button"
          className="surface-flat flex items-center gap-2 rounded-xl border border-border/50 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          <Users className="size-4" />
          <span className="hidden sm:inline">Manage Groups</span>
        </button>
        <button
          type="button"
          aria-label="More options"
          className="surface-flat flex size-9 items-center justify-center rounded-xl border border-border/50 text-foreground transition-colors hover:bg-muted/50"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
    </div>
  );
}
