/** Realistic placeholder data only — no Firestore wiring yet. Ledger shape: youAreOwed/youOwe are tracked as
 *  two separate running totals per person (not one signed balance) so a person who has both lent and
 *  borrowed at once still displays correctly — netBalance is derived, never stored. */

export type PersonStatus = "active" | "overdue" | "settled";

export interface PersonActivityItem {
  id: string;
  type: "received" | "paid";
  description: string;
  amount: number;
  date: string;
}

export interface LedgerPerson {
  id: string;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  youAreOwed: number;
  youOwe: number;
  status: PersonStatus;
  lastActivity: string;
  firstTransaction: string;
  reminder: string | null;
  transactionsCount: number;
  activity: PersonActivityItem[];
}

export const peopleLedgerStats = {
  totalYouAreOwed: 245600,
  owedByPeopleCount: 6,
  totalYouOwe: 105800,
  owingPeopleCount: 4,
  netBalance: 139800,
  settledThisMonth: 54200,
  settledTransactionsCount: 12,
};

export const ledgerPeople: LedgerPerson[] = [
  {
    id: "rohit-sharma",
    name: "Rohit Sharma",
    phone: "+91 98765 43210",
    email: "rohit.sharma@email.com",
    relationship: "Friend",
    youAreOwed: 75000,
    youOwe: 0,
    status: "active",
    lastActivity: "Today, 09:14 AM",
    firstTransaction: "Mar 10, 2025",
    reminder: null,
    transactionsCount: 7,
    activity: [
      { id: "act-1", type: "received", description: "Friend trip expenses", amount: 5000, date: "May 28, 2025" },
      { id: "act-2", type: "received", description: "Laptop advance", amount: 20000, date: "May 26, 2025" },
      { id: "act-3", type: "received", description: "Festival gift return", amount: 10000, date: "May 20, 2025" },
      { id: "act-4", type: "paid", description: "Movie tickets", amount: 2000, date: "May 18, 2025" },
    ],
  },
  {
    id: "anjali-mehta",
    name: "Anjali Mehta",
    phone: "+91 98123 45678",
    email: "anjali.mehta@email.com",
    relationship: "Colleague",
    youAreOwed: 0,
    youOwe: 38500,
    status: "active",
    lastActivity: "Yesterday, 08:30 PM",
    firstTransaction: "Apr 2, 2025",
    reminder: "Jun 5, 2026",
    transactionsCount: 5,
    activity: [
      { id: "act-5", type: "paid", description: "Dinner bill", amount: 2350, date: "May 27, 2025" },
      { id: "act-6", type: "paid", description: "Cab fare shared", amount: 650, date: "May 10, 2025" },
    ],
  },
  {
    id: "vivek-menon",
    name: "Vivek Menon",
    phone: "+91 97025 11223",
    email: "vivek.menon@email.com",
    relationship: "Business Partner",
    youAreOwed: 120000,
    youOwe: 0,
    status: "active",
    lastActivity: "May 28, 2025",
    firstTransaction: "Jan 18, 2025",
    reminder: null,
    transactionsCount: 9,
    activity: [{ id: "act-7", type: "received", description: "Laptop advance", amount: 20000, date: "May 26, 2025" }],
  },
  {
    id: "sneha-nair",
    name: "Sneha Nair",
    phone: "+91 90123 67890",
    email: "sneha.nair@email.com",
    relationship: "Roommate",
    youAreOwed: 0,
    youOwe: 22300,
    status: "active",
    lastActivity: "May 27, 2025",
    firstTransaction: "Feb 8, 2025",
    reminder: null,
    transactionsCount: 4,
    activity: [{ id: "act-8", type: "paid", description: "Electricity bill split", amount: 2100, date: "May 15, 2025" }],
  },
  {
    id: "arjun-das",
    name: "Arjun Das",
    phone: "+91 99456 23456",
    email: "arjun.das@email.com",
    relationship: "Cousin",
    youAreOwed: 50600,
    youOwe: 0,
    status: "active",
    lastActivity: "May 26, 2025",
    firstTransaction: "Mar 22, 2025",
    reminder: null,
    transactionsCount: 3,
    activity: [{ id: "act-9", type: "received", description: "Wedding gift lent", amount: 15000, date: "May 26, 2025" }],
  },
  {
    id: "meera-iyer",
    name: "Meera Iyer",
    phone: "+91 98765 09876",
    email: "meera.iyer@email.com",
    relationship: "Friend",
    youAreOwed: 0,
    youOwe: 18000,
    status: "overdue",
    lastActivity: "May 25, 2025",
    firstTransaction: "Dec 1, 2024",
    reminder: "May 30, 2026",
    transactionsCount: 6,
    activity: [{ id: "act-10", type: "paid", description: "Borrowed cash", amount: 5000, date: "May 25, 2025" }],
  },
  {
    id: "kiran-joseph",
    name: "Kiran Joseph",
    phone: "+91 96543 21098",
    email: "kiran.joseph@email.com",
    relationship: "Neighbor",
    youAreOwed: 0,
    youOwe: 12000,
    status: "active",
    lastActivity: "May 24, 2025",
    firstTransaction: "Apr 14, 2025",
    reminder: null,
    transactionsCount: 2,
    activity: [{ id: "act-11", type: "paid", description: "Parking fine shared", amount: 1200, date: "May 24, 2025" }],
  },
  {
    id: "suresh-kumar",
    name: "Suresh Kumar",
    phone: "+91 94321 09876",
    email: "suresh.kumar@email.com",
    relationship: "Uncle",
    youAreOwed: 25000,
    youOwe: 0,
    status: "settled",
    lastActivity: "May 20, 2025",
    firstTransaction: "Nov 5, 2024",
    reminder: null,
    transactionsCount: 4,
    activity: [{ id: "act-12", type: "received", description: "Loan repayment", amount: 25000, date: "May 20, 2025" }],
  },
  {
    id: "divya-pillai",
    name: "Divya Pillai",
    phone: "+91 93456 78901",
    email: "divya.pillai@email.com",
    relationship: "Friend",
    youAreOwed: 9500,
    youOwe: 0,
    status: "active",
    lastActivity: "May 15, 2025",
    firstTransaction: "Apr 30, 2025",
    reminder: null,
    transactionsCount: 2,
    activity: [{ id: "act-13", type: "received", description: "Concert tickets", amount: 4500, date: "May 15, 2025" }],
  },
  {
    id: "rahul-verma",
    name: "Rahul Verma",
    phone: "+91 92345 67812",
    email: "rahul.verma@email.com",
    relationship: "College Friend",
    youAreOwed: 15000,
    youOwe: 0,
    status: "active",
    lastActivity: "May 12, 2025",
    firstTransaction: "Feb 20, 2025",
    reminder: null,
    transactionsCount: 3,
    activity: [{ id: "act-14", type: "received", description: "Goa trip advance", amount: 9500, date: "May 12, 2025" }],
  },
];

export const recentPeopleTransactions = [
  {
    id: "ptxn-1",
    type: "received" as const,
    personName: "Rohit Sharma",
    description: "Friend trip expenses",
    date: "May 28, 2025",
    category: "Travel",
    amount: 5000,
  },
  {
    id: "ptxn-2",
    type: "paid" as const,
    personName: "Anjali Mehta",
    description: "Dinner bill",
    date: "May 27, 2025",
    category: "Food & Dining",
    amount: 2350,
  },
  {
    id: "ptxn-3",
    type: "received" as const,
    personName: "Vivek Menon",
    description: "Laptop advance",
    date: "May 26, 2025",
    category: "Personal",
    amount: 20000,
  },
  {
    id: "ptxn-4",
    type: "paid" as const,
    personName: "Meera Iyer",
    description: "Borrowed cash",
    date: "May 25, 2025",
    category: "Personal",
    amount: 5000,
  },
];
