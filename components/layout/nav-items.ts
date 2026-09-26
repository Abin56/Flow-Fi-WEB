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

/** Sidebar groupings, ordered by how often each job comes up: check the month → log day-to-day money →
 *  plan upcoming spend → manage debt → bring in bank data → review trends → configure. Purely
 *  presentational; routes themselves are unchanged. */
export type NavSection = "Overview" | "Daily Money" | "Plan" | "Debt" | "Import" | "Insights" | "System";

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, section: "Overview" },
  { label: "Month Cycle", href: "/month-cycle", icon: CalendarRange, section: "Overview" },
  { label: "Calendar", href: "/calendar", icon: Calendar, section: "Overview" },

  { label: "Transactions", href: "/transactions", icon: Receipt, section: "Daily Money" },
  { label: "Accounts", href: "/accounts", icon: Wallet, section: "Daily Money" },
  { label: "Credit Cards", href: "/credit-cards", icon: CreditCard, section: "Daily Money" },
  { label: "People Ledger", href: "/people", icon: Users, section: "Daily Money" },

  { label: "Budgets", href: "/budgets", icon: PiggyBank, section: "Plan" },
  { label: "Bills", href: "/bills", icon: Repeat, section: "Plan" },
  { label: "Savings", href: "/savings", icon: Target, section: "Plan" },

  { label: "Loans", href: "/loans", icon: Landmark, section: "Debt" },
  { label: "EMI", href: "/emi", icon: Banknote, section: "Debt" },

  { label: "Statement Review", href: "/statement-review", icon: FileStack, section: "Import" },
  { label: "SMS Candidates", href: "/transaction-candidates", icon: MessageSquareText, section: "Import" },

  { label: "Reports", href: "/reports", icon: FileBarChart, section: "Insights" },
  { label: "Analytics", href: "/analytics", icon: LineChart, section: "Insights" },
  { label: "History", href: "/history", icon: History, section: "Insights" },
  { label: "AI Assistant", href: "/ai-assistant", icon: Bot, section: "Insights" },

  { label: "Settings", href: "/settings", icon: Settings, section: "System" },
  { label: "Help & Support", href: "/help", icon: LifeBuoy, section: "System" },
];
