/** Realistic placeholder data only — no Firestore wiring yet. Shapes mirror the eventual real domain types
 *  (lib/models/credit-card.ts) loosely: name, issuer/network, last4, credit limit, current balance, statement
 *  and due dates, minimum due, accent, a small per-card recent-activity list, and card-perks summary fields
 *  (reward points / cashback / lounge visits) used by the Credit Cards workspace's benefits panel. */

export type CardNetwork = "Visa" | "Mastercard" | "Amex" | "RuPay";

export interface MockCardTransaction {
  id: string;
  merchant: string;
  category: string;
  amount: number;
  date: string;
}

export interface MockCreditCard {
  id: string;
  name: string;
  issuer: string;
  network: CardNetwork;
  last4: string;
  creditLimit: number;
  currentBalance: number;
  statementDate: string;
  dueDate: string;
  minimumDue: number;
  isPrimary: boolean;
  /** Accent token name — maps to an existing tone class, keeps each card visually distinct without new colors. */
  accent: "primary" | "success" | "warning" | "purple" | "expense";
  rewardPoints: number;
  cashbackEarned: number;
  loungeVisitsLeft: number;
  recentTransactions: MockCardTransaction[];
}

export const mockCreditCards: MockCreditCard[] = [
  {
    id: "cc-amex-platinum",
    name: "Amex Platinum",
    issuer: "American Express",
    network: "Amex",
    last4: "4021",
    creditLimit: 300000,
    currentBalance: 274500,
    statementDate: "2026-07-28",
    dueDate: "2026-08-14",
    minimumDue: 13725,
    isPrimary: true,
    accent: "expense",
    rewardPoints: 124850,
    cashbackEarned: 8450,
    loungeVisitsLeft: 8,
    recentTransactions: [
      { id: "cctx-1", merchant: "Taj Hotels", category: "Shopping", amount: 18400, date: "2026-07-30" },
      { id: "cctx-2", merchant: "Apple Store", category: "Shopping", amount: 129900, date: "2026-07-24" },
      { id: "cctx-3", merchant: "Indigo Airlines", category: "Transport", amount: 21200, date: "2026-07-18" },
      { id: "cctx-4", merchant: "Zomato", category: "Food & Dining", amount: 890, date: "2026-07-15" },
    ],
  },
  {
    id: "cc-hdfc-regalia",
    name: "HDFC Regalia",
    issuer: "HDFC Bank",
    network: "Visa",
    last4: "7788",
    creditLimit: 150000,
    currentBalance: 62100,
    statementDate: "2026-07-22",
    dueDate: "2026-08-22",
    minimumDue: 3105,
    isPrimary: false,
    accent: "warning",
    rewardPoints: 42300,
    cashbackEarned: 1980,
    loungeVisitsLeft: 4,
    recentTransactions: [
      { id: "cctx-5", merchant: "BigBasket", category: "Food & Dining", amount: 3240, date: "2026-07-29" },
      { id: "cctx-6", merchant: "Uber", category: "Transport", amount: 560, date: "2026-07-27" },
      { id: "cctx-7", merchant: "Amazon", category: "Shopping", amount: 8990, date: "2026-07-20" },
    ],
  },
  {
    id: "cc-icici-coral",
    name: "ICICI Coral",
    issuer: "ICICI Bank",
    network: "RuPay",
    last4: "3390",
    creditLimit: 100000,
    currentBalance: 14200,
    statementDate: "2026-07-15",
    dueDate: "2026-08-05",
    minimumDue: 710,
    isPrimary: false,
    accent: "success",
    rewardPoints: 9600,
    cashbackEarned: 640,
    loungeVisitsLeft: 2,
    recentTransactions: [
      { id: "cctx-8", merchant: "Blue Tokai Coffee", category: "Food & Dining", amount: 420, date: "2026-07-28" },
      { id: "cctx-9", merchant: "Netflix", category: "Entertainment", amount: 649, date: "2026-07-12" },
      { id: "cctx-10", merchant: "Swiggy Instamart", category: "Food & Dining", amount: 1120, date: "2026-07-10" },
    ],
  },
  {
    id: "cc-sbi-simplyclick",
    name: "SBI SimplyCLICK",
    issuer: "State Bank of India",
    network: "Mastercard",
    last4: "5567",
    creditLimit: 80000,
    currentBalance: 5300,
    statementDate: "2026-07-10",
    dueDate: "2026-07-30",
    minimumDue: 265,
    isPrimary: false,
    accent: "purple",
    rewardPoints: 3100,
    cashbackEarned: 210,
    loungeVisitsLeft: 0,
    recentTransactions: [
      { id: "cctx-11", merchant: "Myntra", category: "Shopping", amount: 2799, date: "2026-07-08" },
      { id: "cctx-12", merchant: "BookMyShow", category: "Entertainment", amount: 700, date: "2026-07-03" },
    ],
  },
];
