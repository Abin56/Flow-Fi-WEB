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
  section: NavSection;
}

/** Section groupings for the sidebar — purely presentational (Phase 3 shell). Every route below
 *  already existed in NAV_ITEMS; this only buckets them under muted section labels, it does not
 *  add, remove, or rename any route. */
export type NavSection = "Overview" | "Finance" | "Planning" | "Import" | "Insights" | "System";

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, section: "Overview" },
  { label: "Month Cycle", href: "/month-cycle", icon: CalendarRange, section: "Overview" },

  { label: "Transactions", href: "/transactions", icon: Receipt, section: "Finance" },
  { label: "History", href: "/history", icon: History, section: "Finance" },
  { label: "Accounts", href: "/accounts", icon: Wallet, section: "Finance" },
  { label: "Credit Cards", href: "/credit-cards", icon: CreditCard, section: "Finance" },
  { label: "People Ledger", href: "/people", icon: Users, section: "Finance" },

  { label: "Bills", href: "/bills", icon: Repeat, section: "Planning" },
  { label: "Budgets", href: "/budgets", icon: PiggyBank, section: "Planning" },
  { label: "Savings", href: "/savings", icon: Target, section: "Planning" },
  { label: "EMI", href: "/emi", icon: Banknote, section: "Planning" },
  { label: "Loans", href: "/loans", icon: Landmark, section: "Planning" },
  { label: "Calendar", href: "/calendar", icon: Calendar, section: "Planning" },

  { label: "Statement Review", href: "/statement-review", icon: FileStack, section: "Import" },
  { label: "SMS Candidates", href: "/transaction-candidates", icon: MessageSquareText, section: "Import" },

  { label: "Reports", href: "/reports", icon: FileBarChart, section: "Insights" },
  { label: "Analytics", href: "/analytics", icon: LineChart, section: "Insights" },
  { label: "AI Assistant", href: "/ai-assistant", icon: Bot, section: "Insights" },

  { label: "Settings", href: "/settings", icon: Settings, section: "System" },
  { label: "Help & Support", href: "/help", icon: LifeBuoy, section: "System" },
];
