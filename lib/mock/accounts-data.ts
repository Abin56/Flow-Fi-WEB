/** Realistic placeholder data only — no Firestore wiring yet. Shapes mirror the eventual real domain types
 *  (lib/models/account.ts) loosely: name, type, opening/current balance, institution, last4, isDefault, accent. */

export type MockAccountType = "cash" | "bank" | "card" | "wallet" | "business" | "other";

export interface MockAccount {
  id: string;
  name: string;
  type: MockAccountType;
  institution: string | null;
  accountHolderName: string;
  accountNumberLast4: string | null;
  openingBalance: number;
  currentBalance: number;
  isDefault: boolean;
  /** Accent token name — maps to an existing tone class, keeps each card visually distinct without new colors. */
  accent: "primary" | "success" | "warning" | "purple" | "expense";
  notes: string | null;
}

export const mockAccounts: MockAccount[] = [
  {
    id: "acc-hdfc-salary",
    name: "HDFC Salary",
    type: "bank",
    institution: "HDFC Bank",
    accountHolderName: "Abin John",
    accountNumberLast4: "4821",
    openingBalance: 260000,
    currentBalance: 412300,
    isDefault: true,
    accent: "primary",
    notes: "Primary salary account, most bills auto-debit from here.",
  },
  {
    id: "acc-icici-savings",
    name: "ICICI Savings",
    type: "bank",
    institution: "ICICI Bank",
    accountHolderName: "Abin John",
    accountNumberLast4: "9013",
    openingBalance: 210000,
    currentBalance: 268900,
    isDefault: false,
    accent: "success",
    notes: "Secondary savings, used for emergency fund.",
  },
  {
    id: "acc-cash-wallet",
    name: "Cash Wallet",
    type: "cash",
    institution: null,
    accountHolderName: "Abin John",
    accountNumberLast4: null,
    openingBalance: 5000,
    currentBalance: 8400,
    isDefault: false,
    accent: "warning",
    notes: null,
  },
  {
    id: "acc-paytm",
    name: "Paytm Wallet",
    type: "wallet",
    institution: "Paytm Payments Bank",
    accountHolderName: "Abin John",
    accountNumberLast4: null,
    openingBalance: 1200,
    currentBalance: 3150,
    isDefault: false,
    accent: "purple",
    notes: "Used mostly for quick UPI top-ups and cab rides.",
  },
  {
    id: "acc-amex",
    name: "Amex Platinum",
    type: "card",
    institution: "American Express",
    accountHolderName: "Abin John",
    accountNumberLast4: "4021",
    openingBalance: 0,
    currentBalance: -96400,
    isDefault: false,
    accent: "expense",
    notes: "Statement closes on the 14th.",
  },
  {
    id: "acc-freelance-business",
    name: "Freelance Business",
    type: "business",
    institution: "IDFC First Bank",
    accountHolderName: "Abin John (Consulting)",
    accountNumberLast4: "6650",
    openingBalance: 40000,
    currentBalance: 118750,
    isDefault: false,
    accent: "primary",
    notes: "Client payments and business expenses.",
  },
];
