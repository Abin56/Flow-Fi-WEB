"use client";

/**
 * Step 1 of Smart Capture — the user hands over a copied transaction table
 * (Paste Text) or a screenshot (Screenshot). Everything stays in the
 * browser: text is parsed locally; screenshots are cropped on a canvas and
 * read by self-hosted Tesseract (lib/tesseract-ocr.ts), loaded only when the
 * user presses "Read text".
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ClipboardPaste, ImageUp, Lock, RefreshCw, RotateCcw, ScanText, Sparkles, Trash2, Type, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClayButton } from "@/components/clay/clay-button";
import { Textarea } from "@/components/ui/textarea";
import { imageWarnings, isUsableCrop, ocrScaleFor, prepareForOcr, type Rect, type Size } from "../lib/image-crop";
import { OcrCancelledError, recognizeScreenshot, type OcrLine, type OcrProgress } from "../lib/tesseract-ocr";
import { CropSelector } from "./crop-selector";

export type CaptureMode = "text" | "image";

export interface CaptureImage {
  file: Blob;
  url: string;
  name: string;
}

/** Everything review needs to show an OCR capture beside its rows. */
export interface OcrCapture {
  text: string;
  lines: OcrLine[];
  imageUrl: string;
  natural: Size;
  /** The area that was read, in natural pixels (whole image when nothing was selected). */
  area: Rect;
  /** Size of the prepared (scaled) canvas OCR boxes are measured in. */
  prepared: Size;
  crop: Rect | null;
  confidence: number;
  durationMs: number;
  warnings: string[];
}

const noopSubscribe = () => () => {};

const SAMPLE = `02/09/2026  SWIGGY BANGALORE             452.00
07/09/2026  REFUND AMAZON PAY INDIA    1,299.00 Cr
15/09/2026  FINANCE CHARGES              312.40
Total Amount Due                       1,28,000.00`;

export function CaptureInput({
  mode,
  onModeChange,
  text,
  onTextChange,
  image,
  onImageChange,
  crop,
  onCropChange,
  onExtract,
  onExtractOcr,
  error,
}: {
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  image: CaptureImage | null;
  onImageChange: (image: CaptureImage | null) => void;
  crop: Rect | null;
  onCropChange: (crop: Rect | null) => void;
  onExtract: (text: string) => void;
  onExtractOcr: (capture: OcrCapture) => void;
  error: string | null;
}) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [ocrFailed, setOcrFailed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The server snapshot (false) keeps hydration consistent; the client value never changes during a session.
  const clipboardReadable = useSyncExternalStore(noopSubscribe, () => !!navigator.clipboard, () => false);
  const reading = progress != null;

  // Leaving the page mid-read must stop the worker.
  useEffect(() => () => abortRef.current?.abort(), []);

  const acceptImage = useCallback(
    (file: Blob, name: string) => {
      if (!file.type.startsWith("image/")) {
        setLocalError("That file isn't an image. Use a PNG, JPG or WebP screenshot.");
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        setLocalError("That image is over 15 MB — crop it to just the transaction rows.");
        return;
      }
      setLocalError(null);
      setOcrFailed(false);
      onCropChange(null);
      onImageChange({ file, url: URL.createObjectURL(file), name });
      onModeChange("image");
    },
    [onCropChange, onImageChange, onModeChange],
  );

  // Ctrl/Cmd+V of a screenshot anywhere on the page lands in the Screenshot tab.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (reading) return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        acceptImage(file, "Pasted screenshot");
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptImage, reading]);

  async function pasteFromClipboard() {
    setLocalError(null);
    try {
      if (mode === "image" && "read" in navigator.clipboard) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) return acceptImage(await item.getType(type), "Pasted screenshot");
        }
        setLocalError("No image on the clipboard. Take a screenshot (Win+Shift+S / Cmd+Shift+4) first.");
        return;
      }
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) setLocalError("The clipboard is empty — copy the transaction rows from your statement first.");
      else onTextChange(clip);
    } catch {
      setLocalError("The browser blocked clipboard access. Click the box and press Ctrl+V (Cmd+V) instead.");
    }
  }

  async function readImage() {
    const img = imageRef.current;
    if (!image || !img || !img.naturalWidth) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLocalError(null);
    setOcrFailed(false);
    setProgress({ stage: "loading", progress: 0, label: "Preparing image" });
    try {
      const natural = { width: img.naturalWidth, height: img.naturalHeight };
      const effectiveCrop = isUsableCrop(crop) ? crop : null;
      const area = effectiveCrop ?? { x: 0, y: 0, ...natural };
      const canvas = prepareForOcr(img, effectiveCrop);
      const result = await recognizeScreenshot(canvas, { onProgress: setProgress, signal: controller.signal });
      if (!result.text.trim()) {
        setOcrFailed(true);
        setLocalError("No text was found in this image. Try a sharper screenshot or select just the transaction rows.");
        return;
      }
      onExtractOcr({
        text: result.text,
        lines: result.lines,
        imageUrl: image.url,
        natural,
        area,
        prepared: { width: Math.round(area.width * ocrScaleFor(area)), height: Math.round(area.height * ocrScaleFor(area)) },
        crop: effectiveCrop,
        confidence: result.confidence,
        durationMs: result.durationMs,
        warnings: imageWarnings(natural, effectiveCrop),
      });
    } catch (e) {
      if (e instanceof OcrCancelledError) {
        setLocalError("Reading cancelled. Nothing was extracted.");
      } else {
        setOcrFailed(true);
        setLocalError(`Couldn't read this screenshot: ${e instanceof Error ? e.message : "unknown error"}. Check your connection to this site (the OCR engine loads from FlowFi itself) and try again.`);
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }

  const shownError = localError ?? error;

  return (
    <div className="surface-primary flex flex-col gap-5 rounded-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Capture source" className="inline-flex rounded-2xl border border-border bg-muted/40 p-1">
          {(
            [
              { id: "text", label: "Paste text", icon: Type },
              { id: "image", label: "Screenshot", icon: ImageUp },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={mode === id}
              disabled={reading}
              onClick={() => {
                onModeChange(id);
                setLocalError(null);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-sm font-medium transition-colors",
                mode === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" />
          Processed on this device — nothing is uploaded
        </span>
      </div>

      {mode === "text" ? (
        <div className="flex flex-col gap-3">
          <ol className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            {["Open your card statement (PDF or net-banking).", "Select just the transaction rows and copy.", "Paste below and extract — you review everything next."].map((step, i) => (
              <li key={step} className="flex items-start gap-2 rounded-2xl bg-muted/40 px-3 py-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary-accent-text">{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>
          <div className="relative">
            <Textarea
              aria-label="Pasted statement text"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder={SAMPLE}
              spellCheck={false}
              className="min-h-64 resize-y rounded-2xl font-mono text-xs leading-relaxed"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear pasted text"
                onClick={() => onTextChange("")}
                className="absolute top-2 right-2 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {clipboardReadable && (
              <ClayButton variant="secondary" size="sm" onClick={() => void pasteFromClipboard()}>
                <ClipboardPaste className="size-3.5" />
                Paste from clipboard
              </ClayButton>
            )}
            <span className="text-xs text-muted-foreground">{text ? `${text.split("\n").filter((l) => l.trim()).length} lines` : "Dates, descriptions and amounts are detected automatically."}</span>
            <ClayButton className="ml-auto" disabled={!text.trim()} onClick={() => onExtract(text)}>
              <Sparkles className="size-4" />
              Extract transactions
            </ClayButton>
          </div>
        </div>
      ) : !image ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) acceptImage(file, file.name);
          }}
          className={cn(
            "flex min-h-64 flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-6 py-10 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30",
          )}
        >
          <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary-accent-text">
            <ImageUp className="size-6" />
          </div>
          <div>
            <p className="font-medium text-foreground">Drop a screenshot of your statement&apos;s transaction rows</p>
            <p className="mt-1 text-xs text-muted-foreground">or press Ctrl+V / Cmd+V to paste one · PNG, JPG, WebP up to 15 MB</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <ClayButton variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              Choose image
            </ClayButton>
            {clipboardReadable && (
              <ClayButton variant="secondary" size="sm" onClick={() => void pasteFromClipboard()}>
                <ClipboardPaste className="size-3.5" />
                Paste screenshot
              </ClayButton>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            <CropSelector src={image.url} crop={crop} onCropChange={onCropChange} imageRef={imageRef} disabled={reading} />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="truncate">{image.name}</span>
              <button type="button" disabled={reading} onClick={() => fileInputRef.current?.click()} className="ml-auto inline-flex items-center gap-1 hover:text-foreground">
                <RefreshCw className="size-3.5" /> Replace
              </button>
              <button
                type="button"
                disabled={reading}
                onClick={() => {
                  onImageChange(null);
                  onCropChange(null);
                  setOcrFailed(false);
                  setLocalError(null);
                }}
                className="inline-flex items-center gap-1 hover:text-danger"
              >
                <Trash2 className="size-3.5" /> Remove
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="rounded-2xl bg-muted/40 p-4 text-sm">
              <p className="font-medium text-foreground">Read the screenshot on this device</p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                <li>Select just the transaction rows for the best accuracy.</li>
                <li>The first read downloads the OCR engine (about 7 MB) from FlowFi; later reads reuse it.</li>
                <li>OCR can misread digits. Every row must be checked against the image and confirmed before import.</li>
              </ul>
            </div>

            {reading ? (
              <div className="flex flex-col gap-2 rounded-2xl border border-border p-4" role="status" aria-live="polite">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ScanText className="size-4 animate-pulse text-primary-accent-text" />
                  {progress.label}…
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{Math.round(progress.progress * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(4, progress.progress * 100)}%` }} />
                </div>
                <ClayButton variant="secondary" size="sm" className="self-end" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </ClayButton>
              </div>
            ) : (
              <ClayButton onClick={() => void readImage()}>
                {ocrFailed ? <RotateCcw className="size-4" /> : <ScanText className="size-4" />}
                {ocrFailed ? "Try again" : crop ? "Read selected area" : "Read text"}
              </ClayButton>
            )}
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Choose screenshot"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) acceptImage(file, file.name);
          e.target.value = "";
        }}
      />

      {shownError && (
        <p role="alert" className="flex items-start gap-2 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {shownError}
        </p>
      )}
    </div>
  );
}
