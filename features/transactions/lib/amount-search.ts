/**
 * Amount search for the Transactions list — display-only filtering, never touches stored data.
 *
 * Supported queries (₹, "rs", commas and spaces are ignored):
 *   500          amount is 500 (any paise: 500.00–500.99); description/notes text matches still apply
 *   500.5        amount is exactly 500.50
 *   >500  >=500  greater than / at least
 *   <500  <=500  less than / at most
 *   =500         exactly 500 (amount only, no text match)
 *   500-1000     between, inclusive (also "500..1000" and "500 to 1000")
 *
 * Amounts are compared on the positive `transaction.amount` — the figure the list shows.
 */
export type AmountQuery =
  /** A bare number: matches the amount, but is also a valid text search (e.g. "7-Eleven 24"). */
  | { kind: "number"; min: number; max: number }
  /** An explicit amount expression (operator or range): amount-only. */
  | { kind: "expression"; test: (amount: number) => boolean };

const NUMBER = String.raw`(\d+(?:\.\d{1,2})?)`;

/** Strip currency marks and digit grouping so "₹1,250.50" reads as "1250.50". */
function normalize(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^(?:₹|rs\.?|inr)\s*/, "")
    .replace(/(?<=[<>=]\s*)(?:₹|rs\.?|inr)\s*/g, "")
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/\s+/g, " ");
}

/** Paise-precise equality, so 0.1 + 0.2 style float noise never hides a match. */
function toPaise(n: number): number {
  return Math.round(n * 100);
}

export function parseAmountQuery(query: string): AmountQuery | null {
  const q = normalize(query);
  if (!q) return null;

  const bare = q.match(new RegExp(`^${NUMBER}$`));
  if (bare) {
    const value = Number(bare[1]);
    // "500" covers 500.00–500.99; "500.5" is exact.
    return bare[1].includes(".") ? { kind: "number", min: value, max: value } : { kind: "number", min: value, max: value + 0.99 };
  }

  const op = q.match(new RegExp(`^(>=|<=|>|<|=)\\s*${NUMBER}$`));
  if (op) {
    const value = toPaise(Number(op[2]));
    const tests: Record<string, (paise: number) => boolean> = {
      ">": (p) => p > value,
      ">=": (p) => p >= value,
      "<": (p) => p < value,
      "<=": (p) => p <= value,
      "=": (p) => p === value,
    };
    const test = tests[op[1]];
    return { kind: "expression", test: (amount) => test(toPaise(amount)) };
  }

  const range = q.match(new RegExp(`^${NUMBER}\\s*(?:-|–|\\.\\.|to)\\s*${NUMBER}$`));
  if (range) {
    const a = toPaise(Number(range[1]));
    const b = toPaise(Number(range[2]));
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return {
      kind: "expression",
      test: (amount) => {
        const p = toPaise(amount);
        return p >= lo && p <= hi;
      },
    };
  }

  return null;
}

export function amountMatches(query: AmountQuery, amount: number): boolean {
  if (query.kind === "expression") return query.test(amount);
  const p = toPaise(amount);
  return p >= toPaise(query.min) && p <= toPaise(query.max);
}
