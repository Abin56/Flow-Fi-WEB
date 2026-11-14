/**
 * Shared Loan / EMI Record payment, when people's shares of what this payment settles are still open: see
 * `people-share-confirm.tsx` for the simple Yes/No question this is answered with.
 */

/** "Sanju" · "Sanju and AMMA" · "Sanju and 2 others". */
export function peopleNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}
