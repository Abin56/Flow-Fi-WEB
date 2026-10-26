"use client";

/**
 * Smart Capture Studio — paste (or screenshot) a statement's transaction
 * rows, review the extracted candidates, then go on to "Check duplicates"
 * (the Reconciliation Studio), which compares them with what FlowFi already
 * has. Nothing is written from here.
 *
 * "Next" hands the verified rows over in memory (features/reconciliation/
 * lib/capture-handoff.ts) — only when the same review gates as before pass.
 * The direct "Approve & Import" step (capture-approval.tsx) is kept intact
 * internally but is no longer reachable from this workflow, so no import can
 * bypass reconciliation.
 *
 * Source management (header actions): Replace screenshot, Paste new
 * statement, Retry OCR, Clear capture, Back to capture. Anything that would
 * drop the current rows asks first when the user has done review work (see
 * `hasReviewWork`) or has already handed the capture over; the old rows are
 * never kept behind a new source. A review open in Reconciliation is never
 * touched from here — it is replaced or discarded there, explicitly.
 *
 * Draft recovery (lib/capture-draft.ts) keeps only review *decisions* in this
 * tab's sessionStorage — never the statement text, amounts or screenshot. After
 * a refresh the user re-pastes the same text (or reads the same screenshot)
 * and the decisions come back. Coming "Back" from Reconciliation (no refresh)
 * reopens the capture exactly as it was handed over, from memory.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPaste, History, ImageUp, Lock, RotateCcw, ScanText, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { ClayButton } from "@/components/clay/clay-button";
import { useAccounts } from "@/hooks/use-accounts";
import { clearCaptureSnapshot, declinePendingHandoff, getHandoffState, handOffCapture } from "@/features/reconciliation/lib/capture-handoff";
import { parsePastedStatement, type CaptureParseResult } from "../lib/parse-pasted-statement";
import { canContinue, hasReviewWork, toReviewRows, type ReviewRow } from "../lib/capture-review";
import { annotateOcrRows, flagRepeatedRows } from "../lib/ocr-review";
import { buildDraft, clearDraft, loadDraft, restoreDecisions, saveDraft, type CaptureDraft } from "../lib/capture-draft";
import type { Rect } from "../lib/image-crop";
import { CaptureInput, type CaptureImage, type CaptureMode, type OcrCapture } from "./capture-input";
import { CaptureReview } from "./capture-review";
import { HeaderAction, WorkspaceHeader } from "./workspace-header";

type Stage = "capture" | "review";

const NO_ROWS_MESSAGE = "No transaction rows found. Each row should start with a date (e.g. 05/09/2026 or 05 Sep) and include an amount like 1,299.00.";

/** A pending "this drops your review" confirmation. `cancel` releases anything prepared for the action (e.g. a new image's URL). */
interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => void;
  cancel?: () => void;
}

export function SmartCaptureStudio() {
  const [stage, setStage] = useState<Stage>("capture");
  const [mode, setMode] = useState<CaptureMode>("text");
  const [text, setText] = useState("");
  const [image, setImageState] = useState<CaptureImage | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [source, setSource] = useState("");
  const [ocr, setOcr] = useState<OcrCapture | null>(null);
  const [parse, setParse] = useState<CaptureParseResult | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<CaptureDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const router = useRouter();
  const { data: accounts = [] } = useAccounts();

  // On mount: back from Reconciliation (same tab, no refresh) → reopen the capture as it was handed over, from memory;
  // otherwise read this tab's decisions-only draft (sessionStorage only exists in the browser).
  useEffect(() => {
    const snapshot = getHandoffState().snapshot;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time restore after hydration (memory or browser-only storage) */
    if (snapshot) {
      // Smart Capture owns a fresh object URL for its own view; the handoff keeps only the Blob.
      const url = snapshot.image ? URL.createObjectURL(snapshot.image.file) : null;
      imageUrlRef.current = url;
      setImageState(snapshot.image && url ? { file: snapshot.image.file, url, name: snapshot.image.name } : null);
      setMode(snapshot.mode);
      setText(snapshot.ocr ? "" : snapshot.sourceText);
      setCrop(snapshot.crop);
      setSource(snapshot.sourceText);
      setOcr(snapshot.ocr && url ? { ...snapshot.ocr, imageUrl: url } : null);
      setParse(snapshot.parse);
      setRows(snapshot.rows);
      setAccountId(snapshot.accountId);
      setStage("review");
      setNotice("Back from Check duplicates — your rows and selections are as you handed them over. Your duplicate review there is kept; going Next again updates it.");
      return;
    }
    const draft = loadDraft();
    if (draft) setPendingDraft(draft);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Revoke the screenshot's object URL when it's replaced or the page unmounts — it's never persisted anywhere.
  const setImage = useCallback(
    (next: CaptureImage | null) => {
      if (imageUrlRef.current && imageUrlRef.current !== next?.url) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = next?.url ?? null;
      setImageState(next);
      // Re-reading the same screenshot after a refresh: re-apply the saved selection so the text (and fingerprint) match.
      if (next && pendingDraft?.source === "ocr" && pendingDraft.crop) setCrop(pendingDraft.crop);
    },
    [pendingDraft],
  );
  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  // Save review decisions (never content) while a capture is in progress.
  useEffect(() => {
    if (completed || rows.length === 0) return;
    // Decided here, not only via CaptureApproval's onComplete: a child's effect runs before this one, so the
    // completion clear would otherwise be overwritten by this save in the same commit.
    const included = rows.filter((r) => r.include);
    if (included.length > 0 && included.every((r) => r.committedTransactionId || r.action === "ignore")) {
      clearDraft();
      return;
    }
    saveDraft(buildDraft({ sourceText: source, source: ocr ? "ocr" : "text", stage: "review", accountId, crop: ocr?.crop ?? null, rows }));
  }, [completed, rows, accountId, source, ocr, crop]);

  const hasReview = parse != null && rows.length > 0;

  /** Runs `action` straight away, or after an explicit confirmation when it would drop review work. */
  function guard(action: () => void, what: { title: string; confirmLabel: string; consequence: string }, cancel?: () => void) {
    // Read at the moment of the action: handing over doesn't re-render this page.
    const handedOver = getHandoffState().snapshot != null;
    if (!hasReview || (!hasReviewWork(rows) && !handedOver)) {
      action();
      return;
    }
    const confirmed = rows.filter((r) => r.confirmed || r.confirmedFields.length > 0).length;
    const lost = [
      `${rows.length} extracted row${rows.length === 1 ? "" : "s"}`,
      confirmed > 0 && `${confirmed} verification${confirmed === 1 ? "" : "s"}`,
      rows.some((r) => r.edited) && "your corrections",
      rows.some((r) => r.include !== r.suggestedInclude) && "your include/exclude choices",
    ].filter(Boolean);
    setConfirm({
      title: what.title,
      description:
        `${what.consequence} This removes ${lost.join(", ")}. Nothing has been imported and your FlowFi records are not affected.` +
        (handedOver ? " A duplicate check already open in Check duplicates stays there until you replace or discard it." : ""),
      confirmLabel: what.confirmLabel,
      run: action,
      cancel,
    });
  }

  /** Forgets the current rows (and their decisions-only draft and restore point). Keeps the source inputs unless told. */
  function clearReview() {
    clearDraft();
    setPendingDraft(null);
    setNotice(null);
    setHandoffError(null);
    setRows([]);
    setParse(null);
    setOcr(null);
    setSource("");
    setAccountId(null);
    setCompleted(false);
    // Forget this capture's restore point (and any handoff Reconciliation hasn't taken yet). A review already in
    // progress in Reconciliation is NOT touched — that is discarded there, explicitly.
    clearCaptureSnapshot();
    declinePendingHandoff();
  }

  function startReview(sourceText: string, result: CaptureParseResult, reviewRows: ReviewRow[], ocrCapture: OcrCapture | null) {
    let nextRows = reviewRows;
    setNotice(null);
    setHandoffError(null);
    // A new capture: "Back" from Reconciliation must not reopen the previous one any more.
    clearCaptureSnapshot();
    if (pendingDraft) {
      const restored = restoreDecisions(pendingDraft, sourceText, reviewRows);
      if (restored) {
        // Always reopens at review — even a draft saved at the retired "approve" step: the next step is Reconciliation.
        nextRows = restored.rows;
        setAccountId(pendingDraft.accountId);
        setNotice(
          `Restored your decisions on ${restored.restored} row${restored.restored === 1 ? "" : "s"}.` +
            (restored.needsRecheck > 0 ? ` ${restored.needsRecheck} hand-edited row${restored.needsRecheck === 1 ? " was" : "s were"} not saved — check ${restored.needsRecheck === 1 ? "it" : "them"} again.` : ""),
        );
      } else {
        // A different statement is an intentional new capture: the old unfinished draft (decisions only, no content)
        // is simply replaced — the banner already offered recovery, so no extra message is needed here.
        clearDraft();
      }
      setPendingDraft(null);
    }
    setError(null);
    setCompleted(false);
    setSource(sourceText);
    setOcr(ocrCapture);
    setParse(result);
    setRows(nextRows);
    setStage("review");
  }

  /** A new source while a review is open: the same source just returns to it; a different one replaces it (asking first). */
  function replaceWith(sourceText: string, begin: () => void) {
    if (hasReview && sourceText === source) {
      setStage("review");
      setNotice("Same statement as your open review — your rows and decisions are kept.");
      return;
    }
    if (hasReview) {
      guard(
        () => {
          clearReview();
          begin();
        },
        { title: "Replace the current capture?", confirmLabel: "Replace capture", consequence: "The new statement takes the place of the rows you are reviewing." },
      );
      return;
    }
    begin();
  }

  function extract(sourceText: string) {
    const result = parsePastedStatement(sourceText);
    if (result.rows.length === 0) {
      setError(sourceText.trim().length === 0 ? "Paste some statement text first." : NO_ROWS_MESSAGE);
      return;
    }
    const parsedRows = flagRepeatedRows(result.rows);
    replaceWith(sourceText, () => startReview(sourceText, { ...result, rows: parsedRows }, toReviewRows(parsedRows, "text"), null));
  }

  function extractOcr(capture: OcrCapture) {
    const result = parsePastedStatement(capture.text);
    if (result.rows.length === 0) {
      setError(`The screenshot was read, but ${NO_ROWS_MESSAGE.charAt(0).toLowerCase()}${NO_ROWS_MESSAGE.slice(1)} Try selecting just the transaction rows.`);
      return;
    }
    const annotated = annotateOcrRows(result.rows, capture.lines);
    replaceWith(capture.text, () => startReview(capture.text, { ...result, rows: annotated }, toReviewRows(annotated, "ocr"), capture));
  }

  /**
   * The screenshot input changed while a screenshot review is open: that review's image (and the rows read from it)
   * belong to the old screenshot, so it is cleared — never left pointing at a revoked image.
   */
  function changeImage(next: CaptureImage | null) {
    if (!ocr || next?.url === ocr.imageUrl) {
      setImage(next);
      return;
    }
    guard(
      () => {
        clearReview();
        setImage(next);
      },
      { title: next ? "Replace the screenshot?" : "Remove the screenshot?", confirmLabel: next ? "Replace screenshot" : "Remove screenshot", consequence: "The rows you are reviewing were read from the current screenshot." },
      () => {
        if (next) URL.revokeObjectURL(next.url);
      },
    );
  }

  // ---- header source actions ----
  function replaceScreenshot() {
    guard(
      () => {
        clearReview();
        setImage(null);
        setCrop(null);
        setMode("image");
        setStage("capture");
      },
      { title: "Replace the screenshot?", confirmLabel: "Replace screenshot", consequence: "You'll choose a new screenshot and read it from the start." },
    );
  }

  function pasteNewStatement() {
    guard(
      () => {
        clearReview();
        setImage(null);
        setCrop(null);
        setText("");
        setMode("text");
        setStage("capture");
      },
      { title: "Paste a new statement?", confirmLabel: "Start new paste", consequence: "You'll paste new statement text and extract it from the start." },
    );
  }

  function retryOcr() {
    guard(
      () => {
        clearReview();
        setMode("image");
        setStage("capture");
        setNotice(null);
      },
      { title: "Read the screenshot again?", confirmLabel: "Read again", consequence: "The same screenshot is read again from scratch — adjust the selected area first if rows were missed." },
    );
  }

  function clearCapture() {
    guard(
      () => {
        clearReview();
        setText("");
        setCrop(null);
        setImage(null);
        setMode("text");
        setStage("capture");
      },
      { title: "Clear this capture?", confirmLabel: "Clear capture", consequence: "The screenshot or pasted text is removed from this page." },
    );
  }

  /**
   * Next → Reconciliation. The same gate as before (`canContinue`): every included row complete with no unresolved
   * issue — strict OCR fields included. Excluded rows travel along, still excluded (traceable, never imported).
   * The statement account is chosen — explicitly — in Reconciliation, so none is carried over from here.
   */
  function continueToReconciliation() {
    if (!canContinue(rows) || !parse) return;
    const result = handOffCapture({
      sourceText: source,
      parse,
      rows,
      ocr,
      image: image ? { file: image.file, name: image.name } : null,
      crop: ocr?.crop ?? crop,
      mode,
      accountId: null,
      accounts,
    });
    if (!result.ok) {
      setHandoffError(result.error);
      return;
    }
    router.push("/reconciliation");
  }

  const ready = stage === "review" && canContinue(rows);
  const showSourceActions = hasReview || image != null || text.trim().length > 0;

  return (
    <div className={stage === "review" && parse ? "flex flex-col gap-3 px-1 lg:h-[calc(100dvh-6.5rem)] lg:min-h-[34rem]" : "flex flex-col gap-3 px-1"}>
      <WorkspaceHeader
        icon={ScanText}
        title="Smart Capture"
        current={stage}
        steps={{
          capture: stage === "review" ? { onSelect: () => setStage("capture") } : undefined,
          review: stage === "capture" && hasReview ? { onSelect: () => setStage("review") } : undefined,
          reconcile: { onSelect: continueToReconciliation, disabled: !ready },
        }}
      >
        {/* "Back to capture" is the review's own action bar button (always visible) and the "Capture" step. */}
        {showSourceActions && ocr && image && (
          <HeaderAction icon={RotateCcw} onClick={retryOcr} testId="retry-ocr">
            Retry OCR
          </HeaderAction>
        )}
        {showSourceActions && (ocr || (mode === "image" && image)) && (
          <HeaderAction icon={ImageUp} onClick={replaceScreenshot} testId="replace-screenshot">
            Replace screenshot
          </HeaderAction>
        )}
        {showSourceActions && (
          <HeaderAction icon={ClipboardPaste} onClick={pasteNewStatement} testId="paste-new">
            Paste new statement
          </HeaderAction>
        )}
        {showSourceActions && (
          <HeaderAction icon={Trash2} tone="danger" onClick={clearCapture} testId="clear-capture">
            Clear capture
          </HeaderAction>
        )}
        {!showSourceActions && (
          <span className="inline-flex items-center gap-1.5 text-xs text-hero-foreground/60">
            <Lock className="size-3.5" /> Processed on this device
          </span>
        )}
      </WorkspaceHeader>

      {pendingDraft && stage === "capture" && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2">
          <History className="size-4 shrink-0 text-primary-accent-text" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            <span className="font-medium">
              Unfinished capture from {new Date(pendingDraft.savedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {pendingDraft.rowCount} rows.
            </span>{" "}
            <span className="text-muted-foreground">{pendingDraft.source === "ocr" ? "Read the same screenshot again" : "Paste the same text again"} to restore your decisions — the content itself was never saved.</span>
          </p>
          <ClayButton variant="secondary" size="sm" onClick={clearCapture}>
            Discard draft
          </ClayButton>
        </div>
      )}

      {stage === "capture" && hasReview && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2" data-testid="review-in-progress">
          <History className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            Your review of {rows.length} row{rows.length === 1 ? "" : "s"} is still open.{" "}
            <span className="text-muted-foreground">Extracting a different statement replaces it — you&apos;ll be asked first if you&apos;ve made decisions.</span>
          </p>
          <ClayButton size="sm" onClick={() => setStage("review")}>
            Return to review
          </ClayButton>
        </div>
      )}

      {notice && stage !== "capture" && (
        <div role="status" className="flex items-center gap-2 rounded-2xl bg-primary/10 px-3 py-2 text-sm text-foreground">
          <History className="size-4 shrink-0 text-primary-accent-text" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="rounded-full p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      )}

      {stage === "capture" && (
        <CaptureInput
          mode={mode}
          onModeChange={setMode}
          text={text}
          onTextChange={setText}
          image={image}
          onImageChange={changeImage}
          crop={crop}
          onCropChange={setCrop}
          onExtract={extract}
          onExtractOcr={extractOcr}
          error={error}
        />
      )}
      {handoffError && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {handoffError}
        </p>
      )}
      {stage === "review" && parse && (
        <CaptureReview parse={parse} rows={rows} onRowsChange={setRows} onBack={() => setStage("capture")} onContinue={continueToReconciliation} ocr={ocr} />
      )}

      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (open) return;
          confirm?.cancel?.();
          setConfirm(null);
        }}
        variant="destructive"
        title={confirm?.title ?? ""}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel}
        cancelLabel="Keep my review"
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          run?.();
        }}
      />
    </div>
  );
}
