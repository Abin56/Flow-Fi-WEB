/**
 * Reconciliation's write boundary. Reviewing is read-only; the ONLY write is the Phase 4 final approval, and it is
 * confined to three small files:
 *   - lib/approval-commit.ts       — the one place `commitReviewImport` (the existing engine) is called
 *   - lib/approval-app-deps.ts     — builds the app's account + transaction repositories for it
 *   - lib/authoritative-reader.ts  — the pre-commit SERVER re-read (Firestore read functions only)
 * Everything else must stay free of repositories, Firestore and the commit engine. These checks fail if a later change
 * adds a second write path, a direct repository write, an unsupported-action repository, or a Firestore write function.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const ROOT = path.resolve(import.meta.dirname);
const PAGE = path.resolve(ROOT, "../../app/(app)/reconciliation/page.tsx");
const rel = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");
const ALL = [...sources(ROOT), PAGE];

const COMMIT = "lib/approval-commit.ts";
const DEPS = "lib/approval-app-deps.ts";
const READER = "lib/authoritative-reader.ts";

/** Never allowed anywhere in the feature, writer files included. */
const NEVER = [
  /\b(addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\s*\(/,
  /\.(createTransaction|createTransferPair|createTransferPairAtomic|createExpense|assignToPerson|editTransaction|softDeleteTransaction|markHandled|createEmi|createLoan)\s*\(/,
  /\bimportCandidate\s*\(/,
  /\bcreate(Expense|Emi|Loan|InstallmentRepositoryFor|Person|CreditCard|Statement)[A-Za-z]*\s*\(/,
];

describe("reconciliation safety boundary", () => {
  it("has no direct write call, split/EMI/loan/person repository or candidate import anywhere", () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      const text = readFileSync(file, "utf8");
      for (const pattern of NEVER) if (pattern.test(text)) offenders.push(`${rel(file)} ~ ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });

  it("only approval-commit.ts runs the commit engine, and it also runs the engine's pre-flight and duplicate check", () => {
    const callers = ALL.filter((f) => /\bcommitReviewImport\s*\(/.test(readFileSync(f, "utf8"))).map(rel);
    expect(callers).toEqual([COMMIT]);
    const text = readFileSync(path.join(ROOT, COMMIT), "utf8");
    expect(text).toMatch(/getPreflightBlockers\(/);
    expect(text).toMatch(/detectFreshDuplicatesForCommit\(/);
    expect(text).toMatch(/from\s+["']@\/features\/transaction-studio\/lib\/commit-review-import["']/);
  });

  it("only approval-app-deps.ts builds repositories, and only the account and transaction ones", () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      const text = readFileSync(file, "utf8");
      const calls = [...text.matchAll(/\bcreate([A-Za-z]*)Repository\s*\(/g)].map((m) => m[1]);
      if (calls.length === 0) continue;
      if (rel(file) !== DEPS) offenders.push(`${rel(file)} builds a repository`);
      else if (calls.some((c) => c !== "Account" && c !== "Transaction")) offenders.push(`${rel(file)} builds ${calls.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("only authoritative-reader.ts touches Firestore, and only its read functions", () => {
    const importers = ALL.filter((f) => /from\s+["']firebase\/firestore["']/.test(readFileSync(f, "utf8"))).map(rel);
    expect(importers).toEqual([READER]);
    const imported = /import\s*\{([^}]*)\}\s*from\s*["']firebase\/firestore["']/.exec(readFileSync(path.join(ROOT, READER), "utf8"))![1]!
      .split(",")
      .map((n) => n.replace(/\btype\b/, "").trim())
      .filter(Boolean);
    expect(imported.sort()).toEqual(["Firestore", "FirestoreDataConverter", "collection", "getDocsFromServer", "query", "where"]);
  });

  it("the review screen never starts an approval by itself (no effect calls approve/open)", () => {
    const hook = readFileSync(path.join(ROOT, "hooks/use-reconciliation-approval.ts"), "utf8");
    expect(hook).not.toMatch(/useEffect/);
    const workspace = readFileSync(path.join(ROOT, "components/reconciliation-workspace.tsx"), "utf8");
    expect(workspace).not.toMatch(/useEffect\([^)]*approval\.(open|approve)/);
  });

  it("Smart Capture's workflow can't reach the direct import (it must go through Reconciliation)", () => {
    const studio = readFileSync(path.resolve(ROOT, "../smart-capture/components/smart-capture-studio.tsx"), "utf8");
    expect(studio).not.toMatch(/from\s+["']\.\/capture-approval["']|<CaptureApproval\b|commitReviewImport\s*\(/);
    expect(studio).toMatch(/router\.push\("\/reconciliation"\)/);
  });
});
