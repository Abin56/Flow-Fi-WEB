"use client";

import {
  Banknote,
  Bot,
  Calendar,
  CreditCard,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  PiggyBank,
  Receipt,
  Repeat,
  Settings,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PAGES = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Transactions", href: "/transactions", icon: Receipt },
  { label: "Accounts", href: "/accounts", icon: Wallet },
  { label: "Credit Cards", href: "/credit-cards", icon: CreditCard },
  { label: "Bills", href: "/bills", icon: Repeat },
  { label: "Budgets", href: "/budgets", icon: PiggyBank },
  { label: "Savings", href: "/savings", icon: Target },
  { label: "EMI", href: "/emi", icon: Banknote },
  { label: "Loans", href: "/loans", icon: Landmark },
  { label: "People Ledger", href: "/people", icon: Users },
  { label: "Calendar", href: "/calendar", icon: Calendar },
  { label: "Reports", href: "/reports", icon: FileBarChart },
  { label: "AI Assistant", href: "/ai-assistant", icon: Bot },
  { label: "Settings", href: "/settings", icon: Settings },
];

const MAX_RESULTS_PER_GROUP = 5;

/**
 * Real cross-entity search — matches by name/description substring across
 * every already-live-subscribed collection (React Query cache, no extra
 * fetch). Deliberately client-side substring matching, not a search index;
 * fine at this app's real data volumes and avoids standing up a search
 * backend (e.g. Algolia) this project has no requirement for.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();

  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { data: bills = [] } = useBills();
  const { data: loans = [] } = useLoans();
  const { data: creditCards = [] } = useCreditCards();
  const { data: people = [] } = usePeople();

  const accountById = useMemo(() => new Map((accounts as Account[]).map((a) => [a.id, a])), [accounts]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="rounded-3xl! border-0 bg-card shadow-e4">
      <CommandInput placeholder="Search transactions, accounts, bills, loans, pages..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          {PAGES.map((page) => (
            <CommandItem key={page.href} value={page.label} onSelect={() => go(page.href)}>
              <page.icon /> {page.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Transactions">
          {(transactions as Transaction[])
            .filter((t) => t.deletedAt == null)
            .slice(0, MAX_RESULTS_PER_GROUP)
            .map((t) => (
              <CommandItem
                key={t.id}
                value={`${t.description || "transaction"} ${t.notes}`}
                onSelect={() => go("/transactions")}
              >
                <Receipt />
                {t.description || "(No description)"}
                <span className="ml-auto text-xs text-muted-foreground">{formatCurrency(t.amount)}</span>
              </CommandItem>
            ))}
        </CommandGroup>

        <CommandGroup heading="Accounts">
          {(accounts as Account[]).slice(0, MAX_RESULTS_PER_GROUP).map((a) => (
            <CommandItem key={a.id} value={a.name} onSelect={() => go("/accounts")}>
              <Wallet />
              {a.name}
              <span className="ml-auto text-xs text-muted-foreground">{formatCurrency(a.currentBalance)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Credit Cards">
          {(creditCards as CreditCardProfile[]).slice(0, MAX_RESULTS_PER_GROUP).map((c) => {
            const account = accountById.get(c.accountId);
            return (
              <CommandItem key={c.id} value={account?.name ?? "Credit Card"} onSelect={() => go("/credit-cards")}>
                <CreditCard />
                {account?.name ?? "Credit Card"} {c.lastFourDigits ? `•••• ${c.lastFourDigits}` : ""}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandGroup heading="Bills">
          {(bills as Bill[]).slice(0, MAX_RESULTS_PER_GROUP).map((b) => (
            <CommandItem key={b.id} value={b.name} onSelect={() => go("/bills")}>
              <Repeat />
              {b.name}
              <span className="ml-auto text-xs text-muted-foreground">{formatCurrency(b.amount)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Loans">
          {(loans as Loan[]).slice(0, MAX_RESULTS_PER_GROUP).map((l) => (
            <CommandItem key={l.id} value={l.name ?? "Loan"} onSelect={() => go("/loans")}>
              <Landmark />
              {l.name ?? "Loan"}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="People">
          {(people as Person[]).slice(0, MAX_RESULTS_PER_GROUP).map((p) => (
            <CommandItem key={p.id} value={p.name} onSelect={() => go("/people")}>
              <Users />
              {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
