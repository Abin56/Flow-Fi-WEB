/**
 * Merchant Registry — ground truth for the deterministic Merchant
 * Normalizer (Statement Intelligence Layer, post-HDFC-parser task).
 *
 * Originally authored as Task 2's golden reference data
 * (functions/tests/fixtures/workspace/merchant-reference.ts) with an
 * explicit note that it would become the seed for this real Merchant
 * Intelligence stage — promoted here verbatim (no duplication: the test
 * fixture file now re-exports from this module) now that a real consumer
 * exists.
 *
 * Deterministic only — every entry is a fixed, human-curated alias list.
 * No AI, no fuzzy/ML matching. Extend by adding entries/aliases here.
 */

export type MerchantType =
  | "shopping"
  | "grocery"
  | "food_delivery"
  | "fuel"
  | "subscription"
  | "travel"
  | "financial"
  | "telecom"
  | "utility"
  | "healthcare"
  | "income"
  | "fee";

export interface MerchantReferenceEntry {
  canonicalName: string;
  /** Raw strings as they actually appear on real statements — unnormalized, inconsistent casing/spacing on purpose. */
  aliases: string[];
  expectedCategory: string;
  /** The confidence a correct Merchant Normalizer should produce for a clean alias match. */
  expectedConfidence: number;
  expectedRecurring: boolean;
  expectedCountry: string;
  expectedType: MerchantType;
}

export const MERCHANT_REGISTRY: readonly MerchantReferenceEntry[] = [
  {
    canonicalName: "Amazon",
    aliases: ["AMZN", "Amazon Marketplace", "Amazon India", "AMAZON SELLER SERVICES", "AMAZON.IN"],
    expectedCategory: "Shopping",
    expectedConfidence: 0.98,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "shopping",
  },
  {
    canonicalName: "Flipkart",
    aliases: ["FLIPKART", "FLIPKART INTERNET", "FKRT"],
    expectedCategory: "Shopping",
    expectedConfidence: 0.97,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "shopping",
  },
  {
    canonicalName: "Myntra",
    aliases: ["MYNTRA", "MYNTRA DESIGNS"],
    expectedCategory: "Shopping",
    expectedConfidence: 0.96,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "shopping",
  },
  {
    canonicalName: "DMart",
    aliases: ["DMART", "AVENUE SUPERMARTS", "D-MART"],
    expectedCategory: "Groceries",
    expectedConfidence: 0.95,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "grocery",
  },
  {
    canonicalName: "BigBasket",
    aliases: ["BIGBASKET", "BIG BASKET", "SUPERMARKET GROCERY SUPPLIES"],
    expectedCategory: "Groceries",
    expectedConfidence: 0.94,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "grocery",
  },
  {
    canonicalName: "Swiggy",
    aliases: ["SWIGGY", "SWIGGY INSTAMART", "BUNDL TECHNOLOGIES"],
    expectedCategory: "Food",
    expectedConfidence: 0.97,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "food_delivery",
  },
  {
    canonicalName: "Zomato",
    aliases: ["ZOMATO", "ZOMATO ONLINE", "ZOMATO LTD"],
    expectedCategory: "Food",
    expectedConfidence: 0.97,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "food_delivery",
  },
  {
    canonicalName: "Indian Oil",
    aliases: ["INDIAN OIL", "IOCL", "INDIANOIL CORP"],
    expectedCategory: "Fuel",
    expectedConfidence: 0.93,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "fuel",
  },
  {
    canonicalName: "Shell",
    aliases: ["SHELL", "SHELL INDIA MARKETING"],
    expectedCategory: "Fuel",
    expectedConfidence: 0.92,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "fuel",
  },
  {
    canonicalName: "Reliance Petroleum",
    aliases: ["RELIANCE PETROLEUM", "RELIANCE PETRO", "RIL PETROLEUM"],
    expectedCategory: "Fuel",
    expectedConfidence: 0.9,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "fuel",
  },
  {
    canonicalName: "Netflix",
    aliases: ["NETFLIX", "NETFLIX.COM", "NETFLIX ENTERTAINMENT"],
    expectedCategory: "Subscription",
    expectedConfidence: 0.98,
    expectedRecurring: true,
    expectedCountry: "United States",
    expectedType: "subscription",
  },
  {
    canonicalName: "Spotify",
    aliases: ["SPOTIFY", "SPOTIFY INDIA"],
    expectedCategory: "Subscription",
    expectedConfidence: 0.97,
    expectedRecurring: true,
    expectedCountry: "Sweden",
    expectedType: "subscription",
  },
  {
    canonicalName: "Google Play",
    aliases: ["GOOGLE PLAY", "GOOGLE *PLAY", "GOOGLE PLAY APPS"],
    expectedCategory: "Subscription",
    expectedConfidence: 0.9,
    expectedRecurring: true,
    expectedCountry: "United States",
    expectedType: "subscription",
  },
  {
    canonicalName: "Apple",
    aliases: ["APPLE.COM/BILL", "APPLE INDIA", "APPLE SERVICES"],
    expectedCategory: "Subscription",
    expectedConfidence: 0.91,
    expectedRecurring: true,
    expectedCountry: "United States",
    expectedType: "subscription",
  },
  {
    canonicalName: "IRCTC",
    aliases: ["IRCTC", "IRCTC RAIL", "INDIAN RAILWAY CATERING"],
    expectedCategory: "Travel",
    expectedConfidence: 0.95,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "travel",
  },
  {
    canonicalName: "CRED",
    aliases: ["CRED", "CRED CLUB", "DREAMPLUG TECHNOLOGIES"],
    expectedCategory: "Bills",
    expectedConfidence: 0.88,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "financial",
  },
  {
    canonicalName: "LIC",
    aliases: ["LIC", "LIC OF INDIA", "LIC PREMIUM"],
    expectedCategory: "Bills",
    expectedConfidence: 0.93,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "financial",
  },
  {
    canonicalName: "Airtel",
    aliases: ["AIRTEL", "BHARTI AIRTEL", "AIRTEL POSTPAID"],
    expectedCategory: "Bills",
    expectedConfidence: 0.95,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "telecom",
  },
  {
    canonicalName: "Jio",
    aliases: ["JIO", "RELIANCE JIO", "JIO RECHARGE"],
    expectedCategory: "Bills",
    expectedConfidence: 0.95,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "telecom",
  },
  {
    canonicalName: "Electricity Board",
    aliases: ["ELECTRICITY BOARD", "STATE ELECTRICITY BOARD", "ELEC BOARD BBPS"],
    expectedCategory: "Bills",
    expectedConfidence: 0.87,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "utility",
  },
  {
    canonicalName: "Water Authority",
    aliases: ["WATER AUTHORITY", "MUNICIPAL WATER BOARD", "WATER BOARD BBPS"],
    expectedCategory: "Bills",
    expectedConfidence: 0.85,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "utility",
  },
  {
    canonicalName: "Hospital",
    aliases: ["HOSPITAL", "CITY HOSPITAL", "MULTISPECIALITY HOSPITAL"],
    expectedCategory: "Medical",
    expectedConfidence: 0.75,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "healthcare",
  },
  {
    canonicalName: "Pharmacy",
    aliases: ["PHARMACY", "APOLLO PHARMACY", "MEDPLUS PHARMACY"],
    expectedCategory: "Medical",
    expectedConfidence: 0.85,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "healthcare",
  },
  {
    canonicalName: "Salary Credit",
    aliases: ["SALARY CREDIT", "NEFT SALARY", "SAL CREDIT"],
    expectedCategory: "Salary",
    expectedConfidence: 0.9,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "income",
  },
  {
    canonicalName: "Interest Credit",
    aliases: ["INTEREST CREDIT", "INT CREDIT", "INTEREST CR"],
    expectedCategory: "Interest",
    expectedConfidence: 0.9,
    expectedRecurring: true,
    expectedCountry: "India",
    expectedType: "income",
  },
  {
    canonicalName: "Cashback",
    aliases: ["CASHBACK", "CASHBACK CREDIT", "REWARD CASHBACK"],
    expectedCategory: "Cashback",
    expectedConfidence: 0.85,
    expectedRecurring: false,
    expectedCountry: "India",
    // "fee" here means "credit-direction, card-account-level entry" (same
    // bucket as "Card Payment" below) — not literally a fee. Grouped this
    // way, not under "income", specifically so the credit-card-plausible
    // generator pool (CREDIT_CARD_PLAUSIBLE_TYPES in
    // generate-transactions.ts) includes it; "income" is reserved for
    // genuinely bank-statement-only entries like Salary/Interest Credit.
    expectedType: "fee",
  },
  {
    canonicalName: "Card Payment",
    aliases: ["CARD PAYMENT RECEIVED", "PAYMENT RECEIVED - THANK YOU", "BILL PAYMENT"],
    expectedCategory: "Transfer",
    expectedConfidence: 0.9,
    expectedRecurring: false,
    expectedCountry: "India",
    expectedType: "fee",
  },
] as const;

export function merchantsByType(type: MerchantType): MerchantReferenceEntry[] {
  return MERCHANT_REGISTRY.filter((m) => m.expectedType === type);
}
