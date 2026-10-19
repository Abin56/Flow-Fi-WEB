const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const compactCurrencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCurrency(amount: number) {
  return currencyFormatter.format(amount);
}

export function formatCurrencyCompact(amount: number) {
  return compactCurrencyFormatter.format(amount);
}

const preciseCurrencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Full paise precision — for data-entry/review contexts (Transaction Studio's grid, split editor, footer totals) where `formatCurrency`'s 0-decimal rounding would hide real amount differences. */
export function formatCurrencyPrecise(amount: number) {
  return preciseCurrencyFormatter.format(amount);
}

/**
 * The exact amount: whole rupees as `₹5,331`, anything with paise as `₹5,330.93`. For payment confirmation UI,
 * where a rounded headline would differ from what is actually debited. Display only — the amount itself is never rounded.
 */
export function formatCurrencyExact(amount: number) {
  return Math.round(amount * 100) % 100 === 0 ? formatCurrency(amount) : formatCurrencyPrecise(amount);
}
