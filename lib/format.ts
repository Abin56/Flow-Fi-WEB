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
