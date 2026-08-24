/** Realistic placeholder data only — no Firestore wiring yet. Extends lib/mock/dashboard-data.ts's
 *  shapes/values for overlapping months so Dashboard -> Reports doesn't feel disjointed. */

export const cashFlowHistory = [
  { month: "Sep", income: 168400, expense: 89200 },
  { month: "Oct", income: 174200, expense: 96800 },
  { month: "Nov", income: 179800, expense: 108400 },
  { month: "Dec", income: 210500, expense: 142200 },
  { month: "Jan", income: 172000, expense: 88000 },
  { month: "Feb", income: 178500, expense: 91200 },
  { month: "Mar", income: 172000, expense: 88000 },
  { month: "Apr", income: 178500, expense: 91200 },
  { month: "May", income: 165000, expense: 102400 },
  { month: "Jun", income: 190200, expense: 87600 },
  { month: "Jul", income: 181000, expense: 96800 },
  { month: "Aug", income: 186400, expense: 94230 },
].map((m) => ({ ...m, net: m.income - m.expense }));

export const netWorthHistory = [
  { month: "Sep", assets: 1520000, liabilities: 348000 },
  { month: "Oct", assets: 1548000, liabilities: 342000 },
  { month: "Nov", assets: 1560000, liabilities: 338000 },
  { month: "Dec", assets: 1572000, liabilities: 336000 },
  { month: "Jan", assets: 1456000, liabilities: 330400 },
  { month: "Feb", assets: 1508000, liabilities: 326800 },
  { month: "Mar", assets: 1482000, liabilities: 322000 },
  { month: "Apr", assets: 1560000, liabilities: 318400 },
  { month: "May", assets: 1599000, liabilities: 314600 },
  { month: "Jun", assets: 1613000, liabilities: 310200 },
  { month: "Jul", assets: 1768000, liabilities: 306800 },
  { month: "Aug", assets: 2145850, liabilities: 303200 },
].map((m) => ({ ...m, netWorth: m.assets - m.liabilities }));

export const netWorthBreakdown = [
  { name: "Bank & Cash", value: 689600 },
  { name: "Investments", value: 986400 },
  { name: "Property", value: 420000 },
  { name: "Other Assets", value: 49850 },
];

export const liabilitiesBreakdown = [
  { name: "Home Loan", value: 268400 },
  { name: "Credit Cards", value: 24700 },
  { name: "Personal Loan", value: 10100 },
];

export const categorySpending = [
  { category: "Food & Dining", amount: 18200, budget: 25000, txns: 34 },
  { category: "Shopping", amount: 21800, budget: 15000, txns: 12 },
  { category: "Transport", amount: 6400, budget: 8000, txns: 21 },
  { category: "Entertainment", amount: 4200, budget: 10000, txns: 8 },
  { category: "Utilities", amount: 8900, budget: 9500, txns: 5 },
  { category: "EMI", amount: 28400, budget: 28400, txns: 1 },
  { category: "Healthcare", amount: 3100, budget: 6000, txns: 3 },
];

/** Category x weekday spend intensity for the heat map (relative amounts, arbitrary units). */
export const spendingHeatmap = {
  categories: ["Food & Dining", "Shopping", "Transport", "Entertainment", "Utilities"],
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  values: [
    [420, 180, 640, 210, 980, 1240, 860],
    [0, 1200, 0, 3200, 0, 8900, 2100],
    [180, 220, 190, 260, 340, 620, 410],
    [0, 0, 640, 0, 1200, 1800, 560],
    [2200, 0, 0, 0, 0, 0, 6700],
  ],
};

export const incomeBreakdown = [
  { source: "Salary", amount: 172000 },
  { source: "Freelance", amount: 9400 },
  { source: "Investments", amount: 5000 },
];

export const forecast = {
  cashFlow: [
    { month: "Sep", net: 92200, projected: true },
    { month: "Oct", net: 88600, projected: true },
    { month: "Nov", net: 95400, projected: true },
  ],
  netWorth: [
    { month: "Sep", netWorth: 1888200, projected: true },
    { month: "Oct", netWorth: 1932800, projected: true },
    { month: "Nov", netWorth: 1981600, projected: true },
  ],
};

export const insights = [
  {
    id: "ins-1",
    headline: "You're spending 18% more on Shopping than last month.",
    detail: "Shopping is the only budget category over its monthly limit — ₹6,800 above plan so far.",
    tone: "warning" as const,
  },
  {
    id: "ins-2",
    headline: "Net worth grew 22% over the last 6 months.",
    detail: "Investment gains and lower liabilities are the biggest drivers — up ₹564K since March.",
    tone: "success" as const,
  },
  {
    id: "ins-3",
    headline: "Your savings rate is 49.4%, well above the 30% target.",
    detail: "At this pace you're on track to hit your emergency fund goal 3 months early.",
    tone: "success" as const,
  },
];

export const trendHighlights = [
  { id: "th-1", label: "Avg. Monthly Income", value: 181558, delta: 3.2, direction: "up" as const },
  { id: "th-2", label: "Avg. Monthly Expense", value: 98169, delta: 8.7, direction: "up" as const },
  { id: "th-3", label: "Avg. Savings Rate", value: 45.9, delta: 1.4, direction: "down" as const, isPercent: true },
  { id: "th-4", label: "Net Worth Growth (6mo)", value: 22.1, delta: 22.1, direction: "up" as const, isPercent: true },
];
