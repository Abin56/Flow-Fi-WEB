/** Realistic placeholder data only — no Firestore wiring yet. Dedicated to the Accounts page's flat redesign
 *  (distinct from lib/mock/accounts-data.ts, which Transactions still depends on) — figures reconcile:
 *  totalBalance = totalInBanks + cashOnHand + the SBI fixed deposit. */

export const accountStats = {
  totalBalance: 872600,
  totalBalanceChangePercent: 12.6,
  totalInBanks: 624600,
  totalInBanksChangePercent: 8.4,
  cashOnHand: 48000,
  cashOnHandChangePercent: -3.2,
  upcoming7Days: 125000,
  upcomingReminders: 3,
};

export type AccountColor =
  | "slate"
  | "orange"
  | "blue"
  | "green"
  | "cyan"
  | "violet"
  | "maroon"
  | "emerald"
  | "bronze"
  | "charcoal"
  | "navy"
  | "plum";

export interface AccountOverviewItem {
  id: string;
  name: string;
  typeLabel: string;
  mask: string | null;
  balance: number;
  balanceLabel: string;
  isPrimary?: boolean;
  cardStyle: "featured" | "compact";
  color: AccountColor;
  sparkline?: number[];
  accountHolder: string;
  accountNumberMasked: string | null;
  ifsc: string | null;
  branch: string | null;
  upiId: string | null;
  linkedSince: string | null;
}

export const accountsOverviewList: AccountOverviewItem[] = [
  {
    id: "hdfc-savings",
    name: "HDFC Bank",
    typeLabel: "Savings Account",
    mask: "4567",
    balance: 325600,
    balanceLabel: "Available Balance",
    isPrimary: true,
    cardStyle: "featured",
    color: "slate",
    sparkline: [12, 18, 15, 22, 19, 26, 24, 30, 27, 33],
    accountHolder: "Abin John",
    accountNumberMasked: "5010 12** **** 4567",
    ifsc: "HDFC0004567",
    branch: "Kochi Main Branch",
    upiId: "abin@hdfcbank",
    linkedSince: "May 12, 2025",
  },
  {
    id: "icici-savings",
    name: "ICICI Bank",
    typeLabel: "Savings Account",
    mask: "1234",
    balance: 185000,
    balanceLabel: "Available Balance",
    cardStyle: "featured",
    color: "orange",
    sparkline: [20, 17, 21, 16, 19, 14, 17, 12, 15, 11],
    accountHolder: "Abin John",
    accountNumberMasked: "6604 12** **** 1234",
    ifsc: "ICIC0001234",
    branch: "Kakkanad Branch",
    upiId: "abin@icici",
    linkedSince: "Jun 3, 2025",
  },
  {
    id: "kotak-current",
    name: "Kotak Mahindra Bank",
    typeLabel: "Current Account",
    mask: "9876",
    balance: 114000,
    balanceLabel: "Available Balance",
    cardStyle: "featured",
    color: "blue",
    sparkline: [10, 13, 11, 15, 14, 18, 16, 20, 19, 23],
    accountHolder: "Abin John",
    accountNumberMasked: "2222 12** **** 9876",
    ifsc: "KKBK0009876",
    branch: "MG Road Branch",
    upiId: "abin@kotak",
    linkedSince: "Feb 20, 2025",
  },
  {
    id: "cash-wallet",
    name: "Cash Wallet",
    typeLabel: "Cash on Hand",
    mask: null,
    balance: 28000,
    balanceLabel: "Current Balance",
    cardStyle: "compact",
    color: "green",
    accountHolder: "Abin John",
    accountNumberMasked: null,
    ifsc: null,
    branch: null,
    upiId: null,
    linkedSince: "Jan 1, 2025",
  },
  {
    id: "sbi-fd",
    name: "SBI Bank",
    typeLabel: "Fixed Deposit",
    mask: "3456",
    balance: 200000,
    balanceLabel: "Matures on Jun 15, 2026",
    cardStyle: "compact",
    color: "cyan",
    accountHolder: "Abin John",
    accountNumberMasked: "3312 12** **** 3456",
    ifsc: "SBIN0003456",
    branch: "Ernakulam Branch",
    upiId: null,
    linkedSince: "Jun 15, 2024",
  },
  {
    id: "paytm-wallet",
    name: "Paytm Payments Bank",
    typeLabel: "Wallet",
    mask: null,
    balance: 20000,
    balanceLabel: "Available Balance",
    cardStyle: "compact",
    color: "violet",
    accountHolder: "Abin John",
    accountNumberMasked: null,
    ifsc: null,
    branch: null,
    upiId: "abin@paytm",
    linkedSince: "Mar 8, 2025",
  },
  {
    id: "idfc-business",
    name: "IDFC First Bank",
    typeLabel: "Business Account",
    mask: "2210",
    balance: 0,
    balanceLabel: "Available Balance",
    cardStyle: "compact",
    color: "slate",
    accountHolder: "Abin John (Consulting)",
    accountNumberMasked: "1012 12** **** 2210",
    ifsc: "IDFB0002210",
    branch: "Vytilla Branch",
    upiId: "abinconsulting@idfc",
    linkedSince: "Jul 28, 2025",
  },
];

export const recentAccountTransactions = [
  {
    id: "txn-1",
    merchant: "Blue Tokai Coffee",
    category: "Food & Dining",
    account: "HDFC Bank •••• 4567",
    amount: -420,
    timestamp: "Today, 09:14 AM",
  },
  {
    id: "txn-2",
    merchant: "Salary Credit",
    category: "Income",
    account: "ICICI Bank •••• 1234",
    amount: 186400,
    timestamp: "Yesterday, 08:30 AM",
  },
  {
    id: "txn-3",
    merchant: "Swiggy Order",
    category: "Food & Dining",
    account: "HDFC Bank •••• 4567",
    amount: -580,
    timestamp: "May 20, 07:45 PM",
  },
  {
    id: "txn-4",
    merchant: "Amazon Purchase",
    category: "Shopping",
    account: "Kotak Mahindra •••• 9876",
    amount: -1249,
    timestamp: "May 20, 03:12 PM",
  },
  {
    id: "txn-5",
    merchant: "Cash Withdrawal",
    category: "Transfer",
    account: "Cash Wallet",
    amount: -5000,
    timestamp: "May 19, 11:00 AM",
  },
];

export const accountQuickActions = [
  { id: "statement", label: "Statement" },
  { id: "manage", label: "Manage" },
  { id: "rename", label: "Rename" },
  { id: "hide", label: "Hide" },
] as const;

export const accountShortcuts = [
  { id: "transactions", label: "View Transactions" },
  { id: "insights", label: "Account Insights" },
  { id: "alert", label: "Set Balance Alert" },
  { id: "reconcile", label: "Reconcile Account" },
] as const;
