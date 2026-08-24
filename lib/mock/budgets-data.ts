/** Realistic placeholder data only — no Firestore wiring yet. Shapes mirror the eventual real domain types
 *  (lib/models/budget.ts) loosely: category, an icon-friendly key, spent/limit for the current month, and an
 *  optional trend versus last month. Deliberately mixes on-track, near-limit (>80%) and over-limit (>100%)
 *  categories so the page shows real visual variety. */

export type BudgetIconKey =
  | "food"
  | "transport"
  | "shopping"
  | "entertainment"
  | "utilities"
  | "health"
  | "travel"
  | "groceries"
  | "housing"
  | "debt";

export interface MockBudget {
  id: string;
  category: string;
  /** Short hint of what rolls up into this category, shown as a subtitle in the categories table. */
  subtitle: string;
  iconKey: BudgetIconKey;
  spent: number;
  limit: number;
  month: string;
  /** Percent change in spend vs last month — positive means spending more than last month. */
  trendPercent: number | null;
}

export const mockBudgets: MockBudget[] = [
  {
    id: "bud-housing",
    category: "Housing",
    subtitle: "Rent, Maintenance, Utilities",
    iconKey: "housing",
    spent: 10250,
    limit: 22000,
    month: "August 2026",
    trendPercent: -2.1,
  },
  {
    id: "bud-shopping",
    category: "Shopping",
    subtitle: "Groceries, Personal, Online",
    iconKey: "shopping",
    spent: 8450,
    limit: 12000,
    month: "August 2026",
    trendPercent: 18.3,
  },
  {
    id: "bud-food",
    category: "Food & Dining",
    subtitle: "Restaurants, Cafes",
    iconKey: "food",
    spent: 2950,
    limit: 6000,
    month: "August 2026",
    trendPercent: -6.5,
  },
  {
    id: "bud-transport",
    category: "Transport",
    subtitle: "Fuel, Travel, Parking",
    iconKey: "transport",
    spent: 2650,
    limit: 8000,
    month: "August 2026",
    trendPercent: 4.2,
  },
  {
    id: "bud-entertainment",
    category: "Entertainment",
    subtitle: "Movies, OTT, Events",
    iconKey: "entertainment",
    spent: 4850,
    limit: 5000,
    month: "August 2026",
    trendPercent: -12.1,
  },
  {
    id: "bud-utilities",
    category: "Utilities",
    subtitle: "Electricity, Internet, Water",
    iconKey: "utilities",
    spent: 7850,
    limit: 9000,
    month: "August 2026",
    trendPercent: 2.8,
  },
  {
    id: "bud-health",
    category: "Health & Wellness",
    subtitle: "Pharmacy, Fitness, Checkups",
    iconKey: "health",
    spent: 3100,
    limit: 6000,
    month: "August 2026",
    trendPercent: null,
  },
  {
    id: "bud-travel",
    category: "Travel",
    subtitle: "Flights, Hotels, Trips",
    iconKey: "travel",
    spent: 6200,
    limit: 10000,
    month: "August 2026",
    trendPercent: 41.7,
  },
  {
    id: "bud-groceries",
    category: "Groceries",
    subtitle: "Supermarket, Essentials",
    iconKey: "groceries",
    spent: 6900,
    limit: 12000,
    month: "August 2026",
    trendPercent: -3.4,
  },
  {
    id: "bud-debt",
    category: "Debt & EMI",
    subtitle: "Loan Installments, Cards",
    iconKey: "debt",
    spent: 7730,
    limit: 18850,
    month: "August 2026",
    trendPercent: 1.6,
  },
];

/** How this month's spend rolls up under the 50/30/20-style buckets shown in the Budget Overview donut. */
export const budgetTypeBreakdown: { type: string; budget: number; spent: number; color: "primary" | "expense" | "success" | "warning" }[] = [
  { type: "Needs", budget: 52000, spent: 18450, color: "primary" },
  { type: "Wants", budget: 32000, spent: 14120, color: "expense" },
  { type: "Savings", budget: 25000, spent: 8000, color: "success" },
  { type: "Debt & Loans", budget: 18850, spent: 7730, color: "warning" },
];

/** Daily spend for the current month — sparse bar values with tick labels only at the start, middle, and end,
 *  matching how the reference chart reads (only May 1 / May 15 / May 31 are labeled under the bars). */
export const dailyAverageSpend = {
  average: 1593,
  trendPercent: 8.6,
  days: [
    820, 1450, 1120, 2100, 1780, 640, 1960, 2350, 1340, 980, 1600, 2480, 1890, 1120, 1593, 2040, 1780, 960, 1450, 2200,
    1680, 1120, 2600, 1940, 1380, 1020, 1760, 2150, 1490, 1180, 890,
  ],
};

export const helpfulTips = {
  rule: {
    title: "Use 50/30/20 rule",
    description: "50% Needs • 30% Wants • 20% Savings",
    detail: "Helps maintain a healthy financial balance.",
  },
  upcoming: [
    { id: "tip-rent", title: "Rent Payment", date: "Due on Aug 20", daysLeft: 3 },
    { id: "tip-emi", title: "Car EMI", date: "Due on Aug 25", daysLeft: 13 },
  ],
};
