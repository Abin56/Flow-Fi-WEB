import type { Category } from "@/lib/models/category";

/**
 * Local, keyword-based category suggestion for the Add/Edit transaction form. Pure and offline — no network, no
 * writes. It only ever returns a category that ALREADY EXISTS in the list it is given (never creates one), and it
 * stays silent when the text is ambiguous. The form decides when to show it; nothing here touches saving.
 */

type RuleKind = "expense" | "income" | "both";

interface Rule {
  /** Category names this rule may point at (first one present in the user's list wins). Lower-case. */
  names: string[];
  kind: RuleKind;
  /** Whole words (or whole phrases) in the description. */
  keywords: string[];
}

const RULES: Rule[] = [
  {
    names: ["food"],
    kind: "expense",
    keywords: [
      "coffee", "tea", "chai", "mandi", "restaurant", "lunch", "dinner", "breakfast", "snack", "snacks", "biryani", "pizza", "burger",
      "cafe", "grocery", "groceries", "swiggy", "zomato", "juice", "meal", "meals", "bakery", "milk", "vegetables", "fruits", "food",
    ],
  },
  {
    names: ["transport"],
    kind: "expense",
    keywords: ["petrol", "diesel", "fuel", "uber", "taxi", "cab", "rapido", "bus", "metro", "train", "parking", "toll", "transport"],
  },
  {
    names: ["health"],
    kind: "expense",
    keywords: ["medicine", "medicines", "doctor", "hospital", "pharmacy", "clinic", "dental", "dentist", "medical", "health"],
  },
  {
    names: ["shopping"],
    kind: "expense",
    keywords: ["clothes", "shirt", "shoes", "myntra", "flipkart", "shopping"],
  },
  {
    names: ["bills & utilities", "bills and utilities", "bills", "utilities"],
    kind: "expense",
    keywords: ["electricity", "wifi", "broadband", "internet", "recharge", "dth", "water bill", "gas bill", "phone bill", "mobile bill", "bill", "bills"],
  },
  {
    names: ["entertainment"],
    kind: "expense",
    keywords: ["movie", "movies", "cinema", "netflix", "spotify", "concert", "entertainment"],
  },
  { names: ["salary"], kind: "income", keywords: ["salary", "payroll", "wages", "paycheck", "paycheque"] },
  { names: ["freelance"], kind: "income", keywords: ["freelance", "freelancing", "client payment", "invoice"] },
  { names: ["personal loan", "loan"], kind: "both", keywords: ["loan", "loan repayment", "repayment"] },
];

/** The plain keywords the rules above recognise for a form kind — reused (read-only) by description autocomplete. */
export function commonDescriptionKeywords(kind: "income" | "expense"): string[] {
  return RULES.filter((r) => r.kind === "both" || r.kind === kind).flatMap((r) => r.keywords);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function words(text: string): string[] {
  return norm(text).replace(/[^\p{L}\p{N}& ]+/gu, " ").split(" ").filter(Boolean);
}

/** True when `keyword` (one or more words) appears as whole word(s) in `tokens`. */
function hasKeyword(tokens: string[], keyword: string): boolean {
  const k = keyword.split(" ");
  for (let i = 0; i + k.length <= tokens.length; i++) {
    if (k.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

/**
 * The existing category that best fits `description`, or null (nothing recognised, ambiguous, or the matching
 * category doesn't exist / isn't valid for this kind). `categories` should already be limited to the form kind's
 * categories (expense form → not income-only ones, and vice versa); the rule's own kind is checked too.
 */
export function suggestCategoryForDescription(input: { description: string; kind: "income" | "expense"; categories: Category[] }): Category | null {
  const tokens = words(input.description);
  if (tokens.length === 0) return null;

  const hits = new Map<string, Category>();
  for (const rule of RULES) {
    if (rule.kind !== "both" && rule.kind !== input.kind) continue;
    if (!rule.keywords.some((kw) => hasKeyword(tokens, kw))) continue;
    const category = rule.names
      .map((n) => input.categories.find((c) => norm(c.name) === n && (c.type === "both" || c.type === input.kind) && c.isActive !== false))
      .find((c): c is Category => c != null);
    // A matched rule whose category the user doesn't have is simply not a suggestion — never a different guess.
    if (category) hits.set(category.id, category);
  }
  // Two different categories matched ("pharmacy bill") → ambiguous → don't guess.
  return hits.size === 1 ? [...hits.values()][0] : null;
}
