import { Plus, RefreshCw, Users } from "lucide-react";

const UTILITY =
  "flex h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent [&_svg]:text-muted-foreground";
const SOON = "rounded-[4px] bg-secondary px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase";

/** Title, the (not yet built) Refresh / Groups utilities — marked as such — and the primary Add Account. */
export function AccountsHeader({ onAdd }: { onAdd?: () => void }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Accounts</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Your banks, cards, wallets and cash — balances in one place.</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled title="Coming soon" className={UTILITY}>
          <RefreshCw className="size-4" strokeWidth={1.75} />
          <span className="hidden sm:inline">Refresh</span>
          <span className={SOON}>Soon</span>
        </button>
        <button type="button" disabled title="Coming soon" className={UTILITY}>
          <Users className="size-4" strokeWidth={1.75} />
          <span className="hidden sm:inline">Groups</span>
          <span className={SOON}>Soon</span>
        </button>
        {onAdd && (
          <>
            <span className="mx-1 hidden h-5 w-px bg-border-strong/60 sm:block" aria-hidden />
            <button
              type="button"
              onClick={onAdd}
              className="flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" strokeWidth={2.25} />
              Add Account
            </button>
          </>
        )}
      </div>
    </header>
  );
}
