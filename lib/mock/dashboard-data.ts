/** Realistic placeholder data only — no Firestore wiring yet. Figures match the FlowFi dashboard reference design 1:1. */

export const netWorth = {
  amount: 598200,
  changeAmount: 48200,
  changePercent: 8.77,
};

export const financialHealth = {
  score: 82,
  label: "Great",
  message: "You're doing better than last month.",
};

export const cashFlow = {
  income: 245600,
  expenses: 172300,
  net: 73300,
  weeks: [
    { label: "1-7", value: 9200 },
    { label: "8-14", value: 22400 },
    { label: "15-21", value: -8600 },
    { label: "22-31", value: -21800 },
  ],
};

export const aiInsight = {
  category: "Shopping",
  percent: 18,
  headline: "You're spending 18% more on Shopping than last month.",
  detail: "Consider setting a budget.",
  cta: "Review Budget",
};

export const needsAttention = [
  {
    id: "attn-bill",
    type: "bill" as const,
    title: "Upcoming Bill",
    subtitle: "HDFC Credit Card",
    amount: 6430,
    note: "Due in 2 days",
    cta: "Pay Now",
  },
  {
    id: "attn-emi",
    type: "emi" as const,
    title: "EMI Payment",
    subtitle: "Home Loan EMI",
    amount: 28400,
    note: "Due in 5 days",
    cta: "Pay Now",
  },
  {
    id: "attn-budget",
    type: "budget" as const,
    title: "Budget Alert",
    subtitle: "Shopping",
    amount: 21800,
    note: "18% over budget",
    cta: "View",
  },
  {
    id: "attn-goal",
    type: "goal" as const,
    title: "Goal Progress",
    subtitle: "Bike Fund",
    percent: 68,
    note: "68% completed",
    cta: "View",
  },
];

export const accountsOverview = {
  totalBalance: 864540,
  changeThisMonth: 12400,
  accounts: [
    { id: "acc-1", name: "HDFC Savings", mask: "1234", balance: 245600, accent: "primary" as const },
    { id: "acc-2", name: "ICICI Savings", mask: "5678", balance: 185400, accent: "warning" as const },
    { id: "acc-3", name: "Cash Wallet", mask: null, balance: 24850, accent: "success" as const },
    { id: "acc-4", name: "Axis Salary Account", mask: "9012", balance: 408690, accent: "info" as const },
  ],
};

export const expensesByCategory = {
  total: 172300,
  items: [
    { category: "Shopping", amount: 21800, percent: 37, color: "purple" as const },
    { category: "Food & Dining", amount: 18200, percent: 22, color: "pink" as const },
    { category: "Transport", amount: 16400, percent: 19, color: "warning" as const },
    { category: "Entertainment", amount: 9600, percent: 11, color: "info" as const },
    { category: "Bills & Utilities", amount: 6900, percent: 8, color: "success" as const },
    { category: "Others", amount: 3400, percent: 3, color: "muted" as const },
  ],
};

export const budgetsOverview = {
  monthlyBudget: 250000,
  spent: 172300,
  categories: [
    { category: "Shopping", spent: 21800, limit: 18000 },
    { category: "Food & Dining", spent: 18200, limit: 25000 },
    { category: "Transport", spent: 16400, limit: 20000 },
    { category: "Entertainment", spent: 9600, limit: 12000 },
  ],
};

export const recentTransactions = [
  { id: "txn-1", merchant: "Blue Tokai Coffee", category: "Food & Dining", date: "Today", amount: -420 },
  { id: "txn-2", merchant: "Salary Credit", category: "Income", date: "Yesterday", amount: 186400 },
  { id: "txn-3", merchant: "Swiggy Order", category: "Food & Dining", date: "May 20", amount: -580 },
  { id: "txn-4", merchant: "Amazon Purchase", category: "Shopping", date: "May 20", amount: -1249 },
  { id: "txn-5", merchant: "Netflix Subscription", category: "Entertainment", date: "May 19", amount: -649 },
];

export const upcomingBills = [
  { id: "bill-1", name: "HDFC Credit Card", date: "May 24, 2025", daysLeft: 2 },
  { id: "bill-2", name: "Airtel Mobile", date: "May 26, 2025", daysLeft: 4 },
  { id: "bill-3", name: "Electricity Bill", date: "May 28, 2025", daysLeft: 6 },
  { id: "bill-4", name: "Internet Bill", date: "May 30, 2025", daysLeft: 8 },
];

export const quickActions = [
  { id: "qa-expense", label: "Add Expense", icon: "expense" as const, color: "danger" as const },
  { id: "qa-income", label: "Add Income", icon: "income" as const, color: "success" as const },
  { id: "qa-transfer", label: "Transfer Money", icon: "transfer" as const, color: "purple" as const },
  { id: "qa-split", label: "Split Expense", icon: "split" as const, color: "indigo" as const },
  { id: "qa-goal", label: "Add Goal", icon: "goal" as const, color: "warning" as const },
  { id: "qa-upload", label: "Upload Bill", icon: "upload" as const, color: "info" as const },
];
