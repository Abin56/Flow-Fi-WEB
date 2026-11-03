"use client";

import { AlertTriangle, FileText, HardDrive, Info, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAccounts } from "@/hooks/use-accounts";
import { storage } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { useStorageUsage } from "../hooks/use-storage-usage";
import { deleteStorageFiles } from "../lib/storage-service";
import {
  formatBytes,
  parseLimitMb,
  STORAGE_LIMIT_PRESETS_MB,
  storageLevelMessage,
  BYTES_PER_MB,
  type StorageFileRecord,
} from "../lib/storage-usage";

const CARD = "rounded-[20px] border border-border/60 bg-card p-5 shadow-e1";
const DATE_FMT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
/** Statuses where the analyzer is actively reading the PDF — deleting it now would break that run. */
const BUSY_STATUSES = new Set(["decrypting", "parsing"]);

function isBusy(f: StorageFileRecord): boolean {
  return f.documentStatuses.some((s) => BUSY_STATUSES.has(s));
}

function typeLabel(contentType: string): string {
  return contentType === "application/pdf" ? "PDF" : contentType.split("/").pop()?.toUpperCase() || "File";
}

const LEVEL_BAR: Record<string, string> = {
  ok: "bg-primary",
  warning: "bg-warning",
  full: "bg-expense",
  over: "bg-expense",
};

function UsageBar({ percent, level, label }: { percent: number; level: string; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-3 w-full overflow-hidden rounded-full bg-secondary"
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", LEVEL_BAR[level] ?? "bg-primary")} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function StorageManagement() {
  const { uid, discovery, files, summary, limitBytes, setLimit, isLoading, isFetching, error, refresh } = useStorageUsage();
  const { data: accounts = [] } = useAccounts();
  const cardName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const [customMb, setCustomMb] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const notice = storageLevelMessage(summary);
  const grouped = useMemo(() => {
    const bySection = new Map<string, StorageFileRecord[]>();
    for (const f of files) bySection.set(f.sectionId, [...(bySection.get(f.sectionId) ?? []), f]);
    return summary.sections.map((s) => ({
      section: s,
      files: (bySection.get(s.id) ?? []).slice().sort((a, b) => b.sizeBytes - a.sizeBytes),
    }));
  }, [files, summary.sections]);

  const selectedFiles = files.filter((f) => selected.has(f.path));
  const selectedBytes = selectedFiles.reduce((n, f) => n + f.sizeBytes, 0);
  const sharedCount = selectedFiles.filter((f) => f.documentIds.length > 1).length;
  const keptRecords = selectedFiles.reduce((n, f) => n + f.documentIds.length, 0);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function applyLimit(bytes: number) {
    setLimit(bytes);
    setLimitError(null);
    setCustomMb("");
    toast.success("Storage limit updated", `Your limit is now ${formatBytes(bytes)}.`);
  }

  function applyCustom() {
    const parsed = parseLimitMb(customMb);
    if (!parsed.ok) {
      setLimitError(parsed.message);
      return;
    }
    applyLimit(parsed.bytes);
  }

  async function handleDelete() {
    if (!uid) return;
    setDeleting(true);
    try {
      const result = await deleteStorageFiles({ storage }, uid, [...selected]);
      if (result.failed.length > 0) {
        toast.error(
          `${result.failed.length} file${result.failed.length === 1 ? "" : "s"} couldn't be deleted`,
          result.failed[0]!.message,
        );
      }
      if (result.deleted.length > 0) {
        toast.success(`Deleted ${result.deleted.length} file${result.deleted.length === 1 ? "" : "s"}`, "Your statement history and transactions were not changed.");
      }
      // Failed paths stay selected so the user can retry; deleted ones leave the selection.
      setSelected(new Set(result.failed.map((f) => f.path)));
      setConfirmOpen(false);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="storage-management">
      <section className={CARD} aria-label="Storage usage">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-primary/12 text-primary-accent-text">
              <HardDrive className="size-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-foreground">Storage</h2>
              <p className="text-xs text-muted-foreground">Files you&apos;ve uploaded to FlowFi (not your financial records)</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isFetching} aria-label="Recalculate storage usage">
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} /> Recalculate
          </Button>
        </div>

        {isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="storage-loading">Measuring your stored files…</p>
        ) : error ? (
          <p className="mt-4 text-sm text-expense" role="alert" data-testid="storage-error">
            Couldn&apos;t read your storage usage ({error.message}). Nothing was changed — try Recalculate.
          </p>
        ) : (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Used</dt>
                <dd className="text-lg font-bold tabular-nums" data-testid="storage-used">{formatBytes(summary.usedBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Limit</dt>
                <dd className="text-lg font-bold tabular-nums" data-testid="storage-limit">{formatBytes(summary.limitBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Remaining</dt>
                <dd className="text-lg font-bold tabular-nums" data-testid="storage-remaining">{formatBytes(summary.remainingBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Used of limit</dt>
                <dd className="text-lg font-bold tabular-nums" data-testid="storage-percent">{summary.percentUsed >= 10 ? Math.round(summary.percentUsed) : summary.percentUsed.toFixed(1)}%</dd>
              </div>
            </dl>
            <div className="mt-3">
              <UsageBar percent={summary.percentUsed} level={summary.level} label="Storage used of limit" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground" data-testid="storage-filecount">
              {summary.fileCount} stored file{summary.fileCount === 1 ? "" : "s"}
            </p>
            {notice && (
              <p
                role="status"
                data-testid="storage-notice"
                className={cn(
                  "mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm",
                  summary.level === "warning" ? "bg-warning/15 text-foreground" : "bg-expense/10 text-expense",
                )}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {notice}
              </p>
            )}
            {discovery && discovery.unreadable > 0 && (
              <p className="mt-2 text-xs text-warning-foreground" data-testid="storage-unreadable">
                {discovery.unreadable} file{discovery.unreadable === 1 ? "" : "s"} couldn&apos;t be measured, so the total may be understated.
              </p>
            )}
          </>
        )}
      </section>

      <section className={CARD} aria-label="Storage limit">
        <h3 className="text-sm font-semibold text-foreground">Your storage limit</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          New statement uploads are blocked when they would take you past this limit. It&apos;s a personal allocation saved on this device — there is no
          billing or plan behind it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {STORAGE_LIMIT_PRESETS_MB.map((mb) => (
            <Button
              key={mb}
              size="sm"
              variant={limitBytes === mb * BYTES_PER_MB ? "default" : "outline"}
              onClick={() => applyLimit(mb * BYTES_PER_MB)}
              aria-pressed={limitBytes === mb * BYTES_PER_MB}
            >
              {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
            </Button>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={customMb}
              onChange={(e) => {
                setCustomMb(e.target.value);
                setLimitError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustom();
              }}
              inputMode="decimal"
              placeholder="Custom MB"
              aria-label="Custom storage limit in MB"
              aria-invalid={limitError ? true : undefined}
              className="h-8 w-28 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button size="sm" variant="outline" onClick={applyCustom}>Set limit</Button>
          </div>
        </div>
        {limitError && (
          <p className="mt-2 text-xs text-expense" role="alert" data-testid="storage-limit-error">{limitError}</p>
        )}
        {!isLoading && !error && summary.usedBytes > limitBytes && (
          <p className="mt-2 text-xs text-muted-foreground">Your limit is below what you already use. Nothing is deleted automatically — free space below or raise the limit.</p>
        )}
      </section>

      <section className={CARD} aria-label="Usage by section">
        <h3 className="text-sm font-semibold text-foreground">Where your storage goes</h3>
        {summary.sections.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="storage-empty">
            {isLoading ? "…" : "No uploaded files yet."}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4" data-testid="storage-sections">
            {summary.sections.map((s, i) => (
              <li key={s.id} data-testid={`storage-section-${s.id}`}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">
                    {s.label}
                    {i === 0 && summary.sections.length > 1 && <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">Largest</span>}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatBytes(s.bytes)} · {s.fileCount} file{s.fileCount === 1 ? "" : "s"} · {Math.round(s.sharePercent)}%
                  </span>
                </div>
                <div className="mt-1.5">
                  <UsageBar percent={s.sharePercent} level="ok" label={`${s.label} share of used storage`} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground" data-testid="storage-not-stored">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Only statement PDFs are uploaded to FlowFi storage today. Smart Capture reads screenshots and pasted text on your device and doesn&apos;t keep the
            file; your profile photo is saved in this browser; and transactions have no receipt/attachment upload yet — so none of those use storage.
            Sizes are the real size of each stored file; the total is the sum of the files listed here.
            {discovery?.orphanScan === "unavailable" && " Leftover files with no statement record couldn't be searched for, so any such files wouldn't appear here."}
          </p>
        </div>
      </section>

      <section className={CARD} aria-label="Stored files">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Clean up stored files</h3>
          <Button
            variant="destructive"
            size="sm"
            disabled={selected.size === 0 || deleting}
            onClick={() => setConfirmOpen(true)}
            data-testid="storage-delete-selected"
          >
            <Trash2 className="size-3.5" /> Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Deleting a file removes only the stored PDF. The statement record, imported transactions and all your financial data stay exactly as they are.
        </p>

        {grouped.length === 0 && !isLoading && <p className="mt-3 text-sm text-muted-foreground">Nothing to clean up.</p>}
        {grouped.map(({ section, files: sectionFiles }) => (
          <div key={section.id} className="mt-4" data-testid={`storage-group-${section.id}`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.label} · {formatBytes(section.bytes)}
            </p>
            <ul className="mt-2 divide-y divide-border/60 rounded-xl border border-border/60">
              {sectionFiles.map((f) => {
                const busy = isBusy(f);
                const cards = f.accountIds.map((id) => cardName.get(id)).filter(Boolean);
                return (
                  <li key={f.path} className="flex items-center gap-3 px-3 py-2.5" data-testid="storage-file-row">
                    <Checkbox
                      checked={selected.has(f.path)}
                      disabled={busy}
                      onCheckedChange={() => toggle(f.path)}
                      aria-label={`Select ${f.displayName}`}
                    />
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {typeLabel(f.contentType)} · {f.uploadedAt ? `uploaded ${DATE_FMT.format(f.uploadedAt)}` : "upload date unknown"}
                        {cards.length > 0 && ` · ${cards.join(", ")}`}
                        {` · ${f.fileName.slice(0, 12)}…`}
                        {busy && " · still processing"}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-foreground">{formatBytes(f.sizeBytes)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${selected.size} stored file${selected.size === 1 ? "" : "s"}?`}
        description={
          `This frees ${formatBytes(selectedBytes)} and can't be undone. Only the stored PDF${selected.size === 1 ? " is" : "s are"} removed — ` +
          `${keptRecords > 0 ? `the ${keptRecords} linked statement record${keptRecords === 1 ? "" : "s"}, ` : ""}your imported transactions and statement history are kept. ` +
          `You won't be able to re-run PDF parsing or unlock a password-protected statement from a deleted file.` +
          (sharedCount > 0 ? ` ${sharedCount} of these files is shared by more than one statement record; all of them lose the PDF.` : "")
        }
        variant="destructive"
        confirmLabel="Delete files"
        onConfirm={() => void handleDelete()}
        loading={deleting}
      />
    </div>
  );
}
