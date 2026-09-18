import {
  Banknote,
  Bot,
  Calendar,
  CalendarRange,
  CreditCard,
  LayoutDashboard,
  Landmark,
  LifeBuoy,
  MessageSquareText,
  PiggyBank,
  Receipt,
  Repeat,
  Settings,
  Target,
  Users,
  Wallet,
  FileBarChart,
  FileStack,
  History,
  LineChart,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  /**
   * Product group this item belongs to, if any. When set, the item is only
   * shown once `useFinancialProductAvailability()` reports the user has at
   * least one record in that group — see `sidebar-nav-content.tsx`.
   */
  requiresProduct?: "accounts" | "creditCards" | "loanOrEmi";
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Month Cycle", href: "/month-cycle", icon: CalendarRange },
  { label: "Transactions", href: "/transactions", icon: Receipt },
  { label: "History", href: "/history", icon: History },
  { label: "Accounts", href: "/accounts", icon: Wallet, requiresProduct: "accounts" },
  { label: "Credit Cards", href: "/credit-cards", icon: CreditCard },
  { label: "Statement Review", href: "/statement-review", icon: FileStack, requiresProduct: "creditCards" },
  { label: "SMS Candidates", href: "/transaction-candidates", icon: MessageSquareText },
  { label: "Bills", href: "/bills", icon: Repeat },
  { label: "Budgets", href: "/budgets", icon: PiggyBank },
  { label: "Savings", href: "/savings", icon: Target },
  { label: "EMI", href: "/emi", icon: Banknote, requiresProduct: "loanOrEmi" },
  { label: "Loans", href: "/loans", icon: Landmark, requiresProduct: "loanOrEmi" },
  { label: "People Ledger", href: "/people", icon: Users },
  { label: "Calendar", href: "/calendar", icon: Calendar },
  { label: "Reports", href: "/reports", icon: FileBarChart },
  { label: "Analytics", href: "/analytics", icon: LineChart },
  { label: "AI Assistant", href: "/ai-assistant", icon: Bot },
  { label: "Settings", href: "/settings", icon: Settings },
  { label: "Help & Support", href: "/help", icon: LifeBuoy },
];
