/**
 * Explicit return context for People Ledger → Transactions round-trips. The People side encodes where it
 * was (person + selected cycle + whether the expanded ledger was open) into an in-app `return` path and a
 * display label; the Transactions side shows "← Back to <name>" and goes back there once the transaction
 * operation is finished. Survives a refresh (it lives in the URL), never depends on `history.back()`.
 *
 * The cycle is carried as its START date (`cycle=YYYY-MM-DD`) and re-resolved against the user's global
 * Settings → Month cycle start day (`cycleContaining`) — never a hard-coded 18th → 17th window.
 */

import { cycleContaining, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { isInAppPath } from "@/lib/engines/linked-people-readiness";

export const RETURN_PARAM = "return";
export const RETURN_LABEL_PARAM = "returnLabel";
export const CYCLE_PARAM = "cycle";
export const VIEW_PARAM = "view";

export interface PeopleReturnContext {
  /** In-app path back to the originating People ledger. */
  href: string;
  /** Who it returns to ("AMMA") — shown as "Back to AMMA". */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatCycleParam(cycle: StatementCycle): string {
  const d = cycle.start;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local-midnight date a `cycle=` value names, or null when malformed. */
export function parseCycleAnchor(value: string | null | undefined): Date | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.getMonth() === Number(m[2]) - 1 && date.getDate() === Number(m[3]) ? date : null;
}

/** The cycle (of the given global start day) a `cycle=` value points at, or null when absent/malformed. */
export function cycleFromParam(value: string | null | undefined, startDay: number): StatementCycle | null {
  const anchor = parseCycleAnchor(value);
  return anchor ? cycleContaining(anchor, startDay) : null;
}

/** `/people?person=<id>&cycle=<start>[&view=ledger]` — the exact ledger context to come back to. */
export function peopleLedgerHref(params: { personId: string; cycle: StatementCycle; view?: "ledger" | null }): string {
  const q = new URLSearchParams({ person: params.personId, [CYCLE_PARAM]: formatCycleParam(params.cycle) });
  if (params.view === "ledger") q.set(VIEW_PARAM, "ledger");
  return `/people?${q.toString()}`;
}

/** `/transactions?transaction=<id>` plus the return context when one is given. */
export function transactionHref(transactionId: string, origin?: PeopleReturnContext | null): string {
  const q = new URLSearchParams({ transaction: transactionId });
  if (origin && isPeopleReturnPath(origin.href)) {
    q.set(RETURN_PARAM, origin.href);
    q.set(RETURN_LABEL_PARAM, origin.label);
  }
  return `/transactions?${q.toString()}`;
}

/** Only an in-app People path is followed back — never an external or arbitrary URL. */
export function isPeopleReturnPath(path: string): boolean {
  return isInAppPath(path) && (path === "/people" || path.startsWith("/people?"));
}

/** The return context carried by a URL's query, or null when there is none (or it isn't a People path). */
export function readPeopleReturnContext(params: Pick<URLSearchParams, "get">): PeopleReturnContext | null {
  const href = params.get(RETURN_PARAM);
  if (!href || !isPeopleReturnPath(href)) return null;
  const label = params.get(RETURN_LABEL_PARAM)?.trim();
  return { href, label: label || "People" };
}
