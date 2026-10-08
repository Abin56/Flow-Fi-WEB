/**
 * Tolerant list parsing (WFI-P2-13). A converter throws on a malformed legacy document (e.g. a missing
 * timestamp); mapping a whole snapshot with `d.data()` then errored the ENTIRE live list — every account,
 * transaction or person vanished because of one bad doc. Here each document is parsed on its own: a bad one is
 * quarantined (skipped and reported once by path) and the rest of the list still loads.
 */

const reported = new Set<string>();

export function safeDocs<T>(docs: readonly { data(): T; ref?: { path: string }; id?: string }[]): T[] {
  const out: T[] = [];
  for (const d of docs) {
    try {
      out.push(d.data());
    } catch (error) {
      const key = d.ref?.path ?? d.id ?? "unknown";
      if (!reported.has(key)) {
        reported.add(key);
        console.error(`[FlowFi] Skipped an unreadable record (${key}) — the rest of the list still loads.`, error);
      }
    }
  }
  return out;
}
