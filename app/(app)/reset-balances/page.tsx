import { notFound } from "next/navigation";

// DISABLED (audit MFI-P0-01). This route used to overwrite EVERY account's and person's cached `currentBalance`
// with its `openingBalance`, ignoring all live transactions and ledger entries. It is no longer reachable and
// performs no write. Balances must never be reset in bulk: compare them read-only with the Financial Audit page
// (`/financial-audit`) and correct any drift deliberately, per record. This folder can be deleted.
export default function ResetBalancesPage() {
  notFound();
}
