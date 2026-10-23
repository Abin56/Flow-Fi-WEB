/**
 * Copy Text formats for the People share — WhatsApp plain text built only from `MonthlySettlementView` (the Monthly
 * Settlement PDF's view model), so the copied message and the PDF carry the same figures, statuses and wording.
 * Nothing here recomputes money.
 *
 *  - Smart Settlement (`smartSettlementText`) — the default, a compact receipt: payment due now first, open items
 *    grouped into "pay this cycle" / "moved to <next cycle>" by the model's own postponed flag, receipts, a short
 *    balance summary. No monospace tables or padded columns.
 *  - Detailed (`monthlySettlementDetailedText`) — the line-by-line reconciliation message.
 *  - Summary — the engine's short message (`statementShareText`, unchanged, in `person-cycle-statement-share`).
 *
 * Safe by construction: a both-ways balance never states a single payable amount; a settled balance says so;
 * postponed money is always "still owed, not cancelled"; earlier items cleared this cycle appear only in the
 * reconciliation; stored descriptions are shown as entered (shortened only for the phone, with WhatsApp's formatting
 * characters neutralised so a description can never bold / italicise / strike the rest of the message).
 */

import { money2, tidyAccount, type MonthlyItem, type MonthlyPayment, type MonthlySettlementView } from "@/features/people/lib/monthly-settlement-model";

export type CopyFormat = "smart" | "detailed" | "summary";
export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: "smart", label: "Smart Settlement" },
  { id: "detailed", label: "Detailed" },
  { id: "summary", label: "Summary" },
];

/**
 * User-entered text (names, descriptions, account names) inside a WhatsApp message: its formatting markers * _ ~ `
 * are swapped for look-alike characters, so "50% *off*" stays literal text and never toggles bold. Display only.
 */
export function waSafe(s: string): string {
  return s.replace(/\*/g, "∗").replace(/_/g, "ˍ").replace(/~/g, "∼").replace(/`/g, "ˋ").replace(/\s+/g, " ").trim();
}

const TITLE_MAX = 34;
/** A long stored description is shortened for a phone screen (display only — the stored text is untouched). */
const short = (s: string, max = TITLE_MAX) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const upper = (s: string) => s.toLocaleUpperCase("en-IN");
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const dateOf = (p: MonthlyPayment) => (p.date === "Date not known" ? p.date : p.date.replace(/ \d{4}$/, ""));
const sourceOf = (p: MonthlyPayment) => (p.source ? waSafe(tidyAccount(p.source)) : "");

// ---------------------------------------------------------------------------------------------------
// Smart Settlement
// ---------------------------------------------------------------------------------------------------

/** Section divider: short enough for a portrait phone at WhatsApp's default text size. */
const DIVIDER = "━".repeat(20);
const SUB_RULE = "─".repeat(20);
/** Label-to-amount spacing — no padded columns (WhatsApp's text font is proportional, so padding never aligns). */
const GAP = "  ";
const SEP = "  •  ";

/** "01 Oct – 31 Oct 2026" → "01–31 Oct 2026"; "17 Sep – 16 Oct 2026" stays as is. */
export function compactCycle(label: string): string {
  const m = label.match(/^(\d{1,2}) (\w{3})(?: (\d{4}))? – (\d{1,2}) (\w{3}) (\d{4})$/);
  if (!m) return label;
  const [, d1, m1, y1, d2, m2, y2] = m;
  if (!y1 && m1 === m2) return `${d1}–${d2} ${m2} ${y2}`;
  return label;
}

/** The cycle's closing month for the header ("OCT 2026"), read from the cycle label — never assumed. */
function cycleMonth(label: string): string {
  const m = label.match(/(\w{3}) (\d{4})$/);
  return m ? upper(`${m[1]} ${m[2]}`) : "";
}

/** One open item: title, then the amount still owed (+ quiet tags); a part-paid line only when something was paid. */
function itemBlock(it: MonthlyItem, v: MonthlySettlementView, person: string, owner: string, showTarget: boolean): string[] {
  const partPaid = it.paid !== "—";
  const amount = `${money2(it.remaining)}${it.postponed || partPaid ? " remaining" : ""}`;
  const tags = [
    it.group === "earlier" ? "earlier balance" : "",
    it.status === "Overdue" || it.status === "Upcoming" ? it.status.toLowerCase() : "",
    showTarget && it.postponed ? it.status.replace(/^Rest in /, "moved to ").replace(/^Moved to /, "moved to ") : "",
    v.mixed && it.owedBy ? `${firstName(it.owedBy === "them" ? person : owner)} owes` : "",
  ].filter(Boolean);
  const out = [`*${short(waSafe(it.title))}*`, [amount, ...tags].join(SEP)];
  if (partPaid) out.push(`_Paid ${money2(it.paid)} / ${money2(it.amount)}_`);
  return out;
}

/** What a receipt went to: "Previous balance cleared", "Bajaj Finance · EMI #13", "B · cleared". */
function allocationLabel(a: MonthlyPayment["lines"][number]): string {
  if (a.label.startsWith("Earlier balance")) return a.cleared ? "Previous balance cleared" : `Previous balance${a.tail ? ` · ${money2(a.tail)} left` : ""}`;
  return `${short(waSafe(a.label))}${a.cleared ? " · cleared" : ""}`;
}

export function smartSettlementText(v: MonthlySettlementView): string {
  const settled = v.direction === "settled";
  const person = waSafe(v.personName);
  const owner = waSafe(v.ownerName);
  const cycle = compactCycle(v.cycleLabel);
  const year = cycle.match(/ (\d{4})$/)?.[1];
  const range = year ? cycle.slice(0, -5) : cycle;
  const asOf = year ? v.asOf.replace(new RegExp(` ${year}$`), "") : v.asOf;
  const month = cycleMonth(v.cycleLabel);

  // ---- 1. Compact header ----
  const out: string[] = ["*FlowFi  /  SMART SETTLEMENT*", `*${short(upper(person), 40)}*${month ? `${SEP}${month}` : ""}`, `${range}  |  Updated ${asOf}`, "", DIVIDER];

  // ---- 2–3. The actionable figure first, then the secondary totals ----
  if (settled) out.push("*ALL SETTLED*", `*${money2(v.outstanding)}*`);
  else if (v.mixed) {
    out.push("*NET BALANCE*", `*${money2(v.outstanding)}*`, "", `${firstName(person)} owes${GAP}${money2(v.mixed.theyOwe)}`, `${firstName(owner)} owes${GAP}${money2(v.mixed.ownerOwes)}`);
  } else if (v.split) {
    out.push("*PAYMENT DUE NOW*", `*${money2(v.split.dueNow)}*`, "", `Total outstanding${GAP}${money2(v.outstanding)}`, `${v.split.postponedTo}${GAP}${money2(v.split.postponed)}`);
  } else out.push("*TOTAL OUTSTANDING*", `*${money2(v.outstanding)}*`);
  if (v.advance) out.push(`_${v.advance.label}: ${money2(v.advance.value)} — held apart, not in the total._`);
  out.push(DIVIDER);

  let n = 0;
  const section = (title: string) => {
    if (n > 0) out.push("", DIVIDER);
    n += 1;
    out.push(`*${String(n).padStart(2, "0")}  /  ${title}*`, "");
  };

  // ---- 4–6. Open items, grouped by the model's own postponed flag (never reclassified here) ----
  const open = v.items.filter((i) => i.remainingPaise > 0);
  const nowItems = v.split ? open.filter((i) => !i.postponed) : open;
  const moved = v.split ? open.filter((i) => i.postponed) : [];
  out.push("");
  if (nowItems.length > 0) {
    section(v.split ? "PAY THIS CYCLE" : "OPEN ITEMS");
    nowItems.forEach((it, k) => out.push(...(k ? [""] : []), ...itemBlock(it, v, person, owner, !v.split)));
    if (v.split) out.push("", `*TOTAL DUE  →  ${money2(v.split.dueNow)}*`);
  }
  if (v.split && moved.length > 0) {
    section(upper(v.split.postponedTo));
    const many = v.split.postponedTo === "Moved to later cycles";
    moved.forEach((it, k) => out.push(...(k ? [""] : []), ...itemBlock(it, v, person, owner, many)));
    out.push("", `*TOTAL MOVED  →  ${money2(v.split.postponed)}*`, "_Postponed, not cancelled._");
  }

  // ---- 7. Payments: one ✓ line per amount applied, where it landed, and what it went to ----
  if (v.payments.length > 0) {
    section(v.payments.every((p) => p.inbound) ? "PAYMENTS RECEIVED" : "PAYMENTS");
    let rows = 0;
    for (const p of v.payments) {
      const source = sourceOf(p);
      const where = source.startsWith("Received in ") ? source.slice("Received in ".length) : "";
      // A receipt recorded after the fact with no account is a record, not new money in a bank account.
      const record = source && !where && !source.startsWith("Paid from") ? `   _${source.charAt(0).toUpperCase()}${source.slice(1)}_` : null;
      const byLine = p.lines.length > 1 && p.lines.every((a) => a.amount);
      const parts = byLine ? p.lines.map((a) => ({ amount: a.amount as string, lines: [a] })) : [{ amount: p.amount, lines: p.lines }];
      for (const part of parts) {
        out.push(...(rows ? [""] : []), `${p.inbound ? "✓" : "↗"} ${money2(part.amount)}${SEP}${dateOf(p)}`);
        if (!p.inbound) out.push(`   ${waSafe(p.label)}`);
        if (record) out.push(record);
        const detail = [where, ...part.lines.map(allocationLabel)].filter(Boolean).join("  /  ");
        if (detail) out.push(`   ${detail}`);
        rows += 1;
      }
    }
    if (rows > 1 && v.totalPaid) out.push("", `*TOTAL RECEIVED${GAP}${money2(v.totalPaid)}*`);
  }

  // ---- 8. Balance summary (omitted for a both-ways balance, whose sides are named above) ----
  const total = v.lines.find((l) => l.key === "outstanding");
  const body = v.lines.filter((l) => l.key !== "outstanding");
  if (!v.mixed && total && body.length > 0) {
    const label = { previous: "Previous balance", new: "New this cycle", applied: "Received" } as const;
    section("BALANCE SUMMARY");
    out.push(...body.map((l) => `${label[l.key as keyof typeof label]}${GAP}${l.key === "applied" ? "−" : ""}${money2(l.value)}`), SUB_RULE, `*OUTSTANDING${GAP}${money2(total.value)}*`);
  }

  // ---- Direction footer ----
  if (n > 0) out.push("");
  if (settled) out.push("*Nothing to pay — all settled.*");
  else {
    const [from, to] = v.direction === "iOwe" ? [owner, person] : [person, owner];
    out.push(`*${v.mixed ? "NET  " : ""}${upper(from)}  →  ${upper(to)}*`);
  }
  out.push("_Powered by FlowFi_");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Detailed (the line-by-line reconciliation message)
// ---------------------------------------------------------------------------------------------------

function detailedItem(it: MonthlyItem, v: MonthlySettlementView): string {
  const part = it.paid !== "—" ? `${it.remaining} left of ${it.amount}` : it.remaining;
  const tags = [it.status, it.group === "earlier" ? "earlier balance" : "", v.mixed && it.owedBy ? `${firstName(it.owedBy === "them" ? v.personName : v.ownerName)} owes` : ""].filter(Boolean);
  return `• ${short(waSafe(it.title), 40)} — ${part} · ${tags.join(" · ")}`;
}

function detailedPayment(p: MonthlyPayment): string[] {
  const source = sourceOf(p);
  const where = source ? (source.startsWith("Received in") ? source.replace(/^Received/, "received") : source.charAt(0).toLowerCase() + source.slice(1)) : "";
  const lines = [[dateOf(p), p.amount, p.inbound || !p.label ? where : waSafe(p.label)].filter(Boolean).join(" · ")];
  for (const a of p.lines) lines.push(a.amount ? `  → ${a.amount} to ${short(waSafe(a.label), 40)}${a.tail ? ` (${a.tail})` : ""}` : `  → ${a.label}`);
  return lines;
}

export function monthlySettlementDetailedText(v: MonthlySettlementView): string {
  const settled = v.direction === "settled";
  const person = waSafe(v.personName);
  const owner = waSafe(v.ownerName);
  const out: string[] = [`*FlowFi Monthly Settlement*`, `*${person}* · ${v.cycleLabel}`, `As of ${v.asOf}`, ""];
  if (v.mixed && !settled) {
    out.push("*Balance (owed both ways)*", `${person} owes ${owner}: ${money2(v.mixed.theyOwe)}`, `${owner} owes ${person}: ${money2(v.mixed.ownerOwes)}`);
  } else {
    for (const l of v.lines) {
      if (l.key === "outstanding") continue;
      out.push(`${l.key === "applied" ? "Received" : l.label}: ${money2(l.value)}`);
      if (l.key === "previous" && v.cleared) out.push(`  – ${v.cleared.count} earlier ${v.cleared.count === 1 ? "item" : "items"} (${v.cleared.range}) cleared this cycle`);
      if (l.key === "applied" && l.note) out.push(`  – ${money2(l.note)}`);
    }
    out.push(settled ? "*Settled — nothing outstanding*" : `*Total outstanding: ${money2(v.outstanding)}*`);
    if (v.split) out.push("", `*Due now:* ${money2(v.split.dueNow)}`, `*${v.split.postponedTo}:* ${money2(v.split.postponed)} (postponed — still owed, not cancelled)`);
  }
  if (v.advance) out.push("", `${v.advance.label}: ${money2(v.advance.value)} (held apart, not in the total)`);
  const open = v.items.filter((i) => i.remainingPaise > 0);
  if (open.length > 0) out.push("", `*Open items*`, ...open.map((i) => money2(detailedItem(i, v))));
  if (v.payments.length > 0) {
    out.push("", `*Payments*`);
    v.payments.forEach((p, i) => out.push(...detailedPayment(p).map(money2), ...(i < v.payments.length - 1 ? [""] : [])));
    if (v.payments.length > 1 && v.totalPaid) out.push(`Total received: ${money2(v.totalPaid)}`);
  }
  const headline = v.direction === "iOwe" ? `${owner} owes ${person}` : `${person} owes ${owner}`;
  out.push("", settled ? "*All settled*" : v.mixed ? `*Net: ${headline} ${money2(v.outstanding)}*` : `*${headline}*`);
  return out.join("\n");
}
