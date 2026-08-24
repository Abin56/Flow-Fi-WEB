/** Realistic placeholder data only — no Firestore wiring yet. Field names loosely mirror lib/models/transaction.ts
 *  (type, amount, dateTime, accountId, categoryId, description, notes, transferId, excludeFromCalculations,
 *  linkedPersonId, owesPersonToggle) so it reads as the same domain, without needing to satisfy the Firestore
 *  interface exactly since there's no persistence here. */

export type MockTransactionType = "income" | "expense";

export type MockTransactionStatus = "cleared" | "pending";

export interface MockTransaction {
  id: string;
  type: MockTransactionType;
  amount: number;
  dateTime: string; // ISO date
  accountId: string;
  categoryId: string;
  description: string;
  notes: string;
  transferId: string | null;
  excludeFromCalculations: boolean;
  linkedPersonId: string | null;
  linkedPersonName: string | null;
  owesPersonToggle: boolean;
  status: MockTransactionStatus;
}

export const categories = [
  { id: "cat-food", label: "Food & Dining", tone: "warning" as const },
  { id: "cat-shopping", label: "Shopping", tone: "purple" as const },
  { id: "cat-transport", label: "Transport", tone: "primary" as const },
  { id: "cat-income", label: "Income", tone: "success" as const },
  { id: "cat-utilities", label: "Utilities", tone: "neutral" as const },
  { id: "cat-emi", label: "EMI", tone: "expense" as const },
  { id: "cat-entertainment", label: "Entertainment", tone: "purple" as const },
  { id: "cat-rent", label: "Rent", tone: "expense" as const },
  { id: "cat-transfer", label: "Transfer", tone: "neutral" as const },
];

export function categoryLabel(categoryId: string): string {
  return categories.find((c) => c.id === categoryId)?.label ?? "Uncategorized";
}

export function categoryTone(categoryId: string) {
  return categories.find((c) => c.id === categoryId)?.tone ?? "neutral";
}

// Accounts referenced: acc-hdfc-salary, acc-icici-savings, acc-cash-wallet, acc-paytm, acc-amex, acc-freelance-business

export const mockTransactions: MockTransaction[] = [
  { id: "txn-001", type: "income", amount: 186400, dateTime: "2026-07-01T09:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-income", description: "Salary Credit", notes: "Monthly salary from Whitefield Tech Pvt Ltd", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-002", type: "expense", amount: 32000, dateTime: "2026-07-01T10:15:00", accountId: "acc-hdfc-salary", categoryId: "cat-rent", description: "Rent Payment", notes: "Flat rent, HSR Layout", transferId: null, excludeFromCalculations: false, linkedPersonId: "person-landlord", linkedPersonName: "Mr. Ramesh (Landlord)", owesPersonToggle: false, status: "cleared" },
  { id: "txn-003", type: "expense", amount: 420, dateTime: "2026-07-01T18:30:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Blue Tokai Coffee", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-004", type: "expense", amount: 640, dateTime: "2026-07-02T20:05:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Zomato", notes: "Dinner order", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-005", type: "expense", amount: 286, dateTime: "2026-07-02T08:40:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "Office commute", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-006", type: "expense", amount: 3299, dateTime: "2026-07-03T14:20:00", accountId: "acc-hdfc-salary", categoryId: "cat-shopping", description: "Amazon", notes: "USB-C charger + cables", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-007", type: "expense", amount: 1499, dateTime: "2026-07-03T07:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-utilities", description: "ACT Fibernet", notes: "Internet bill", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-008", type: "expense", amount: 649, dateTime: "2026-07-04T12:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-entertainment", description: "Netflix", notes: "Monthly subscription", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-009", type: "expense", amount: 550, dateTime: "2026-07-04T21:10:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Swiggy", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-010", type: "expense", amount: 28400, dateTime: "2026-07-05T09:30:00", accountId: "acc-hdfc-salary", categoryId: "cat-emi", description: "Home EMI", notes: "HDFC home loan installment", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-011", type: "expense", amount: 3200, dateTime: "2026-07-05T11:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-utilities", description: "BESCOM Electricity", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "pending" },
  { id: "txn-012", type: "expense", amount: 890, dateTime: "2026-07-06T13:45:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Truffles Cafe", notes: "Lunch with team", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-013", type: "expense", amount: 245, dateTime: "2026-07-06T19:00:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-014", type: "expense", amount: 15000, dateTime: "2026-07-07T15:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-transfer", description: "Transfer to ICICI Savings", notes: "Monthly savings sweep", transferId: "xfer-001", excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-015", type: "income", amount: 15000, dateTime: "2026-07-07T15:00:00", accountId: "acc-icici-savings", categoryId: "cat-transfer", description: "Transfer from HDFC Salary", notes: "Monthly savings sweep", transferId: "xfer-001", excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-016", type: "expense", amount: 2100, dateTime: "2026-07-08T17:20:00", accountId: "acc-hdfc-salary", categoryId: "cat-shopping", description: "Myntra", notes: "Two t-shirts", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-017", type: "expense", amount: 480, dateTime: "2026-07-08T20:30:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Blue Tokai Coffee", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-018", type: "expense", amount: 1200, dateTime: "2026-07-09T09:15:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Local grocery store", notes: "Vegetables and milk", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-019", type: "expense", amount: 720, dateTime: "2026-07-09T21:45:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Zomato", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-020", type: "expense", amount: 350, dateTime: "2026-07-10T08:00:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "Airport drop", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-021", type: "expense", amount: 5400, dateTime: "2026-07-11T13:00:00", accountId: "acc-freelance-business", categoryId: "cat-shopping", description: "Adobe Creative Cloud", notes: "Annual plan for client work", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-022", type: "income", amount: 45000, dateTime: "2026-07-12T10:00:00", accountId: "acc-freelance-business", categoryId: "cat-income", description: "Client Payment - Aster Studio", notes: "Website revamp milestone 2", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-023", type: "expense", amount: 990, dateTime: "2026-07-12T19:30:00", accountId: "acc-hdfc-salary", categoryId: "cat-entertainment", description: "BookMyShow", notes: "Movie tickets", transferId: null, excludeFromCalculations: false, linkedPersonId: "person-priya", linkedPersonName: "Priya", owesPersonToggle: true, status: "cleared" },
  { id: "txn-024", type: "expense", amount: 640, dateTime: "2026-07-13T20:00:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Swiggy", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-025", type: "expense", amount: 2800, dateTime: "2026-07-14T11:00:00", accountId: "acc-amex", categoryId: "cat-shopping", description: "Decathlon", notes: "Running shoes", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-026", type: "expense", amount: 96400, dateTime: "2026-07-14T00:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-emi", description: "Amex Platinum Bill Payment", notes: "Full statement payment", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-027", type: "expense", amount: 300, dateTime: "2026-07-15T18:00:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Street food", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-028", type: "expense", amount: 410, dateTime: "2026-07-15T20:15:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-029", type: "expense", amount: 1850, dateTime: "2026-07-16T12:30:00", accountId: "acc-hdfc-salary", categoryId: "cat-food", description: "Blue Tokai Coffee", notes: "Team offsite coffee run", transferId: null, excludeFromCalculations: true, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-030", type: "expense", amount: 6200, dateTime: "2026-07-17T16:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-shopping", description: "Amazon", notes: "Monitor stand + desk mat", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-031", type: "expense", amount: 780, dateTime: "2026-07-18T19:45:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Zomato", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-032", type: "expense", amount: 1499, dateTime: "2026-07-19T09:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-entertainment", description: "Spotify + Netflix bundle", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-033", type: "expense", amount: 320, dateTime: "2026-07-19T08:20:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-034", type: "expense", amount: 4200, dateTime: "2026-07-20T14:00:00", accountId: "acc-icici-savings", categoryId: "cat-shopping", description: "Croma", notes: "Wireless mouse + keyboard", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-035", type: "expense", amount: 560, dateTime: "2026-07-21T21:00:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Swiggy", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-036", type: "expense", amount: 2000, dateTime: "2026-07-22T10:00:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Big Bazaar", notes: "Monthly groceries", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-037", type: "expense", amount: 3600, dateTime: "2026-07-23T13:00:00", accountId: "acc-freelance-business", categoryId: "cat-utilities", description: "AWS Bill", notes: "Client project hosting", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-038", type: "expense", amount: 275, dateTime: "2026-07-24T08:30:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-039", type: "expense", amount: 640, dateTime: "2026-07-24T20:40:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Zomato", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-040", type: "expense", amount: 1650, dateTime: "2026-07-25T17:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-shopping", description: "Amazon", notes: "Book order", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-041", type: "expense", amount: 900, dateTime: "2026-07-26T20:00:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Truffles Cafe", notes: "Dinner with Priya", transferId: null, excludeFromCalculations: false, linkedPersonId: "person-priya", linkedPersonName: "Priya", owesPersonToggle: true, status: "cleared" },
  { id: "txn-042", type: "expense", amount: 3200, dateTime: "2026-07-27T09:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-utilities", description: "BESCOM Electricity", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-043", type: "expense", amount: 495, dateTime: "2026-07-28T19:20:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Swiggy", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-044", type: "expense", amount: 210, dateTime: "2026-07-28T08:10:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-045", type: "expense", amount: 10000, dateTime: "2026-07-29T15:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-transfer", description: "Transfer to ICICI Savings", notes: "Extra savings", transferId: "xfer-002", excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-046", type: "income", amount: 10000, dateTime: "2026-07-29T15:00:00", accountId: "acc-icici-savings", categoryId: "cat-transfer", description: "Transfer from HDFC Salary", notes: "Extra savings", transferId: "xfer-002", excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-047", type: "expense", amount: 1120, dateTime: "2026-07-30T12:15:00", accountId: "acc-hdfc-salary", categoryId: "cat-food", description: "Blue Tokai Coffee", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-048", type: "expense", amount: 649, dateTime: "2026-07-31T12:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-entertainment", description: "Netflix", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "pending" },
  { id: "txn-049", type: "income", amount: 186400, dateTime: "2026-08-01T09:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-income", description: "Salary Credit", notes: "Monthly salary from Whitefield Tech Pvt Ltd", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-050", type: "expense", amount: 32000, dateTime: "2026-08-01T10:00:00", accountId: "acc-hdfc-salary", categoryId: "cat-rent", description: "Rent Payment", notes: "Flat rent, HSR Layout", transferId: null, excludeFromCalculations: false, linkedPersonId: "person-landlord", linkedPersonName: "Mr. Ramesh (Landlord)", owesPersonToggle: false, status: "cleared" },
  { id: "txn-051", type: "expense", amount: 420, dateTime: "2026-08-01T18:00:00", accountId: "acc-cash-wallet", categoryId: "cat-food", description: "Blue Tokai Coffee", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-052", type: "expense", amount: 690, dateTime: "2026-08-01T20:30:00", accountId: "acc-paytm", categoryId: "cat-food", description: "Zomato", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-053", type: "expense", amount: 310, dateTime: "2026-08-02T08:15:00", accountId: "acc-paytm", categoryId: "cat-transport", description: "Uber", notes: "", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
  { id: "txn-054", type: "expense", amount: 2450, dateTime: "2026-08-02T16:30:00", accountId: "acc-hdfc-salary", categoryId: "cat-shopping", description: "Amazon", notes: "Phone case + screen guard", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "pending" },
  { id: "txn-055", type: "expense", amount: 15400, dateTime: "2026-08-02T00:00:00", accountId: "acc-freelance-business", categoryId: "cat-emi", description: "Office Coworking Fee", notes: "WeWork monthly desk", transferId: null, excludeFromCalculations: false, linkedPersonId: null, linkedPersonName: null, owesPersonToggle: false, status: "cleared" },
];
