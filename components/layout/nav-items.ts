import {
  CalendarRange,
  CreditCard,
  LayoutDashboard,
  Landmark,
  LifeBuoy,
  MessageSquareText,
  Receipt,
  Repeat,
  Settings,
  Target,
  Users,
  Wallet,
  FileBarChart,
  HandCoins,
  FileStack,
  History,
  LineChart,
  TrendingDown,
  ScanSearch,
  ScanText,
  Scale,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  section: NavSection;
  /** Extra route prefixes that should also mark this item active (e.g. a legacy route folded into it). */
  alsoActiveFor?: string[];
  /** One letter: pressing `g` then this letter opens the page (Gmail/GitHub style). Unique across the menu. */
  chord: string;
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.alsoActiveFor ?? [])].some((prefix) => pathname.startsWith(prefix));
}

/** Sidebar groupings, ordered by how often each job comes up: check the month → log day-to-day money →
 *  plan upcoming spend → manage debt → bring in bank data → review trends → configure. Purely
 *  presentational; routes themselves are unchanged. */
export type NavSection = "Overview" | "Daily Money" | "Plan" | "Debt" | "Import" | "Insights" | "System";

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, section: "Overview", chord: "d" },
  { label: "My Money", href: "/my-money", icon: HandCoins, section: "Overview", chord: "m" },
  { label: "Month Cycle", href: "/month-cycle", icon: CalendarRange, section: "Overview", chord: "y" },

  { label: "Transactions", href: "/transactions", icon: Receipt, section: "Daily Money", chord: "t" },
  { label: "Accounts", href: "/accounts", icon: Wallet, section: "Daily Money", chord: "a" },
  { label: "Credit Cards", href: "/credit-cards", icon: CreditCard, section: "Daily Money", chord: "c" },
  { label: "People Ledger", href: "/people", icon: Users, section: "Daily Money", chord: "p" },

  { label: "Bills", href: "/bills", icon: Repeat, section: "Plan", chord: "b" },
  { label: "Savings", href: "/savings", icon: Target, section: "Plan", chord: "s" },

  { label: "Loan & EMI", href: "/loans", icon: Landmark, section: "Debt", chord: "l", alsoActiveFor: ["/emi"] },
  { label: "Debt Planner", href: "/debt-planner", icon: TrendingDown, section: "Debt", chord: "n" },

  { label: "Statement Review", href: "/statement-review", icon: FileStack, section: "Import", chord: "w" },
  { label: "Transaction Inbox", href: "/transaction-candidates", icon: MessageSquareText, section: "Import", chord: "i" },
  { label: "Smart Capture", href: "/smart-capture", icon: ScanText, section: "Import", chord: "x" },

  { label: "Reports", href: "/reports", icon: FileBarChart, section: "Insights", chord: "r" },
  { label: "Analytics", href: "/analytics", icon: LineChart, section: "Insights", chord: "z" },
  { label: "Activity", href: "/activity", icon: History, section: "Insights", chord: "u" },

  { label: "Settings", href: "/settings", icon: Settings, section: "System", chord: "e" },
  { label: "Financial Audit", href: "/financial-audit", icon: ScanSearch, section: "System", chord: "f" },
  { label: "Balance Control", href: "/balance-control", icon: Scale, section: "System", chord: "o" },
  { label: "Help & Support", href: "/help", icon: LifeBuoy, section: "System", chord: "h" },
];

/** The four pages most people live in — the default Quick access tiles (Alt+1…4). */
export const DEFAULT_PINS = ["/dashboard", "/accounts", "/transactions", "/loans"];

export const NAV_BY_HREF = new Map(NAV_ITEMS.map((item) => [item.href, item]));

/** The menu entry a pathname belongs to (longest matching prefix wins, so /loans-installments never hides /loans). */
export function navItemForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.filter((item) => isNavItemActive(item, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
}
